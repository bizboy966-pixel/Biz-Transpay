'use strict';

const { randomUUID } = require('node:crypto');
const { authorizeAdmin } = require('./admin-authorization.cjs');
const { readJson } = require('./auth-login.cjs');
const security = require('./security.cjs');

const CATALOG_FIELDS = [
  'id', 'provider', 'country', 'country_label', 'code', 'name', 'currency',
  'endpoint_slug', 'network', 'operator', 'public_code', 'withdraw_mode',
  'active', 'archived', 'hidden', 'otp_required', 'ussd_code',
  'gateway_fee_pct', 'gateway_fee_fixed', 'platform_fee_pct',
  'platform_fee_fixed', 'fee_pct', 'fee_fixed', 'min', 'max',
  'amount_increment', 'payment_flow',
];
const FEE_FIELDS = [
  'gateway_fee_pct', 'gateway_fee_fixed', 'platform_fee_pct',
  'platform_fee_fixed', 'fee_pct', 'fee_fixed', 'min', 'max',
];
const PROVIDERS = {
  paydunya: {
    id: 'payment_provider_paydunya',
    permission: 'providers',
    fields: ['master_key', 'public_key', 'private_key', 'token'],
    env: {
      master_key: 'PAYDUNYA_MASTER_KEY',
      public_key: 'PAYDUNYA_PUBLIC_KEY',
      private_key: 'PAYDUNYA_PRIVATE_KEY',
      token: 'PAYDUNYA_TOKEN',
    },
  },
  izipay: {
    id: 'payment_provider_izipay',
    permission: 'providers',
    fields: ['api_key', 'webhook_secret'],
    env: {
      api_key: 'IZIPAY_API_KEY',
      webhook_secret: 'IZIPAY_WEBHOOK_SECRET',
    },
  },
  afribapay: {
    id: 'payment_provider_afribapay',
    permission: 'providers',
    fields: ['api_user', 'api_key', 'merchant_key', 'agent_id'],
    env: {},
  },
  mbiyo: {
    id: 'payment_provider_mbiyo',
    permission: 'providers',
    fields: ['public_key', 'secret_key', 'webhook_secret'],
    env: {
      public_key: 'MBIYO_PUBLIC_KEY',
      secret_key: 'MBIYO_SECRET_KEY',
      webhook_secret: 'MBIYO_WEBHOOK_SECRET',
    },
  },
};

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function reply(res, status, body) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function bool(value, field) {
  if (typeof value !== 'boolean') throw httpError(422, `${field} doit être booléen`);
  return value;
}

function number(value, field, { nullable = false, max = 1e12 } = {}) {
  if (nullable && (value === null || value === '')) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) {
    throw httpError(422, `${field} doit être un nombre positif valide`);
  }
  return parsed;
}

function safeCatalogRow(raw) {
  return Object.fromEntries(CATALOG_FIELDS
    .filter(key => Object.hasOwn(raw, key))
    .map(key => [key, raw[key]]));
}

