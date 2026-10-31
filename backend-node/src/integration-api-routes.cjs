'use strict';

const crypto = require('node:crypto');
const { authenticateIntegrationApi, IntegrationApiError } = require('./integration-api-auth.cjs');
const { readJson } = require('./auth-login.cjs');
const {
  publicPaymentPayload, publicPaymentText,
} = require('./public-payment-copy.cjs');

function pickFields(document, fields) {
  return Object.fromEntries(fields
    .filter(field => Object.hasOwn(document || {}, field))
    .map(field => [field, document[field]]));
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function publicCryptoDeposit(document) {
  const result = pickFields(document, [
    'id', 'status', 'amount', 'asset_code', 'coin', 'network', 'credit_currency',
    'deposit_address', 'memo', 'memo_type', 'amount_to_send', 'expires_at',
    'fee_pct', 'fee_fixed', 'fee', 'amount_net', 'tx_hash', 'created_at', 'updated_at',
  ]);
  result.pending_manual = ['creating', 'provider_unknown'].includes(document.status)
    && !document.deposit_address;
  return result;
}

function publicCryptoPayout(transaction) {
  const metadata = typeof transaction.metadata === 'string'
    ? (() => { try { return JSON.parse(transaction.metadata); } catch { return {}; } })()
    : (transaction.metadata || {});
  return {
    id: transaction.id,
    status: transaction.status,
    amount: metadata.amount_gross ?? transaction.amount,
    asset_code: metadata.asset_code ?? transaction.currency,
    coin: metadata.coin,
    network: metadata.network,
    wallet_address: metadata.wallet_address ?? transaction.counterparty,
    destination_memo: metadata.destination_memo,
    fee: metadata.fee,
    fee_bearer: metadata.fee_bearer,
    recipient_gets: metadata.recipient_gets,
    total_debit: metadata.total_debit,
    pending_manual: Boolean(metadata.manual_review_required || metadata.provider_outcome_unknown),
    tx_hash: metadata.tx_hash,
    created_at: transaction.created_at,
  };
}

function publicMobileMoneyDeposit(document) {
  return pickFields(document, [
    'id', 'status', 'amount', 'currency', 'country', 'operator', 'phone_number',
    'full_name', 'email', 'reference', 'description', 'provider_reference',
    'external_id', 'transaction_id', 'fee', 'fee_amount', 'fee_currency',
    'requested_amount', 'charged_amount', 'total_fee', 'amount_net',
    'fee_bearer', 'created_at', 'updated_at', 'confirmed_at',
  ]);
}

function publicMobileMoneyOperator(operator) {
  const row = pickFields(operator, [
    'country', 'country_label', 'code', 'name', 'currency', 'min', 'max',
  ]);
  if (typeof row.name === 'string') row.name = publicPaymentText(row.name);
  const flow = operator?.payment_flow;
  if (flow && typeof flow === 'object' && !Array.isArray(flow)) {
    const flowFields = [
      'kind', 'before_submit', 'otp_required', 'otp_request_before_submit', 'otp_label',
      'ussd_code', 'ussd_template', 'steps', 'instructions', 'action_label',
      'address_required', 'address_label',
    ];
    row.payment_flow = pickFields(flow, flowFields);
  }
  return row;
}

function publicMobileMoneyPayout(transaction) {
  const metadata = typeof transaction?.metadata === 'string'
    ? (() => { try { return JSON.parse(transaction.metadata); } catch { return {}; } })()
    : (transaction?.metadata || {});
  return {
    ...pickFields(transaction, [
      'id', 'reference', 'status', 'amount', 'currency',
      'created_at', 'updated_at', 'completed_at',
    ]),
    pending_manual: Boolean(metadata.manual_review_required || metadata.provider_outcome_unknown),
  };
}

function mobileMoneyPayoutResponse(transaction, pendingManual = false) {
  const payout = publicMobileMoneyPayout(transaction);
  return {
    id: String(payout.id || ''),
    status: String(payout.status || 'pending'),
    payout: {
      id: String(payout.id || ''),
      reference: String(payout.reference || ''),
      status: String(payout.status || 'pending'),
      amount: Number(payout.amount),
      currency: String(payout.currency || '').toUpperCase(),
      ...(pendingManual || payout.pending_manual ? { pending_manual: true } : {}),
    },
  };
}

function reply(res, status, body) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(publicPaymentPayload(body)));
}

