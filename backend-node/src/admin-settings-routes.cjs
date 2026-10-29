'use strict';

const crypto = require('node:crypto');
const { authorizeAdmin } = require('./admin-authorization.cjs');
const { getAppFeatures, getPlatformConfig } = require('./public-config-routes.cjs');

const FEATURE_BOOLEAN_KEYS = [
  'mobile_money_enabled', 'crypto_enabled',
  'wallet_xof_enabled', 'wallet_xaf_enabled', 'wallet_crypto_enabled',
  'deposit_xof_enabled', 'deposit_xaf_enabled', 'deposit_crypto_enabled',
  'withdrawal_xof_enabled', 'withdrawal_xaf_enabled', 'withdrawal_crypto_enabled',
  'links_enabled', 'payment_api_enabled',
];
const FEATURE_STRING_KEYS = [
  'mobile_money_coming_soon_message', 'crypto_coming_soon_message',
];
const SUPPORTED_CONVERSION_PAIRS = [
  ['USDT', 'XOF'], ['USDT', 'XAF'], ['XOF', 'USDT'],
  ['XAF', 'USDT'], ['XOF', 'XAF'], ['XAF', 'XOF'],
];
const OBJECT_CONFIG_KEYS = [
  'conversion_rates', 'conversion_limits', 'conversion_pairs_enabled', 'conversion_fee',
];

function reply(res, status, body) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error('Corps de requête trop volumineux');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    const error = new Error('Corps JSON invalide');
    error.status = 400;
    throw error;
  }
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function conversionView(config) {
  return {
    rates: config.conversion_rates || {},
    crypto_usdt_rates: config.crypto_usdt_rates || { USDT: 1 },
    crypto_usdt_rates_updated_at: config.crypto_usdt_rates_updated_at ?? null,
    limits: config.conversion_limits || {},
    pairs_enabled: config.conversion_pairs_enabled || {},
    fee: config.conversion_fee || {},
    supported_pairs: SUPPORTED_CONVERSION_PAIRS.map(([from, to]) => `${from}_${to}`),
  };
}

function createAdminSettingsRoutes({ db, sessionService, env = process.env }) {
  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const routeMethods = new Map([
      ['/api/admin/settings/features', new Set(['GET', 'PATCH'])],
      ['/api/admin/platform/config', new Set(['GET', 'PATCH'])],
      ['/api/admin/conversion/config', new Set(['GET', 'PATCH'])],
    ]);
    const methods = routeMethods.get(path);
    if (!methods || !methods.has(req.method)) return false;

    const isConversion = path === '/api/admin/conversion/config';
    const isPlatform = path === '/api/admin/platform/config';
    const isWrite = req.method === 'PATCH';
    const permission = isConversion
      ? (isWrite ? 'fees:write' : 'fees:read')
      : (isWrite ? 'settings:write' : 'settings:read');
    const action = isConversion
      ? (isWrite ? 'update_conversion_config' : 'read_conversion_config')
      : isPlatform
        ? (isWrite ? 'update_platform_config' : 'read_platform_config')
        : (isWrite ? 'update_app_features' : 'read_app_features');

    try {
      const { admin } = await authorizeAdmin(req, {
        db, sessionService, env, permission, action,
      });

      if (!isWrite && !isConversion && !isPlatform) {
        reply(res, 200, await getAppFeatures(db));
        return true;
      }
      if (!isWrite && isPlatform) {
        reply(res, 200, await getPlatformConfig(db));
        return true;
      }
      if (!isWrite && isConversion) {
        reply(res, 200, conversionView(await getPlatformConfig(db)));
        return true;
      }

      const body = await readJson(req);
      const updates = {};
      if (isConversion) {
        for (const key of OBJECT_CONFIG_KEYS) {
          if (body[key] === undefined) continue;
          if (!body[key] || typeof body[key] !== 'object' || Array.isArray(body[key])) {
            throw fail(422, `Configuration invalide : ${key}`);
          }
          updates[key] = body[key];
        }
        if (body.crypto_usdt_rates !== undefined) {
          if (!body.crypto_usdt_rates || typeof body.crypto_usdt_rates !== 'object'
              || Array.isArray(body.crypto_usdt_rates)) {
            throw fail(422, 'Configuration invalide : crypto_usdt_rates');
          }
          const cryptoRates = { USDT: 1 };
          for (const [rawCoin, rawRate] of Object.entries(body.crypto_usdt_rates)) {
            const coin = String(rawCoin || '').trim().toUpperCase();
            if (coin === 'USDT' || rawRate === null || rawRate === '') continue;
            if (!/^[A-Z0-9]{2,16}$/.test(coin)) {
              throw fail(400, `Code crypto invalide : ${coin || '(vide)'}`);
            }
            const rate = Number(rawRate);
            if (!Number.isFinite(rate) || rate <= 0 || rate > 1e15) {
              throw fail(400, `Taux USDT invalide pour ${coin}`);
            }
            cryptoRates[coin] = rate;
          }
          updates.crypto_usdt_rates = cryptoRates;
          updates.crypto_usdt_rates_updated_at = new Date().toISOString();
        }
      } else if (isPlatform) {
        if (body.conversion_fee !== undefined) {
          if (!body.conversion_fee || typeof body.conversion_fee !== 'object'
              || Array.isArray(body.conversion_fee)) {
            throw fail(422, 'Configuration invalide : conversion_fee');
          }
          updates.conversion_fee = body.conversion_fee;
        }
        if (body.auto_withdrawals_disabled !== undefined) {
          if (typeof body.auto_withdrawals_disabled !== 'boolean') {
            throw fail(422, 'auto_withdrawals_disabled doit être un booléen');
          }
          updates.auto_withdrawals_disabled = body.auto_withdrawals_disabled;
        }
      } else {
        for (const key of FEATURE_BOOLEAN_KEYS) {
          if (body[key] === undefined) continue;
          if (typeof body[key] !== 'boolean') throw fail(422, `${key} doit être un booléen`);
          updates[key] = body[key];
        }
        for (const key of FEATURE_STRING_KEYS) {
          if (body[key] === undefined) continue;
          if (typeof body[key] !== 'string' || body[key].length > 500) {
            throw fail(422, `${key} est invalide`);
          }
          updates[key] = body[key];
        }
      }

      if (!Object.keys(updates).length) throw fail(400, 'Aucune modification');
      // Retain the action details expected by the existing administration log.
      await db.collection('admin_logs').insert_one({
        id: crypto.randomUUID(),
        admin_id: admin.id,
        admin_username: admin.username || null,
        action,
        details: Object.keys(updates),
        created_at: new Date().toISOString(),
        ip: '',
      });
      await db.collection('settings').update_one(
        { id: isConversion || isPlatform ? 'platform_config' : 'app_features' },
        { $set: updates },
        true,
      );

      if (isConversion) reply(res, 200, conversionView(await getPlatformConfig(db)));
      else if (isPlatform) reply(res, 200, await getPlatformConfig(db));
      else reply(res, 200, await getAppFeatures(db));
      return true;
    } catch (error) {
      reply(res, error.status || 500, {
        detail: error.code
          ? { code: error.code, message: error.message }
          : error.message || 'Erreur interne.',
      });
      return true;
    }
  }
  return { handleRoute };
}

module.exports = { createAdminSettingsRoutes, conversionView };
