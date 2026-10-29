'use strict';

const Decimal = require('decimal.js');
const security = require('./security.cjs');
const { authorizeAdmin } = require('./admin-authorization.cjs');

const DEFAULT_BASE_URL = 'https://dashboard.mbiyo.africa/api/v1';

function reply(res, status, body) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function valueOf(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function rowsFrom(payload, keys, mappingValues = false) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  for (const key of keys) {
    if (payload[key] !== undefined) return rowsFrom(payload[key], keys, mappingValues);
  }
  if (payload.data !== undefined) return rowsFrom(payload.data, keys, mappingValues);
  if (mappingValues) {
    return Object.entries(payload).map(([currency, value]) => (
      value && typeof value === 'object' && !Array.isArray(value)
        ? { currency: value.currency || currency, ...value }
        : { currency, balance: value }
    ));
  }
  return [];
}

function moneyText(value, optional = false) {
  if (value === null || value === undefined || value === '') {
    if (optional) return null;
    throw new Error('missing provider amount');
  }
  const amount = new Decimal(String(value));
  if (!amount.isFinite()) throw new Error('invalid provider amount');
  return amount.toFixed();
}

function asBoolean(object, keys) {
  const value = valueOf(object, keys);
  return value === true || value === 1
    || ['true', '1', 'yes', 'oui'].includes(String(value || '').toLowerCase());
}

function currencyCode(item) {
  const currency = String(valueOf(item, [
    'currency', 'currency_code', 'currencyCode', 'currency_code_iso', 'code',
  ]) || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/.test(currency)) throw new Error('invalid provider currency');
  return currency;
}

function sanitizeWallets(payload) {
  return rowsFrom(payload, ['wallets', 'wallet', 'walletList', 'wallet_data', 'items'])
    .map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('invalid provider wallet');
      }
      const id = String(valueOf(item, [
        'id', 'wallet_id', 'walletId', 'walletIdentifier', 'wallet_code', 'code', 'name',
      ]) || '').trim();
      if (!id) throw new Error('missing provider wallet id');
      const countryCode = String(valueOf(item, ['country_code', 'countryCode', 'iso2']) || '')
        .trim().toUpperCase() || null;
      const countryValue = String(valueOf(item, ['country_name', 'countryName', 'country']) || '')
        .trim();
      const capabilities = item.capabilities && typeof item.capabilities === 'object'
        ? item.capabilities : {};
      return {
        id,
        currency: currencyCode(item),
        country: countryValue || countryCode,
        country_code: countryCode,
        balance: moneyText(valueOf(item, ['balance', 'amount', 'available_balance', 'available'])),
        raw_amount: moneyText(valueOf(item, ['raw_amount', 'rawAmount']), true),
        topup: asBoolean(item, ['topup', 'top_up', 'can_top_up', 'canTopUp'])
          || asBoolean(capabilities, ['topup', 'top_up', 'can_top_up']),
        payout: asBoolean(item, ['payout', 'can_payout', 'canPayout'])
          || asBoolean(capabilities, ['payout', 'can_payout']),
        local_swap: asBoolean(item, ['local_swap', 'localSwap', 'can_local_swap', 'canLocalSwap'])
          || asBoolean(capabilities, ['local_swap', 'localSwap', 'can_local_swap']),
      };
    });
}

function sanitizeNetworks(payload) {
  return rowsFrom(payload, [
    'network_balances', 'networkBalances', 'network_balance',
    'networks', 'network', 'operators', 'balance', 'items',
  ]).map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('invalid provider network');
    }
    const countryCode = String(valueOf(item, ['country_code', 'countryCode', 'iso2', 'country']) || '')
      .trim().toUpperCase();
    const network = String(valueOf(item, [
      'network', 'network_code', 'networkCode', 'networkName',
      'operator_code', 'operatorCode', 'operator', 'provider',
    ]) || '').trim();
    if (!/^[A-Z]{2,3}$/.test(countryCode) || !network) {
      throw new Error('missing provider network identity');
    }
    const operator = String(valueOf(item, [
      'operator_name', 'operatorName', 'providerName', 'provider', 'operator',
    ]) || network).trim();
    return {
      network,
      label: String(valueOf(item, ['label', 'network_label', 'networkLabel', 'name']) || network)
        .trim(),
      operator,
      country: String(valueOf(item, ['country_name', 'countryName']) || countryCode).trim(),
      country_code: countryCode,
      currency: currencyCode(item),
      balance: moneyText(valueOf(item, ['balance', 'amount', 'available_balance', 'available'])),
      wallet_id: String(valueOf(item, ['wallet_id', 'walletId', 'wallet', 'id']) || '').trim() || null,
    };
  });
}

