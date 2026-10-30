'use strict';

const security = require('./security.cjs');

const DEFAULT_SANDBOX_BASE_URL = 'https://api-sandbox.afribapay.com';

function providerError(status, message, outcomeUnknown = false) {
  const error = new Error(message);
  error.status = status;
  error.outcomeUnknown = outcomeUnknown;
  return error;
}

function decryptCredential(value, key) {
  if (!value) return '';
  try {
    return security.decryptFernet(value, key);
  } catch {
    throw providerError(503, 'AfribaPAY credentials unavailable');
  }
}

function loadAfriBaPayConfig(saved, sessionSecret) {
  if (!saved?.enabled) {
    throw providerError(503, 'AfribaPAY is disabled');
  }
  if (!sessionSecret || !saved.api_user_encrypted || !saved.api_key_encrypted
      || !saved.merchant_key_encrypted || !saved.agent_id_encrypted) {
    throw providerError(503, 'AfribaPAY credentials are incomplete');
  }

  const key = security.fernetKey(sessionSecret);
  const apiUser = decryptCredential(saved.api_user_encrypted, key);
  const apiKey = decryptCredential(saved.api_key_encrypted, key);
  const merchantKey = decryptCredential(saved.merchant_key_encrypted, key);
  const mode = String(saved.mode || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
  const configuredBaseUrl = mode === 'live'
    ? saved.live_api_base_url
    : (saved.sandbox_api_base_url || DEFAULT_SANDBOX_BASE_URL);

  let url;
  try { url = new URL(String(configuredBaseUrl || '')); } catch {
    throw providerError(503, 'AfribaPAY API URL is unavailable');
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password
      || !(hostname === 'afribapay.com' || hostname.endsWith('.afribapay.com'))) {
    throw providerError(503, 'AfribaPAY API URL is invalid');
  }

  return {
    apiUser,
    apiKey,
    merchantKey,
    mode,
    baseUrl: url.toString().replace(/\/+$/, ''),
  };
}

async function readJson(response, { status, outcomeUnknown = false } = {}) {
  let payload;
  try { payload = await response.json(); } catch {
    throw providerError(status || 502, 'AfribaPAY returned an invalid response', outcomeUnknown);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw providerError(status || 502, 'AfribaPAY returned an invalid response', outcomeUnknown);
  }
  return payload;
}

async function submitAfriBaPayin({ config, payload, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') {
    throw providerError(503, 'AfribaPAY service unavailable');
  }
  const basic = Buffer.from(`${config.apiUser}:${config.apiKey}`, 'utf8').toString('base64');
  let tokenResponse;
  try {
    tokenResponse = await fetchImpl(`${config.baseUrl}/v1/token`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw providerError(503, 'AfribaPAY token service unavailable');
  }
  if (!tokenResponse.ok) {
    throw providerError(503, 'AfribaPAY token service rejected the request');
  }
  const tokenPayload = await readJson(tokenResponse, { status: 503 });
  const data = tokenPayload.data && typeof tokenPayload.data === 'object'
    ? tokenPayload.data : tokenPayload;
  const token = String(data.access_token || '').trim();
  if (!token) throw providerError(503, 'AfribaPAY token is missing');

  let payinResponse;
  try {
    payinResponse = await fetchImpl(`${config.baseUrl}/v1/pay/payin`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ ...payload, merchant_key: config.merchantKey }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw providerError(502, 'AfribaPAY payment outcome is unknown', true);
  }
  if (!payinResponse.ok) {
    throw providerError(
      payinResponse.status >= 500 ? 502 : 400,
      'AfribaPAY rejected the payment request',
      payinResponse.status >= 500,
    );
  }
  const responsePayload = await readJson(payinResponse, {
    status: 502,
    outcomeUnknown: true,
  });
  if (responsePayload.success === false) {
    throw providerError(400, 'AfribaPAY rejected the payment request');
  }
  return responsePayload;
}

module.exports = {
  DEFAULT_SANDBOX_BASE_URL,
  loadAfriBaPayConfig,
  submitAfriBaPayin,
};
