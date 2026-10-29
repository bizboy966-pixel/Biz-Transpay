'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { applyWalletOperation } = require('./wallet.cjs');
const { getAppFeatures, getPlatformConfig } = require('./public-config-routes.cjs');

const INTERNAL_INTEGRATION_USER = Symbol('internalIntegrationUser');
const MAX_BODY_BYTES = 16 * 1024;
const WINDOW_MS = 60_000;
const MAX_EXCHANGES_PER_WINDOW = 12;
const UUID_URL_NAMESPACE = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Requête trop volumineuse');
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid body');
    }
    return value;
  } catch {
    throw httpError(400, 'Corps JSON invalide');
  }
}

function uuid5(userId, operationId) {
  const digest = crypto.createHash('sha1')
    .update(UUID_URL_NAMESPACE)
    .update(Buffer.from(`${userId}:${operationId}`, 'utf8'))
    .digest();
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function fingerprint(fromCurrency, toCurrency, amount) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ from_currency: fromCurrency, to_currency: toCurrency, amount }))
    .digest('hex');
}

function transactionResponse(transaction) {
  const metadata = transaction.metadata || {};
  return {
    received: Number(metadata.received),
    fee: Number(metadata.fee),
    rate: Number(metadata.rate),
    from_currency: metadata.from_currency,
    to_currency: metadata.to_currency,
    transaction,
  };
}

function nowIso() {
  return new Date().toISOString();
}

