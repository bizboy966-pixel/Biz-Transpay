'use strict';

const crypto = require('node:crypto');

const BASE_URL = 'https://dashboard.mbiyo.africa/api/v1';
const CONTAINERS = [
  'data', 'result', 'payload', 'event', 'transaction', 'transaction_data', 'payment',
];
const SUCCESS_STATUSES = new Set([
  'completed', 'complete', 'success', 'successful', 'sent', 'paid', 'succeeded',
  'approved', 'confirmed', 'validated', 'settled', 'successfully_completed',
  'processed', 'paid_successfully', 'payment_successful',
]);
const FAILURE_STATUSES = new Set([
  'failed', 'failure', 'cancelled', 'canceled', 'rejected', 'declined', 'error', 'refunded',
]);
const CALLING_CODES = Object.freeze({
  BF: '226', BJ: '229', CI: '225', CM: '237', CG: '242', ML: '223', SN: '221',
  TG: '228', CD: '243', GM: '220', GN: '224', UG: '256', TZ: '255', KE: '254',
  RW: '250', GH: '233', NG: '234', ZA: '27', ZM: '260', EG: '20',
});
const ROUND_TO_FIVE = new Set(['BF', 'BJ', 'CI', 'CM', 'GN', 'ML', 'TG']);

function statusValue(payload) {
  const seen = new Set();
  const ordered = [];
  const collect = item => {
    if (!item || typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    for (const key of [...CONTAINERS, 'metadata']) {
      const value = item[key];
      if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') collect(value);
    }
    ordered.push(item);
  };
  collect(payload);
  for (const item of ordered) {
    for (const key of [
      'status', 'state', 'payment_status', 'payment_state',
      'transaction_status', 'transaction_state', 'status_code',
    ]) {
      const value = item[key];
      if (value !== undefined && value !== null && value !== ''
          && !['object', 'function'].includes(typeof value)) {
        return String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
      }
    }
  }
  return '';
}

function transactionId(payload, allowShortFields = false) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
  for (const key of [
    'transaction_id', 'transactionId', 'provider_transaction_id', 'providerTransactionId',
  ]) {
    if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') {
      return String(payload[key]).trim().slice(0, 160);
    }
  }
  if (allowShortFields) {
    for (const key of ['id', 'reference']) {
      if (payload[key] !== undefined && payload[key] !== null && payload[key] !== '') {
        return String(payload[key]).trim().slice(0, 160);
      }
    }
  }
  for (const key of CONTAINERS) {
    const value = payload[key];
    const values = Array.isArray(value) ? value : [value];
    for (const nested of values) {
      const found = transactionId(nested, true);
      if (found) return found;
    }
  }
  return '';
}

function scalarValue(payload, keys) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  for (const key of keys) {
    const value = payload[key];
    if (value !== undefined && value !== null && value !== ''
        && typeof value !== 'object') return value;
  }
  const queue = [payload.metadata, ...CONTAINERS.map(key => payload[key])];
  for (const value of queue) {
    const values = Array.isArray(value) ? value : [value];
    for (const nested of values) {
      const found = scalarValue(nested, keys);
      if (found !== null) return found;
    }
  }
  return null;
}

function normalizeAmount(country, amount) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return NaN;
  return ROUND_TO_FIVE.has(String(country || '').toUpperCase())
    ? Math.round(value / 5) * 5 : value;
}

function normalizePhoneNumber(country, phoneNumber) {
  const code = String(country || '').toUpperCase();
  const callingCode = CALLING_CODES[code];
  const raw = String(phoneNumber || '').trim();
  if (!callingCode || !/^[\d\s().+-]+$/.test(raw)) {
    throw new Error('Numéro Mobile Money invalide.');
  }
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  const suppliedInternational = raw.startsWith('+') || raw.trim().startsWith('00')
    || digits.startsWith(callingCode);
  if (suppliedInternational) {
    if (!digits.startsWith(callingCode)) {
      throw new Error(`Le numéro ne correspond pas au pays sélectionné (${code}).`);
    }
    digits = digits.slice(callingCode.length);
  }
  const exactLength = code === 'CI' ? 10 : code === 'ML' ? 8 : null;
  if (!/^\d{6,13}$/.test(digits) || (exactLength && digits.length !== exactLength)) {
    throw new Error(`Le numéro Mobile Money ${code} est invalide.`);
  }
  return `+${callingCode}${digits}`;
}

function sameMobileNumber(received, expected) {
  const digits = value => String(value || '').replace(/\D/g, '').replace(/^00/, '');
  const left = digits(received);
  const right = digits(expected);
  if (!left || !right) return false;
  if (left === right) return true;
  const [shorter, longer] = [left, right].sort((a, b) => a.length - b.length);
  return shorter.length >= 7 && longer.endsWith(shorter);
}

