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

async function afriBearerToken(config, fetchImpl) {
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
  return token;
}

function afribapayPaymentFlow({ country, operator }) {
  const countryCode = String(country || '').trim().toUpperCase();
  const operatorCode = String(operator || '').trim().toLowerCase().split(':').at(-1)
    .replace(/[^a-z0-9_-]/g, '');
  if (countryCode === 'BF' && ['wligdicash', 'wligdi-cash'].includes(operatorCode)) {
    return {
      kind: 'otp',
      before_submit: true,
      otp_required: true,
      otp_request_before_submit: true,
      otp_label: 'Code OTP Wigli Dicash',
      steps: [
        'Appuyez sur « Demander le code » : AfriBaPay envoie le code OTP au numéro indiqué.',
        'Saisissez le code reçu, puis validez le paiement.',
      ],
    };
  }
  if (operatorCode === 'wave') {
    return {
      kind: 'redirect',
      before_submit: false,
      steps: [
        'Après le démarrage, vous serez redirigé vers le lien Wave renvoyé par AfriBaPay.',
        'Terminez le paiement sur la page ou dans l’application Wave, puis revenez pour le suivi.',
      ],
    };
  }
  return {
    kind: 'phone_confirmation',
    before_submit: false,
    steps: [
      'La demande est envoyée à l’opérateur sélectionné.',
      'Suivez les instructions de paiement affichées sur votre téléphone et revenez ici pour le suivi.',
    ],
  };
}

async function requestAfriBaPayOtp({ config, payload, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') {
    throw providerError(503, 'AfribaPAY service unavailable');
  }
  const country = String(payload?.country || '').trim().toUpperCase();
  const operator = String(payload?.operator || '').trim().toLowerCase().split(':').at(-1);
  if (country !== 'BF' || !['wligdicash', 'wligdi-cash'].includes(operator)) {
    throw providerError(422, 'OTP request is not documented for this operator');
  }
  const token = await afriBearerToken(config, fetchImpl);
  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}/v1/pay/otp`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        operator: String(payload.operator || '').trim().toLowerCase().split(':').at(-1),
        country,
        phone_number: payload.phone_number,
        amount: payload.amount,
        currency: payload.currency,
        merchant_key: config.merchantKey,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw providerError(502, 'The OTP request outcome is unknown', true);
  }
  if (!response.ok) {
    throw providerError(response.status >= 500 ? 502 : 400, 'AfribaPAY rejected the OTP request', response.status >= 500);
  }
  const result = await readJson(response, { status: 502, outcomeUnknown: true });
  const data = result.data && typeof result.data === 'object' ? result.data : result;
  if (String(data.status || '').toUpperCase() !== 'SUCCESS' || Number(data.code) !== 200) {
    throw providerError(400, 'AfribaPAY did not confirm that the OTP was sent');
  }
  return { sent: true };
}

async function submitAfriBaPayin({ config, payload, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') {
    throw providerError(503, 'AfribaPAY service unavailable');
  }
  const token = await afriBearerToken(config, fetchImpl);

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
  requestAfriBaPayOtp,
  afribapayPaymentFlow,
};
