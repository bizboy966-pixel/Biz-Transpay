'use strict';

const { createHash } = require('node:crypto');
const { sessionToken } = require('./auth-session-routes.cjs');
const { readJson } = require('./auth-login.cjs');
const security = require('./security.cjs');
const { getAppFeatures, getPlatformConfig } = require('./public-config-routes.cjs');
const { authorizeAdmin } = require('./admin-authorization.cjs');
const { applyWalletOperation } = require('./wallet.cjs');

const ASSET_SPECS = [
  { id: 'USDC.POLYGON', coin: 'USDC', name: 'USD Coin', network: 'POLYGON', networkName: 'Polygon', aliases: ['POLYGON', 'MATIC'], addressRegex: '^0x[a-fA-F0-9]{40}$' },
  { id: 'USDC.SOL', coin: 'USDC', name: 'USD Coin', network: 'SOL', networkName: 'Solana', aliases: ['SOL', 'SOLANA'], addressRegex: '^[1-9A-HJ-NP-Za-km-z]{32,44}$' },
  { id: 'USDC.BEP20', coin: 'USDC', name: 'USD Coin', network: 'BEP20', networkName: 'BNB Smart Chain (BEP20)', aliases: ['BEP20', 'BSC', 'BNBSMARTCHAIN'], addressRegex: '^0x[a-fA-F0-9]{40}$' },
  { id: 'USDC.ERC20', coin: 'USDC', name: 'USD Coin', network: 'ERC20', networkName: 'Ethereum (ERC20)', aliases: ['ERC20', 'ETH', 'ETHEREUM'], addressRegex: '^0x[a-fA-F0-9]{40}$' },
  { id: 'USDT.POLYGON', coin: 'USDT', name: 'Tether', network: 'POLYGON', networkName: 'Polygon', aliases: ['POLYGON', 'MATIC'], addressRegex: '^0x[a-fA-F0-9]{40}$' },
  { id: 'USDT.BEP20', coin: 'USDT', name: 'Tether', network: 'BEP20', networkName: 'BNB Smart Chain (BEP20)', aliases: ['BEP20', 'BSC', 'BNBSMARTCHAIN'], addressRegex: '^0x[a-fA-F0-9]{40}$' },
  { id: 'USDT.SOL', coin: 'USDT', name: 'Tether', network: 'SOL', networkName: 'Solana', aliases: ['SOL', 'SOLANA'], addressRegex: '^[1-9A-HJ-NP-Za-km-z]{32,44}$' },
  { id: 'USDT.TRC20', coin: 'USDT', name: 'Tether', network: 'TRC20', networkName: 'Tron (TRC20)', aliases: ['TRC20', 'TRX', 'TRON'], addressRegex: '^T[A-Za-z1-9]{33}$' },
  { id: 'USDT.TON', coin: 'USDT', name: 'Tether', network: 'TON', networkName: 'TON', aliases: ['TON', 'TONCOIN'], addressRegex: '^[A-Za-z0-9_-]{48}$', memoRequired: true },
  { id: 'USDT.ERC20', coin: 'USDT', name: 'Tether', network: 'ERC20', networkName: 'Ethereum (ERC20)', aliases: ['ERC20', 'ETH', 'ETHEREUM'], addressRegex: '^0x[a-fA-F0-9]{40}$' },
  { id: 'BNB.BNB', coin: 'BNB', name: 'BNB', network: 'BNB', networkName: 'BNB (natif)', aliases: ['BNB', 'BSC', 'BEP2', 'BEP20', 'BNBCHAIN', 'BNBSMARTCHAIN'], addressRegex: '^(0x[a-fA-F0-9]{40}|bnb1[0-9a-z]{38})$', native: true },
  { id: 'BTC.BTC', coin: 'BTC', name: 'Bitcoin', network: 'BTC', networkName: 'Bitcoin (natif)', aliases: ['BTC', 'BITCOIN', 'BITCOINMAINNET'], addressRegex: '^(bc1|[13])[a-zA-HJ-NP-Z0-9]{25,62}$', native: true },
  { id: 'SOL.SOL', coin: 'SOL', name: 'Solana', network: 'SOL', networkName: 'Solana (natif)', aliases: ['SOL', 'SOLANA'], addressRegex: '^[1-9A-HJ-NP-Za-km-z]{32,44}$', native: true },
  { id: 'TON.TON', coin: 'TON', name: 'Toncoin', network: 'TON', networkName: 'TON (natif)', aliases: ['TON', 'TONCOIN'], addressRegex: '^[A-Za-z0-9_-]{48}$', memoRequired: true, native: true },
  { id: 'TRX.TRX', coin: 'TRX', name: 'TRON', network: 'TRX', networkName: 'TRON (natif)', aliases: ['TRX', 'TRON'], addressRegex: '^T[A-Za-z1-9]{33}$', native: true },
  { id: 'ETH.ETH', coin: 'ETH', name: 'Ethereum', network: 'ETH', networkName: 'Ethereum (natif)', aliases: ['ETH', 'ETHEREUM'], addressRegex: '^0x[a-fA-F0-9]{40}$', native: true },
];
const SPEC_BY_ID = new Map(ASSET_SPECS.map(spec => [spec.id, spec]));
const ASSET_CACHE_MS = 300_000;