function paymentFlow(operator, amount) {
  const country = String(operator?.country || '').toUpperCase();
  const network = String(operator?.network || '').toLowerCase();
  const ussdTemplate = {
    'BF:orange': '*144*4*6*MONTANT#',
    'CI:orange': '#144*82#',
    'ML:orange': '#144#77#',
    'SN:orange': '#144#391#',
    'GN:orange': '#144#',
  }[`${country}:${network}`];
  if (ussdTemplate) {
    const ussdCode = country === 'BF' && network === 'orange' && amount
      ? `*144*4*6*${Math.round(Number(amount))}#` : ussdTemplate;
    const beforeSubmit = true;
    return {
      kind: 'ussd',
      before_submit: beforeSubmit,
      otp_required: false,
      ussd_code: ussdCode,
      ussd_template: ussdTemplate,
      steps: [
        country === 'GN'
          ? `Composez ${ussdCode}, choisissez l’option 4 puis l’option 2 avant de lancer le paiement.`
          : `Composez ${ussdCode} sur votre téléphone avant de lancer le paiement.`,
        country === 'GN'
          ? 'Suivez le menu pour générer la demande.'
          : 'Suivez le menu de votre opérateur pour autoriser la demande.',
        'Revenez ici : la confirmation sera vérifiée automatiquement.',
      ],
      action_label: beforeSubmit
        ? 'J’ai autorisé la demande, lancer le paiement' : 'Confirmer le paiement',
    };
  }
  if (country === 'GM' && ['qmoney', 'aps'].includes(network)) {
    return {
      kind: 'otp',
      before_submit: false,
      otp_required: true,
      otp_label: 'PIN de validation reçu après le lancement',
      steps: ['Lancez le paiement.', 'Saisissez le PIN demandé pour finaliser.'],
      action_label: 'Finaliser le paiement',
    };
  }
  return {
    kind: 'phone_confirmation',
    before_submit: false,
    otp_required: false,
    steps: [
      'Lancez le paiement.',
      country === 'CI' && network === 'mtn'
        ? 'Si une notification Mobile Money apparaît sur votre téléphone, confirmez-la.'
        : 'Validez la notification reçue sur votre téléphone.',
    ],
    action_label: 'Valider sur mon téléphone',
  };
}

function verifySignature(rawBody, signature, secret) {
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0 || !signature || !secret) return false;
  const expected = crypto.createHmac('sha256', String(secret)).update(rawBody).digest();
  const suppliedValue = String(signature).trim().toLowerCase().replace(/^sha256=/, '');
  if (!/^[a-f0-9]{64}$/.test(suppliedValue)) return false;
  const supplied = Buffer.from(suppliedValue, 'hex');
  return supplied.length === expected.length && crypto.timingSafeEqual(expected, supplied);
}

function safeRedirectUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password
      ? url.toString() : '';
  } catch {
    return '';
  }
}

function cleanInstructions(value) {
  const items = Array.isArray(value) ? value : [value];
  return items
    .filter(item => typeof item === 'string' || typeof item === 'number')
    .map(item => String(item).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 500))
    .filter(Boolean)
    .slice(0, 8);
}

function mbiyoResponseFields(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const id = transactionId(payload);
  return {
    ...(data.auth_mode ? { auth_mode: String(data.auth_mode).slice(0, 32) } : {}),
    ...(safeRedirectUrl(data.redirect_url) ? { redirect_url: safeRedirectUrl(data.redirect_url) } : {}),
    instructions: cleanInstructions(data.instructions),
    ...(id ? { provider_reference: id } : {}),
    provider_response: { transaction_id: id || null, status: statusValue(payload) || null },
  };
}

async function requestMbiyo({ apiKey, baseUrl = BASE_URL, fetchImpl = globalThis.fetch,
  method = 'GET', path, body } = {}) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw Object.assign(new Error('Mbiyo n’est pas configuré.'), { status: 503 });
  }
  let base;
  try {
    base = new URL(String(baseUrl || BASE_URL));
  } catch {
    throw Object.assign(new Error('URL Mbiyo invalide.'), { status: 503 });
  }
  if (base.protocol !== 'https:' || !base.hostname || base.username || base.password) {
    throw Object.assign(new Error('URL Mbiyo HTTPS invalide.'), { status: 503 });
  }
  const endpoint = `${base.toString().replace(/\/+$/, '')}/${String(path || '').replace(/^\/+/, '')}`;
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw Object.assign(new Error('Mbiyo ne répond pas; le statut sera vérifié sans relancer le dépôt.'), {
      status: 502, outcomeUnknown: true,
    });
  }
  let payload;
  try { payload = await response.json(); } catch { payload = null; }
  if (!response.ok) {
    throw Object.assign(new Error('Mbiyo a refusé ou ne peut pas traiter la demande.'), {
      status: response.status >= 500 ? 502 : 400,
      providerStatusCode: response.status,
      outcomeUnknown: response.status >= 500,
    });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw Object.assign(new Error('Réponse Mbiyo invalide; le statut sera vérifié.'), {
      status: 502, outcomeUnknown: true,
    });
  }
  return payload;
}

module.exports = {
  BASE_URL,
  SUCCESS_STATUSES,
  FAILURE_STATUSES,
  statusValue,
  transactionId,
  scalarValue,
  normalizeAmount,
  normalizePhoneNumber,
  sameMobileNumber,
  paymentFlow,
  verifySignature,
  safeRedirectUrl,
  cleanInstructions,
  mbiyoResponseFields,
  requestMbiyo,
};
