'use strict';

const { sessionToken } = require('./auth-session-routes.cjs');
const CRYPTO_FEE_ASSETS = [
  ['USDC.POLYGON', 'USDC', 'POLYGON'], ['USDC.SOL', 'USDC', 'SOL'],
  ['USDC.BEP20', 'USDC', 'BEP20'], ['USDC.ERC20', 'USDC', 'ERC20'],
  ['USDT.POLYGON', 'USDT', 'POLYGON'], ['USDT.BEP20', 'USDT', 'BEP20'],
  ['USDT.SOL', 'USDT', 'SOL'], ['USDT.TRC20', 'USDT', 'TRC20'],
  ['USDT.TON', 'USDT', 'TON'], ['USDT.ERC20', 'USDT', 'ERC20'],
  ['BNB.BNB', 'BNB', 'BNB'], ['BTC.BTC', 'BTC', 'BTC'],
  ['SOL.SOL', 'SOL', 'SOL'], ['TON.TON', 'TON', 'TON'],
  ['TRX.TRX', 'TRX', 'TRX'], ['ETH.ETH', 'ETH', 'ETH'],
].map(([id, coin, network]) => ({ id, coin, network }));

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

const FEDAPAY_OPERATOR_CATALOG = {
  BJ: [
    { code: 'mtn_bj', label: 'MTN Bénin', mode: 'mtn_open', kind: 'both' },
    { code: 'moov_bj', label: 'Moov Bénin', mode: 'moov', kind: 'both' },
    { code: 'celtiis_bj', label: 'Celtiis Bénin', mode: 'celtiis_bj', kind: 'both' },
  ],
  CI: [
    { code: 'mtn_ci', label: "MTN Côte d'Ivoire", mode: 'mtn_ci', kind: 'both' },
    { code: 'moov_ci', label: "Moov Côte d'Ivoire", mode: 'moov_ci', kind: 'payout' },
    { code: 'orange_ci', label: "Orange Côte d'Ivoire", mode: 'orange_ci', kind: 'payout' },
    { code: 'wave_ci', label: "Wave Côte d'Ivoire", mode: 'wave_ci', kind: 'payout' },
  ],
  TG: [
    { code: 'moov_tg', label: 'Moov Togo', mode: 'moov_tg', kind: 'both' },
    { code: 'togocel_tg', label: 'TogoCom (T-Money)', mode: 'togocel', kind: 'both' },
  ],
  SN: [
    { code: 'orange_sn', label: 'Orange Sénégal', mode: 'orange_sn', kind: 'both' },
    { code: 'moov_sn', label: 'Moov Sénégal (Free)', mode: 'free_sn', kind: 'payout' },
  ],
  ML: [
    { code: 'airtel_ml', label: 'Airtel Mali', mode: 'airtel_ml', kind: 'collect' },
  ],
  NE: [
    { code: 'airtel_ne', label: 'Airtel Niger', mode: 'airtel_ne', kind: 'collect' },
    { code: 'wave_ne', label: 'Wave Niger', mode: 'wave_ne', kind: 'both' },
    { code: 'orange_ne', label: 'Orange Niger', mode: 'orange_ne', kind: 'both' },
  ],
  BF: [
    { code: 'moov_bf', label: 'Moov Burkina Faso', mode: 'moov_bf', kind: 'both' },
    { code: 'yas_bf', label: 'Mixx by Yas Burkina', mode: 'sbin', kind: 'collect' },
  ],
  GN: [
    { code: 'mtn_gn', label: 'MTN Guinée', mode: 'mtn_open_gn', kind: 'both' },
    { code: 'moov_gn', label: 'Moov Guinée', mode: 'moov_gn', kind: 'collect' },
    { code: 'wave_gn', label: 'Wave Guinée', mode: 'wave_gn', kind: 'collect' },
    { code: 'orange_gn', label: 'Orange Guinée', mode: 'orange_gn', kind: 'collect' },
  ],
};
const FEDAPAY_COUNTRY_LABELS = {
  BJ: 'Bénin',
  CI: "Côte d'Ivoire",
  TG: 'Togo',
  SN: 'Sénégal',
  ML: 'Mali',
  NE: 'Niger',
  BF: 'Burkina Faso',
  GN: 'Guinée',
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

function providerConfigured(config, env, provider) {
  if (!config?.enabled) return false;
  const credentialKeys = new Set([
    'api_key_encrypted', 'secret_key_encrypted', 'api_secret_encrypted',
    'client_secret_encrypted', 'master_key_encrypted', 'public_key_encrypted',
    'private_key_encrypted', 'token_encrypted',
  ]);
  if (Object.entries(config).some(([key, value]) => (
    credentialKeys.has(key.toLowerCase())
      && typeof value === 'string' && value.length > 0
  ))) return true;
  const envKeys = {
    paydunya: ['PAYDUNYA_MASTER_KEY', 'PAYDUNYA_PUBLIC_KEY', 'PAYDUNYA_PRIVATE_KEY', 'PAYDUNYA_TOKEN'],
    mbiyo: ['MBIYO_SECRET_KEY', 'MBIYO_API_KEY'],
    afribapay: ['AFRIBAPAY_API_KEY', 'AFRIBAPAY_SECRET_KEY', 'AFRIBAPAY_CLIENT_ID'],
  };
  return (envKeys[provider] || []).some(key => Boolean(String(env[key] || '').trim()));
}

function operatorFee(operator, fallback, key) {
  const value = operator?.[key] ?? fallback?.[key] ?? 0;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function publicCryptoConfig(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = { enabled: source.enabled === true };
  for (const key of [
    'fees', 'fees_gateway', 'fees_platform',
    'fees_gateway_fixed', 'fees_platform_fixed',
  ]) {
    const section = source[key];
    if (!section || typeof section !== 'object' || Array.isArray(section)) continue;
    output[key] = Object.fromEntries(Object.entries(section)
      .filter(([asset, amount]) => /^[A-Za-z0-9._-]{1,48}$/.test(asset)
        && Number.isFinite(Number(amount)) && Number(amount) >= 0)
      .map(([asset, amount]) => [asset, Number(amount)]));
  }
  for (const key of ['disabled_assets', 'hidden_coins']) {
    if (Array.isArray(source[key])) {
      output[key] = source[key].filter(item => typeof item === 'string' && item.length <= 48);
    }
  }
  return output;
}

function cryptoFeeValue(section, field, keys, fallback = 0) {
  const values = section?.[field];
  if (!values || typeof values !== 'object' || Array.isArray(values)) return fallback;
  for (const key of keys) {
    if (!Object.hasOwn(values, key)) continue;
    const amount = Number(values[key]);
    if (Number.isFinite(amount) && amount >= 0) return amount;
  }
  return fallback;
}

function publicFeeCrypto(section) {
  const source = section && typeof section === 'object' ? section : {};
  const disabled = new Set((source.disabled_assets || []).map(value => String(value).toUpperCase()));
  const hidden = new Set((source.hidden_coins || []).map(value => String(value).toUpperCase()));
  const assets = CRYPTO_FEE_ASSETS.filter(asset => (
    !disabled.has(asset.id) && !hidden.has(asset.coin)
  )).map(asset => {
    const keys = [asset.id, asset.coin];
    const totalPct = cryptoFeeValue(source, 'fees', keys, 4);
    const platformPct = cryptoFeeValue(source, 'fees_platform', keys, 0);
    const gatewayPct = cryptoFeeValue(
      source, 'fees_gateway', keys, Math.max(0, totalPct - platformPct),
    );
    return {
      code: asset.coin,
      asset_id: asset.id,
      network: asset.network,
      fee_pct: gatewayPct + platformPct,
      fee_fixed: cryptoFeeValue(source, 'fees_gateway_fixed', keys, 0)
        + cryptoFeeValue(source, 'fees_platform_fixed', keys, 0),
    };
  });
  return { enabled: source.enabled === true, assets };
}

function publicFeeProviderCatalog(catalog) {
  return (Array.isArray(catalog) ? catalog : []).map(operator => {
    const gatewayPct = Number(operator.gateway_fee_pct) || 0;
    const platformPct = Number(operator.platform_fee_pct) || 0;
    const gatewayFixed = Number(operator.gateway_fee_fixed) || 0;
    const platformFixed = Number(operator.platform_fee_fixed) || 0;
    return {
      country: operator.country || null,
      country_label: operator.country_label || operator.country || null,
      name: operator.name || operator.code || null,
      currency: operator.currency || 'XOF',
      fee_pct: gatewayPct || platformPct
        ? gatewayPct + platformPct : Number(operator.fee_pct) || 0,
      fee_fixed: gatewayFixed || platformFixed
        ? gatewayFixed + platformFixed : Number(operator.fee_fixed) || 0,
      min: Number(operator.min) || 0,
      max: Number(operator.max) || null,
    };
  });
}

function publicWithdrawalOperators(transferConfig, providers, env) {
  const mobileMoney = transferConfig?.mobile_money || {};
  if (!mobileMoney.enabled) return { enabled: false, operators: [] };
  const ready = {
    paydunya: providerConfigured(providers.paydunya, env, 'paydunya'),
    mbiyo: providerConfigured(providers.mbiyo, env, 'mbiyo'),
    afribapay: providerConfigured(providers.afribapay, env, 'afribapay'),
  };
  const seen = new Set();
  const operators = (Array.isArray(mobileMoney.operators) ? mobileMoney.operators : [])
    .filter(operator => {
      const provider = String(operator.provider || 'paydunya').toLowerCase();
      if (!Object.hasOwn(ready, provider) || !ready[provider]
          || operator.active === false || operator.archived || operator.hidden) return false;
      const key = [
        String(operator.country || '').toUpperCase(),
        String(operator.code || '').toLowerCase().replace(/^mbiyo_/, ''),
        String(operator.currency || '').toUpperCase(),
      ].join(':');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map(operator => {
      const gatewayPct = Number(operator.gateway_fee_pct) || 0;
      const platformPct = Number(operator.platform_fee_pct) || 0;
      const gatewayFixed = Number(operator.gateway_fee_fixed) || 0;
      const platformFixed = Number(operator.platform_fee_fixed) || 0;
      return {
        country: operator.country,
        country_label: operator.country_label || operator.country,
        name: operator.name || operator.code,
        currency: operator.currency || 'XOF',
        fee_pct: gatewayPct || platformPct
          ? gatewayPct + platformPct : Number(operator.fee_pct) || 0,
        fee_fixed: gatewayFixed || platformFixed
          ? gatewayFixed + platformFixed : Number(operator.fee_fixed) || 0,
        min: Number(operator.min) || 0,
        max: Number(operator.max) || null,
      };
    });
  return { enabled: operators.length > 0, operators };
}

function createPublicConfigRoutes({ db, sessionService, env = process.env }) {
  async function handleRoute(req, res) {
    if (req.method !== 'GET') return false;
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    if (path === '/api/fedapay/catalog') {
      reply(res, 200, Object.entries(FEDAPAY_OPERATOR_CATALOG).map(([country, operators]) => ({
        country,
        country_label: FEDAPAY_COUNTRY_LABELS[country] || country,
        operators: structuredClone(operators),
      })));
      return true;
    }
    if (path === '/api/stats/public') {
      reply(res, 200, {
        users: 50000,
        partners: 5000,
        transactions: 1000000,
        uptime: 99.9,
      });
      return true;
    }
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
    if (path === '/api/fees/config') {
      if (!sessionService) {
        reply(res, 503, { detail: 'Configuration des frais indisponible.' });
        return true;
      }
      try {
        await sessionService.authenticate(sessionToken(req));
        const settings = db.collection('settings');
        const [deposit, withdrawal, paydunya, mbiyo, afribapay, platform] = await Promise.all([
          settings.find_one({ id: 'deposit_config' }, { _id: 0 }),
          settings.find_one({ id: 'transfer_config' }, { _id: 0 }),
          settings.find_one({ id: 'payment_provider_paydunya' }, { _id: 0 }),
          settings.find_one({ id: 'payment_provider_mbiyo' }, { _id: 0 }),
          settings.find_one({ id: 'payment_provider_afribapay' }, { _id: 0 }),
          getPlatformConfig(db),
        ]);
        const paydunyaCredentials = Boolean(
          (paydunya?.master_key_encrypted || env.PAYDUNYA_MASTER_KEY)
          && (paydunya?.private_key_encrypted || env.PAYDUNYA_PRIVATE_KEY)
          && (paydunya?.token_encrypted || env.PAYDUNYA_TOKEN),
        );
        const paydunyaModes = paydunya?.modes;
        const paydunyaModeReady = !paydunyaModes || Object.values(paydunyaModes).some(mode => (
          mode && typeof mode === 'object' ? mode.enabled === true : Boolean(mode)
        ));
        const paydunyaCatalog = paydunya?.enabled !== false
          && paydunyaCredentials && paydunyaModeReady
          ? publicFeeProviderCatalog((paydunya.catalog || []).filter(operator => (
            operator.active !== false && !operator.archived && !operator.hidden
            && ['XOF', 'XAF'].includes(String(operator.currency || '').toUpperCase())
          )))
          : [];
        const mbiyoConfigured = Boolean(
          mbiyo?.enabled
          && (mbiyo.secret_key_encrypted || mbiyo.api_key_encrypted
            || env.MBIYO_SECRET_KEY || env.MBIYO_API_KEY),
        );
        const mbiyoCatalog = mbiyoConfigured
          ? publicFeeProviderCatalog((mbiyo.catalog || []).filter(operator => (
            operator.active !== false && !operator.archived && !operator.hidden
          )))
          : [];
        const depositOperators = [...paydunyaCatalog, ...mbiyoCatalog];
        const conversion = platform.conversion_fee || {};
        reply(res, 200, {
          deposit: {
            mobile_money: { enabled: depositOperators.length > 0, operators: depositOperators },
            crypto: publicFeeCrypto(deposit?.crypto),
          },
          withdrawal: {
            mobile_money: publicWithdrawalOperators(
              withdrawal, { paydunya, mbiyo, afribapay }, env,
            ),
            crypto: publicFeeCrypto(withdrawal?.crypto),
          },
          conversion: {
            enabled: Boolean(conversion.enabled),
            type: conversion.type || 'percent',
            value: Number(conversion.value) || 0,
            min_fee: conversion.min_fee ?? null,
            max_fee: conversion.max_fee ?? null,
          },
        });
      } catch (error) {
        reply(res, error.status || 503, {
          detail: error.status === 401 ? 'Session requise'
            : error.status ? error.message : 'Configuration des frais indisponible.',
        });
      }
      return true;
    }
    if (path === '/api/deposits/config') {
      const surface = url.searchParams.get('surface') || 'dashboard';
      if (!['dashboard', 'public_link'].includes(surface)) {
        reply(res, 422, { detail: 'Surface de dépôt invalide' });
        return true;
      }
      try {
        const settings = db.collection('settings');
        const [depositConfig, paydunya, mbiyo, afribapay, transferConfig] = await Promise.all([
          settings.find_one({ id: 'deposit_config' }, { _id: 0 }),
          settings.find_one({ id: 'payment_provider_paydunya' }, { _id: 0 }),
          settings.find_one({ id: 'payment_provider_mbiyo' }, { _id: 0 }),
          settings.find_one({ id: 'payment_provider_afribapay' }, { _id: 0 }),
          settings.find_one({ id: 'transfer_config' }, { _id: 0 }),
        ]);
        const fees = Array.isArray(depositConfig?.mobile_money?.operators)
          ? depositConfig.mobile_money.operators : [];
        const providerConfigs = [
          { name: 'paydunya', config: paydunya },
          { name: 'mbiyo', config: mbiyo },
          ...(surface === 'public_link' ? [] : [{ name: 'afribapay', config: afribapay }]),
        ];
        const grouped = new Map();
        const seen = new Set();
        for (const { name, config } of providerConfigs) {
          if (!providerConfigured(config, env, name)) continue;
          for (const raw of Array.isArray(config.catalog) ? config.catalog : []) {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)
                || raw.active === false || raw.archived === true || raw.hidden === true) continue;
            const country = String(raw.country || '').trim().toUpperCase();
            const code = String(raw.public_code || raw.code || '').trim();
            const currency = String(raw.currency || 'XOF').trim().toUpperCase();
            if (!/^[A-Z]{2,3}$/.test(country) || !/^[A-Za-z0-9_-]{1,64}$/.test(code)
                || !/^[A-Z]{3,5}$/.test(currency)) continue;
            const keyCode = code.toLowerCase().replace(/^mbiyo_/, '');
            const identity = `${country}:${keyCode}:${currency}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
            const feeEntry = fees.find(item => (
              String(item.country || '').toUpperCase() === country
              && String(item.code || '').toLowerCase().replace(/^mbiyo_/, '') === keyCode
            ));
            if (feeEntry?.active === false || feeEntry?.hidden === true) continue;
            const row = {
              code,
              name: String(raw.name || code),
              label: String(raw.name || code),
              currency,
              fee_pct: operatorFee(raw, feeEntry, 'fee_pct'),
              fee_fixed: operatorFee(raw, feeEntry, 'fee_fixed'),
              gateway_fee_pct: operatorFee(raw, feeEntry, 'gateway_fee_pct'),
              gateway_fee_fixed: operatorFee(raw, feeEntry, 'gateway_fee_fixed'),
              platform_fee_pct: operatorFee(raw, feeEntry, 'platform_fee_pct'),
              platform_fee_fixed: operatorFee(raw, feeEntry, 'platform_fee_fixed'),
              amount_increment: operatorFee(raw, feeEntry, 'amount_increment'),
              min: Math.max(0, Number(raw.min ?? feeEntry?.min ?? 100) || 0),
              max: Number(raw.max ?? feeEntry?.max ?? 0) || null,
              payment_flow: raw.payment_flow && typeof raw.payment_flow === 'object'
                && !Array.isArray(raw.payment_flow) ? raw.payment_flow : {},
            };
            if (!grouped.has(country)) {
              grouped.set(country, {
                country,
                country_label: String(raw.country_label || country),
                operators: [],
              });
            }
            grouped.get(country).operators.push(row);
          }
        }
        const catalog = [...grouped.values()];
        const enabled = depositConfig?.mobile_money?.enabled === true
          && catalog.some(group => group.operators.length > 0);
        reply(res, 200, {
          enabled,
          mobile_money_enabled: enabled,
          catalog,
          crypto: publicCryptoConfig(depositConfig?.crypto),
          transfer_crypto_fees: publicCryptoConfig(transferConfig?.crypto),
        });
      } catch {
        reply(res, 503, { detail: 'Configuration de dépôt indisponible' });
      }
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
  publicFeeCrypto,
};