function validateCatalogRows(value, provider, currentRows = []) {
  if (!Array.isArray(value) || value.length > 500) {
    throw httpError(422, 'Le catalogue doit contenir au maximum 500 lignes');
  }
  const rows = [];
  const ids = new Set();
  const routes = new Set();
  const currentById = new Map((Array.isArray(currentRows) ? currentRows : [])
    .filter(isObject).map(row => [String(row.id || ''), row]));

  for (const input of value) {
    if (!isObject(input)) throw httpError(422, 'Chaque ligne du catalogue doit être un objet');
    const row = safeCatalogRow(input);
    const id = String(row.id || '').trim();
    const country = String(row.country || '').trim().toUpperCase();
    const code = String(row.code || '').trim();
    const currency = String(row.currency || '').trim().toUpperCase();
    if (!id || id.length > 120 || ids.has(id)
        || !/^[A-Z0-9_-]{2,12}$/.test(country)
        || !/^[A-Za-z0-9_-]{2,100}$/.test(code)
        || !/^[A-Z]{3,5}$/.test(currency)) {
      throw httpError(422, 'Identifiant, pays, opérateur ou devise invalide dans le catalogue');
    }
    ids.add(id);
    const routeKey = `${country}:${code.toLowerCase()}:${currency}`;
    if (routes.has(routeKey)) throw httpError(422, 'Une route opérateur est présente plusieurs fois');
    routes.add(routeKey);
    if (typeof row.name !== 'string' || !row.name.trim() || row.name.length > 120) {
      throw httpError(422, 'Le nom de l’opérateur est obligatoire');
    }
    if (provider === 'paydunya'
        && !/^[A-Za-z0-9_-]{2,100}$/.test(String(row.endpoint_slug || ''))) {
      throw httpError(422, 'L’endpoint PayDunya est invalide');
    }
    if (provider === 'afribapay') {
      const existing = currentById.get(id);
      if (!existing) throw httpError(422, 'Cette route AfribaPAY n’existe pas dans le catalogue enregistré');
      // Keep provider routing identifiers fixed; only the fields exposed for
      // editing in the admin panel may be changed.
      for (const key of [
        'provider', 'country', 'country_label', 'currency', 'code',
        'public_code', 'operator', 'otp_required', 'ussd_code',
      ]) {
        if (Object.hasOwn(existing, key)) row[key] = existing[key];
      }
    }
    if (provider === 'mbiyo') {
      row.provider = 'mbiyo';
      row.network = String(row.network || '').trim().toLowerCase();
      if (!/^[a-z0-9_-]{2,60}$/.test(row.network)) {
        throw httpError(422, 'Le réseau Mbiyo est invalide');
      }
    }
    if (provider === 'paydunya' || provider === 'mbiyo') {
      row.country = country;
      row.code = provider === 'mbiyo' ? code.toLowerCase() : code;
      row.currency = currency;
      for (const key of ['active', 'archived', 'hidden']) {
        if (row[key] !== undefined) row[key] = bool(row[key], key);
      }
    }
    for (const key of FEE_FIELDS) {
      if (Object.hasOwn(row, key)) {
        row[key] = number(row[key], key, { nullable: true });
        // Legacy provider catalogues use a zero maximum to mean "unlimited".
        if (key === 'max' && row[key] === 0) row[key] = null;
      }
    }
    if (row.max !== undefined && row.max !== null
        && row.min !== undefined && row.min !== null && row.max < row.min) {
      throw httpError(422, 'Le montant maximum doit être supérieur au minimum');
    }
    rows.push(row);
  }

  if (provider === 'afribapay') {
    // Do not let a stale client silently remove documented provider routes.
    for (const row of currentById.values()) {
      if (!ids.has(String(row.id || ''))) rows.push(safeCatalogRow(row));
    }
  }
  return rows;
}

function validateBaseUrl(value, field) {
  const text = String(value || '').trim();
  if (!text && field.startsWith('live_')) return '';
  let parsed;
  try { parsed = new URL(text); } catch { throw httpError(422, `${field} doit être une URL HTTPS valide`); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password
      || parsed.search || parsed.hash || text.length > 500) {
    throw httpError(422, `${field} doit être une URL HTTPS valide`);
  }
  return text.replace(/\/+$/, '');
}

function configured(doc, provider, key, env) {
  return Boolean(doc[`${key}_encrypted`] || env[provider.env[key]]);
}

