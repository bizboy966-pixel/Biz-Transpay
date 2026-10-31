'use strict';

const PROVIDER_NAME_PATTERNS = [
  [/\bPayDunya\b/gi, 'Biz-transPay'],
  [/\bAfriBaPay\b/gi, 'Biz-transPay'],
  [/\bMbiyo(?:Pay)?\b/gi, 'Biz-transPay'],
  [/\bPay\s*Junior\b/gi, 'Biz-transPay'],
  [/\bBiya\s*Pay\b/gi, 'Biz-transPay'],
  [/\bAfrika\s*Pay\b/gi, 'Biz-transPay'],
];

const DISPLAY_TEXT_FIELDS = new Set([
  'detail', 'message', 'description', 'error', 'otp_label', 'steps',
  'instructions', 'action_label', 'redirect_label',
]);
const PRIVATE_PAYMENT_FIELDS = new Set([
  'provider', 'provider_id', 'provider_name', 'provider_mode', 'payment_provider',
  'provider_config', 'mode', 'gateway_fee', 'platform_fee', 'gateway_fee_pct',
  'platform_fee_pct', 'gateway_fee_fixed', 'platform_fee_fixed',
]);

function publicPaymentText(value) {
  return PROVIDER_NAME_PATTERNS.reduce(
    (text, [pattern, replacement]) => text.replace(pattern, replacement),
    String(value || ''),
  );
}

function publicPaymentFlow(flow) {
  if (Array.isArray(flow)) return flow.map(publicPaymentFlow);
  if (!flow || typeof flow !== 'object') {
    return typeof flow === 'string' ? publicPaymentText(flow) : flow;
  }
  return Object.fromEntries(Object.entries(flow).map(([key, value]) => (
    [key, publicPaymentFlow(value)]
  )));
}

function publicPaymentPayload(value, key = '', insideFlow = false) {
  if (Array.isArray(value)) {
    return value.map(item => publicPaymentPayload(item, key, insideFlow));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([childKey]) => !PRIVATE_PAYMENT_FIELDS.has(childKey))
      .map(([childKey, childValue]) => (
        [childKey, publicPaymentPayload(
          childValue,
          childKey,
          insideFlow || childKey === 'payment_flow',
        )]
      )));
  }
  if (typeof value !== 'string') return value;
  if (key === 'fee_bearer') {
    if (value === 'client') return 'sender';
    if (value === 'merchant') return 'receiver';
  }
  if (key === 'code') {
    const match = /^(?:PAYDUNYA|AFRIBAPAY|MBIYO)_([A-Z0-9_]+)$/i.exec(value);
    if (match) return `BIZTRANSPAY_${match[1]}`;
  }
  return insideFlow || DISPLAY_TEXT_FIELDS.has(key)
    ? publicPaymentText(value) : value;
}

module.exports = {
  publicPaymentText,
  publicPaymentFlow,
  publicPaymentPayload,
};
