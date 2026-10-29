'use strict';

const DEFAULT_APP_FEATURES = {
  id: 'app_features',
  mobile_money_enabled: true,
  crypto_enabled: true,
  mobile_money_coming_soon_message: 'Bientôt disponible — cette fonctionnalité est en cours de finalisation.',
  crypto_coming_soon_message: 'Bientôt disponible — cette fonctionnalité est en cours de finalisation.',
  wallet_xof_enabled: true,
  wallet_xaf_enabled: true,
  wallet_crypto_enabled: true,
  deposit_xof_enabled: true,
  deposit_xaf_enabled: true,
  deposit_crypto_enabled: true,
  withdrawal_xof_enabled: true,
  withdrawal_xaf_enabled: true,
  withdrawal_crypto_enabled: true,
  links_enabled: true,
  payment_api_enabled: true,
};

const FEATURE_BOOLEAN_KEYS = [
  'mobile_money_enabled', 'crypto_enabled',
  'wallet_xof_enabled', 'wallet_xaf_enabled', 'wallet_crypto_enabled',
  'deposit_xof_enabled', 'deposit_xaf_enabled', 'deposit_crypto_enabled',
  'withdrawal_xof_enabled', 'withdrawal_xaf_enabled', 'withdrawal_crypto_enabled',
  'links_enabled', 'payment_api_enabled',
];

const DEFAULT_PLATFORM_CONFIG = {
  id: 'platform_config',
  conversion_fee: {
    enabled: true, type: 'percent', value: 0.5, min_fee: 0, max_fee: null,
  },
  conversion_rates: {
    USDT_XOF: 600, USDT_XAF: 600, XOF_USDT: 0.00165, XAF_USDT: 0.00165,
    XOF_XAF: 1, XAF_XOF: 1,
  },
  crypto_usdt_rates: { USDT: 1 },
  crypto_usdt_rates_updated_at: null,
  conversion_limits: {
    USDT_XOF: { min: 1, max: 5000 },
    USDT_XAF: { min: 1, max: 5000 },
    XOF_USDT: { min: 500, max: 3000000 },
    XAF_USDT: { min: 500, max: 3000000 },
    XOF_XAF: { min: 500, max: 5000000 },
    XAF_XOF: { min: 500, max: 5000000 },
  },
  conversion_pairs_enabled: {
    USDT_XOF: true, USDT_XAF: true, XOF_USDT: true, XAF_USDT: true,
    XOF_XAF: true, XAF_XOF: true,
  },
  auto_withdrawals_disabled: false,
};

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function getAppFeatures(db) {
  const settings = db.collection('settings');
  let features = await settings.find_one({ id: 'app_features' }, { _id: 0 });
  if (!features) {
    await settings.update_one(
      { id: 'app_features' },
      { $setOnInsert: DEFAULT_APP_FEATURES },
      true
    );
    features = await settings.find_one({ id: 'app_features' }, { _id: 0 });
  }
  return features || structuredClone(DEFAULT_APP_FEATURES);
}

async function getPlatformConfig(db) {
  const settings = db.collection('settings');
  let config = await settings.find_one({ id: 'platform_config' }, { _id: 0 });
  if (!config) {
    await settings.update_one(
      { id: 'platform_config' },
      { $setOnInsert: DEFAULT_PLATFORM_CONFIG },
      true
    );
    config = await settings.find_one({ id: 'platform_config' }, { _id: 0 });
  }
  config = config || structuredClone(DEFAULT_PLATFORM_CONFIG);
  for (const [key, value] of Object.entries(DEFAULT_PLATFORM_CONFIG)) {
    if (config[key] === undefined) config[key] = structuredClone(value);
  }
  for (const key of [
    'conversion_rates', 'conversion_limits', 'conversion_pairs_enabled', 'crypto_usdt_rates',
  ]) {
    if (!config[key] || typeof config[key] !== 'object' || Array.isArray(config[key])) {
      config[key] = {};
    }
    for (const [nestedKey, value] of Object.entries(DEFAULT_PLATFORM_CONFIG[key])) {
      if (config[key][nestedKey] === undefined) {
        config[key][nestedKey] = structuredClone(value);
      }
    }
  }
  return config;
}

function publicFeatures(features) {
  const output = {};
  for (const key of FEATURE_BOOLEAN_KEYS) {
    output[key] = Boolean(
      features[key] === undefined ? DEFAULT_APP_FEATURES[key] : features[key]
    );
  }
  output.mobile_money_coming_soon_message =
    features.mobile_money_coming_soon_message || '';
  output.crypto_coming_soon_message = features.crypto_coming_soon_message || '';
  return output;
}

function createPublicConfigRoutes({ db, env = process.env }) {
  async function handleRoute(req, res) {
    if (req.method !== 'GET') return false;
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    if (path === '/api/security/turnstile-config') {
      const siteKey = String(env.CLOUDFLARE_TURNSTILE_SITE_KEY || '').trim();
      const secret = String(env.CLOUDFLARE_TURNSTILE_SECRET_KEY || '').trim();
      reply(res, 200, {
        enabled: Boolean(secret && siteKey),
        site_key: siteKey || null,
      });
      return true;
    }
    if (path === '/api/settings/features') {
      const features = await getAppFeatures(db);
      reply(res, 200, publicFeatures(features));
      return true;
    }
    if (path === '/api/conversion/config') {
      const config = await getPlatformConfig(db);
      reply(res, 200, {
        rates: config.conversion_rates || {},
        limits: config.conversion_limits || {},
        pairs_enabled: config.conversion_pairs_enabled || {},
        fee: config.conversion_fee || {},
      });
      return true;
    }
    if (path === '/api/exchange/rate') {
      const config = await getPlatformConfig(db);
      const from = url.searchParams.get('from_currency') || 'XOF';
      const to = url.searchParams.get('to_currency') || 'XAF';
      const key = `${from.toUpperCase()}_${to.toUpperCase()}`;
      const fee = config.conversion_fee || {};
      const feeType = fee.type === undefined ? 'percent' : fee.type;
      const feeValue = fee.value === undefined ? 0.5 : fee.value;
      reply(res, 200, {
        from,
        to,
        rate: Number(config.conversion_rates?.[key] ?? 1),
        fee_enabled: fee.enabled === undefined ? true : Boolean(fee.enabled),
        fee_type: feeType,
        fee_value: feeValue,
        fee_min: fee.min_fee === undefined ? 0 : fee.min_fee,
        fee_max: fee.max_fee ?? null,
        fee_pct: feeType === 'percent'
          ? Number(feeValue) / 100
          : 0,
      });
      return true;
    }
    return false;
  }
  return { handleRoute };
}

module.exports = {
  createPublicConfigRoutes,
  getAppFeatures,
  getPlatformConfig,
  publicFeatures,
};