function publicConfig(provider, doc, env) {
  const catalog = (Array.isArray(doc.catalog) ? doc.catalog : [])
    .filter(isObject).map(safeCatalogRow);
  if (provider === 'paydunya') {
    const credentialNames = ['master_key', 'private_key', 'token'];
    const isConfigured = credentialNames.every(key => configured(doc, PROVIDERS.paydunya, key, env));
    const modes = isObject(doc.modes) ? doc.modes : {
      softpay_direct: { enabled: true }, psr: { enabled: false }, par_redirect: { enabled: false },
    };
    const publicModes = {};
    for (const name of ['softpay_direct', 'psr', 'par_redirect']) {
      const raw = modes[name];
      const enabled = isObject(raw) ? raw.enabled !== false : Boolean(raw);
      publicModes[name] = { enabled, available: Boolean(doc.enabled && isConfigured && enabled) };
    }
    const result = {
      enabled: doc.enabled !== false,
      mode: doc.mode === 'live' ? 'live' : 'test',
      store_name: doc.store_name || 'Biz-transPay',
      configured: isConfigured,
      modes: publicModes,
      mode_availability: Object.fromEntries(Object.entries(publicModes)
        .map(([name, mode]) => [name, mode.available])),
      catalog: catalog.filter(row => ['XOF', 'XAF'].includes(String(row.currency || '').toUpperCase())),
    };
    for (const key of PROVIDERS.paydunya.fields) {
      result[`${key}_configured`] = configured(doc, PROVIDERS.paydunya, key, env);
    }
    return result;
  }
  if (provider === 'izipay') {
    const apiKeyConfigured = configured(doc, PROVIDERS.izipay, 'api_key', env);
    const webhookConfigured = configured(doc, PROVIDERS.izipay, 'webhook_secret', env);
    return {
      configured: apiKeyConfigured && webhookConfigured,
      api_key_configured: apiKeyConfigured,
      webhook_secret_configured: webhookConfigured,
    };
  }
  if (provider === 'mbiyo') {
    const secretConfigured = Boolean(doc.secret_key_encrypted || doc.api_key_encrypted
      || env.MBIYO_SECRET_KEY || env.MBIYO_API_KEY);
    return {
      enabled: doc.enabled === true,
      mode: doc.mode === 'live' ? 'live' : 'test',
      configured: secretConfigured,
      public_key_configured: Boolean(doc.public_key_encrypted || env.MBIYO_PUBLIC_KEY),
      secret_key_configured: secretConfigured,
      webhook_secret_configured: Boolean(doc.webhook_secret_encrypted || env.MBIYO_WEBHOOK_SECRET),
      catalog,
    };
  }

  const hasCredential = key => Boolean(doc[`${key}_encrypted`]);
  const credentialsConfigured = PROVIDERS.afribapay.fields.every(hasCredential);
  const mode = doc.mode === 'live' ? 'live' : 'sandbox';
  const apiBaseUrl = mode === 'live'
    ? doc.live_api_base_url
    : (doc.sandbox_api_base_url || 'https://api-sandbox.afribapay.com');
  const payoutBaseUrl = mode === 'live' ? doc.live_payout_base_url : doc.sandbox_payout_base_url;
  const hasHttpsHost = value => {
    try {
      const url = new URL(String(value || ''));
      const hostname = url.hostname.toLowerCase();
      return url.protocol === 'https:' && Boolean(hostname)
        && !url.username && !url.password
        && (hostname === 'afribapay.com' || hostname.endsWith('.afribapay.com'));
    } catch { return false; }
  };
  return {
    enabled: doc.enabled === true,
    mode,
    configured: credentialsConfigured,
    payin_available: Boolean(doc.enabled && credentialsConfigured && hasHttpsHost(apiBaseUrl)),
    payout_available: Boolean(doc.enabled && credentialsConfigured && hasHttpsHost(payoutBaseUrl)),
    api_user_configured: hasCredential('api_user'),
    api_key_configured: hasCredential('api_key'),
    merchant_key_configured: hasCredential('merchant_key'),
    agent_id_configured: hasCredential('agent_id'),
    sandbox_api_base_url: doc.sandbox_api_base_url || '',
    sandbox_payout_base_url: doc.sandbox_payout_base_url || '',
    live_api_base_url: doc.live_api_base_url || '',
    live_payout_base_url: doc.live_payout_base_url || '',
    catalog,
  };
}

function providerDefaults(provider) {
  const base = {
    id: PROVIDERS[provider].id,
    enabled: false,
    catalog: [],
  };
  if (provider === 'paydunya') {
    return {
      ...base, enabled: true, mode: 'test', store_name: 'Biz-transPay',
      modes: { softpay_direct: { enabled: true }, psr: { enabled: false }, par_redirect: { enabled: false } },
    };
  }
  if (provider === 'mbiyo') return { ...base, enabled: true, mode: 'test', setup_version: 3 };
  if (provider === 'afribapay') return { ...base, mode: 'sandbox' };
  return base;
}