function createIntegrationApiRoutes({
  db, now = Date.now, getCryptoAssets, getMobileMoneyOperators, getExchangeQuote,
  executeExchange, createPaymentLink, createCryptoDeposit, createMobileMoneyDeposit,
  quoteMobileMoneyDeposit, createCryptoPayout, createMobileMoneyPayout, refreshMobileMoneyPayout,
  refreshMobileMoneyDeposit,
}) {
  const mobileMoneyDepositRefreshAt = new Map();

  async function refreshIntegrationDeposit(depositId, userId) {
    const id = String(depositId || '');
    const ownerId = String(userId || '');
    let deposit = await db.collection('momo_deposits').find_one(
      { id, user_id: ownerId }, { _id: 0 },
    );
    if (!deposit || deposit.status !== 'pending'
        || typeof refreshMobileMoneyDeposit !== 'function') return deposit;

    const key = `${ownerId}:${id}`;
    const checkedAt = Number(now());
    const previousCheck = mobileMoneyDepositRefreshAt.get(key);
    if (previousCheck !== undefined && checkedAt - previousCheck < 10_000) return deposit;
    mobileMoneyDepositRefreshAt.set(key, checkedAt);
    while (mobileMoneyDepositRefreshAt.size > 500) {
      mobileMoneyDepositRefreshAt.delete(mobileMoneyDepositRefreshAt.keys().next().value);
    }

    try { await refreshMobileMoneyDeposit(id, ownerId); } catch { /* Keep the last verified snapshot. */ }
    deposit = await db.collection('momo_deposits').find_one(
      { id, user_id: ownerId }, { _id: 0 },
    ) || deposit;
    return deposit;
  }

  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const cryptoAssetCatalog = req.method === 'GET'
      && url.pathname === '/api/integration/v1/crypto/assets';
    const mobileMoneyOperatorCatalog = req.method === 'GET'
      && url.pathname === '/api/integration/v1/mobile-money/operators';
    const mobileMoneyDepositQuote = req.method === 'POST'
      && url.pathname === '/api/integration/v1/deposits/quote';
    const exchangeQuote = req.method === 'GET'
      && url.pathname === '/api/integration/v1/exchanges/quote';
    const exchangeExecution = req.method === 'POST'
      && url.pathname === '/api/integration/v1/exchanges';
    const linkCreation = req.method === 'POST'
      && url.pathname === '/api/integration/v1/links';
    const cryptoDepositStart = req.method === 'POST'
      && url.pathname === '/api/integration/v1/crypto/deposits';
    const mobileMoneyDepositStart = req.method === 'POST'
      && url.pathname === '/api/integration/v1/deposits';
    const cryptoPayoutStart = req.method === 'POST'
      && url.pathname === '/api/integration/v1/crypto/payouts';
    const mobileMoneyPayoutStart = req.method === 'POST'
      && url.pathname === '/api/integration/v1/payouts';
    const listPaths = {
      '/api/integration/v1/deposits': 'deposit',
      '/api/integration/v1/payouts': 'payout',
      '/api/integration/v1/crypto/deposits': 'crypto_deposit',
      '/api/integration/v1/crypto/payouts': 'crypto_payout',
      '/api/integration/v1/exchanges': 'exchange',
      '/api/integration/v1/links': 'link',
    };
    const kind = listPaths[url.pathname];
    const isTransactions = url.pathname === '/api/integration/v1/transactions';
    const exchangeMatch = req.method === 'GET'
      ? /^\/api\/integration\/v1\/exchanges\/([^/]+)$/.exec(url.pathname) : null;
    const linkPaymentsMatch = req.method === 'GET'
      ? /^\/api\/integration\/v1\/links\/([^/]+)\/payments$/.exec(url.pathname) : null;
    const linkMatch = req.method === 'GET'
      ? /^\/api\/integration\/v1\/links\/([^/]+)$/.exec(url.pathname) : null;
    const payoutMatch = req.method === 'GET'
      ? /^\/api\/integration\/v1\/payouts\/([^/]+)$/.exec(url.pathname) : null;
    const depositMatch = req.method === 'GET'
      ? /^\/api\/integration\/v1\/deposits\/([^/]+)$/.exec(url.pathname) : null;
    const cryptoDepositMatch = req.method === 'GET'
      ? /^\/api\/integration\/v1\/crypto\/deposits\/([^/]+)$/.exec(url.pathname) : null;
    const cryptoPayoutMatch = req.method === 'GET'
      ? /^\/api\/integration\/v1\/crypto\/payouts\/([^/]+)$/.exec(url.pathname) : null;
    const isDetail = exchangeMatch || linkPaymentsMatch || linkMatch || payoutMatch
      || depositMatch || cryptoDepositMatch || cryptoPayoutMatch;
    if ((req.method !== 'GET' && !exchangeExecution && !linkCreation
          && !mobileMoneyDepositQuote
          && !cryptoDepositStart && !mobileMoneyDepositStart && !cryptoPayoutStart
          && !mobileMoneyPayoutStart)
        || (!kind && !isTransactions && !isDetail && !cryptoAssetCatalog
          && !mobileMoneyOperatorCatalog && !exchangeQuote
          && !exchangeExecution && !linkCreation && !mobileMoneyDepositQuote && !cryptoDepositStart
          && !mobileMoneyDepositStart && !cryptoPayoutStart
          && !mobileMoneyPayoutStart)) return false;
    try {
      const rawLimit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 100;
      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 500) {
        reply(res, 422, { detail: 'Invalid limit; expected an integer between 1 and 500.' });
        return true;
      }
      const credential = await authenticateIntegrationApi({ db, req, now });
      if (mobileMoneyDepositQuote) {
        if (credential.environment !== 'live'
            || !Array.isArray(credential.scopes)
            || !credential.scopes.includes('deposits:write')) {
          reply(res, 403, { detail: 'A Live deposits:write scope is required.' });
          return true;
        }
        if (typeof quoteMobileMoneyDeposit !== 'function') {
          reply(res, 503, { detail: 'Mobile Money fee quote service unavailable.' });
          return true;
        }
        let body;
        try {
          body = await readJson(req, 32 * 1024);
        } catch (error) {
          reply(res, error.status || 400, { detail: error.message || 'Invalid request body.' });
          return true;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          reply(res, 422, { detail: 'A JSON object is required.' });
          return true;
        }
        if (body.fee_bearer !== undefined) {
          const bearer = String(body.fee_bearer || '').trim().toLowerCase();
          const normalized = {
            sender: 'sender',
            client: 'sender',
            receiver: 'receiver',
            merchant: 'receiver',
          }[bearer];
          if (!normalized) {
            reply(res, 422, { detail: 'fee_bearer must be sender or receiver.' });
            return true;
          }
          body.fee_bearer = normalized;
        }
        const result = await quoteMobileMoneyDeposit(credential.user_id, body);
        if (!result?.handled) {
          reply(res, 503, { detail: 'Mobile Money fee quote service did not handle the request.' });
          return true;
        }
        reply(res, result.status || 502, result.body || {});
        return true;
      }
      if (mobileMoneyDepositStart) {
        if (credential.environment !== 'live'
            || !Array.isArray(credential.scopes)
            || !credential.scopes.includes('deposits:write')) {
          reply(res, 403, { detail: 'Live deposit scope is required.' });
          return true;
        }
        if (typeof createMobileMoneyDeposit !== 'function') {
          reply(res, 503, { detail: 'Mobile Money deposit service unavailable.' });
          return true;
        }
        const idempotencyKey = String(req.headers?.['idempotency-key'] || '').trim();
        if (idempotencyKey.length < 8 || idempotencyKey.length > 120) {
          reply(res, 422, { detail: 'A valid Idempotency-Key header is required.' });
          return true;
        }
        let body;
        try {
          body = await readJson(req, 32 * 1024);
        } catch (error) {
          reply(res, error.status || 400, { detail: error.message || 'Invalid request body.' });
          return true;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          reply(res, 422, { detail: 'A JSON object is required.' });
          return true;
        }
        if (body.fee_bearer !== undefined) {
          const bearer = String(body.fee_bearer || '').trim().toLowerCase();
          const normalized = {
            sender: 'sender',
            client: 'sender',
            receiver: 'receiver',
            merchant: 'receiver',
          }[bearer];
          if (!normalized) {
            reply(res, 422, { detail: 'fee_bearer must be sender or receiver.' });
            return true;
          }
          body.fee_bearer = normalized;
        }
        if (body.request_otp !== undefined && typeof body.request_otp !== 'boolean') {
          reply(res, 422, { detail: 'request_otp must be a boolean.' });
          return true;
        }
        const otpRequest = body.request_otp === true;
        if (otpRequest && String(body.otp || '').trim()) {
          reply(res, 422, { detail: 'Do not send otp in the same request as request_otp.' });
          return true;
        }
        const requestFingerprint = crypto.createHash('sha256')
          .update(stableJson(body), 'utf8').digest('hex');
        const operationKind = otpRequest ? 'deposit_otp' : 'deposit';
        const operationId = `${operationKind}:${crypto.createHash('sha256')
          .update(`${credential.user_id}:${credential.environment}:${idempotencyKey}`, 'utf8')
          .digest('hex')}`;
        const operations = db.collection('integration_operations');
        const existing = await operations.find_one({
          id: operationId,
          user_id: String(credential.user_id),
          environment: credential.environment,
        }, { _id: 0 });
        if (existing) {
          if (existing.request_fingerprint !== requestFingerprint) {
            reply(res, 409, { detail: 'Idempotency key was used with a different request.' });
            return true;
          }
          if (existing.response) {
            if (otpRequest) {
              reply(res, existing.response_status || 200, existing.response);
              return true;
            }
            let response = existing.response;
            const previousDeposit = await refreshIntegrationDeposit(
              existing.business_id || response.id, credential.user_id,
            );
            if (previousDeposit) {
              const currentDeposit = publicMobileMoneyDeposit(previousDeposit);
              response = {
                ...response,
                id: String(previousDeposit.id),
                status: String(previousDeposit.status || response.status || 'pending'),
                deposit: { ...(response.deposit || {}), ...currentDeposit },
              };
              await operations.update_one({
                id: operationId,
                user_id: String(credential.user_id),
                environment: credential.environment,
              }, { $set: {
                status: response.status,
                response,
                updated_at: new Date(now()).toISOString(),
              } });
            }
            reply(res, 200, response);
            return true;
          }
          if (otpRequest) {
            reply(res, 409, {
              detail: 'Le résultat de la demande de code est incertain. Vérifiez votre téléphone avant toute nouvelle demande.',
            });
            return true;
          }
        }
        if (otpRequest) {
          try {
            await operations.insert_one({
              id: operationId,
              user_id: String(credential.user_id),
              environment: credential.environment,
              kind: operationKind,
              status: 'otp_requesting',
              request_fingerprint: requestFingerprint,
              response: null,
              created_at: new Date(now()).toISOString(),
              updated_at: new Date(now()).toISOString(),
            });
          } catch {
            const raced = await operations.find_one({
              id: operationId,
              user_id: String(credential.user_id),
              environment: credential.environment,
            }, { _id: 0 });
            if (raced?.request_fingerprint === requestFingerprint && raced.response) {
              reply(res, raced.response_status || 200, raced.response);
            } else {
              reply(res, 409, {
                detail: 'La demande de code est déjà en cours ou son résultat est incertain. Vérifiez votre téléphone.',
              });
            }
            return true;
          }
        }
        const internalKey = `btpi_${crypto.createHash('sha256')
          .update(`${credential.user_id}:${credential.environment}:${idempotencyKey}`, 'utf8')
          .digest('hex').slice(0, 48)}`;
        const result = await createMobileMoneyDeposit(
          credential.user_id, body, internalKey,
        );
        if (!result?.handled) {
          const response = { detail: 'Mobile Money deposit service did not handle the request.' };
          if (otpRequest) {
            await operations.replace_one({ id: operationId }, {
              id: operationId, user_id: String(credential.user_id),
              environment: credential.environment, kind: operationKind,
              status: 'failed', request_fingerprint: requestFingerprint,
              response_status: 503, response,
              created_at: new Date(now()).toISOString(),
              updated_at: new Date(now()).toISOString(),
            }, true);
          }
          reply(res, 503, response);
          return true;
        }
        if (otpRequest) {
          const confirmed = result.status === 200 && result.body?.otp_sent === true;
          const responseStatus = confirmed ? 200 : (result.status || 502);
          const response = confirmed
            ? result.body
            : result.body?.detail
              ? result.body
              : { detail: 'Biz-transPay n’a pas confirmé l’envoi du code. Vérifiez votre téléphone avant de recommencer.' };
          await operations.replace_one({ id: operationId }, {
            id: operationId, user_id: String(credential.user_id),
            environment: credential.environment, kind: operationKind,
            status: confirmed ? 'otp_sent' : 'failed',
            request_fingerprint: requestFingerprint,
            response_status: responseStatus, response,
            created_at: new Date(now()).toISOString(),
            updated_at: new Date(now()).toISOString(),
          }, true);
          reply(res, responseStatus, response);
          return true;
        }
        if (result.status !== 200 || !result.body?.id) {
          reply(res, result.status || 502, result.body || { detail: 'Deposit creation failed.' });
          return true;
        }
        const deposit = result.body;
        const response = {
          id: String(deposit.id),
          status: String(deposit.status || 'pending'),
          deposit,
        };
        const timestamp = new Date(now()).toISOString();
        await operations.replace_one(
          { id: operationId },
          {
            id: operationId,
            user_id: String(credential.user_id),
            environment: credential.environment,
            kind: 'deposit',
            business_id: response.id,
            status: response.status,
            request_fingerprint: requestFingerprint,
            reference: body.reference || null,
            response,
            created_at: existing?.created_at || timestamp,
            updated_at: timestamp,
          },
          true,
        );
        reply(res, 200, response);
        return true;
      }
      if (mobileMoneyPayoutStart) {
        if (credential.environment !== 'live'
            || !Array.isArray(credential.scopes)
            || !credential.scopes.includes('payouts:write')
            || credential.payout_opt_in !== true) {
          reply(res, 403, {
            detail: 'Live payouts:write scope and explicit payout opt-in are required.',
          });
          return true;
        }
        if (typeof createMobileMoneyPayout !== 'function') {
          reply(res, 503, { detail: 'Mobile Money payout service unavailable.' });
          return true;
        }
        const owner = await db.collection('users').find_one(
          { id: String(credential.user_id) }, { _id: 0, kyc_status: 1 },
        );
        if (!owner || owner.kyc_status !== 'verified') {
          reply(res, 403, { detail: 'Verified KYC is required for payouts.' });
          return true;
        }
        const idempotencyKey = String(req.headers?.['idempotency-key'] || '').trim();
        if (idempotencyKey.length < 8 || idempotencyKey.length > 120) {
          reply(res, 422, { detail: 'A valid Idempotency-Key header is required.' });
          return true;
        }
        let body;
        try {
          body = await readJson(req, 32 * 1024);
        } catch (error) {
          reply(res, error.status || 400, { detail: error.message || 'Invalid request body.' });
          return true;
        }
        const requestFingerprint = crypto.createHash('sha256')
          .update(stableJson(body), 'utf8').digest('hex');
        const operationId = `mobile_payout:${crypto.createHash('sha256')
          .update(`${credential.user_id}:${credential.environment}:${idempotencyKey}`, 'utf8')
          .digest('hex')}`;
        const operations = db.collection('integration_operations');
        const existing = await operations.find_one({
          id: operationId,
          user_id: String(credential.user_id),
          environment: credential.environment,
        }, { _id: 0 });
        if (existing) {
          if (existing.request_fingerprint !== requestFingerprint) {
            reply(res, 409, { detail: 'Idempotency key was used with a different request.' });
            return true;
          }
          if (existing.response) {
            let previousTransaction = await db.collection('transactions').find_one({
              id: String(existing.business_id || ''),
              user_id: String(credential.user_id),
            }, { _id: 0 });
            if (previousTransaction) {
              if (typeof refreshMobileMoneyPayout === 'function') {
                try {
                  previousTransaction = await refreshMobileMoneyPayout(
                    previousTransaction.id, credential.user_id,
                  ) || previousTransaction;
                } catch { /* A status polling failure never resubmits a payout. */ }
              }
              const response = mobileMoneyPayoutResponse(previousTransaction);
              await operations.update_one({
                id: operationId,
                user_id: String(credential.user_id),
                environment: credential.environment,
              }, { $set: {
                status: response.status,
                response,
                updated_at: new Date(now()).toISOString(),
              } });
              reply(res, 200, response);
              return true;
            }
            reply(res, 200, existing.response);
            return true;
          }
        }
        const internalKey = `btpi_${crypto.createHash('sha256')
          .update(`${credential.user_id}:${credential.environment}:${idempotencyKey}`, 'utf8')
          .digest('hex').slice(0, 48)}`;
        const result = await createMobileMoneyPayout(
          credential.user_id, body, internalKey,
        );
        const transaction = result?.transaction || result;
        if (!transaction?.id || !['pending', 'completed', 'failed'].includes(String(transaction.status))) {
          reply(res, 502, { detail: 'The payout was not safely recorded.' });
          return true;
        }
        const response = mobileMoneyPayoutResponse(
          transaction, Boolean(result?.pending_manual),
        );
        const timestamp = new Date(now()).toISOString();
        await operations.replace_one(
          { id: operationId },
          {
            id: operationId,
            user_id: String(credential.user_id),
            environment: credential.environment,
            kind: 'payout',
            business_id: response.id,
            status: response.status,
            request_fingerprint: requestFingerprint,
            reference: body.reference || null,
            response,
            created_at: existing?.created_at || transaction.created_at || timestamp,
            updated_at: timestamp,
          },
          true,
        );
        reply(res, 200, response);
        return true;
      }
      if (cryptoPayoutStart) {
        if (credential.environment !== 'live'
            || !Array.isArray(credential.scopes)
            || !credential.scopes.includes('payouts:write')
            || credential.payout_opt_in !== true) {
          reply(res, 403, {
            detail: 'Live payouts:write scope and explicit payout opt-in are required.',
          });
          return true;
        }
        if (typeof createCryptoPayout !== 'function') {
          reply(res, 503, { detail: 'Crypto payout service unavailable.' });
          return true;
        }
        const payoutOwner = await db.collection('users').find_one(
          { id: String(credential.user_id) }, { _id: 0, kyc_status: 1 },
        );
        if (!payoutOwner || payoutOwner.kyc_status !== 'verified') {
          reply(res, 403, { detail: 'Verified KYC is required for payouts.' });
          return true;
        }
        const idempotencyKey = String(req.headers?.['idempotency-key'] || '').trim();
        if (idempotencyKey.length < 8 || idempotencyKey.length > 120) {
          reply(res, 422, { detail: 'A valid Idempotency-Key header is required.' });
          return true;
        }
        let body;
        try {
          body = await readJson(req, 32 * 1024);
        } catch (error) {
          reply(res, error.status || 400, { detail: error.message || 'Invalid request body.' });
          return true;
        }
        const requestFingerprint = crypto.createHash('sha256')
          .update(stableJson(body), 'utf8').digest('hex');
        const operationId = `crypto_payout:${crypto.createHash('sha256')
          .update(`${credential.user_id}:${credential.environment}:${idempotencyKey}`, 'utf8')
          .digest('hex')}`;
        const operations = db.collection('integration_operations');
        const existing = await operations.find_one({
          id: operationId,
          user_id: String(credential.user_id),
          environment: credential.environment,
        }, { _id: 0 });
        if (existing) {
          if (existing.request_fingerprint !== requestFingerprint) {
            reply(res, 409, { detail: 'Idempotency key was used with a different request.' });
            return true;
          }
          if (existing.response) {
            reply(res, 200, existing.response);
            return true;
          }
        }
        const internalKey = `btpi_${crypto.createHash('sha256')
          .update(`${credential.user_id}:${credential.environment}:${idempotencyKey}`, 'utf8')
          .digest('hex').slice(0, 48)}`;
        const payout = await createCryptoPayout(
          credential.user_id, body, internalKey,
        );
        if (!payout?.id || payout.status !== 'pending') {
          reply(res, 502, { detail: 'The crypto payout was not safely recorded.' });
          return true;
        }
        const response = {
          id: String(payout.id),
          status: String(payout.status),
          payout: publicCryptoPayout(payout),
        };
        const timestamp = new Date(now()).toISOString();
        await operations.replace_one(
          { id: operationId },
          {
            id: operationId,
            user_id: String(credential.user_id),
            environment: credential.environment,
            kind: 'crypto_payout',
            business_id: response.id,
            status: response.status,
            request_fingerprint: requestFingerprint,
            reference: body.reference || null,
            response,
            created_at: existing?.created_at || timestamp,
            updated_at: timestamp,
          },
          true,
        );
        reply(res, 200, response);
        return true;
      }
      if (cryptoDepositStart) {
        if (credential.environment !== 'live'
            || !Array.isArray(credential.scopes)
            || !credential.scopes.includes('deposits:write')) {
          reply(res, 403, { detail: 'Live deposit scope is required.' });
          return true;
        }
        if (typeof createCryptoDeposit !== 'function') {
          reply(res, 503, { detail: 'Crypto deposit service unavailable.' });
          return true;
        }
        const idempotencyKey = String(req.headers?.['idempotency-key'] || '').trim();
        if (idempotencyKey.length < 8 || idempotencyKey.length > 120) {
          reply(res, 422, { detail: 'A valid Idempotency-Key header is required.' });
          return true;
        }
        let body;
        try {
          body = await readJson(req, 32 * 1024);
        } catch (error) {
          reply(res, error.status || 400, { detail: error.message || 'Invalid request body.' });
          return true;
        }
        const requestFingerprint = crypto.createHash('sha256')
          .update(stableJson(body), 'utf8').digest('hex');
        const operationId = `crypto_deposit:${crypto.createHash('sha256')
          .update(`${credential.user_id}:${credential.environment}:${idempotencyKey}`, 'utf8')
          .digest('hex')}`;
        const operations = db.collection('integration_operations');
        const existing = await operations.find_one({
          id: operationId,
          user_id: String(credential.user_id),
          environment: credential.environment,
        }, { _id: 0 });
        if (existing) {
          if (existing.request_fingerprint !== requestFingerprint) {
            reply(res, 409, { detail: 'Idempotency key was used with a different request.' });
            return true;
          }
          if (existing.response) {
            reply(res, 200, existing.response);
            return true;
          }
        }
        const internalIdempotencyKey = `btpi_${crypto.createHash('sha256')
          .update(`${credential.user_id}:${credential.environment}:${idempotencyKey}`, 'utf8')
          .digest('hex').slice(0, 48)}`;
        const deposit = await createCryptoDeposit(
          credential.user_id,
          { ...body, idempotency_key: internalIdempotencyKey },
        );
        const response = {
          id: deposit.id,
          status: deposit.status || 'pending',
          deposit: publicCryptoDeposit(deposit),
        };
        const timestamp = new Date(now()).toISOString();
        await operations.replace_one(
          { id: operationId },
          {
            id: operationId,
            user_id: String(credential.user_id),
            environment: credential.environment,
            kind: 'crypto_deposit',
            business_id: String(deposit.id),
            status: response.status,
            request_fingerprint: requestFingerprint,
            reference: body.reference || null,
            response,
            created_at: existing?.created_at || timestamp,
            updated_at: timestamp,
          },
          true,
        );
        reply(res, 200, response);
        return true;
      }
      if (exchangeExecution) {
        if (credential.environment !== 'live'
            || !Array.isArray(credential.scopes)
            || !credential.scopes.includes('exchanges:write')) {
          reply(res, 403, { detail: 'Live exchange scope is required.' });
          return true;
        }
        if (typeof executeExchange !== 'function') {
          reply(res, 503, { detail: 'Exchange service unavailable.' });
          return true;
        }
        const idempotencyKey = String(req.headers?.['idempotency-key'] || '').trim();
        if (idempotencyKey.length < 8 || idempotencyKey.length > 120) {
          reply(res, 422, { detail: 'A valid Idempotency-Key header is required.' });
          return true;
        }
        let body;
        try {
          body = await readJson(req, 16 * 1024);
        } catch (error) {
          reply(res, error.status || 400, { detail: error.message || 'Invalid request body.' });
          return true;
        }
        const result = await executeExchange(credential.user_id, {
          ...body,
          idempotency_key: idempotencyKey,
        });
        if (!result?.handled) {
          reply(res, 503, { detail: 'Exchange service did not handle the request.' });
          return true;
        }
        if (result.status === 200) {
          const exchange = result.body;
          const transaction = exchange?.transaction || exchange;
          const businessId = String(transaction?.id || '');
          if (businessId) {
            const operationId = `exchange:${crypto.createHash('sha256')
              .update(`${credential.user_id}:${idempotencyKey}`, 'utf8').digest('hex')}`;
            const createdAt = transaction.created_at || new Date(now()).toISOString();
            const response = {
              id: businessId,
              status: transaction.status || 'completed',
              exchange,
            };
            await db.collection('integration_operations').replace_one(
              { id: operationId },
              {
                id: operationId,
                user_id: String(credential.user_id),
                environment: credential.environment,
                kind: 'exchange',
                business_id: businessId,
                status: response.status,
                response,
                created_at: createdAt,
                updated_at: new Date(now()).toISOString(),
              },
              true,
            );
            reply(res, 200, response);
            return true;
          }
        }
        reply(res, result.status || 502, result.body || { detail: 'Exchange failed.' });
        return true;
      }
      if (linkCreation) {
        if (credential.environment !== 'live'
            || !Array.isArray(credential.scopes)
            || !credential.scopes.includes('links:write')) {
          reply(res, 403, { detail: 'Live payment-link scope is required.' });
          return true;
        }
        if (typeof createPaymentLink !== 'function') {
          reply(res, 503, { detail: 'Payment-link service unavailable.' });
          return true;
        }
        const idempotencyKey = String(req.headers?.['idempotency-key'] || '').trim();
        if (idempotencyKey.length < 8 || idempotencyKey.length > 120) {
          reply(res, 422, { detail: 'A valid Idempotency-Key header is required.' });
          return true;
        }
        let body;
        try {
          body = await readJson(req, 16 * 1024);
        } catch (error) {
          reply(res, error.status || 400, { detail: error.message || 'Invalid request body.' });
          return true;
        }
        const result = await createPaymentLink(
          credential.user_id, body, idempotencyKey,
        );
        if (!result?.handled) {
          reply(res, 503, { detail: 'Payment-link service did not handle the request.' });
          return true;
        }
        if (result.status === 200 && result.body?.id) {
          const link = result.body;
          const businessId = String(link.id);
          const operationId = `link:${crypto.createHash('sha256')
            .update(`${credential.user_id}:${idempotencyKey}`, 'utf8').digest('hex')}`;
          const response = { id: businessId, status: 'created', link };
          await db.collection('integration_operations').replace_one(
            { id: operationId },
            {
              id: operationId,
              user_id: String(credential.user_id),
              environment: credential.environment,
              kind: 'link',
              business_id: businessId,
              status: 'created',
              response,
              created_at: link.created_at || new Date(now()).toISOString(),
              updated_at: new Date(now()).toISOString(),
            },
            true,
          );
          reply(res, 200, response);
          return true;
        }
        reply(res, result.status || 502, result.body || { detail: 'Link creation failed.' });
        return true;
      }
      if (cryptoAssetCatalog) {
        const direction = String(url.searchParams.get('direction') || 'deposit').toLowerCase();
        if (!['deposit', 'payout'].includes(direction)) {
          reply(res, 422, { detail: 'Direction must be deposit or payout.' });
          return true;
        }
        if (typeof getCryptoAssets !== 'function') {
          reply(res, 503, { detail: 'Crypto asset catalogue unavailable.' });
          return true;
        }
        const assets = await getCryptoAssets(direction, credential.user_id);
        reply(res, 200, assets);
        return true;
      }
      if (mobileMoneyOperatorCatalog) {
        const direction = String(url.searchParams.get('direction') || 'deposit').toLowerCase();
        if (!['deposit', 'payout'].includes(direction)) {
          reply(res, 422, { detail: 'Direction must be deposit or payout.' });
          return true;
        }
        if (typeof getMobileMoneyOperators !== 'function') {
          reply(res, 503, { detail: 'Mobile Money operator catalogue unavailable.' });
          return true;
        }
        const catalogue = await getMobileMoneyOperators(direction, credential.user_id);
        reply(res, 200, {
          direction,
          enabled: Boolean(catalogue?.enabled),
          availability_source: catalogue?.availability_source
            || 'serving_environment_configuration',
          operators: Array.isArray(catalogue?.operators)
            ? catalogue.operators.map(publicMobileMoneyOperator) : [],
        });
        return true;
      }
      if (exchangeQuote) {
        if (typeof getExchangeQuote !== 'function') {
          reply(res, 503, { detail: 'Exchange quote unavailable.' });
          return true;
        }
        const quote = await getExchangeQuote(
          url.searchParams.get('from_currency'),
          url.searchParams.get('to_currency'),
          url.searchParams.get('amount'),
        );
        reply(res, 200, quote);
        return true;
      }
      const operationFor = (kind, businessId) => db.collection('integration_operations')
        .find_one({
          user_id: credential.user_id,
          environment: credential.environment,
          kind,
          business_id: businessId,
        }, { _id: 0 });
      if (depositMatch || payoutMatch || cryptoDepositMatch || cryptoPayoutMatch) {
        const match = depositMatch || payoutMatch || cryptoDepositMatch || cryptoPayoutMatch;
        const businessId = match[1];
        const kind = depositMatch ? 'deposit' : payoutMatch ? 'payout'
          : cryptoDepositMatch ? 'crypto_deposit' : 'crypto_payout';
        const operation = await operationFor(kind, businessId);
        if (!operation) {
          reply(res, 404, { detail: kind.includes('payout') ? 'Payout not found' : 'Deposit not found' });
          return true;
        }
        let transaction = payoutMatch || cryptoPayoutMatch
          ? await db.collection('transactions').find_one({
            id: businessId, user_id: credential.user_id,
          }, { _id: 0 })
          : null;
        let document = depositMatch
          ? await db.collection('momo_deposits').find_one({
            id: businessId, user_id: credential.user_id,
          }, { _id: 0 })
          : cryptoDepositMatch
            ? await db.collection('crypto_deposits').find_one({
              id: businessId, user_id: credential.user_id,
            }, { _id: 0 })
            : null;
        if (depositMatch && document) {
          document = await refreshIntegrationDeposit(businessId, credential.user_id) || document;
        }
        if ((payoutMatch || cryptoPayoutMatch) && !transaction) {
          reply(res, 404, { detail: kind.includes('crypto') ? 'Crypto payout not found' : 'Payout not found' });
          return true;
        }
        if (payoutMatch && typeof refreshMobileMoneyPayout === 'function') {
          transaction = await refreshMobileMoneyPayout(businessId, credential.user_id)
            || transaction;
        }
        if ((depositMatch || cryptoDepositMatch) && !document) {
          reply(res, 404, { detail: kind === 'crypto_deposit' ? 'Crypto deposit not found' : 'Deposit not found' });
          return true;
        }
        if (depositMatch) {
          const safeDeposit = publicMobileMoneyDeposit(document);
          const response = {
            ...(operation.response || {}),
            id: String(document.id),
            status: String(document.status || operation.status || 'pending'),
            deposit: { ...(operation.response?.deposit || {}), ...safeDeposit },
          };
          await db.collection('integration_operations').update_one(
            {
              id: operation.id,
              user_id: String(credential.user_id),
              environment: credential.environment,
            },
            { $set: {
              status: response.status,
              response,
              updated_at: new Date(now()).toISOString(),
            } },
          );
          reply(res, 200, safeDeposit);
        }
        else if (payoutMatch) {
          const safePayout = publicMobileMoneyPayout(transaction);
          const payoutResponse = mobileMoneyPayoutResponse(transaction);
          await db.collection('integration_operations').update_one(
            {
              id: operation.id,
              user_id: String(credential.user_id),
              environment: credential.environment,
            },
            { $set: {
              status: payoutResponse.status,
              response: payoutResponse,
              updated_at: new Date(now()).toISOString(),
            } },
          );
          reply(res, 200, safePayout);
        }
        else if (cryptoPayoutMatch) reply(res, 200, publicCryptoPayout(transaction));
        else if (cryptoDepositMatch) reply(res, 200, publicCryptoDeposit(document));
        else reply(res, 200, publicMobileMoneyDeposit(document));
        return true;
      }
      if (exchangeMatch) {
        const operation = await operationFor('exchange', exchangeMatch[1]);
        if (!operation) {
          reply(res, 404, { detail: 'Exchange not found' });
          return true;
        }
        reply(res, 200, operation);
        return true;
      }
      if (linkMatch || linkPaymentsMatch) {
        const linkId = (linkMatch || linkPaymentsMatch)[1];
        const operation = await operationFor('link', linkId);
        if (!operation) {
          reply(res, 404, { detail: 'Link not found' });
          return true;
        }
        const link = await db.collection('payment_links').find_one({
          id: linkId,
          user_id: credential.user_id,
        }, { _id: 0 });
        if (!link) {
          reply(res, 404, { detail: 'Link not found' });
          return true;
        }
        if (linkPaymentsMatch) {
          const payments = await db.collection('link_payments').find(
            { link_id: linkId }, { _id: 0 },
          ).sort('created_at', -1).to_list(200);
          reply(res, 200, payments);
          return true;
        }
        reply(res, 200, link);
        return true;
      }
      const query = {
        user_id: credential.user_id,
        environment: credential.environment,
      };
      if (kind) query.kind = kind;
      const operations = await db.collection('integration_operations').find(
        query, { _id: 0 },
      ).sort('created_at', -1).to_list(rawLimit);
      reply(res, 200, operations);
      return true;
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      const detail = error instanceof IntegrationApiError
        ? error.detail
        : error.detail ?? (status === 500 ? 'Integration API request failed.' : error.message);
      const providerCode = /^PAYDUNYA_\d{3,4}$/.test(String(error.code || ''))
        ? String(error.code)
        : null;
      reply(res, status, { detail, ...(providerCode ? { code: providerCode } : {}) });
      return true;
    }
  }
  return { handleRoute };
}

module.exports = { createIntegrationApiRoutes };
