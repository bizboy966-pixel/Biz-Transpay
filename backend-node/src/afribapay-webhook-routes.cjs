'use strict';

const crypto = require('node:crypto');
const Decimal = require('decimal.js');
const security = require('./security.cjs');
const { applyWalletOperation } = require('./wallet.cjs');
const { MOBILE_MONEY_COUNTRY_CURRENCY } = require('./supported-currencies.cjs');

const MAX_BODY_BYTES = 256 * 1024;
const SANDBOX_API_BASE_URL = 'https://api-sandbox.afribapay.com';
const COUNTRY_CURRENCIES = Object.fromEntries(
  Object.entries(MOBILE_MONEY_COUNTRY_CURRENCY).map(([country, currency]) => [country, [currency]]),
);

function reply(res, status, body) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function first(object, names) {
  for (const name of names) {
    const value = object && typeof object === 'object' ? object[name] : null;
    if (value !== null && value !== undefined && value !== '') return value;
  }
  return null;
}

function providerValue(payload, names) {
  return first(payload?.data, names) ?? first(payload, names);
}

async function readRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Webhook body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function safeEqualHex(expected, actual) {
  if (!/^[a-f0-9]{64}$/i.test(actual || '')) return false;
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  return expectedBuffer.length === actualBuffer.length
    && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function decryptProviderValue(value, key) {
  if (!value) return '';
  return security.decryptFernet(value, key);
}

function providerConfig(saved, env) {
  try {
    const key = security.fernetKey(env.SESSION_SECRET);
    const apiUser = decryptProviderValue(saved?.api_user_encrypted, key);
    const apiKey = decryptProviderValue(saved?.api_key_encrypted, key);
    const mode = String(saved?.mode || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
    const configuredUrl = mode === 'live'
      ? saved?.live_api_base_url
      : (saved?.sandbox_api_base_url || SANDBOX_API_BASE_URL);
    if (!apiUser || !apiKey || !configuredUrl) throw new Error('Missing provider configuration');
    const url = new URL(configuredUrl);
    if (url.protocol !== 'https:' || url.username || url.password
        || !(url.hostname === 'afribapay.com' || url.hostname.endsWith('.afribapay.com'))) {
      throw new Error('Invalid provider host');
    }
    return { apiUser, apiKey, mode, baseUrl: url.toString().replace(/\/+$/, '') };
  } catch {
    const error = new Error('AfribaPAY configuration unavailable');
    error.status = 503;
    throw error;
  }
}

function tokenExpiration(payload, token, now = Date.now()) {
  const expiresAt = Date.parse(String(providerValue(payload, ['expires_at']) || ''));
  if (Number.isFinite(expiresAt)) return expiresAt;
  const expiresIn = Number(providerValue(payload, ['expires_in']));
  if (Number.isFinite(expiresIn) && expiresIn > 0) return now + (expiresIn * 1000);
  try {
    const claims = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    if (Number.isFinite(Number(claims.exp))) return Number(claims.exp) * 1000;
  } catch {
    // Opaque tokens without expiry metadata are used only for the current request.
  }
  return null;
}

async function providerStatus(config, orderId, fetchImpl, tokenCache = null, transactionId = '') {
  const cacheKey = `${config.baseUrl}:${config.apiUser}:${
    crypto.createHash('sha256').update(config.apiKey).digest('hex')}`;
  const now = Date.now();
  let token = tokenCache?.get(cacheKey)?.expiresAt > now + 60_000
    ? tokenCache.get(cacheKey).token : '';
  if (!token) {
    const basic = Buffer.from(`${config.apiUser}:${config.apiKey}`, 'utf8').toString('base64');
    let tokenResponse;
    try {
      tokenResponse = await fetchImpl(new URL('/v1/token', config.baseUrl), {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      const error = new Error('AfribaPAY token service unavailable');
      error.status = 503;
      throw error;
    }
    if (!tokenResponse.ok) {
      const error = new Error('AfribaPAY token service rejected the request');
      error.status = 503;
      throw error;
    }
    let tokenPayload;
    try { tokenPayload = await tokenResponse.json(); } catch {
      const error = new Error('AfribaPAY token response invalid');
      error.status = 503;
      throw error;
    }
    token = String(providerValue(tokenPayload, ['access_token']) || '');
    if (!token) {
      const error = new Error('AfribaPAY token missing');
      error.status = 503;
      throw error;
    }
    const expiresAt = tokenExpiration(tokenPayload, token);
    if (tokenCache && expiresAt) tokenCache.set(cacheKey, { token, expiresAt });
  }

  const statusUrl = new URL('/v1/status', config.baseUrl);
  const transactionIdentifier = String(transactionId || '').trim();
  statusUrl.searchParams.set(
    transactionIdentifier ? 'transaction_id' : 'order_id',
    transactionIdentifier || orderId,
  );
  let statusResponse;
  try {
    statusResponse = await fetchImpl(statusUrl, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    const error = new Error('AfribaPAY status service unavailable');
    error.status = 503;
    throw error;
  }
  if (!statusResponse.ok) {
    const error = new Error('AfribaPAY status service rejected the request');
    error.status = 503;
    error.providerStatusCode = statusResponse.status;
    throw error;
  }
  try {
    const payload = await statusResponse.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error();
    return payload;
  } catch {
    const error = new Error('AfribaPAY status response invalid');
    error.status = 503;
    throw error;
  }
}

function amount(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    const parsed = new Decimal(String(value));
    return parsed.isFinite() ? parsed : null;
  } catch {
    return null;
  }
}

function eventOrderId(payload, url) {
  const data = payload?.data;
  return String(
    first(data, ['order_id', 'orderId', 'merchant_order_id', 'reference'])
      || first(payload, ['order_id', 'orderId', 'merchant_order_id', 'reference'])
      || url.searchParams.get('order_id')
      || url.searchParams.get('reference')
      || url.searchParams.get('ref')
      || '',
  ).trim();
}

function createAfriBaPayWebhookRoutes({ db, env = process.env, fetchImpl = globalThis.fetch }) {
  const tokenCache = new Map();
  async function handleRoute(req, res) {
    if (req.method !== 'POST') return false;
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch { return false; }
    if (url.pathname !== '/api/webhooks/afribapay') return false;

    try {
      const raw = await readRawBody(req);
      const signature = String(req.headers?.afribapay_sign || '').trim();
      const saved = await db.collection('settings').find_one(
        { id: 'payment_provider_afribapay' }, { _id: 0 },
      );
      const config = providerConfig(saved, env);
      const expected = crypto.createHmac('sha256', config.apiKey).update(raw).digest('hex');
      if (!safeEqualHex(expected, signature)) {
        reply(res, 403, { detail: 'Signature invalide.' });
        return true;
      }

      let payload;
      try { payload = JSON.parse(raw.toString('utf8')); } catch {
        reply(res, 400, { detail: 'Notification AfribaPAY invalide.' });
        return true;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        reply(res, 400, { detail: 'Notification AfribaPAY invalide.' });
        return true;
      }
      const orderId = eventOrderId(payload, url);
      if (!orderId) {
        reply(res, 200, { received: true });
        return true;
      }

      const deposits = db.collection('momo_deposits');
      let deposit = await deposits.find_one({ id: orderId }, { _id: 0 });
      if (!deposit) {
        deposit = await deposits.find_one({ afribapay_order_id: orderId }, { _id: 0 });
      }
      if (!deposit
          || (String(deposit.provider || '').toLowerCase() !== 'afribapay'
            && !deposit.afribapay_order_id && !deposit.afribapay_id)) {
        reply(res, 200, { received: true });
        return true;
      }
      if (['approved', 'failed', 'expired'].includes(String(deposit.status || '').toLowerCase())) {
        reply(res, 200, { received: true });
        return true;
      }
      if (String(deposit.status || '').toLowerCase() !== 'pending') {
        reply(res, 200, { received: true });
        return true;
      }

      const expectedOrderId = String(
        deposit.afribapay_order_id || deposit.order_id || deposit.id || '',
      ).trim();
      const statusPayload = await providerStatus(
        config,
        expectedOrderId,
        fetchImpl,
        tokenCache,
        deposit.afribapay_transaction_id || deposit.provider_transaction_id,
      );
      const providerStatusValue = String(providerValue(statusPayload, [
        'status', 'payment_status', 'transaction_status',
      ]) || '').trim().toLowerCase();
      const verifiedOrderId = String(providerValue(statusPayload, [
        'order_id', 'orderId', 'merchant_order_id',
      ]) || '').trim();
      const verifiedAt = new Date().toISOString();
      const providerTransactionId = String(providerValue(statusPayload, [
        'transaction_id', 'transactionId', 'payment_id', 'paymentId',
      ]) || '').trim();

      const updatePending = async values => deposits.update_one(
        { id: String(deposit.id), status: 'pending' },
        {
          $set: { ...values, updated_at: verifiedAt },
          $unset: {
            afribapay_last_reconcile_error: '',
            afribapay_reconcile_paused: '',
          },
        },
      );
      const quarantine = async reason => {
        await updatePending({
          status: 'quarantined',
          settlement_error: reason,
          reconciliation_mismatch: reason,
          provider_status: providerStatusValue || null,
          afribapay_verified_at: verifiedAt,
        });
        reply(res, 200, { received: true });
      };

      if (verifiedOrderId && verifiedOrderId !== expectedOrderId) {
        await quarantine('order_id_mismatch');
        return true;
      }
      if (!['success', 'successful', 'completed', 'paid', 'failed', 'failure', 'rejected']
        .includes(providerStatusValue)) {
        await updatePending({
          provider_status: providerStatusValue || 'pending',
          afribapay_verified_at: verifiedAt,
        });
        reply(res, 200, { received: true });
        return true;
      }

      const providerGross = amount(providerValue(statusPayload, [
        'original_amount', 'amount_total', 'gross_amount', 'requested_amount',
      ]));
      const expectedGross = amount(
        deposit.provider_submitted_amount ?? deposit.requested_amount
          ?? deposit.amount_gross ?? deposit.amount,
      );
      const providerCurrency = String(providerValue(statusPayload, [
        'currency', 'currency_code', 'currencyCode',
      ]) || '').trim().toUpperCase();
      const expectedCurrency = String(
        deposit.currency || deposit.wallet_currency || deposit.currency_code || '',
      ).trim().toUpperCase();
      if (!verifiedOrderId || !providerGross || !expectedGross
          || !providerGross.equals(expectedGross)) {
        await quarantine('amount_mismatch');
        return true;
      }
      if (!providerCurrency || providerCurrency !== expectedCurrency) {
        await quarantine('currency_mismatch');
        return true;
      }
      const providerCountry = String(providerValue(statusPayload, [
        'country_code', 'countryCode', 'country',
      ]) || '').trim().toUpperCase();
      const depositCountry = String(deposit.country_code || deposit.country || '').trim().toUpperCase();
      if (providerCountry && depositCountry && providerCountry !== depositCountry) {
        await quarantine('country_mismatch');
        return true;
      }

      if (['failed', 'failure', 'rejected'].includes(providerStatusValue)) {
        await updatePending({
          status: 'failed',
          provider_status: providerStatusValue,
          provider_transaction_id: providerTransactionId || null,
          afribapay_transaction_id: providerTransactionId || null,
          afribapay_verified_at: verifiedAt,
        });
        reply(res, 200, { received: true });
        return true;
      }

      const currency = expectedCurrency;
      const country = depositCountry;
      if (!COUNTRY_CURRENCIES[country]?.includes(currency)) {
        await quarantine('unsupported_country_currency');
        return true;
      }
      const fee = amount(deposit.fee ?? deposit.total_fee ?? 0);
      const netValue = deposit.wallet_credit_amount ?? deposit.amount_net;
      const net = netValue === null || netValue === undefined
        ? (fee ? expectedGross.minus(fee) : expectedGross)
        : amount(netValue);
      const gatewayFee = amount(deposit.gateway_fee ?? 0);
      const platformFee = amount(deposit.platform_fee ?? 0);
      if (!fee || fee.isNegative() || !net || !net.isFinite() || !net.isPositive()
          || net.greaterThan(expectedGross) || !gatewayFee || gatewayFee.isNegative()
          || !platformFee || platformFee.isNegative()) {
        await quarantine('invalid_settlement_amount');
        return true;
      }
      const userId = String(deposit.user_id || '').trim();
      const depositId = String(deposit.id || '').trim();
      if (!userId || !depositId) {
        await quarantine('deposit_identity_missing');
        return true;
      }

      const operationId = `afribapay:deposit:${depositId}`;
      const walletField = `balance_${currency.toLowerCase()}`;
      const ledgerId = `afribapay-deposit-${depositId}`;
      const reference = `BTP-PD-${depositId.slice(0, 16)}`;
      const metadata = {
        operation_id: operationId,
        wallet_operation_id: operationId,
        provider: 'afribapay',
        provider_reference: providerTransactionId
          || deposit.afribapay_transaction_id || deposit.afribapay_payment_id || null,
        operator: deposit.operator || null,
        operator_name: deposit.operator_name || null,
        country,
        country_code: country,
        phone_number: deposit.phone_number || null,
        customer_name: deposit.full_name || null,
        customer_email: deposit.email || null,
        amount_gross: expectedGross.toNumber(),
        fee: fee.toNumber(),
        gateway_fee: gatewayFee.toNumber(),
        platform_fee: platformFee.toNumber(),
        amount_net: net.toNumber(),
        method: 'mobile_money',
      };
      const mutation = await applyWalletOperation(db, {
        userId,
        operationId,
        direction: 'credit',
        primaryField: walletField,
        increments: { [walletField]: net.toNumber() },
        aliases: providerTransactionId ? [`afribapay:payment:${providerTransactionId}`] : [],
        legacyMarkers: [['credited_deposit_ids', depositId]],
        ledger: {
          id: ledgerId,
          user_id: userId,
          type: 'deposit',
          direction: 'in',
          amount: net.toNumber(),
          currency,
          status: 'completed',
          reference,
          description: `Dépôt Mobile Money (${deposit.operator || 'AfribaPAY'})`,
          created_at: deposit.created_at || verifiedAt,
          completed_at: verifiedAt,
          metadata,
        },
      });
      if (mutation.state === 'duplicate_event') {
        await quarantine('provider_payment_identity_reused');
        return true;
      }
      if (!['applied', 'already'].includes(mutation.state)) {
        const error = new Error('Wallet settlement unavailable');
        error.status = 503;
        throw error;
      }
      await deposits.update_one(
        { id: depositId, status: 'pending' },
        { $set: {
          status: 'approved',
          approved_at: verifiedAt,
          updated_at: verifiedAt,
          provider_status: providerStatusValue,
          provider_transaction_id: providerTransactionId || null,
          afribapay_transaction_id: providerTransactionId || null,
          afribapay_verified_at: verifiedAt,
          amount_gross: expectedGross.toNumber(),
          fee: fee.toNumber(),
          gateway_fee: gatewayFee.toNumber(),
          platform_fee: platformFee.toNumber(),
          amount_net: net.toNumber(),
        }, $unset: {
          reconciliation_mismatch: '',
          settlement_error: '',
          afribapay_last_reconcile_error: '',
          afribapay_reconcile_paused: '',
        } },
      );
      reply(res, 200, { received: true });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 503;
      if (Number.isInteger(error.providerStatusCode)) {
        res.providerStatusCode = error.providerStatusCode;
      }
      reply(res, status, {
        detail: status === 403 ? 'Signature invalide.'
          : status === 400 ? 'Notification AfribaPAY invalide.'
            : status === 413 ? 'Notification AfribaPAY trop volumineuse.'
              : 'La notification AfribaPAY n’a pas pu être vérifiée.',
      });
    }
    return true;
  }

  async function reconcileOrder(orderId) {
    const value = String(orderId || '').trim();
    if (!value || value.length > 200) {
      const error = new Error('Invalid AfriBaPay order identifier');
      error.status = 400;
      throw error;
    }
    const saved = await db.collection('settings').find_one(
      { id: 'payment_provider_afribapay' }, { _id: 0 },
    );
    const config = providerConfig(saved, env);
    const rawBody = Buffer.from(JSON.stringify({ order_id: value }), 'utf8');
    const signature = crypto.createHmac('sha256', config.apiKey).update(rawBody).digest('hex');
    const request = {
      method: 'POST',
      url: `/api/webhooks/afribapay?ref=${encodeURIComponent(value)}`,
      headers: { afribapay_sign: signature },
      rawBody,
    };
    const response = {
      writeHead(statusCode) { this.statusCode = statusCode; },
      end(body) { this.body = body; },
    };
    await handleRoute(request, response);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const error = new Error('AfriBaPay deposit reconciliation failed');
      error.status = response.statusCode || 503;
      if (Number.isInteger(response.providerStatusCode)) {
        error.providerStatusCode = response.providerStatusCode;
      }
      throw error;
    }
    return response.body ? JSON.parse(response.body) : { received: true };
  }

  return { handleRoute, reconcileOrder };
}

module.exports = {
  createAfriBaPayWebhookRoutes, providerConfig, providerStatus, safeEqualHex,
};