function createAdminPaymentProviderRoutes({ db, sessionService, sessionSecret = '', env = process.env } = {}) {
  async function handleRoute(req, res) {
    const match = /^\/api\/admin\/payment-providers\/(paydunya|izipay|afribapay|mbiyo)$/
      .exec(new URL(req.url || '/', 'http://localhost').pathname);
    if (!match || !['GET', 'PUT'].includes(String(req.method || '').toUpperCase())) return false;
    const provider = match[1];
    const isWrite = req.method === 'PUT';
    const action = `${isWrite ? 'update' : 'read'}_${provider}_provider`;
    try {
      const { admin } = await authorizeAdmin(req, {
        db, sessionService, env,
        permission: `${PROVIDERS[provider].permission}:${isWrite ? 'write' : 'read'}`,
        action,
        sensitive: isWrite,
      });
      const collection = db.collection('settings');
      const current = await collection.find_one({ id: PROVIDERS[provider].id }, { _id: 0 })
        || providerDefaults(provider);
      if (!isWrite) {
        reply(res, 200, publicConfig(provider, current, env));
        return true;
      }

      const body = await readJson(req, 512 * 1024);
      if (!isObject(body)) throw httpError(422, 'Configuration de prestataire invalide');
      const updates = {};
      const unset = {};
      if (provider === 'paydunya') {
        if (body.enabled !== undefined) updates.enabled = bool(body.enabled, 'enabled');
        if (body.mode !== undefined) {
          if (!['test', 'live'].includes(body.mode)) throw httpError(422, 'Mode PayDunya invalide');
          updates.mode = body.mode;
        }
        if (body.store_name !== undefined) {
          if (typeof body.store_name !== 'string' || body.store_name.trim().length > 120) {
            throw httpError(422, 'Nom de boutique invalide');
          }
          updates.store_name = body.store_name.trim();
        }
        if (body.modes !== undefined) {
          if (!isObject(body.modes)) throw httpError(422, 'Modes PayDunya invalides');
          const modes = { ...(isObject(current.modes) ? current.modes : {}) };
          for (const key of ['softpay_direct', 'psr', 'par_redirect']) {
            if (body.modes[key] === undefined) continue;
            const value = body.modes[key];
            const enabled = isObject(value) ? value.enabled : value;
            modes[key] = { enabled: bool(enabled, `modes.${key}`) };
          }
          if (Object.keys(body.modes).some(key => !['softpay_direct', 'psr', 'par_redirect'].includes(key))) {
            throw httpError(422, 'Mode PayDunya inconnu');
          }
          updates.modes = modes;
        }
        if (body.catalog !== undefined) {
          updates.catalog = validateCatalogRows(body.catalog, provider, current.catalog);
        }
      } else if (provider === 'afribapay') {
        if (body.enabled !== undefined) updates.enabled = bool(body.enabled, 'enabled');
        if (body.mode !== undefined) {
          if (!['sandbox', 'live'].includes(body.mode)) throw httpError(422, 'Mode AfribaPAY invalide');
          updates.mode = body.mode;
        }
        for (const key of ['sandbox_api_base_url', 'sandbox_payout_base_url', 'live_api_base_url', 'live_payout_base_url']) {
          if (body[key] !== undefined) updates[key] = validateBaseUrl(body[key], key);
        }
        if (body.catalog !== undefined) {
          updates.catalog = validateCatalogRows(body.catalog, provider, current.catalog);
        }
      } else if (provider === 'mbiyo') {
        if (body.enabled !== undefined) updates.enabled = bool(body.enabled, 'enabled');
        if (body.mode !== undefined) {
          if (!['test', 'live'].includes(body.mode)) throw httpError(422, 'Mode Mbiyo invalide');
          updates.mode = body.mode;
        }
        if (body.catalog !== undefined) {
          updates.catalog = validateCatalogRows(body.catalog, provider, current.catalog);
        }
      }

      for (const key of PROVIDERS[provider].fields) {
        const clearKey = `clear_${key}`;
        if (body[clearKey] !== undefined && typeof body[clearKey] !== 'boolean') {
          throw httpError(422, `${clearKey} doit être booléen`);
        }
        if (body[clearKey]) {
          unset[`${key}_encrypted`] = '';
          continue;
        }
        const value = body[key];
        if (value === undefined || value === null || value === '') continue;
        if (typeof value !== 'string' || value.length > 4096) {
          throw httpError(422, `Identifiant ${key} invalide`);
        }
        if (!sessionSecret) {
          throw httpError(503, 'SESSION_SECRET doit être configuré pour enregistrer les identifiants');
        }
        updates[`${key}_encrypted`] = security.encryptFernet(
          value.trim(), security.fernetKey(sessionSecret),
        );
      }

      if (!Object.keys(updates).length && !Object.keys(unset).length) {
        reply(res, 200, publicConfig(provider, current, env));
        return true;
      }
      const now = new Date().toISOString();
      updates.updated_at = now;
      updates.updated_by = admin.id;
      const update = {};
      if (Object.keys(updates).length) update.$set = updates;
      if (Object.keys(unset).length) update.$unset = unset;
      await collection.update_one({ id: PROVIDERS[provider].id }, update, true);
      await db.collection('admin_logs').insert_one({
        id: randomUUID(),
        admin_id: admin.id,
        admin_username: admin.username || null,
        action: `save_${provider}_provider_settings`,
        details: {
          updated_fields: [
            ...Object.keys(updates).filter(key => !key.endsWith('_encrypted')),
            ...Object.keys(updates).filter(key => key.endsWith('_encrypted')).map(key => key.replace('_encrypted', '_secret')),
          ],
          cleared_fields: Object.keys(unset).map(key => key.replace('_encrypted', '_secret')),
        },
        ip: '',
        created_at: now,
      });
      const saved = await collection.find_one({ id: PROVIDERS[provider].id }, { _id: 0 });
      reply(res, 200, publicConfig(provider, saved, env));
      return true;
    } catch (error) {
      reply(res, error.status || 500, {
        detail: error.code
          ? { code: error.code, message: error.message }
          : error.status ? error.message : 'Erreur interne.',
      });
      return true;
    }
  }
  return { handleRoute };
}

module.exports = { createAdminPaymentProviderRoutes, validateCatalogRows, publicConfig };
