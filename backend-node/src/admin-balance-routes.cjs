'use strict';

const crypto = require('node:crypto');
const { applyWalletOperation } = require('./wallet.cjs');
const { uuid5 } = require('./exchange-routes.cjs');
const { authorizeAdmin } = require('./admin-authorization.cjs');

const MAX_BODY_BYTES = 16 * 1024;
const ADMIN_CONFIRMATION_PHRASE = 'CONFIRMER';

function httpError(status, message, code) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function reply(res, status, body) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
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
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid');
    return body;
  } catch {
    throw httpError(400, 'Corps JSON invalide');
  }
}

function cryptoWallet(assetId, currency, assets) {
  const asset = assets.get(assetId);
  if (!asset || !asset.wallet_field) throw httpError(400, 'Actif crypto ou réseau indisponible');
  if (currency !== asset.coin && currency !== asset.code) {
    throw httpError(422, 'La devise ne correspond pas à l’actif sélectionné');
  }
  return {
    currency: asset.code,
    field: asset.wallet_field,
    metadata: {
      asset_id: asset.code,
      asset_code: asset.code,
      coin: asset.coin,
      network: asset.network,
      wallet_field: asset.wallet_field,
    },
  };
}

async function resolveWallet(currency, assetId, cryptoCatalog) {
  if (assetId) {
    const assets = await cryptoCatalog.activeExchangeAssets();
    return cryptoWallet(assetId, currency, assets);
  }
  const normalized = currency === 'USD' ? 'USDT' : currency;
  const fields = { XOF: 'balance_xof', XAF: 'balance_xaf', USDT: 'balance_usdt' };
  const field = fields[normalized];
  if (!field) throw httpError(422, 'Sélectionnez un portefeuille crypto et son réseau');
  return { currency: normalized, field, metadata: {} };
}

function createAdminBalanceRoutes({ db, sessionService, cryptoCatalog, env = process.env }) {
  async function handleRoute(req, res) {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { return false; }
    const match = /^\/api\/admin\/users\/([^/]+)\/(credit|debit)$/.exec(url.pathname);
    if (req.method !== 'POST' || !match) return false;
    const action = match[2];
    const isDebit = action === 'debit';

    let authorized;
    try {
      authorized = await authorizeAdmin(req, {
        db, sessionService, env, permission: 'balances:write',
        action: `admin_${action}_attempt`, sensitive: true,
      });
    } catch (error) {
      reply(res, error.status || 500, {
        detail: error.code ? { code: error.code, message: error.message } : error.message || 'Erreur interne.',
      });
      return true;
    }

    let body;
    try { body = await readJson(req); }
    catch (error) {
      reply(res, error.status || 400, { detail: error.message });
      return true;
    }

    let userId;
    try { userId = decodeURIComponent(match[1]); }
    catch {
      reply(res, 400, { detail: 'Identifiant utilisateur invalide' });
      return true;
    }

    const currencyInput = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : '';
    const assetId = typeof body.asset_id === 'string' ? body.asset_id.trim().toUpperCase() : '';
    const amount = Number(body.amount);
    const actionId = body.action_id;
    const reason = body.reason == null ? '' : body.reason;
    if (currencyInput.length < 3 || currencyInput.length > 32) {
      reply(res, 422, { detail: 'Devise invalide' });
      return true;
    }
    if (body.asset_id != null && (typeof body.asset_id !== 'string' || body.asset_id.length > 64)) {
      reply(res, 422, { detail: 'Actif crypto invalide' });
      return true;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      reply(res, 422, { detail: 'Montant invalide' });
      return true;
    }
    if (actionId != null && (typeof actionId !== 'string' || actionId.length < 8 || actionId.length > 120)) {
      reply(res, 422, { detail: 'Identifiant d’action invalide' });
      return true;
    }
    if (typeof reason !== 'string' || reason.length > 500) {
      reply(res, 422, { detail: 'Motif invalide' });
      return true;
    }
    if (typeof body.confirmation !== 'string'
        || body.confirmation.trim().toUpperCase() !== ADMIN_CONFIRMATION_PHRASE) {
      reply(res, 428, {
        detail: {
          code: 'ADMIN_CONFIRMATION_REQUIRED',
          message: 'Une confirmation explicite est requise. Saisissez CONFIRMER.',
        },
      });
      return true;
    }

    try {
      const target = await db.collection('users').find_one(
        { id: userId }, { _id: 0, id: 1, username: 1 },
      );
      if (!target) throw httpError(404, 'Utilisateur introuvable');
      const wallet = await resolveWallet(currencyInput, assetId, cryptoCatalog);
      const operationId = `admin-balance:${actionId || crypto.randomUUID()}`;
      const transactionId = uuid5(userId, operationId);
      const now = new Date().toISOString();
      const description = `${isDebit ? 'Débit' : 'Crédit'} administrateur (${reason || 'manuel'})`;
      const walletMetadata = {
        ...wallet.metadata,
        operation_id: operationId,
        wallet_operation_id: operationId,
      };
      const ledger = {
        id: transactionId,
        user_id: userId,
        type: isDebit ? 'withdrawal' : 'deposit',
        direction: isDebit ? 'out' : 'in',
        amount,
        currency: wallet.currency,
        status: 'completed',
        counterparty: null,
        reference: `BTP-${crypto.randomBytes(5).toString('hex').toUpperCase()}`,
        description,
        created_at: now,
        metadata: {
          admin_id: authorized.admin.id,
          admin_username: authorized.admin.username,
          ...walletMetadata,
        },
      };
      const audit = {
        id: `admin-credit:${transactionId}`,
        admin_id: authorized.admin.id,
        admin_username: authorized.admin.username,
        action,
        target_user_id: userId,
        target_username: target.username || null,
        details: {
          operation_id: operationId,
          amount,
          currency: wallet.currency,
          reason: reason || 'manuel',
          ...wallet.metadata,
        },
        created_at: now,
      };
      const mutation = await applyWalletOperation(db, {
        userId,
        operationId,
        direction: isDebit ? 'debit' : 'credit',
        increments: { [wallet.field]: isDebit ? -amount : amount },
        primaryField: wallet.field,
        ...(isDebit ? {
          requiredBalanceField: wallet.field,
          requiredBalanceAmount: amount,
        } : {}),
        ledger,
        adminLog: audit,
      });
      if (mutation.state === 'insufficient') {
        throw httpError(400, 'Solde utilisateur insuffisant');
      }
      if (mutation.state === 'idempotency_conflict' || mutation.state === 'duplicate_event') {
        throw httpError(409, 'Identifiant d’action déjà utilisé pour une autre opération.');
      }
      if (mutation.state !== 'applied' && mutation.state !== 'already') {
        throw httpError(409, 'Le crédit n’a pas été confirmé ; vérifiez l’identifiant de l’action.');
      }
      const saved = await db.collection('transactions').find_one(
        { id: transactionId, user_id: userId }, { _id: 0 },
      );
      if (!saved || saved.status !== 'completed'
          || String(saved.metadata?.operation_id || '') !== operationId) {
        throw httpError(409, 'Le crédit est déjà marqué comme appliqué, mais son historique doit être vérifié.');
      }
      reply(res, 200, { ok: true, applied: mutation.state === 'applied' });
    } catch (error) {
      reply(res, error.status || 500, {
        detail: error.code ? { code: error.code, message: error.message } : error.message || 'Erreur interne.',
      });
    }
    return true;
  }

  return { handleRoute };
}

module.exports = { createAdminBalanceRoutes, resolveWallet, ADMIN_CONFIRMATION_PHRASE };
