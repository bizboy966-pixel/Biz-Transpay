'use strict';

const { URL } = require('node:url');
const { sessionToken } = require('./auth-session-routes.cjs');
const { publicUser } = require('./public-user.cjs');
const { operationIdentity } = require('./wallet.cjs');
const { reply } = require('./auth-login.cjs');

const API_DEPOSIT_TYPES = ['deposit', 'deposit_in', 'payin'];
const API_SOURCE_VALUES = ['api', 'integration_api', 'merchant_api'];
const PROVIDER_REFERENCE_KEYS = [
  'provider_reference', 'paydunya_disbursement_id', 'paydunya_reference',
  'mbiyo_transaction_id', 'afribapay_transaction_id', 'fedapay_id',
  'provider_id', 'transaction_id',
];
const LOOKUP_WINDOW_MS = 60_000;
const MAX_LOOKUPS_PER_WINDOW = 30;

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function metadataObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch { return {}; }
  }
  return {};
}

function apiPaymentMarkerTerms(transactionIds = [], operationIds = []) {
  const type = { type: { $in: API_DEPOSIT_TYPES } };
  const terms = [
    { ...type, 'metadata.payment_source': { $in: API_SOURCE_VALUES } },
    { ...type, 'metadata.source': { $in: API_SOURCE_VALUES } },
    { ...type, 'metadata.idempotency_key': { $regex: '^btpi_' } },
    { ...type, 'metadata.integration_reference': { $exists: true } },
    { ...type, 'metadata.merchant_payment_id': { $exists: true } },
  ];
  if (transactionIds.length) terms.push({ ...type, id: { $in: transactionIds } });
  if (operationIds.length) terms.push({
    ...type, 'metadata.operation_id': { $in: operationIds },
  });
  return terms;
}

async function integrationApiMarkers(db, userId, limit) {
  const sourceQuery = {
    user_id: userId,
    $or: [
      { idempotency_key: { $regex: '^btpi_' } },
      { source: { $in: API_SOURCE_VALUES } },
    ],
  };
  const [momo, crypto] = await Promise.all([
    db.collection('momo_deposits').find(sourceQuery, {
      _id: 0, id: 1, provider: 1, source: 1, idempotency_key: 1, created_at: 1,
    }).sort('created_at', -1).to_list(limit),
    db.collection('crypto_deposits').find({
      user_id: userId, idempotency_key: { $regex: '^btpi_' },
    }, { _id: 0, id: 1, created_at: 1 }).sort('created_at', -1).to_list(limit),
  ]);
  const transactionIds = new Set();
  const operationIds = new Set();
  for (const deposit of momo) {
    const id = String(deposit.id || '');
    const source = String(deposit.source || '').trim().toLowerCase();
    const isApi = String(deposit.idempotency_key || '').startsWith('btpi_')
      || API_SOURCE_VALUES.includes(source);
    if (id && isApi && !['link_payment', 'payment_link'].includes(source)) {
      transactionIds.add(`${String(deposit.provider || 'paydunya').trim().toLowerCase()}-deposit-${id}`);
    }
  }
  for (const deposit of crypto) {
    if (deposit.id) operationIds.add(`izipay:deposit:${deposit.id}`);
  }
  return { transactionIds: [...transactionIds], operationIds: [...operationIds] };
}

