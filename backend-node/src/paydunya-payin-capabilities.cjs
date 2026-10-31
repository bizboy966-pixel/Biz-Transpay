'use strict';

const { resolvePaydunyaSoftpayOperator } = require('./paydunya-softpay.cjs');

const PAYDUNYA_PAYIN_MODE_PRIORITY = Object.freeze([
  'softpay_direct', 'psr', 'par_redirect',
]);

function paydunyaModeEnabled(config, mode) {
  const modes = config?.modes && typeof config.modes === 'object'
    && !Array.isArray(config.modes) ? config.modes : {};
  const raw = modes[mode] ?? (mode === 'softpay_direct' ? modes.softpay : undefined);
  if (raw === undefined || raw === null) return mode === 'softpay_direct';
  return raw === true || raw?.enabled === true;
}

function enabledPaydunyaPayinModes(config) {
  return PAYDUNYA_PAYIN_MODE_PRIORITY.filter(mode => (
    paydunyaModeEnabled(config, mode)
    && (mode !== 'softpay_direct' || config?.mode === 'live')
  ));
}

function preferredPaydunyaPayinMode(config) {
  const enabled = enabledPaydunyaPayinModes(config);
  if (enabled.includes('softpay_direct')) return 'softpay_direct';
  const checkoutModes = enabled.filter(mode => mode === 'psr' || mode === 'par_redirect');
  return checkoutModes.length === 1 ? checkoutModes[0] : '';
}

function paydunyaPayinModeForOperator(config, operator, country) {
  const enabled = enabledPaydunyaPayinModes(config);
  const endpointCandidates = [
    operator?.endpoint_slug, operator?.public_code, operator?.code, operator?.operator,
  ].filter(Boolean);
  if (enabled.includes('softpay_direct') && endpointCandidates.some(candidate => (
    resolvePaydunyaSoftpayOperator(candidate, country)
  ))) {
    return 'softpay_direct';
  }
  const checkoutModes = enabled.filter(mode => mode === 'psr' || mode === 'par_redirect');
  return checkoutModes.length === 1 ? checkoutModes[0] : '';
}

function paydunyaPayinReady(config, env = process.env) {
  if (!config?.enabled || !preferredPaydunyaPayinMode(config)) return false;
  return Boolean(
    (config.master_key_encrypted || env.PAYDUNYA_MASTER_KEY)
    && (config.private_key_encrypted || env.PAYDUNYA_PRIVATE_KEY)
    && (config.token_encrypted || env.PAYDUNYA_TOKEN),
  );
}

module.exports = {
  PAYDUNYA_PAYIN_MODE_PRIORITY,
  paydunyaModeEnabled,
  enabledPaydunyaPayinModes,
  preferredPaydunyaPayinMode,
  paydunyaPayinModeForOperator,
  paydunyaPayinReady,
};