function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function walletField(specOrId) {
  const id = typeof specOrId === 'string' ? specOrId : specOrId?.id;
  const spec = SPEC_BY_ID.get(String(id || '').trim().toUpperCase());
  if (!spec) return null;
  const suffix = `${spec.coin}_${spec.network}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `balance_crypto_${suffix}`;
}

function normalizedNetwork(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function networkMatches(spec, value) {
  const candidate = normalizedNetwork(value);
  if (!candidate) return false;
  return [...spec.aliases, spec.network]
    .map(normalizedNetwork)
    .filter(Boolean)
    .some(alias => candidate === alias || candidate.startsWith(alias));
}

function providerAssetSpec(asset) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return null;
  const assetCode = String(asset.assetCode || '').trim().toUpperCase();
  const [codeCoin, codeNetwork, ...rest] = assetCode.split('.');
  const coin = String(asset.coinCode || codeCoin || '').trim().toUpperCase();
  if (!coin) return null;
  const candidates = [rest.length ? '' : codeNetwork, asset.network, asset.networkName, asset.blockchainCode, asset.blockchainName];
  for (const spec of ASSET_SPECS) {
    if (coin !== spec.coin) continue;
    if (!assetCode.includes('.') && spec.native && assetCode === spec.coin) return spec;
    if (candidates.some(value => networkMatches(spec, value))) return spec;
  }
  return null;
}

function catalogMap(assets) {
  const selected = new Map();
  for (const asset of Array.isArray(assets) ? assets : []) {
    const spec = providerAssetSpec(asset);
    if (!spec) continue;
    const exact = String(asset.assetCode || '').trim().toUpperCase() === spec.id;
    const score = [Boolean(asset.isActive) ? 1 : 0, exact ? 1 : 0];
    const previous = selected.get(spec.id);
    if (!previous || score[0] > previous.score[0]
        || (score[0] === previous.score[0] && score[1] > previous.score[1])) {
      selected.set(spec.id, { asset, score });
    }
  }
  return new Map([...selected].map(([id, row]) => [id, row.asset]));
}

function assetEnabled(section, spec) {
  const disabled = new Set((section.disabled_assets || []).map(value => String(value).trim().toUpperCase()));
  const hidden = new Set((section.hidden_coins || []).map(value => String(value).trim().toUpperCase()));
  return !disabled.has(spec.id) && !hidden.has(spec.coin);
}

function numeric(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function cryptoRate(config, coin) {
  const key = String(coin || '').trim().toUpperCase();
  if (key === 'USDT') return 1;
  const rate = Number(config.crypto_usdt_rates?.[key]);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function feePercentSplit(section, coin, assetId) {
  const keys = assetId ? [String(assetId).toUpperCase(), String(coin).toUpperCase()] : [String(coin).toUpperCase()];
  const lookup = object => {
    for (const key of keys) {
      if (Object.hasOwn(object || {}, key)) return numeric(object[key]);
    }
    return null;
  };
  const total = lookup(section.fees || {}) ?? 4;
  const platform = lookup(section.fees_platform || {}) ?? 0;
  const gateway = lookup(section.fees_gateway || {}) ?? Math.max(0, total - platform);
  return { gateway, platform };
}

function fixedFee(section, field, spec) {
  const values = section[field] || {};
  const raw = values[spec.id] ?? values[spec.coin] ?? 0;
  return numeric(raw);
}

function publicConfigError(error) {
  return error?.status ? { status: error.status, message: error.message } : null;
}

function createCryptoCatalogRoutes({
  db, sessionService, sessionSecret = '', env = process.env, fetchImpl = globalThis.fetch,
}) {
  let assetCache = { key: '', until: 0, data: null };

  async function credentials() {
    const saved = await db.collection('settings').find_one(
      { id: 'payment_provider_izipay' },
      { _id: 0, api_key_encrypted: 1, webhook_secret_encrypted: 1 }
    ) || {};
    let apiKey = '';
    let webhookSecret = '';
    try {
      const key = security.fernetKey(sessionSecret);
      if (saved.api_key_encrypted) apiKey = security.decryptFernet(saved.api_key_encrypted, key);
      if (saved.webhook_secret_encrypted) webhookSecret = security.decryptFernet(saved.webhook_secret_encrypted, key);
    } catch {
      throw httpError(503, 'Les identifiants Easy Change Pay ne peuvent pas être déchiffrés');
    }
    apiKey = apiKey || String(env.IZIPAY_API_KEY || '').trim();
    webhookSecret = webhookSecret || String(env.IZIPAY_WEBHOOK_SECRET || '').trim();
    const baseUrl = String(env.IZIPAY_BASE_URL || 'https://api.pay.izichange.com').replace(/\/+$/, '');
    let parsed;
    try { parsed = new URL(baseUrl); } catch { throw httpError(503, 'Configuration IziPay invalide'); }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
      throw httpError(503, 'Configuration IziPay invalide');
    }
    return { apiKey, webhookSecret, baseUrl, configured: Boolean(apiKey && webhookSecret) };
  }

  async function providerAssets(config, { force = false } = {}) {
    if (!config.configured) return null;
    const cacheKey = createHash('sha256')
      .update(`${config.apiKey}\n${config.baseUrl}`)
      .digest('hex');
    if (!force && assetCache.key === cacheKey && assetCache.until > Date.now()) {
      return assetCache.data;
    }
    let response;
    try {
      response = await fetchImpl(`${config.baseUrl}/v1/assets`, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw httpError(503, 'Catalogue crypto temporairement indisponible');
    }
    let text;
    try { text = await response.text(); } catch { throw httpError(503, 'Catalogue crypto temporairement indisponible'); }
    if (text.length > 2_000_000) throw httpError(502, 'Réponse du catalogue crypto trop volumineuse');
    if (!response.ok) throw httpError(503, 'Catalogue crypto temporairement indisponible');
    let assets;
    try { assets = JSON.parse(text); } catch { throw httpError(502, 'Réponse du catalogue crypto invalide'); }
    if (!Array.isArray(assets)) throw httpError(502, 'Réponse du catalogue crypto invalide');
    assetCache = { key: cacheKey, until: Date.now() + ASSET_CACHE_MS, data: assets };
    return assets;
  }

  async function getPayout(payoutId) {
    const id = String(payoutId || '').trim();
    if (!id || id.length > 200 || /[\u0000-\u001f\u007f]/.test(id)) {
      throw httpError(422, 'Identifiant de payout invalide');
    }
    const config = await credentials();
    if (!config.apiKey) throw httpError(503, 'Passerelle crypto non configurée');
    let response;
    try {
      response = await fetchImpl(
        `${config.baseUrl}/v1/payouts/${encodeURIComponent(id)}`,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            accept: 'application/json',
          },
          signal: AbortSignal.timeout(20_000),
        },
      );
    } catch {
      throw httpError(502, 'Statut du payout indisponible; aucun solde n’a été modifié.');
    }
    let text;
    try { text = await response.text(); } catch {
      throw httpError(502, 'Réponse du payout invalide; aucun solde n’a été modifié.');
    }
    if (text.length > 512_000) throw httpError(502, 'Réponse du payout trop volumineuse');
    let payload;
    try { payload = JSON.parse(text); } catch {
      throw httpError(502, 'Réponse du payout invalide; aucun solde n’a été modifié.');
    }
    if (!response.ok || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw httpError(502, 'Impossible de vérifier le payout auprès du prestataire.');
    }
    return payload;
  }

  async function getDepositCryptoConfig() {
    const deposit = await db.collection('settings').find_one(
      { id: 'deposit_config' },
      { _id: 0, crypto: 1 }
    );
    return deposit?.crypto || { enabled: true, fees: {}, fees_gateway: {}, fees_platform: {}, fees_gateway_fixed: {}, fees_platform_fixed: {}, disabled_assets: [], hidden_coins: [] };
  }

  async function getTransferCryptoConfig() {
    const transfer = await db.collection('settings').find_one(
      { id: 'transfer_config' },
      { _id: 0, crypto: 1 }
    );
    return transfer?.crypto || {
      enabled: true,
      fees: {},
      fees_gateway: {},
      fees_platform: {},
      fees_gateway_fixed: {},
      fees_platform_fixed: {},
      disabled_assets: [],
      hidden_coins: [],
    };
  }

  async function getActiveCatalog(section) {
    if (section.enabled === false) return new Map();
    const config = await credentials();
    if (!config.configured) return new Map();
    const rows = await providerAssets(config);
    return catalogMap(rows);
  }

  async function activeExchangeAssets() {
    const crypto = await getDepositCryptoConfig();
    const catalog = await getActiveCatalog(crypto);
    const platform = await getPlatformConfig(db);
    const active = new Map();
    for (const spec of ASSET_SPECS) {
      const provider = catalog.get(spec.id);
      const rate = cryptoRate(platform, spec.coin);
      if (!provider?.isActive || !assetEnabled(crypto, spec) || rate === null) continue;
      active.set(spec.id, {
        code: spec.id,
        coin: spec.coin,
        network: spec.network,
        network_name: spec.networkName,
        name: spec.name,
        wallet_field: walletField(spec),
        usdt_rate: rate,
      });
    }
    return active;
  }

  function exchangeCurrencyInfo(code, cryptoAssets) {
    if (code === 'XOF') return { code, wallet_field: 'balance_xof', kind: 'fiat' };
    if (code === 'XAF') return { code, wallet_field: 'balance_xaf', kind: 'fiat' };
    if (code === 'USDT') {
      throw httpError(400, "Le solde USDT non attribué n'est pas disponible dans Exchange.");
    }
    const asset = cryptoAssets.get(code);
    if (!asset) throw httpError(400, `Portefeuille crypto non disponible : ${code}`);
    return { ...asset, kind: 'crypto' };
  }

  async function exchangeRateContext(config, fromCode, toCode) {
    const cryptoRequested = [fromCode, toCode].some(code => !['XOF', 'XAF'].includes(code));
    const cryptoAssets = cryptoRequested ? await activeExchangeAssets() : new Map();
    const source = exchangeCurrencyInfo(fromCode, cryptoAssets);
    const destination = exchangeCurrencyInfo(toCode, cryptoAssets);
    const rates = config.conversion_rates || {};
    const pairs = config.conversion_pairs_enabled || {};
    let pairKey;
    let rate;
    if (source.kind === 'fiat' && destination.kind === 'fiat') {
      pairKey = `${fromCode}_${toCode}`;
      rate = numeric(rates[pairKey]);
    } else if (source.kind === 'crypto' && destination.kind === 'crypto') {
      pairKey = null;
      rate = Number(source.usdt_rate) / Number(destination.usdt_rate);
    } else if (source.kind === 'crypto') {
      pairKey = `USDT_${toCode}`;
      rate = Number(source.usdt_rate) * numeric(rates[pairKey]);
    } else {
      pairKey = `${fromCode}_USDT`;
      rate = numeric(rates[pairKey]) / Number(destination.usdt_rate);
    }
    if (pairKey && pairs[pairKey] === false) {
      throw httpError(400, 'Cette paire de conversion est désactivée');
    }
    if (!Number.isFinite(rate) || rate <= 0) throw httpError(503, 'Taux de conversion indisponible');
    const limitsKey = pairKey || `${fromCode}_${toCode}`;
    return {
      source,
      destination,
      rate,
      pair: `${fromCode}_${toCode}`,
      limits: config.conversion_limits?.[limitsKey] || {},
    };
  }

  function computeConversionFee(feeConfig, amount) {
    const fee = feeConfig || {};
    if (fee.enabled === false) return 0;
    let result = fee.type === 'fixed'
      ? numeric(fee.value)
      : amount * numeric(fee.value);
    if (fee.type !== 'fixed') result /= 100;
    if (fee.min_fee !== null && fee.min_fee !== undefined) {
      result = Math.max(result, numeric(fee.min_fee));
    }
    if (fee.max_fee !== null && fee.max_fee !== undefined) {
      result = Math.min(result, numeric(fee.max_fee));
    }
    return Math.round((result + Number.EPSILON) * 1_000_000) / 1_000_000;
  }

  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/deposits/crypto') {
      let userId;
      try {
        const authenticated = await sessionService.authenticate(sessionToken(req));
        userId = sessionService.requireRecentAuth(authenticated);
      } catch (error) {
        reply(res, error.status || 401, { detail: error.message || 'Session requise' });
        return true;
      }
      try {
        const body = await readJson(req, 32 * 1024);
        reply(res, 200, await createCryptoDepositIntent(userId, body));
      } catch (error) {
        const safe = publicConfigError(error);
        reply(res, safe?.status || 500, {
          detail: safe?.message || 'Impossible de créer le dépôt crypto.',
        });
      }
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/crypto/coins') {
      try {
        await authorizeAdmin(req, {
          db, sessionService, env, permission: 'fees:read',
          action: 'read_crypto_catalog',
        });
        const direction = String(url.searchParams.get('direction') || 'withdrawal');
        if (!['deposit', 'withdrawal'].includes(direction)) {
          throw httpError(400, 'Direction crypto invalide');
        }
        const section = direction === 'deposit'
          ? await getDepositCryptoConfig() : await getTransferCryptoConfig();
        let rows = [];
        try {
          const providerConfig = await credentials();
          if (providerConfig.configured) {
            rows = await providerAssets(providerConfig, {
              force: ['true', '1'].includes(String(url.searchParams.get('refresh') || '').toLowerCase()),
            }) || [];
          }
        } catch {
          // Keep the admin catalogue visible with provider availability false;
          // do not expose provider errors or credentials to the browser.
        }
        const catalog = catalogMap(rows);
        const platform = await getPlatformConfig(db);
        const result = ASSET_SPECS.map(spec => {
          const asset = catalog.get(spec.id);
          const { gateway, platform: platformPct } = feePercentSplit(section, spec.coin, spec.id);
          const gatewayFixed = fixedFee(section, 'fees_gateway_fixed', spec);
          const platformFixed = fixedFee(section, 'fees_platform_fixed', spec);
          return {
            asset_id: spec.id,
            coin: spec.coin,
            name: spec.name,
            network: spec.networkName,
            network_code: spec.network,
            provider_asset_code: asset
              ? String(asset.assetCode || '').trim().toUpperCase() : null,
            provider_active: Boolean(asset?.isActive),
            provider_available: Boolean(asset),
            enabled: section.enabled !== false && assetEnabled(section, spec),
            fee_pct: gateway + platformPct,
            gateway_fee_pct: gateway,
            platform_fee_pct: platformPct,
            gateway_fee_fixed: gatewayFixed,
            platform_fee_fixed: platformFixed,
            usdt_rate: cryptoRate(platform, spec.coin),
          };
        });
        reply(res, 200, result);
      } catch (error) {
        reply(res, error.status || 500, {
          detail: error.message || 'Erreur interne.',
        });
      }
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/crypto/assets') {
      try {
        const crypto = await getDepositCryptoConfig();
        if (crypto.enabled === false) {
          reply(res, 200, []);
          return true;
        }
        const config = await credentials();
        if (!config.configured) {
          reply(res, 200, []);
          return true;
        }
        let providerRows;
        try { providerRows = await providerAssets(config); } catch {
          reply(res, 200, []);
          return true;
        }
        const catalog = catalogMap(providerRows);
        const platform = await getPlatformConfig(db);
        const result = [];
        for (const spec of ASSET_SPECS) {
          const asset = catalog.get(spec.id);
          if (!asset?.isActive || !assetEnabled(crypto, spec)) continue;
          const rate = cryptoRate(platform, spec.coin);
          if (rate === null) continue;
          const { gateway, platform: platformPct } = feePercentSplit(crypto, spec.coin, spec.id);
          const gatewayFixed = fixedFee(crypto, 'fees_gateway_fixed', spec);
          const platformFixed = fixedFee(crypto, 'fees_platform_fixed', spec);
          result.push({
            asset_code: String(asset.assetCode || '').trim().toUpperCase(),
            catalog_asset_id: spec.id,
            coin: spec.coin,
            network: spec.network,
            network_name: spec.networkName,
            blockchain_name: asset.blockchainName || spec.networkName,
            minimum: numeric(asset.minimum),
            maximum: numeric(asset.maximum, 1e12) || 1e12,
            memo_required: Boolean(asset.memoRequired || spec.memoRequired),
            memo_type: asset.memoType ?? null,
            usdt_rate: rate,
            credit_currency: spec.id,
            wallet_field: walletField(spec),
            fee_pct: gateway + platformPct,
            gateway_fee_pct: gateway,
            platform_fee_pct: platformPct,
            gateway_fee_fixed: gatewayFixed,
            platform_fee_fixed: platformFixed,
            fee_fixed: gatewayFixed + platformFixed,
          });
        }
        reply(res, 200, result);
      } catch (error) {
        const safe = publicConfigError(error);
        reply(res, safe?.status || 500, { detail: safe?.message || 'Erreur interne.' });
      }
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/conversion/quote') {
      const fromCode = String(url.searchParams.get('from_currency') || '').trim().toUpperCase();
      const toCode = String(url.searchParams.get('to_currency') || '').trim().toUpperCase();
      const amount = Number(url.searchParams.get('amount'));
      if (!fromCode || !toCode) {
        reply(res, 422, { detail: 'Les devises source et destination sont requises' });
        return true;
      }
      if (fromCode === toCode) {
        reply(res, 400, { detail: 'Devises identiques' });
        return true;
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        reply(res, 400, { detail: 'Montant invalide' });
        return true;
      }
      try {
        const config = await getPlatformConfig(db);
        const context = await exchangeRateContext(config, fromCode, toCode);
        const limits = context.limits;
        const minimum = numeric(limits.min);
        const maximum = numeric(limits.max);
        if (amount < minimum) {
          reply(res, 400, { detail: `Montant inférieur au minimum (${limits.min} ${fromCode})` });
          return true;
        }
        if (limits.max && amount > maximum) {
          reply(res, 400, { detail: `Montant supérieur au maximum (${limits.max} ${fromCode})` });
          return true;
        }
        const fee = computeConversionFee(config.conversion_fee, amount);
        if (fee >= amount) {
          reply(res, 400, { detail: 'Les frais dépassent le montant à convertir' });
          return true;
        }
        const received = Math.round(((amount - fee) * context.rate + Number.EPSILON) * 1_000_000) / 1_000_000;
        reply(res, 200, {
          from_currency: fromCode, to_currency: toCode,
          amount, fee, rate: context.rate, received, fee_currency: fromCode,
        });
      } catch (error) {
        const safe = publicConfigError(error);
        reply(res, safe?.status || 500, { detail: safe?.message || 'Erreur interne.' });
      }
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/crypto/coins') {
      let userId;
      try {
        const session = await sessionService.authenticate(sessionToken(req));
        userId = session.userId;
      } catch (error) {
        reply(res, error.status || 401, { detail: error.message || 'Session requise' });
        return true;
      }
      try {
        const section = await getTransferCryptoConfig();
        if (section.enabled === false) {
          reply(res, 200, []);
          return true;
        }
        const providerConfig = await credentials();
        if (!providerConfig.configured) {
          reply(res, 200, []);
          return true;
        }
        let providerRows;
        try { providerRows = await providerAssets(providerConfig); } catch {
          reply(res, 200, []);
          return true;
        }
        const catalog = catalogMap(providerRows);
        const platform = await getPlatformConfig(db);
        const user = await db.collection('users').find_one({ id: userId }, { _id: 0 });
        if (!user) throw httpError(404, 'Utilisateur introuvable');
        const coins = new Map();
        for (const spec of ASSET_SPECS) {
          const asset = catalog.get(spec.id);
          if (!asset?.isActive || !assetEnabled(section, spec)) continue;
          const usdtRate = cryptoRate(platform, spec.coin);
          if (usdtRate === null) continue;
          const { gateway, platform: platformPct } = feePercentSplit(section, spec.coin, spec.id);
          const gatewayFixed = fixedFee(section, 'fees_gateway_fixed', spec);
          const platformFixed = fixedFee(section, 'fees_platform_fixed', spec);
          if (!coins.has(spec.coin)) {
            const coinFees = feePercentSplit(section, spec.coin);
            const coinFixed = fixedFee(section, 'fees_gateway_fixed', { id: spec.coin, coin: spec.coin })
              + fixedFee(section, 'fees_platform_fixed', { id: spec.coin, coin: spec.coin });
            coins.set(spec.coin, {
              coin: spec.coin,
              name: spec.name,
              networks: [],
              fee_pct: coinFees.gateway + coinFees.platform,
              fee_fixed: coinFixed,
              usdt_rate: usdtRate,
            });
          }
          coins.get(spec.coin).networks.push({
            code: spec.network,
            name: spec.networkName,
            wallet_id: spec.id,
            balance: numeric(user[walletField(spec)]),
            asset_code: String(asset.assetCode || '').trim().toUpperCase(),
            catalog_asset_id: spec.id,
            address_regex: spec.addressRegex,
            min: numeric(asset.minimum),
            max: numeric(asset.maximum, 1e12) || 1e12,
            memo_required: Boolean(asset.memoRequired || spec.memoRequired),
            memo_type: asset.memoType ?? null,
            fee_pct: gateway + platformPct,
            gateway_fee_pct: gateway,
            platform_fee_pct: platformPct,
            gateway_fee_fixed: gatewayFixed,
            platform_fee_fixed: platformFixed,
            fee_fixed: gatewayFixed + platformFixed,
            usdt_rate: usdtRate,
          });
        }
        reply(res, 200, [...coins.values()].sort((a, b) => a.coin.localeCompare(b.coin)));
      } catch (error) {
        const safe = publicConfigError(error);
        reply(res, safe?.status || 500, { detail: safe?.message || 'Erreur interne.' });
      }
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/conversion/crypto-wallets') {
      let userId;
      try {
        const session = await sessionService.authenticate(sessionToken(req));
        userId = session.userId;
      } catch (error) {
        reply(res, error.status || 401, { detail: error.message || 'Session requise' });
        return true;
      }
      try {
        const [assets, user] = await Promise.all([
          activeExchangeAssets(),
          db.collection('users').find_one({ id: userId }, { _id: 0 }),
        ]);
        if (!user) throw httpError(404, 'Utilisateur introuvable');
        const result = [...assets.entries()].sort(([a], [b]) => a.localeCompare(b))
          .map(([id, asset]) => {
            const balance = numeric(user[asset.wallet_field]);
            return {
              id, code: id, coin: asset.coin, network: asset.network,
              network_name: asset.network_name, balance,
              value_usdt: Math.round(balance * asset.usdt_rate * 1_000_000) / 1_000_000,
            };
          });
        reply(res, 200, result);
      } catch (error) {
        const safe = publicConfigError(error);
        reply(res, safe?.status || 500, { detail: safe?.message || 'Erreur interne.' });
      }
      return true;
    }
    return false;
  }

  async function integrationCryptoAssets(direction, userId) {
    const features = await getAppFeatures(db);
    const featureKey = direction === 'deposit'
      ? 'deposit_crypto_enabled' : 'withdrawal_crypto_enabled';
    if (features.wallet_crypto_enabled === false || features[featureKey] === false) {
      throw httpError(403, 'Les opérations crypto sont désactivées');
    }
    if (direction === 'deposit') {
      const config = await getDepositCryptoConfig();
      if (config.enabled === false) return [];
      const providerConfig = await credentials();
      if (!providerConfig.configured) return [];
      const providerRows = await providerAssets(providerConfig);
      const catalog = catalogMap(providerRows || []);
      const platform = await getPlatformConfig(db);
      const result = [];
      for (const spec of ASSET_SPECS) {
        const asset = catalog.get(spec.id);
        if (!asset?.isActive || !assetEnabled(config, spec)) continue;
        if (cryptoRate(platform, spec.coin) === null) continue;
        const { gateway, platform: platformPct } = feePercentSplit(config, spec.coin, spec.id);
        result.push({
          asset_code: String(asset.assetCode || '').trim().toUpperCase(),
          coin: spec.coin,
          network: spec.network,
          network_name: spec.networkName,
          minimum: numeric(asset.minimum),
          maximum: numeric(asset.maximum, 1e12) || 1e12,
          memo_required: Boolean(asset.memoRequired || spec.memoRequired),
          fee_pct: gateway + platformPct,
          fee_fixed: fixedFee(config, 'fees_gateway_fixed', spec)
            + fixedFee(config, 'fees_platform_fixed', spec),
        });
      }
      return result;
    }

    const [assets, user] = await Promise.all([
      activeExchangeAssets(),
      db.collection('users').find_one({ id: userId }, { _id: 0 }),
    ]);
    if (!user) throw httpError(404, 'Utilisateur introuvable');
    return [...assets.values()].map(asset => ({
      asset_code: asset.asset_code,
      coin: asset.coin,
      network: asset.network,
      network_name: asset.network_name,
      minimum: numeric(asset.min),
      maximum: numeric(asset.max, 1e12) || 1e12,
      memo_required: Boolean(asset.memo_required),
      balance: numeric(user[asset.wallet_field]),
      fee_pct: numeric(asset.fee_pct),
      fee_fixed: numeric(asset.fee_fixed),
    }));
  }

  function roundCryptoAmount(value) {
    return Math.round((Number(value) + Number.EPSILON) * 1_000_000) / 1_000_000;
  }

  async function createCryptoLinkPaymentIntent(paymentId) {
    const payments = db.collection('link_payments');
    let payment = await payments.find_one(
      { id: String(paymentId), method: 'crypto' }, { _id: 0 },
    );
    if (!payment) throw httpError(404, 'Paiement crypto de lien introuvable');
    if (payment.deposit_address || ['paid', 'expired', 'failed'].includes(payment.status)) {
      return payment;
    }
    const link = await db.collection('payment_links').find_one(
      { id: String(payment.link_id), user_id: String(payment.user_id) }, { _id: 0 },
    );
    if (!link) throw httpError(503, 'Lien marchand introuvable pour le paiement');

    const alreadyDispatched = Boolean(payment.provider_dispatch_started_at);
    const features = await getAppFeatures(db);
    if (!alreadyDispatched && (features.wallet_crypto_enabled === false
        || features.deposit_crypto_enabled === false)) {
      throw httpError(403, 'Les paiements crypto sont désactivés');
    }
    const section = await getDepositCryptoConfig();
    if (!alreadyDispatched && section.enabled === false) {
      throw httpError(403, 'Les dépôts crypto sont désactivés');
    }
    const config = await credentials();
    if (!config.configured) throw httpError(503, 'Passerelle crypto non configurée');

    let requestSnapshot = payment.izipay_request_snapshot;
    let accounting = null;
    if (!requestSnapshot) {
      const amount = Number(payment.amount);
      const assetCode = String(payment.asset_code || '').trim().toUpperCase();
      const fullName = String(payment.customer_name || '').trim();
      const email = String(payment.customer_email || '').trim().toLowerCase();
      const refundAddress = String(payment.refund_address || '').trim();
      const providerRows = await providerAssets(config);
      const catalog = catalogMap(providerRows || []);
      const spec = ASSET_SPECS.find(candidate => {
        const asset = catalog.get(candidate.id);
        const providerCode = String(asset?.assetCode || '').trim().toUpperCase();
        return candidate.id === assetCode
          || `${candidate.coin}.${candidate.network}` === assetCode
          || providerCode === assetCode;
      });
      const asset = spec ? catalog.get(spec.id) : null;
      if (!spec || !asset) throw httpError(400, 'Cryptomonnaie ou réseau non pris en charge');
      if (!asset.isActive || !assetEnabled(section, spec)) {
        throw httpError(400, 'Cet actif ou réseau n’est pas activé');
      }
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12
          || !fullName || fullName.length > 200
          || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
          || !refundAddress || refundAddress.length > 256) {
        throw httpError(422, 'Informations de paiement crypto invalides');
      }
      const platform = await getPlatformConfig(db);
      const rate = cryptoRate(platform, spec.coin);
      if (!rate || rate <= 0) throw httpError(503, 'Le taux crypto est indisponible');
      const baseCoin = roundCryptoAmount(amount / rate);
      const minimum = numeric(asset.minimum);
      const maximum = numeric(asset.maximum, 1e12) || 1e12;
      if (baseCoin < minimum || baseCoin > maximum) {
        throw httpError(400, 'Le montant du lien est hors des limites de cet actif crypto');
      }

      const feeSplit = feePercentSplit(section, spec.coin, spec.id);
      const gatewayFixed = fixedFee(section, 'fees_gateway_fixed', spec);
      const platformFixed = fixedFee(section, 'fees_platform_fixed', spec);
      const feePct = feeSplit.gateway + feeSplit.platform;
      const feeFixed = gatewayFixed + platformFixed;
      const gatewayFee = roundCryptoAmount(
        (baseCoin * feeSplit.gateway / 100 + gatewayFixed) * rate,
      );
      const platformFee = roundCryptoAmount(
        (baseCoin * feeSplit.platform / 100 + platformFixed) * rate,
      );
      const fee = roundCryptoAmount(gatewayFee + platformFee);
      if (feePct >= 100 || fee >= amount) {
        throw httpError(503, 'Configuration de frais invalide pour cet actif');
      }
      const customerPaysFee = !['owner', 'merchant'].includes(
        String(payment.fee_bearer || 'customer').toLowerCase(),
      );
      const chargedAmount = roundCryptoAmount(
        (amount + (customerPaysFee ? fee : 0)) / rate,
      );
      const chargedAmountUsdt = roundCryptoAmount(chargedAmount * rate);
      const walletCreditAmount = customerPaysFee
        ? amount : roundCryptoAmount(amount - fee);
      if (chargedAmount < minimum || chargedAmount > maximum || walletCreditAmount <= 0) {
        throw httpError(400, 'Le montant crypto chargé est hors des limites de cet actif');
      }
      const parts = fullName.split(/\s+/);
      const providerAssetCode = String(asset.assetCode || spec.id).trim().toUpperCase();
      requestSnapshot = {
        requestedCoin: providerAssetCode,
        amount: chargedAmount.toFixed(6),
        customer: {
          firstName: parts[0] || 'Client',
          lastName: parts.slice(1).join(' ') || parts[0] || 'Client',
          email,
          refundAddress,
        },
        merchantReference: String(payment.id),
        metadata: { link_id: String(link.id), kind: 'link_payment' },
      };
      accounting = {
        coin: spec.coin,
        network: spec.network,
        asset_code: providerAssetCode,
        catalog_asset_id: spec.id,
        credit_currency: 'USDT',
        usdt_rate: rate,
        charged_amount: chargedAmount,
        charged_amount_usdt: chargedAmountUsdt,
        amount_crypto: chargedAmount,
        amount_crypto_currency: spec.coin,
        wallet_credit_amount: walletCreditAmount,
        amount_net: walletCreditAmount,
        fee,
        fee_currency: 'USDT',
        fee_pct: feePct,
        fee_fixed: feeFixed,
        gateway_fee: gatewayFee,
        platform_fee: platformFee,
        gateway_fee_pct: feeSplit.gateway,
        platform_fee_pct: feeSplit.platform,
        gateway_fee_fixed: gatewayFixed,
        platform_fee_fixed: platformFixed,
      };
    } else {
      accounting = {
        coin: payment.coin,
        network: payment.network,
        asset_code: payment.asset_code,
        catalog_asset_id: payment.catalog_asset_id,
        credit_currency: 'USDT',
        usdt_rate: Number(payment.usdt_rate),
        charged_amount: Number(payment.charged_amount),
        charged_amount_usdt: Number(payment.charged_amount_usdt),
        amount_crypto: Number(payment.charged_amount),
        amount_crypto_currency: payment.coin,
        wallet_credit_amount: Number(payment.wallet_credit_amount),
        amount_net: Number(payment.wallet_credit_amount),
        fee: Number(payment.fee),
        fee_currency: 'USDT',
        fee_pct: Number(payment.fee_pct),
        fee_fixed: Number(payment.fee_fixed),
        gateway_fee: Number(payment.gateway_fee),
        platform_fee: Number(payment.platform_fee),
        gateway_fee_pct: Number(payment.gateway_fee_pct),
        platform_fee_pct: Number(payment.platform_fee_pct),
        gateway_fee_fixed: Number(payment.gateway_fee_fixed),
        platform_fee_fixed: Number(payment.platform_fee_fixed),
      };
    }

    const timestamp = new Date().toISOString();
    await payments.update_one(
      { id: String(payment.id), status: { $in: ['creating', 'provider_unknown'] } },
      { $set: {
        ...accounting,
        izipay_request_snapshot: requestSnapshot,
        provider_dispatch_started_at: payment.provider_dispatch_started_at || timestamp,
        updated_at: timestamp,
      } },
    );
    payment = await payments.find_one({ id: String(payment.id) }, { _id: 0 });
    if (payment.izipay_intent_id && payment.deposit_address) return payment;

    let response;
    try {
      response = await fetchImpl(`${config.baseUrl}/v1/payment-intents/direct`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': `izipay-link-${payment.id}`,
        },
        body: JSON.stringify(requestSnapshot),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      await payments.update_one(
        { id: String(payment.id), status: { $in: ['creating', 'provider_unknown'] } },
        { $set: { status: 'provider_unknown', updated_at: new Date().toISOString() } },
      );
      throw httpError(502, 'Résultat du paiement inconnu; réessayez avec la même clé.');
    }

    let payload;
    try {
      const text = await response.text();
      if (text.length > 512_000) throw new Error('IziPay response too large');
      payload = JSON.parse(text);
    } catch {
      await payments.update_one(
        { id: String(payment.id), status: { $in: ['creating', 'provider_unknown'] } },
        { $set: { status: 'provider_unknown', updated_at: new Date().toISOString() } },
      );
      throw httpError(502, 'Réponse IziPay invalide; réessayez avec la même clé.');
    }
    if (!response.ok) {
      const rejected = response.status < 500;
      await payments.update_one(
        { id: String(payment.id), status: { $in: ['creating', 'provider_unknown'] } },
        { $set: {
          status: rejected ? 'failed' : 'provider_unknown',
          provider_error_code: String(payload.code || payload.errorCode || '').slice(0, 80) || null,
          ...(rejected ? { failed_at: new Date().toISOString() } : {}),
          updated_at: new Date().toISOString(),
        } },
      );
      throw httpError(rejected ? 400 : 502, rejected
        ? 'IziPay a refusé la demande de paiement.'
        : 'Résultat du paiement inconnu; réessayez avec la même clé.');
    }
    const intentId = String(payload.id || '').trim();
    const depositAddress = String(payload.depositAddress || '').trim();
    if (!intentId || !depositAddress) {
      await payments.update_one(
        { id: String(payment.id), status: { $in: ['creating', 'provider_unknown'] } },
        { $set: {
          status: 'provider_unknown',
          ...(intentId ? { izipay_intent_id: intentId } : {}),
          updated_at: new Date().toISOString(),
        } },
      );
      throw httpError(502, 'Adresse IziPay indisponible; réessayez avec la même clé.');
    }
    const providerExpiry = payload.expiresAt || null;
    const parsedExpiry = providerExpiry ? Date.parse(providerExpiry) : NaN;
    const expiresAt = Number.isFinite(parsedExpiry)
      ? new Date(parsedExpiry).toISOString()
      : new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await payments.update_one(
      { id: String(payment.id), status: { $in: ['creating', 'provider_unknown'] } },
      { $set: {
        status: 'pending',
        izipay_intent_id: intentId,
        izipay_status: String(payload.status || 'pending').toLowerCase().slice(0, 40),
        deposit_address: depositAddress,
        memo: payload.memo || null,
        memo_type: payload.memoType || null,
        amount_to_send: payload.amountToSend || payload.amountCryptoExpected || null,
        expires_at: expiresAt,
        izipay_expires_at: providerExpiry,
        updated_at: new Date().toISOString(),
      } },
    );
    return await payments.find_one({ id: String(payment.id) }, { _id: 0 });
  }

  async function settleCryptoLinkPayment(payment, providerIntent) {
    const link = await db.collection('payment_links').find_one(
      { id: String(payment.link_id), user_id: String(payment.user_id) }, { _id: 0 },
    );
    if (!link) throw httpError(503, 'Lien marchand introuvable pour le règlement');
    const net = Number(payment.wallet_credit_amount);
    const gross = Number(payment.charged_amount_usdt);
    const fee = Number(payment.fee || 0);
    const gatewayFee = Number(payment.gateway_fee || 0);
    const platformFee = Number(payment.platform_fee || 0);
    const rate = Number(payment.usdt_rate);
    if (!Number.isFinite(net) || net <= 0 || !Number.isFinite(gross)
        || gross <= 0 || net > gross || !Number.isFinite(fee) || fee < 0
        || fee > gross || Math.abs(gatewayFee + platformFee - fee) > 0.00001
        || Math.abs(gross - fee - net) > 0.00001
        || !Number.isFinite(rate) || rate <= 0) {
      throw httpError(503, 'Règlement crypto en revue: montants invalides');
    }
    const operationId = `izipay:link:${payment.id}`;
    const intentId = String(providerIntent.id || payment.izipay_intent_id || '');
    const txHash = String(
      providerIntent.txHash || providerIntent.txhash || providerIntent.transactionHash || '',
    ).slice(0, 200);
    const completedAt = new Date().toISOString();
    const mutation = await applyWalletOperation(db, {
      userId: String(link.user_id),
      operationId,
      aliases: [`izipay:intent:${intentId}`],
      direction: 'credit',
      primaryField: 'balance_usdt',
      increments: { balance_usdt: net },
      ledger: {
        id: `izipay-link-${payment.id}`,
        user_id: String(link.user_id),
        type: 'link_payment',
        direction: 'in',
        amount: net,
        currency: 'USDT',
        status: 'completed',
        reference: `BTP-LINK-${String(payment.id).slice(-16).toUpperCase()}`,
        description: `Paiement lien: ${String(link.title || '').slice(0, 150)} · ${payment.coin} ${payment.network}`,
        counterparty: String(payment.customer_email || 'client').slice(0, 200),
        created_at: payment.created_at || completedAt,
        completed_at: completedAt,
        metadata: {
          operation_id: operationId,
          wallet_operation_id: operationId,
          provider: 'izipay',
          link_id: String(link.id),
          link_payment_id: String(payment.id),
          izipay_intent_id: intentId,
          tx_hash: txHash || null,
          coin: payment.coin,
          network: payment.network,
          asset_code: payment.asset_code,
          deposit_address: payment.deposit_address,
          amount_gross: gross,
          amount_crypto: Number(payment.charged_amount),
          amount_crypto_currency: payment.coin,
          usdt_rate: rate,
          fee,
          fee_currency: 'USDT',
          fee_pct: Number(payment.fee_pct || 0),
          gateway_fee: gatewayFee,
          platform_fee: platformFee,
          amount_net: net,
          source: 'payment_link',
        },
      },
    });
    if (!['applied', 'already'].includes(mutation.state)) {
      throw httpError(mutation.state === 'idempotency_conflict' ? 409 : 503,
        'Le crédit crypto du paiement n’a pas pu être enregistré');
    }
    await db.collection('payment_links').update_one(
      { id: String(link.id), link_payment_operation_ids: { $ne: String(payment.id) } },
      {
        $inc: { payments_received: 1, total_received: net },
        $addToSet: { link_payment_operation_ids: String(payment.id) },
      },
    );
    await db.collection('payment_links').update_one(
      { id: String(link.id), single_use_claim_id: String(payment.id) },
      { $set: { active: false } },
    );
    await db.collection('link_payments').update_one(
      {
        id: String(payment.id),
        status: { $in: ['creating', 'provider_unknown', 'pending', 'confirming', 'settling'] },
      },
      { $set: {
        status: 'paid',
        paid_at: completedAt,
        izipay_status: String(providerIntent.status || 'completed').toLowerCase().slice(0, 40),
        izipay_intent_id: intentId,
        tx_hash: txHash || null,
        amount_gross: gross,
        amount_gross_usdt: gross,
        amount_crypto: Number(payment.charged_amount),
        amount_crypto_currency: payment.coin,
        fee,
        amount_net: net,
        amount_net_currency: 'USDT',
        credit_operation_id: operationId,
        ...(mutation.snapshot ? {
          balance_before: mutation.snapshot.balance_before,
          balance_after: mutation.snapshot.balance_after,
        } : {}),
        updated_at: completedAt,
      } },
    );
    return db.collection('link_payments').find_one(
      { id: String(payment.id) }, { _id: 0 },
    );
  }

  async function refreshCryptoLinkPayment(paymentId) {
    const payments = db.collection('link_payments');
    const payment = await payments.find_one(
      { id: String(paymentId), method: 'crypto' }, { _id: 0 },
    );
    if (!payment || ['paid', 'expired', 'failed'].includes(payment.status)
        || !payment.izipay_intent_id) return payment;
    let config;
    try {
      config = await credentials();
      if (!config.configured) return payment;
      const response = await fetchImpl(
        `${config.baseUrl}/v1/payment-intents/${encodeURIComponent(payment.izipay_intent_id)}`,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            accept: 'application/json',
            'content-type': 'application/json',
          },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!response.ok) return payment;
      const text = await response.text();
      if (text.length > 512_000) return payment;
      const payload = JSON.parse(text);
      const receivedId = String(payload.id || payload.intentId || '').trim();
      const merchantReference = String(
        payload.merchantReference || payload.merchant_reference || '',
      ).trim();
      if (receivedId && receivedId !== String(payment.izipay_intent_id)) {
        await payments.update_one({ id: String(payment.id), status: { $ne: 'paid' } }, {
          $set: { status: 'failed', settlement_error: 'izipay_intent_id_mismatch' },
        });
        await db.collection('payment_links').update_one(
          { id: String(payment.link_id), single_use_claim_id: String(payment.id) },
          { $unset: { single_use_claim_id: '' } },
        );
        return payments.find_one({ id: String(payment.id) }, { _id: 0 });
      }
      if (merchantReference && merchantReference !== String(payment.id)) {
        await payments.update_one({ id: String(payment.id), status: { $ne: 'paid' } }, {
          $set: { status: 'failed', settlement_error: 'izipay_merchant_reference_mismatch' },
        });
        await db.collection('payment_links').update_one(
          { id: String(payment.link_id), single_use_claim_id: String(payment.id) },
          { $unset: { single_use_claim_id: '' } },
        );
        return payments.find_one({ id: String(payment.id) }, { _id: 0 });
      }
      if (!receivedId || merchantReference !== String(payment.id)) return payment;
      const providerCoin = String(payload.requestedCoin || payload.requested_coin || '')
        .trim().toUpperCase();
      const expectedAssetCode = String(
        payment.izipay_request_snapshot?.requestedCoin || payment.asset_code || '',
      ).toUpperCase();
      if (providerCoin && providerCoin !== expectedAssetCode) {
        await payments.update_one({ id: String(payment.id), status: { $ne: 'paid' } }, {
          $set: { status: 'failed', settlement_error: 'izipay_asset_mismatch' },
        });
        await db.collection('payment_links').update_one(
          { id: String(payment.link_id), single_use_claim_id: String(payment.id) },
          { $unset: { single_use_claim_id: '' } },
        );
        return payments.find_one({ id: String(payment.id) }, { _id: 0 });
      }
      const status = String(payload.status || '').toLowerCase();
      if (['completed', 'confirmed', 'paid', 'success', 'successful'].includes(status)) {
        return await settleCryptoLinkPayment(payment, payload);
      }
      const failedStatuses = new Set([
        'expired', 'failed', 'rejected', 'canceled', 'cancelled', 'irregular',
      ]);
      if (failedStatuses.has(status)) {
        const terminal = status === 'expired' ? 'expired'
          : ['canceled', 'cancelled'].includes(status) ? 'canceled' : 'failed';
        await payments.update_one(
          { id: String(payment.id), status: { $in: ['creating', 'provider_unknown', 'pending', 'confirming'] } },
          { $set: {
            status: terminal,
            izipay_status: status,
            failed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          } },
        );
        await db.collection('payment_links').update_one(
          {
            id: String(payment.link_id),
            single_use_claim_id: String(payment.id),
          },
          { $unset: { single_use_claim_id: '' } },
        );
      } else if (['confirming', 'processing', 'partially_confirmed'].includes(status)) {
        await payments.update_one(
          { id: String(payment.id), status: { $in: ['pending', 'provider_unknown'] } },
          { $set: { status: 'confirming', izipay_status: status, updated_at: new Date().toISOString() } },
        );
      }
    } catch {
      // Provider/network failures are transient: keep the payment pending and poll again.
      return payment;
    }
    return payments.find_one({ id: String(payment.id) }, { _id: 0 });
  }

  async function createCryptoDepositIntent(userId, body) {
    const amount = Number(body.amount);
    const assetCode = String(body.asset_code || '').trim().toUpperCase();
    const idempotencyKey = String(body.idempotency_key || '').trim();
    const fullName = String(body.full_name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const refundAddress = String(body.refund_address || '').trim();
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) {
      throw httpError(400, 'Montant crypto invalide');
    }
    if (!assetCode || assetCode.length > 32
        || !/^[a-zA-Z0-9._-]{8,128}$/.test(idempotencyKey)
        || !fullName || fullName.length > 200
        || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)
        || !refundAddress || refundAddress.length > 256) {
      throw httpError(422, 'Informations du dépôt crypto invalides');
    }
    if (Number(amount.toFixed(6)) !== amount) {
      throw httpError(400, 'Le montant crypto accepte au maximum 6 décimales');
    }

    const features = await getAppFeatures(db);
    if (features.wallet_crypto_enabled === false
        || features.deposit_crypto_enabled === false) {
      throw httpError(403, 'Les dépôts crypto sont désactivés');
    }
    const section = await getDepositCryptoConfig();
    if (section.enabled === false) throw httpError(403, 'Les dépôts crypto sont désactivés');
    const config = await credentials();
    if (!config.configured) throw httpError(503, 'Passerelle crypto non configurée');
    const providerRows = await providerAssets(config);
    const catalog = catalogMap(providerRows || []);
    const spec = ASSET_SPECS.find(candidate => {
      const asset = catalog.get(candidate.id);
      const providerCode = String(asset?.assetCode || '').trim().toUpperCase();
      return candidate.id === assetCode
        || `${candidate.coin}.${candidate.network}` === assetCode
        || providerCode === assetCode;
    });
    if (!spec) throw httpError(400, 'Cryptomonnaie ou réseau non pris en charge');
    const asset = catalog.get(spec.id);
    if (!asset?.isActive || !assetEnabled(section, spec)) {
      throw httpError(400, 'Cet actif ou réseau n’est pas activé');
    }
    const minimum = numeric(asset.minimum);
    const maximum = numeric(asset.maximum, 1e12) || 1e12;
    if (amount < minimum || amount > maximum) {
      throw httpError(400, `Montant hors limites (${minimum} - ${maximum} ${spec.coin})`);
    }
    const platform = await getPlatformConfig(db);
    const rate = cryptoRate(platform, spec.coin);
    if (rate === null || rate <= 0) {
      throw httpError(503, 'Le taux de conversion crypto est indisponible');
    }
    const feeSplit = feePercentSplit(section, spec.coin, spec.id);
    const gatewayFixed = fixedFee(section, 'fees_gateway_fixed', spec);
    const platformFixed = fixedFee(section, 'fees_platform_fixed', spec);
    const feePct = feeSplit.gateway + feeSplit.platform;
    const feeFixed = gatewayFixed + platformFixed;
    const feeEstimate = (amount * feePct / 100 + feeFixed) * rate;
    if (feePct >= 100 || amount * rate - feeEstimate <= 0) {
      throw httpError(503, 'Configuration de frais crypto invalide');
    }

    const fingerprint = createHash('sha256').update(JSON.stringify({
      amount, asset_code: assetCode, full_name: fullName, email, refund_address: refundAddress,
    })).digest('hex');
    const id = createHash('sha256')
      .update(`izipay-deposit:${userId}:${idempotencyKey}`).digest('hex').slice(0, 32);
    const deposits = db.collection('crypto_deposits');
    let existing = await deposits.find_one({ id, user_id: String(userId) }, { _id: 0 });
    if (existing && existing.request_fingerprint !== fingerprint) {
      throw httpError(409, 'Cette clé d’idempotence est déjà associée à un autre dépôt');
    }
    if (existing?.deposit_address
        || ['confirmed', 'expired', 'failed'].includes(existing?.status)) return existing;

    const createdAt = existing?.created_at || new Date().toISOString();
    const local = {
      ...(existing || {}),
      id,
      user_id: String(userId),
      idempotency_key: idempotencyKey,
      request_fingerprint: fingerprint,
      amount,
      asset_code: assetCode,
      catalog_asset_id: spec.id,
      coin: spec.coin,
      network: spec.network,
      customer_email: email,
      customer_name: fullName,
      credit_currency: spec.id,
      wallet_field: walletField(spec),
      usdt_rate: rate,
      fee_pct: feePct,
      fee_fixed: feeFixed,
      gateway_fee_pct: feeSplit.gateway,
      platform_fee_pct: feeSplit.platform,
      gateway_fee_fixed: gatewayFixed,
      platform_fee_fixed: platformFixed,
      status: existing?.status || 'creating',
      created_at: createdAt,
      updated_at: new Date().toISOString(),
    };
    if (!existing) {
      try {
        await deposits.insert_one(local);
      } catch {
        existing = await deposits.find_one({ id, user_id: String(userId) }, { _id: 0 });
        if (!existing || existing.request_fingerprint !== fingerprint) {
          throw httpError(409, 'Dépôt déjà en cours de création');
        }
      }
    }

    const parts = fullName.split(/\s+/, 2);
    const providerBody = {
      requestedCoin: assetCode,
      amount: amount.toFixed(6),
      customer: {
        firstName: parts[0] || 'Client',
        lastName: parts[1] || parts[0] || 'Client',
        email,
        refundAddress,
      },
      merchantReference: id,
      metadata: { user_id: String(userId), kind: 'crypto_deposit' },
    };
    let response;
    try {
      response = await fetchImpl(`${config.baseUrl}/v1/payment-intents/direct`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          accept: 'application/json',
          'content-type': 'application/json',
          'idempotency-key': `izipay-deposit-${id}`,
        },
        body: JSON.stringify(providerBody),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      await deposits.update_one({ id, user_id: String(userId) }, {
        $set: { status: 'provider_unknown', updated_at: new Date().toISOString() },
      });
      throw httpError(502, 'Résultat du dépôt inconnu; réessayez avec la même clé.');
    }
    let payload;
    try {
      const text = await response.text();
      if (text.length > 512_000) throw new Error('oversized provider response');
      payload = JSON.parse(text);
    } catch {
      await deposits.update_one({ id, user_id: String(userId) }, {
        $set: { status: 'provider_unknown', updated_at: new Date().toISOString() },
      });
      throw httpError(502, 'Réponse crypto invalide; réessayez avec la même clé.');
    }
    if (!response.ok) {
      const failed = response.status < 500;
      await deposits.update_one({ id, user_id: String(userId) }, {
        $set: {
          status: failed ? 'failed' : 'provider_unknown',
          updated_at: new Date().toISOString(),
        },
      });
      throw httpError(failed ? 400 : 502, failed
        ? 'La passerelle a refusé le dépôt crypto.'
        : 'Résultat du dépôt inconnu; réessayez avec la même clé.');
    }
    const depositAddress = String(payload.depositAddress || '').trim();
    if (!depositAddress) {
      await deposits.update_one({ id, user_id: String(userId) }, {
        $set: { status: 'provider_unknown', updated_at: new Date().toISOString() },
      });
      throw httpError(502, 'Adresse de dépôt indisponible; réessayez avec la même clé.');
    }
    const providerExpiry = payload.expiresAt || null;
    const parsedExpiry = providerExpiry ? Date.parse(providerExpiry) : NaN;
    const expiresAt = Number.isFinite(parsedExpiry)
      ? new Date(parsedExpiry).toISOString()
      : new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const result = {
      ...local,
      status: String(payload.status || 'pending').toLowerCase(),
      izipay_intent_id: payload.id || null,
      deposit_address: depositAddress,
      memo: payload.memo || null,
      memo_type: payload.memoType || null,
      amount_to_send: payload.amountToSend || payload.amountCryptoExpected || null,
      expires_at: expiresAt,
      izipay_expires_at: providerExpiry,
      updated_at: new Date().toISOString(),
    };
    await deposits.update_one({ id, user_id: String(userId) }, { $set: result });
    return result;
  }

  async function createCryptoPayoutRequest(userId, body, idempotencyKey) {
    const ownerId = String(userId || '');
    const amount = Number(body.amount);
    const requestedAsset = String(body.asset_code || '').trim().toUpperCase();
    const networkCode = String(body.network_code || '').trim().toUpperCase();
    const address = String(body.wallet_address || '').trim();
    const memo = String(body.destination_memo || '').trim();
    const feeBearer = String(body.fee_bearer || 'sender').trim().toLowerCase();
    const description = String(body.description || '').trim().slice(0, 500);
    const recipientName = String(body.recipient_name || '').trim().slice(0, 180);
    const key = String(idempotencyKey || body.idempotency_key || '').trim();
    if (!ownerId || !Number.isFinite(amount) || amount <= 0 || amount > 1e12
        || !/^[A-Za-z0-9._-]{8,128}$/.test(key)
        || !address || address.length > 256
        || !['sender', 'receiver'].includes(feeBearer)) {
      throw httpError(422, 'Informations du retrait crypto invalides');
    }
    if (Number(amount.toFixed(8)) !== amount) {
      throw httpError(400, 'Le montant crypto accepte au maximum 8 décimales');
    }
    const features = await getAppFeatures(db);
    if (features.wallet_crypto_enabled === false
        || features.withdrawal_crypto_enabled === false) {
      throw httpError(403, 'Les retraits crypto sont désactivés');
    }
    const section = await getTransferCryptoConfig();
    if (section.enabled === false) throw httpError(403, 'Les retraits crypto sont désactivés');
    const providerConfig = await credentials();
    if (!providerConfig.configured) throw httpError(503, 'Passerelle crypto non configurée');
    const assets = await providerAssets(providerConfig);
    const catalog = catalogMap(assets || []);
    const spec = ASSET_SPECS.find(candidate => {
      const providerCode = String(catalog.get(candidate.id)?.assetCode || '')
        .trim().toUpperCase();
      const aliasesMatch = candidate.coin === requestedAsset
        && (!networkCode || networkMatches(candidate, networkCode));
      return candidate.id === requestedAsset
        || `${candidate.coin}.${candidate.network}` === requestedAsset
        || providerCode === requestedAsset
        || aliasesMatch;
    });
    if (!spec) throw httpError(400, 'Cryptomonnaie ou réseau non pris en charge');
    const asset = catalog.get(spec.id);
    if (!asset?.isActive || !assetEnabled(section, spec)) {
      throw httpError(400, 'Cet actif ou réseau n’est pas activé pour les retraits');
    }
    if (networkCode && !networkMatches(spec, networkCode)) {
      throw httpError(400, 'Le réseau ne correspond pas à l’actif sélectionné');
    }
    let addressRegex;
    try { addressRegex = new RegExp(spec.addressRegex); } catch {
      throw httpError(503, 'Configuration du réseau crypto invalide');
    }
    if (!addressRegex.test(address)) throw httpError(400, 'Adresse crypto invalide pour ce réseau');
    if ((asset.memoRequired || spec.memoRequired) && !memo) {
      throw httpError(400, 'Le mémo/tag de destination est requis pour ce réseau');
    }
    const minimum = numeric(asset.minimum);
    const maximum = numeric(asset.maximum, 1e12) || 1e12;
    if (amount < minimum || amount > maximum) {
      throw httpError(400, `Montant hors limites (${minimum} - ${maximum} ${spec.coin})`);
    }
    const wallet = walletField(spec);
    if (!wallet) throw httpError(400, 'Portefeuille crypto/réseau invalide');
    const feeSplit = feePercentSplit(section, spec.coin, spec.id);
    const feePct = feeSplit.gateway + feeSplit.platform;
    const gatewayFixed = fixedFee(section, 'fees_gateway_fixed', spec);
    const platformFixed = fixedFee(section, 'fees_platform_fixed', spec);
    const fee = Math.round(
      ((amount * feePct / 100) + gatewayFixed + platformFixed + Number.EPSILON) * 1e8,
    ) / 1e8;
    if (feePct >= 100 || fee >= amount) {
      throw httpError(503, 'Configuration des frais crypto invalide');
    }
    const totalDebit = Math.round(
      (amount + (feeBearer === 'sender' ? fee : 0) + Number.EPSILON) * 1e8,
    ) / 1e8;
    const recipientGets = feeBearer === 'sender' ? amount : Math.round(
      (amount - fee + Number.EPSILON) * 1e8,
    ) / 1e8;
    if (recipientGets <= 0) throw httpError(503, 'Le montant net après frais est invalide');
    const requestFingerprint = createHash('sha256').update(JSON.stringify({
      asset_code: spec.id,
      network_code: spec.network,
      amount,
      address,
      memo,
      fee_bearer: feeBearer,
      recipient_name: recipientName,
      description,
    })).digest('hex');
    const stableId = createHash('sha256')
      .update(`crypto-payout:${ownerId}:${key}`).digest('hex').slice(0, 32);
    const operationId = `crypto-transfer:${stableId}`;
    const transactionId = `crypto-${stableId}`;
    const reference = `BTP-CRY-${stableId.slice(0, 16).toUpperCase()}`;
    const timestamp = new Date().toISOString();
    const mutation = await applyWalletOperation(db, {
      userId: ownerId,
      operationId,
      requestFingerprint,
      direction: 'debit',
      primaryField: wallet,
      increments: { [wallet]: -totalDebit },
      requiredBalanceField: wallet,
      requiredBalanceAmount: totalDebit,
      ledger: {
        id: transactionId,
        user_id: ownerId,
        type: 'transfer',
        direction: 'out',
        amount: totalDebit,
        currency: spec.id,
        status: 'pending',
        reference,
        counterparty: address,
        description: description || 'Retrait crypto en attente de traitement manuel',
        created_at: timestamp,
        metadata: {
          transfer_type: 'biz_to_crypto',
          amount_gross: amount,
          operation_id: operationId,
          wallet_operation_id: operationId,
          request_fingerprint: requestFingerprint,
          asset_code: spec.id,
          coin: spec.coin,
          network: spec.network,
          wallet_address: address,
          destination_address: address,
          destination_memo: memo || null,
          recipient_name: recipientName || null,
          amount_requested: amount,
          amount_net: recipientGets,
          fee,
          fee_pct: feePct,
          gateway_fee: Math.round((amount * feeSplit.gateway / 100
            + gatewayFixed + Number.EPSILON) * 1e8) / 1e8,
          platform_fee: Math.round((amount * feeSplit.platform / 100
            + platformFixed + Number.EPSILON) * 1e8) / 1e8,
          total_debit: totalDebit,
          fee_bearer: feeBearer,
          idempotency_key: key,
          manual_review_required: true,
          auto_withdrawals_disabled: true,
          pending_manual: true,
        },
      },
    });
    if (mutation.state === 'insufficient') throw httpError(400, 'Solde crypto insuffisant (frais inclus)');
    if (mutation.state === 'missing_user') throw httpError(404, 'Utilisateur introuvable');
    if (mutation.state === 'idempotency_conflict' || mutation.state === 'duplicate_event') {
      throw httpError(409, 'Cette clé d’idempotence est déjà associée à un autre retrait');
    }
    if (!['applied', 'already'].includes(mutation.state)) {
      throw httpError(503, 'Le retrait crypto n’a pas pu être enregistré');
    }
    const transaction = await db.collection('transactions').find_one(
      { id: transactionId, user_id: ownerId }, { _id: 0 },
    );
    if (!transaction) throw httpError(503, 'Le retrait crypto enregistré est introuvable');
    return {
      ...transaction,
      pending_manual: true,
      recipient_gets: recipientGets,
      total_debit: totalDebit,
    };
  }

  async function integrationExchangeQuote(fromCurrency, toCurrency, amount) {
    const query = new URLSearchParams({
      from_currency: String(fromCurrency ?? ''),
      to_currency: String(toCurrency ?? ''),
      amount: String(amount ?? ''),
    });
    const response = {
      writeHead(status) { this.status = status; },
      end(payload) { this.body = JSON.parse(payload); },
    };
    const handled = await handleRoute({
      method: 'GET',
      url: `/api/conversion/quote?${query}`,
      headers: {},
    }, response);
    if (!handled || response.status !== 200) {
      const detail = response.body?.detail;
      throw Object.assign(new Error(
        typeof detail === 'string' ? detail : 'Exchange quote unavailable.',
      ), { status: response.status || 503, detail });
    }
    return response.body;
  }

  return {
    handleRoute,
    integrationCryptoAssets,
    integrationExchangeQuote,
    getPayout,
    createCryptoDepositIntent,
    createCryptoLinkPaymentIntent,
    refreshCryptoLinkPayment,
    createCryptoPayoutRequest,
    activeExchangeAssets,
    providerAssets,
    exchangeRateContext,
    computeConversionFee,
  };
}

module.exports = {
  ASSET_SPECS,
  catalogMap,
  createCryptoCatalogRoutes,
  feePercentSplit,
  walletField,
};