function isApiPayment(transaction, transactionIds, operationIds) {
  const type = String(transaction.type || '').trim().toLowerCase();
  if (type === 'payment') return true;
  if (!API_DEPOSIT_TYPES.includes(type)) return false;
  const metadata = metadataObject(transaction.metadata);
  const source = String(metadata.payment_source || metadata.source || '').trim().toLowerCase();
  return API_SOURCE_VALUES.includes(source)
    || String(metadata.idempotency_key || '').startsWith('btpi_')
    || Boolean(metadata.integration_reference)
    || Boolean(metadata.merchant_payment_id)
    || transactionIds.includes(transaction.id)
    || operationIds.includes(metadata.operation_id);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function failedDepositSearchTerms(rx, needle) {
  const terms = [
    'id', 'reference', 'merchant_reference', 'phone_number', 'phone',
    'customer_phone', 'payer_phone', 'email', 'customer_email', 'payer_email',
    'provider_reference', 'paydunya_reference', 'paydunya_token',
    'mbiyo_transaction_id', 'afribapay_transaction_id', 'afribapay_order_id',
    'fedapay_id', 'provider_id', 'transaction_id',
    'metadata.phone_number', 'metadata.customer_phone', 'metadata.email',
    'metadata.customer_email', 'metadata.provider_reference',
  ].map(path => ({ [path]: rx }));
  const marker = 'BTP-PD-';
  const index = needle.toLowerCase().indexOf(marker.toLowerCase());
  if (index >= 0 && needle.slice(index + marker.length)) {
    terms.push({ id: { $regex: escapeRegex(needle.slice(index + marker.length)), $options: 'i' } });
  }
  return terms;
}

function failedMomoHistoryRow(deposit) {
  const first = keys => keys.map(key => deposit[key]).find(value => value !== undefined && value !== null && value !== '');
  const id = String(deposit.id || '');
  const providerReference = first([
    'provider_reference', 'paydunya_reference', 'mbiyo_transaction_id',
    'afribapay_transaction_id', 'fedapay_id', 'provider_id',
    'transaction_id', 'paydunya_token', 'afribapay_order_id',
  ]) ?? null;
  const phone = first(['phone_number', 'customer_phone', 'payer_phone', 'phone']) ?? null;
  const email = first(['email', 'customer_email', 'payer_email']) ?? null;
  const name = first(['full_name', 'customer_name', 'payer_name']) ?? null;
  const metadata = {
    provider: deposit.provider,
    provider_reference: providerReference,
    phone_number: phone,
    customer_phone: phone,
    email,
    customer_email: email,
    customer_name: name,
    operator: deposit.operator,
    operator_name: deposit.operator_name,
    country_code: deposit.country || deposit.country_code,
    external_reference: deposit.merchant_reference || deposit.external_reference,
  };
  for (const key of ['gateway_fee', 'platform_fee', 'total_fee', 'charged_amount', 'fee_bearer']) {
    if (deposit[key] !== undefined && deposit[key] !== null) metadata[key] = deposit[key];
  }
  const amount = first(['wallet_credit_amount', 'amount', 'processed_amount', 'requested_amount']) ?? 0;
  return {
    id,
    user_id: deposit.user_id,
    type: 'deposit',
    direction: 'in',
    amount,
    currency: deposit.currency,
    status: 'failed',
    reference: `BTP-PD-${id.slice(0, 16)}`,
    description: 'Dépôt Mobile Money échoué',
    counterparty: name || email || phone || 'Expéditeur Mobile Money',
    created_at: deposit.created_at,
    metadata,
  };
}

function providerReference(transaction, metadata) {
  for (const key of PROVIDER_REFERENCE_KEYS) {
    const value = transaction[key] || metadata[key];
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return null;
}

async function enrichWalletSnapshot(db, transaction) {
  if (!transaction) return transaction;
  const metadata = metadataObject(transaction.metadata);
  const operationId = metadata.wallet_operation_id || metadata.operation_id;
  const fields = {};
  const providerRef = providerReference(transaction, metadata);
  if (providerRef && !metadata.provider_reference) fields.provider_reference = providerRef;
  if (operationId) {
    const id = operationIdentity('operation', `${String(transaction.user_id || '')}:${String(operationId)}`);
    const operation = await db.collection('wallet_operations').find_one({
      id, user_id: String(transaction.user_id || ''),
    }, { _id: 0 });
    const snapshot = operation?.snapshot;
    if (snapshot) {
      Object.assign(fields, {
        wallet_operation_id: String(operationId),
        wallet_field: snapshot.wallet_field,
        wallet_operation_direction: snapshot.direction,
        wallet_operation_amount: snapshot.amount,
        wallet_balance_currency: transaction.currency,
        wallet_balance_before: snapshot.balance_before,
        wallet_balance_after: snapshot.balance_after,
        wallet_balances_before: snapshot.wallet_balances_before,
        wallet_balances_after: snapshot.wallet_balances_after,
      });
    }
  }
  if (!Object.keys(fields).length) return transaction;
  return { ...transaction, metadata: { ...metadata, ...fields } };
}

function numericSearchValue(needle) {
  const numeric = needle.replace(',', '.').replace(/[^\d.-]/g, '');
  if (!numeric || numeric === '-' || numeric === '.') return null;
  const parsed = Number(numeric);
  return Number.isFinite(parsed) ? parsed : null;
}

function createUserDataRoutes({ db, sessionService }) {
  const lookupBuckets = new Map();
  function enforceLookupLimit(userId) {
    const now = Date.now();
    const recent = (lookupBuckets.get(String(userId)) || []).filter(time => time > now - LOOKUP_WINDOW_MS);
    if (recent.length >= MAX_LOOKUPS_PER_WINDOW) {
      lookupBuckets.set(String(userId), recent);
      return false;
    }
    recent.push(now);
    lookupBuckets.set(String(userId), recent);
    return true;
  }

  return async function handleUserData(req, res) {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (req.method !== 'GET') return false;
    const isLookup = path === '/api/users/lookup';
    const isWallet = path === '/api/wallet/summary';
    const isList = path === '/api/transactions';
    const detailMatch = /^\/api\/transactions\/([^/]+)$/.exec(path);
    if (!isLookup && !isWallet && !isList && !detailMatch) return false;
    if (!db || !sessionService) {
      reply(res, 503, { detail: 'Données utilisateur indisponibles.', code: 'MIGRATION_INCOMPLETE' });
      return true;
    }
    try {
      const token = sessionToken(req);
      if (!token) {
        reply(res, 401, { detail: { code: 'SESSION_REQUIRED', message: 'Session requise' } });
        return true;
      }
      const identity = await sessionService.authenticate(token);
      const user = await db.collection('users').find_one({ id: identity.userId }, { _id: 0 });
      if (!user) {
        reply(res, 401, { detail: 'Utilisateur introuvable.' });
        return true;
      }
      if (isLookup) {
        if (!enforceLookupLimit(identity.userId)) {
          reply(res, 429, { detail: 'Trop de recherches. Réessayez dans une minute.' });
          return true;
        }
        const url = new URL(req.url, 'http://localhost');
        const needle = String(url.searchParams.get('q') || '').trim().toLowerCase();
        if (!needle || needle.length > 100) {
          reply(res, 422, { detail: 'Recherche invalide.' });
          return true;
        }
        const recipient = await db.collection('users').find_one({
          $or: [
            { username: needle },
            { email: needle },
            { phone: { $regex: escapeRegex(needle), $options: 'i' } },
          ],
        }, { _id: 0, id: 1, username: 1, full_name: 1, country: 1 });
        if (!recipient) {
          reply(res, 404, { detail: 'Utilisateur introuvable' });
          return true;
        }
        reply(res, 200, {
          id: recipient.id,
          username: recipient.username,
          full_name: recipient.full_name || '',
          country: recipient.country || '',
        });
        return true;
      }
      if (isWallet) {
        const transactionsCount = await db.collection('transactions').count_documents({
          user_id: identity.userId,
        });
        const safe = publicUser(user);
        reply(res, 200, {
          balance_xof: user.balance_xof ?? 0,
          balance_xaf: user.balance_xaf ?? 0,
          balance_cdf: user.balance_cdf ?? 0,
          balance_gnf: user.balance_gnf ?? 0,
          balance_usdt: user.balance_usdt ?? 0,
          crypto_wallets: safe.crypto_wallets,
          crypto_wallet_balances: safe.crypto_wallet_balances,
          transactions_count: transactionsCount,
          kyc_status: user.kyc_status || 'not_started',
        });
        return true;
      }
      if (detailMatch) {
        let txId;
        try { txId = decodeURIComponent(detailMatch[1]); }
        catch {
          reply(res, 400, { detail: 'Identifiant de transaction invalide.' });
          return true;
        }
        const transaction = await db.collection('transactions').find_one({
          id: txId, user_id: identity.userId,
        }, { _id: 0 });
        if (!transaction) {
          reply(res, 404, { detail: 'Transaction introuvable' });
          return true;
        }
        reply(res, 200, await enrichWalletSnapshot(db, transaction));
        return true;
      }

      const url = new URL(req.url, 'http://localhost');
      let type = url.searchParams.get('type');
      let status = url.searchParams.get('status');
      if (type === 'all') type = null;
      if (status === 'all') status = null;
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit === null ? 200 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
        reply(res, 422, { detail: 'Limite de résultats invalide.' });
        return true;
      }
      const needle = String(url.searchParams.get('q') || '').trim();
      if (needle.length > 256) {
        reply(res, 422, { detail: 'Recherche trop longue.' });
        return true;
      }
      const needsMarkers = !type || ['deposit', 'payment'].includes(type);
      const markers = needsMarkers
        ? await integrationApiMarkers(db, identity.userId, Math.max(1, Math.min(limit || 1, 1000)))
        : { transactionIds: [], operationIds: [] };
      const markerTerms = apiPaymentMarkerTerms(markers.transactionIds, markers.operationIds);
      const filters = [{
        $nor: [{
          type: 'deposit', direction: 'in', status: { $ne: 'completed' },
        }],
      }];
      if (type === 'payment') filters.push({
        $or: [{ type: 'payment' }, ...markerTerms],
      });
      else if (type === 'deposit') filters.push(
        { type: 'deposit' },
        { $nor: markerTerms },
      );
      else if (type) filters.push({ type });
      if (status) filters.push({ status });

      let failedTerms = [];
      let ownerMatches = false;
      if (needle) {
        const rx = { $regex: escapeRegex(needle), $options: 'i' };
        const searchPaths = [
          'id', 'reference', 'provider_reference', 'external_reference', 'counterparty',
          'description', 'currency', 'type', 'customer_email', 'payer_email',
          'izipay_intent_id', 'izipay_payout_id', 'tx_hash', 'txid', 'tx_id',
          'wallet_address', 'deposit_address', 'destination_address', 'crypto_address',
          'metadata.tx_hash', 'metadata.txid', 'metadata.tx_id',
          'metadata.wallet_address', 'metadata.deposit_address',
          'metadata.destination_address', 'metadata.crypto_address',
          'metadata.recipient_address', 'metadata.customer_email',
          'metadata.payer_email', 'metadata.customer_name', 'metadata.email',
          'metadata.phone_number', 'metadata.customer_phone', 'metadata.external_id',
          'metadata.external_reference', 'metadata.provider_reference',
          'metadata.provider_id', 'metadata.transaction_id',
          'metadata.provider_transaction_id', 'metadata.merchant_reference',
          'metadata.transaction_reference', 'metadata.reference',
          'metadata.biztranspay_reference', 'metadata.paydunya_reference',
          'metadata.paydunya_token', 'metadata.izipay_intent_id',
          'metadata.izipay_payout_id', 'metadata.mbiyo_transaction_id',
          'metadata.afribapay_transaction_id', 'metadata.merchant_payment_id',
          'metadata.payment_id', 'metadata.link_id', 'metadata.link_payment_id',
          'metadata.coin', 'metadata.network', 'metadata.recipient',
          'metadata.recipient_name',
        ];
        const searchTerms = searchPaths.map(field => ({ [field]: rx }));
        const amount = numericSearchValue(needle);
        if (amount !== null) {
          for (const field of [
            'amount', 'metadata.amount_gross', 'metadata.amount_net',
            'metadata.charged_amount', 'metadata.total_debit',
            'metadata.fee', 'metadata.recipient_gets',
          ]) searchTerms.push({ [field]: amount });
        }
        const owner = await db.collection('users').find_one({ id: identity.userId }, {
          _id: 0, email: 1, phone: 1,
        });
        const ownerValues = ['email', 'phone'].map(key => String(owner?.[key] || '').toLowerCase());
        ownerMatches = ownerValues.some(value => value && value.includes(needle.toLowerCase()));
        if (ownerMatches) searchTerms.unshift({ user_id: identity.userId });
        filters.push({ $or: searchTerms });
        failedTerms = failedDepositSearchTerms(rx, needle);
        if (ownerMatches) failedTerms.push({ user_id: identity.userId });
      }

      const query = { user_id: identity.userId };
      if (filters.length) query.$and = filters;
      let docs = await db.collection('transactions').find(query, { _id: 0 })
        .sort('created_at', -1).to_list(limit);
      for (const doc of docs) {
        const metadata = metadataObject(doc.metadata);
        if (isApiPayment(doc, markers.transactionIds, markers.operationIds)
            || metadata.operation_id && markers.operationIds.includes(metadata.operation_id)) {
          doc.history_type = 'payment';
        }
      }
      if (needle && failedTerms.length && (!type || type === 'deposit')
          && (!status || status === 'failed')) {
        const failedQuery = {
          user_id: identity.userId,
          type: 'deposit',
          direction: 'in',
          status: 'failed',
          $or: failedTerms,
        };
        const [failedLedger, failedDeposits] = await Promise.all([
          db.collection('transactions').find(failedQuery, { _id: 0 })
            .sort('created_at', -1).to_list(limit),
          db.collection('momo_deposits').find({
            user_id: identity.userId, status: 'failed', $or: failedTerms,
          }, { _id: 0 }).sort('created_at', -1).to_list(limit),
        ]);
        const byId = new Map(docs.filter(row => row.id).map(row => [String(row.id), row]));
        for (const row of failedLedger) if (row.id) byId.set(String(row.id), byId.get(String(row.id)) || row);
        for (const row of failedDeposits) {
          const history = failedMomoHistoryRow(row);
          if (history.id && !byId.has(history.id)) byId.set(history.id, history);
        }
        docs = [...byId.values()]
          .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
          .slice(0, limit);
      }
      reply(res, 200, docs);
      return true;
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      reply(res, status, {
        detail: error.code
          ? { code: error.code, message: error.message }
          : status >= 500 ? 'Erreur interne.' : error.message,
      }, error.extra?.retry_after ? { 'Retry-After': String(error.extra.retry_after) } : {});
      return true;
    }
  };
}

module.exports = {
  createUserDataRoutes,
  apiPaymentMarkerTerms,
  integrationApiMarkers,
  isApiPayment,
  failedMomoHistoryRow,
  enrichWalletSnapshot,
};