function sanitizeTotals(payload) {
  const records = rowsFrom(payload, [
    'balances', 'wallet_balances', 'wallet_totals', 'walletTotals',
    'totals', 'wallets', 'wallet', 'items',
  ], true);
  const totals = new Map();
  for (const item of records) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('invalid provider balance row');
    }
    const currency = currencyCode(item);
    const amount = new Decimal(moneyText(valueOf(item, [
      'balance', 'amount', 'available_balance', 'available', 'total', 'value',
    ])));
    totals.set(currency, (totals.get(currency) || new Decimal(0)).plus(amount));
  }
  return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, balance]) => ({ currency, balance: balance.toFixed() }));
}

function loadProviderConfig(saved, env) {
  let apiKey = '';
  try {
    if (saved?.api_key_encrypted || saved?.secret_key_encrypted) {
      const key = security.fernetKey(env.SESSION_SECRET);
      const encrypted = saved.api_key_encrypted || saved.secret_key_encrypted;
      apiKey = security.decryptFernet(encrypted, key);
    }
  } catch {
    const error = new Error('Configuration Mbiyo illisible');
    error.status = 503;
    throw error;
  }
  apiKey = apiKey || String(env.MBIYO_API_KEY || '').trim();
  let baseUrl;
  try {
    baseUrl = new URL(saved?.base_url || env.MBIYO_BASE_URL || DEFAULT_BASE_URL);
  } catch {
    const error = new Error('Configuration Mbiyo invalide');
    error.status = 503;
    throw error;
  }
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password
      || !(baseUrl.hostname === 'mbiyo.africa'
        || baseUrl.hostname.endsWith('.mbiyo.africa'))) {
    const error = new Error('Configuration Mbiyo invalide');
    error.status = 503;
    throw error;
  }
  return {
    apiKey,
    mode: String(saved?.mode || 'test'),
    baseUrl: baseUrl.toString().replace(/\/+$/, ''),
    enabled: saved?.enabled === true,
  };
}

function createAdminFundsRoutes({
  db, sessionService, env = process.env, fetchImpl = globalThis.fetch,
}) {
  async function handleRoute(req, res) {
    if (req.method !== 'GET') return false;
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch { return false; }
    if (url.pathname !== '/api/admin/funds') return false;

    try {
      await authorizeAdmin(req, {
        db, sessionService, env,
        permission: 'providers:read',
        action: 'admin_read_provider_funds',
      });
      const currency = String(url.searchParams.get('currency') || '').trim().toUpperCase();
      const countryCode = String(url.searchParams.get('country_code') || '').trim().toUpperCase();
      if ((currency && !/^[A-Z]{3}$/.test(currency))
          || (countryCode && !/^[A-Z]{2}$/.test(countryCode))) {
        reply(res, 422, { detail: 'Filtre devise ou pays invalide.' });
        return true;
      }
      const saved = await db.collection('settings').find_one(
        { id: 'payment_provider_mbiyo' }, { _id: 0 },
      );
      const config = loadProviderConfig(saved, env);
      if (!config.enabled || !config.apiKey) {
        reply(res, 409, { detail: 'Mbiyo est désactivé ou non configuré.' });
        return true;
      }
      if (typeof fetchImpl !== 'function') throw Object.assign(new Error('fetch unavailable'), { status: 503 });
      const headers = {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      };
      const base = config.baseUrl;
      const query = new URLSearchParams();
      if (currency) query.set('currency', currency);
      const networkQuery = new URLSearchParams(query);
      if (countryCode) networkQuery.set('country_code', countryCode);
      const urls = [
        `${base}/wallets${query.size ? `?${query}` : ''}`,
        `${base}/balances${query.size ? `?${query}` : ''}`,
        `${base}/balance/networks${networkQuery.size ? `?${networkQuery}` : ''}`,
      ];
      const responses = await Promise.all(urls.map(endpoint => fetchImpl(endpoint, {
        method: 'GET', headers, signal: AbortSignal.timeout(20_000),
      })));
      if (responses.some(response => !response.ok)) {
        const error = new Error('Mbiyo request failed');
        error.status = 502;
        throw error;
      }
      const payloads = await Promise.all(responses.map(response => response.json()));
      let wallets;
      let networks;
      let walletTotals;
      try {
        wallets = sanitizeWallets(payloads[0]);
        walletTotals = sanitizeTotals(payloads[1]);
        networks = sanitizeNetworks(payloads[2]);
      } catch {
        const error = new Error('Mbiyo a retourné un relevé de soldes invalide.');
        error.status = 502;
        throw error;
      }
      reply(res, 200, {
        provider: 'mbiyo',
        mode: config.mode,
        refreshed_at: new Date().toISOString(),
        wallets,
        network_balances: networks,
        wallet_totals: walletTotals,
      });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 503;
      reply(res, status, {
        detail: status === 502 ? 'Mbiyo a refusé ou invalidé la lecture des soldes.'
          : status === 503 ? 'Le service de soldes est temporairement indisponible.'
            : error.message,
      });
    }
    return true;
  }

  return { handleRoute };
}

module.exports = {
  createAdminFundsRoutes, sanitizeWallets, sanitizeNetworks, sanitizeTotals, loadProviderConfig,
};