function createExchangeRoutes({ db, sessionService, cryptoCatalog, notify = async () => {} }) {
  const rateBuckets = new Map();

  function enforceRateLimit(userId) {
    const now = Date.now();
    const recent = (rateBuckets.get(userId) || []).filter(time => time > now - WINDOW_MS);
    if (recent.length >= MAX_EXCHANGES_PER_WINDOW) {
      rateBuckets.set(userId, recent);
      throw httpError(429, 'Trop de conversions. Réessayez dans une minute.', 'RATE_LIMITED');
    }
    recent.push(now);
    rateBuckets.set(userId, recent);
  }

  async function existingTransaction(userId, transactionId, requestFingerprint, fromCurrency, toCurrency, amount) {
    const transaction = await db.collection('transactions').find_one(
      { id: transactionId, user_id: userId },
      { _id: 0 }
    );
    if (!transaction) return null;
    const metadata = transaction.metadata || {};
    const samePairAndAmount = Number(transaction.amount) === amount
      && String(transaction.currency || '').toUpperCase() === fromCurrency
      && String(metadata.from_currency || '').toUpperCase() === fromCurrency
      && String(metadata.to_currency || '').toUpperCase() === toCurrency;
    const sameRequest = samePairAndAmount
      && (metadata.exchange_request_fingerprint === undefined
        || metadata.exchange_request_fingerprint === requestFingerprint);
    if (!sameRequest || transaction.status !== 'completed' || transaction.type !== 'exchange') {
      throw httpError(409, 'Cette clé d’idempotence est déjà associée à une autre opération.', 'IDEMPOTENCY_CONFLICT');
    }
    return transaction;
  }

  async function handleRoute(req, res) {
    const path = new URL(req.url || '/', 'http://localhost').pathname;
    if (req.method !== 'POST' || path !== '/api/exchange') return false;

    let userId;
    try {
      if (req[INTERNAL_INTEGRATION_USER]) {
        userId = String(req[INTERNAL_INTEGRATION_USER]);
      } else {
        const token = require('./auth-session-routes.cjs').sessionToken(req);
        const authenticated = await sessionService.authenticate(token);
        userId = sessionService.requireRecentAuth(authenticated);
      }
    } catch (error) {
      reply(res, error.status || 401, {
        detail: error.code
          ? { code: error.code, message: error.message }
          : error.message || 'Session requise',
      });
      return true;
    }

    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      reply(res, error.status || 400, { detail: error.message });
      return true;
    }

    const fromCurrency = typeof body.from_currency === 'string'
      ? body.from_currency.trim().toUpperCase() : '';
    const toCurrency = typeof body.to_currency === 'string'
      ? body.to_currency.trim().toUpperCase() : '';
    const amount = Number(body.amount);
    const rawKey = body.idempotency_key;
    if (fromCurrency.length < 2 || fromCurrency.length > 32
        || toCurrency.length < 2 || toCurrency.length > 32) {
      reply(res, 422, { detail: 'Devise source ou destination invalide' });
      return true;
    }
    if (fromCurrency === toCurrency) {
      reply(res, 400, { detail: 'Devises identiques' });
      return true;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      reply(res, 400, { detail: 'Montant invalide' });
      return true;
    }
    if (rawKey !== undefined && rawKey !== null
        && (typeof rawKey !== 'string' || rawKey.length < 8 || rawKey.length > 120)) {
      reply(res, 422, { detail: 'Clé d’idempotence invalide' });
      return true;
    }
    const idempotencyKey = typeof rawKey === 'string' ? rawKey.trim() : '';

    try {
      const user = await db.collection('users').find_one({ id: userId }, { _id: 0 });
      if (!user || String(user.id) !== String(userId)) {
        throw httpError(404, 'Utilisateur introuvable');
      }
      if (user.kyc_status !== 'verified') {
        throw httpError(403, 'Une vérification KYC approuvée est obligatoire avant toute transaction sortante.');
      }
      enforceRateLimit(String(userId));

      const operationId = `exchange:${userId}:${idempotencyKey || crypto.randomUUID()}`;
      const transactionId = uuid5(userId, operationId);
      const requestFingerprint = fingerprint(fromCurrency, toCurrency, amount);
      if (idempotencyKey) {
        const previous = await existingTransaction(
          userId, transactionId, requestFingerprint, fromCurrency, toCurrency, amount,
        );
        if (previous) {
          reply(res, 200, transactionResponse(previous));
          return true;
        }
      }

      const config = await getPlatformConfig(db);
      const context = await cryptoCatalog.exchangeRateContext(config, fromCurrency, toCurrency);
      const source = context.source;
      const destination = context.destination;
      const features = await getAppFeatures(db);
      const sourceFlag = source.kind === 'crypto'
        ? 'wallet_crypto_enabled' : `wallet_${fromCurrency.toLowerCase()}_enabled`;
      const destinationFlag = destination.kind === 'crypto'
        ? 'wallet_crypto_enabled' : `wallet_${toCurrency.toLowerCase()}_enabled`;
      if (features[sourceFlag] === false) {
        throw httpError(400, `Le portefeuille ${fromCurrency} est désactivé`);
      }
      if (features[destinationFlag] === false) {
        throw httpError(400, `Le portefeuille ${toCurrency} est désactivé`);
      }

      const limits = context.limits || {};
      const minimum = Number(limits.min || 0);
      const maximum = Number(limits.max || 0);
      if (amount < minimum) {
        throw httpError(400, `Montant inférieur au minimum (${limits.min} ${fromCurrency})`);
      }
      if (maximum && amount > maximum) {
        throw httpError(400, `Montant supérieur au maximum (${limits.max} ${fromCurrency})`);
      }
      const fee = cryptoCatalog.computeConversionFee(config.conversion_fee || {}, amount);
      if (fee >= amount) throw httpError(400, 'Les frais dépassent le montant à convertir');
      const received = Math.round(((amount - fee) * context.rate + Number.EPSILON) * 1_000_000) / 1_000_000;
      if (!Number.isFinite(received) || received <= 0) throw httpError(400, 'Montant reçu invalide');

      const now = nowIso();
      const transaction = {
        id: transactionId,
        user_id: String(userId),
        type: 'exchange',
        direction: 'out',
        amount,
        currency: fromCurrency,
        status: 'completed',
        counterparty: null,
        reference: `BTP-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
        description: `Conversion ${fromCurrency} → ${toCurrency}`,
        created_at: now,
        metadata: {
          rate: context.rate,
          fee,
          received,
          from_currency: fromCurrency,
          to_currency: toCurrency,
          pair: context.pair,
          wallet_field: source.wallet_field,
          to_wallet_field: destination.wallet_field,
          catalog_asset_id: source.kind === 'crypto' ? source.code : null,
          to_catalog_asset_id: destination.kind === 'crypto' ? destination.code : null,
          gateway_fee: 0,
          platform_fee: fee,
          operation_id: operationId,
          wallet_operation_id: operationId,
          exchange_request_fingerprint: requestFingerprint,
        },
      };

      const mutation = await applyWalletOperation(db, {
        userId: String(userId),
        operationId,
        direction: 'exchange',
        increments: {
          [source.wallet_field]: -amount,
          [destination.wallet_field]: received,
        },
        primaryField: source.wallet_field,
        requiredBalanceField: source.wallet_field,
        requiredBalanceAmount: amount,
        ledger: transaction,
      });

      if (mutation.state === 'insufficient') {
        throw httpError(400, 'Solde insuffisant ou opération déjà appliquée');
      }
      if (mutation.state === 'idempotency_conflict' || mutation.state === 'duplicate_event') {
        throw httpError(409, 'Conflit de clé d’idempotence');
      }
      if (mutation.state === 'missing_user') throw httpError(404, 'Utilisateur introuvable');
      if (mutation.state !== 'applied' && mutation.state !== 'already') {
        throw httpError(400, 'Solde insuffisant ou opération déjà appliquée');
      }

      let savedTransaction = await db.collection('transactions').find_one(
        { id: transactionId, user_id: String(userId) }, { _id: 0 });
      if (!savedTransaction && mutation.snapshot) {
        try {
          await db.collection('transactions').insert_one(transaction);
        } catch (error) {
          if (error.code !== 'ER_DUP_ENTRY' && error.code !== 11000) throw error;
        }
        savedTransaction = await db.collection('transactions').find_one(
          { id: transactionId, user_id: String(userId) }, { _id: 0 });
      }
      if (!savedTransaction) {
        throw httpError(409, 'L’opération est déjà enregistrée mais son historique doit être réconcilié.');
      }
      if (mutation.state === 'applied') {
        try {
          await notify(String(userId), 'exchange_success', 'Échange confirmé',
            `Votre conversion de ${amount} ${fromCurrency} vers ${received} ${toCurrency} est confirmée.`,
            {
              transaction_id: savedTransaction.id,
              status: 'completed',
              amount,
              currency: fromCurrency,
              from_currency: fromCurrency,
              to_currency: toCurrency,
              received,
            });
        } catch { /* notifications must not roll back a committed wallet operation */ }
      }
      reply(res, 200, transactionResponse(savedTransaction));
    } catch (error) {
      reply(res, error.status || 500, {
        detail: error.code ? { code: error.code, message: error.message } : error.message || 'Erreur interne.',
      });
    }
    return true;
  }

  async function handleIntegration(userId, body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = 'POST';
    req.url = '/api/exchange';
    req.headers = {};
    req[INTERNAL_INTEGRATION_USER] = String(userId || '');
    const res = {
      status: 500,
      writeHead(status) { this.status = status; },
      end(text) {
        try { this.body = JSON.parse(String(text || '{}')); } catch { this.body = {}; }
      },
    };
    const handled = await handleRoute(req, res);
    return { handled, status: res.status, body: res.body || {} };
  }

  return { handleRoute, handleIntegration };
}

module.exports = { createExchangeRoutes, uuid5 };
