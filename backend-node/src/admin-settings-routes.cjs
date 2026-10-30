'use strict';

const crypto = require('node:crypto');
const { authorizeAdmin } = require('./admin-authorization.cjs');
const { getAppFeatures, getPlatformConfig } = require('./public-config-routes.cjs');
const { isResendConfigured, publicAppUrl } = require('./auth-recovery-routes.cjs');

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
const TRANSACTION_EMAIL_DEFAULTS = {
  id: 'transaction_email_settings',
  enabled: false,
  withdrawal_otp_enabled: false,
  sender_email: '',
  recipient_type: 'transaction_user',
  event_types: [
    'deposit_confirmed', 'withdrawal_success', 'exchange_success',
    'payment_final', 'kyc_verified', 'kyc_rejected', 'kyc_resubmit_requested',
  ],
  content_fields: ['event_status', 'amount_currency', 'fee', 'reference', 'event_time'],
};
const EMAIL_EVENT_TYPES = new Set(TRANSACTION_EMAIL_DEFAULTS.event_types);
const EMAIL_CONTENT_FIELDS = new Set(TRANSACTION_EMAIL_DEFAULTS.content_fields);
const CRYPTO_CONFIG_KEYS = new Set([
  'enabled', 'fees', 'fees_gateway', 'fees_platform',
  'fees_gateway_fixed', 'fees_platform_fixed', 'disabled_assets', 'hidden_coins',
]);
const CRYPTO_FEE_MAP_KEYS = new Set([
  'fees', 'fees_gateway', 'fees_platform',
  'fees_gateway_fixed', 'fees_platform_fixed',
]);

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

function transactionEmailView(settings, env = process.env) {
  const senderEmail = String(settings.sender_email || '').trim();
  const resendConfigured = isResendConfigured(env);
  const senderConfigured = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(senderEmail);
  const readyToSend = resendConfigured && senderConfigured;
  return {
    enabled: Boolean(settings.enabled),
    sender_email: senderEmail,
    recipient_type: 'transaction_user',
    event_types: [...new Set((Array.isArray(settings.event_types)
      ? settings.event_types : TRANSACTION_EMAIL_DEFAULTS.event_types)
      .filter(value => EMAIL_EVENT_TYPES.has(value)))],
    content_fields: [...new Set((Array.isArray(settings.content_fields)
      ? settings.content_fields : TRANSACTION_EMAIL_DEFAULTS.content_fields)
      .filter(value => EMAIL_CONTENT_FIELDS.has(value)))],
    resend_configured: resendConfigured,
    sender_configured: senderConfigured,
    ready_to_send: readyToSend,
    active: Boolean(settings.enabled && readyToSend),
    withdrawal_otp_enabled: Boolean(settings.withdrawal_otp_enabled),
    withdrawal_otp_active: Boolean(settings.withdrawal_otp_enabled && readyToSend),
    password_reset_ready: Boolean(readyToSend && publicAppUrl(env)),
  };
}

async function transactionEmailSettings(db) {
  const saved = await db.collection('settings').find_one(
    { id: TRANSACTION_EMAIL_DEFAULTS.id }, { _id: 0 },
  );
  const settings = { ...TRANSACTION_EMAIL_DEFAULTS, ...(saved || {}) };
  if (saved && [
    ['deposit_confirmed', 'withdrawal_success', 'payment_final'],
    ['deposit_confirmed', 'withdrawal_success', 'exchange_success', 'payment_final'],
  ].some(previous => JSON.stringify(saved.event_types) === JSON.stringify(previous))) {
    settings.event_types = [...TRANSACTION_EMAIL_DEFAULTS.event_types];
  }
  if (saved && JSON.stringify(saved.content_fields) === JSON.stringify([
    'event_status', 'amount_currency', 'reference', 'event_time',
  ])) {
    settings.content_fields = [...TRANSACTION_EMAIL_DEFAULTS.content_fields];
  }
  return settings;
}

function objectConfig(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail(422, message);
  }
  return value;
}

function validateCryptoConfig(section) {
  objectConfig(section, 'crypto doit être un objet');
  for (const key of Object.keys(section)) {
    if (!CRYPTO_CONFIG_KEYS.has(key)) throw fail(422, `Configuration crypto invalide : ${key}`);
  }
  if (section.enabled !== undefined && typeof section.enabled !== 'boolean') {
    throw fail(422, 'crypto.enabled doit être un booléen');
  }
  for (const key of CRYPTO_FEE_MAP_KEYS) {
    if (section[key] === undefined) continue;
    objectConfig(section[key], `${key} doit être un objet`);
    for (const [asset, raw] of Object.entries(section[key])) {
      const amount = Number(raw);
      if (!/^[A-Za-z0-9._-]{1,48}$/.test(asset)
          || !Number.isFinite(amount) || amount < 0 || amount > 1e9) {
        throw fail(422, `${key} contient une valeur invalide`);
      }
    }
  }
  for (const key of ['disabled_assets', 'hidden_coins']) {
    if (section[key] === undefined) continue;
    if (!Array.isArray(section[key]) || section[key].length > 500
        || section[key].some(value => typeof value !== 'string'
          || value.length < 1 || value.length > 48)) {
      throw fail(422, `${key} doit être une liste d’actifs valide`);
    }
  }
}

function withdrawalNetwork(operator) {
  const provider = String(operator.provider || 'paydunya').toLowerCase();
  let network;
  if (provider === 'paydunya') {
    const mode = String(operator.withdraw_mode || operator.code || '').toLowerCase();
    const knownModes = {
      'orange-money-senegal': 'orange',
      'free-money-senegal': 'free',
      'wave-senegal': 'wave',
      'mtn-benin': 'mtn',
      'moov-benin': 'moov',
      'celtiis-cash': 'celtiis',
      'mtn-ci': 'mtn',
      'orange-money-ci': 'orange',
      'moov-ci': 'moov',
      'wave-ci': 'wave',
      't-money-togo': 'tmoney',
      'moov-togo': 'moov',
      'orange-money-mali': 'orange',
      'moov-mali': 'moov',
      'orange-money-burkina': 'orange',
      'moov-burkina-faso': 'moov',
      'mtn-cameroun': 'mtn',
    };
    network = knownModes[mode] || mode;
  } else if (provider === 'mbiyo') {
    network = String(operator.network || operator.code || '')
      .toLowerCase().replace(/^mbiyo_/, '');
  } else {
    network = String(operator.operator || operator.public_code || operator.code || '')
      .toLowerCase().replace(/^afribapay_/, '');
  }
  return ({
    togocom: 'tmoney', togocel: 'tmoney', 't-money': 'tmoney',
    t_money: 'tmoney', 'celtiis-cash': 'celtiis',
  })[network] || network;
}

function withdrawalIdentifier(operator, provider) {
  const candidates = provider === 'paydunya'
    ? [operator.withdraw_mode, operator.code]
    : provider === 'mbiyo'
      ? [operator.network, operator.code]
      : [operator.operator, operator.public_code, operator.code];
  return String(candidates.find(value => typeof value === 'string' && value.trim()) || '').trim();
}

function validateWithdrawalCatalog(section) {
  objectConfig(section, 'mobile_money doit être un objet');
  if (section.enabled !== undefined && typeof section.enabled !== 'boolean') {
    throw fail(422, 'mobile_money.enabled doit être un booléen');
  }
  const operators = section.operators;
  if (operators === undefined) return;
  if (!Array.isArray(operators) || operators.length > 500) {
    throw fail(422, 'Le catalogue Mobile Money doit être une liste valide');
  }
  const seenRows = new Set();
  const seenActiveRoutes = new Set();
  for (const [index, operator] of operators.entries()) {
    objectConfig(operator, 'Chaque opérateur doit être un objet');
    const provider = String(operator.provider || 'paydunya').trim().toLowerCase();
    const country = String(operator.country || '').trim().toUpperCase();
    const currency = String(operator.currency || '').trim().toUpperCase();
    const code = withdrawalIdentifier(operator, provider);
    const invalidFields = [];
    if (!['paydunya', 'mbiyo', 'afribapay'].includes(provider)) {
      invalidFields.push('prestataire');
    }
    if (!/^[A-Z]{2}$/.test(country)) invalidFields.push('pays');
    if (!['XOF', 'XAF'].includes(currency)) invalidFields.push('devise');
    if (!code || code.length > 120) invalidFields.push('identifiant');
    if (invalidFields.length) {
      const label = String(operator.name || operator.country_label || '').trim().slice(0, 80);
      throw fail(422, `Opérateur ${label || `n° ${index + 1}`} (ligne ${index + 1}) : champ invalide — ${invalidFields.join(', ')}.`);
    }
    if (provider === 'paydunya' && currency !== (country === 'CM' ? 'XAF' : 'XOF')) {
      throw fail(422, 'La devise ne correspond pas au pays');
    }
    const rowKey = `${provider}:${country}:${code.toLowerCase()}:${currency}`;
    if (seenRows.has(rowKey)) {
      throw fail(422, 'Les opérateurs doivent avoir un couple pays/code/devise unique');
    }
    seenRows.add(rowKey);
    for (const key of [
      'fee_pct', 'gateway_fee_pct', 'gateway_fee_fixed',
      'platform_fee_pct', 'platform_fee_fixed', 'min', 'max',
    ]) {
      if (operator[key] === undefined || operator[key] === null || operator[key] === '') continue;
      const amount = Number(operator[key]);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) {
        throw fail(422, `${key} doit être un nombre positif valide`);
      }
    }
    const executable = operator.active !== false
      && operator.archived !== true && operator.hidden !== true;
    if (executable) {
      const minimum = operator.min === undefined || operator.min === null
        ? null : Number(operator.min);
      const maximum = operator.max === undefined || operator.max === null
        || Number(operator.max) === 0 ? null : Number(operator.max);
      if (minimum !== null && maximum !== null && maximum < minimum) {
        throw fail(422, 'La limite maximale doit être supérieure à la minimale');
      }
      const route = `${country}:${withdrawalNetwork({ ...operator, provider })}`;
      if (seenActiveRoutes.has(route)) {
        throw fail(422,
          'Ce pays et cet opérateur ne peuvent être actifs que chez un seul prestataire de retrait.');
      }
      seenActiveRoutes.add(route);
    }
  }
}

async function getConfigDocument(db, id, sections) {
  const saved = await db.collection('settings').find_one({ id }, { _id: 0 });
  const result = saved || { id };
  for (const section of sections) {
    if (!result[section] || typeof result[section] !== 'object'
        || Array.isArray(result[section])) result[section] = {};
  }
  return result;
}

function createAdminSettingsRoutes({ db, sessionService, env = process.env }) {
  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const path = url.pathname;
    const routeMethods = new Map([
      ['/api/admin/settings/features', new Set(['GET', 'PATCH'])],
      ['/api/admin/platform/config', new Set(['GET', 'PATCH'])],
      ['/api/admin/conversion/config', new Set(['GET', 'PATCH'])],
      ['/api/admin/email-notifications', new Set(['GET', 'PUT'])],
      ['/api/admin/deposit/config', new Set(['GET', 'PATCH'])],
      ['/api/admin/transfer/config', new Set(['GET', 'PATCH'])],
      ['/api/admin/referrals/config', new Set(['GET', 'PATCH'])],
    ]);
    const methods = routeMethods.get(path);
    if (!methods || !methods.has(req.method)) return false;

    const isConversion = path === '/api/admin/conversion/config';
    const isPlatform = path === '/api/admin/platform/config';
    const isEmailNotifications = path === '/api/admin/email-notifications';
    const isDepositConfig = path === '/api/admin/deposit/config';
    const isTransferConfig = path === '/api/admin/transfer/config';
    const isFeeCatalog = isDepositConfig || isTransferConfig;
    const isReferralConfig = path === '/api/admin/referrals/config';
    const isWrite = req.method !== 'GET';
    const permission = isConversion || isFeeCatalog
      ? (isWrite ? 'fees:write' : 'fees:read')
      : (isWrite ? 'settings:write' : 'settings:read');
    const action = isConversion
      ? (isWrite ? 'update_conversion_config' : 'read_conversion_config')
      : isDepositConfig
        ? (isWrite ? 'update_deposit_config' : 'read_deposit_config')
        : isTransferConfig
          ? (isWrite ? 'update_transfer_config' : 'read_transfer_config')
      : isReferralConfig
        ? (isWrite ? 'update_referral_rate' : 'read_referral_rate')
      : isPlatform
        ? (isWrite ? 'update_platform_config' : 'read_platform_config')
        : isEmailNotifications
          ? (isWrite ? 'update_transaction_email_settings' : 'read_transaction_email_settings')
          : (isWrite ? 'update_app_features' : 'read_app_features');

    try {
      const { admin } = await authorizeAdmin(req, {
        db, sessionService, env, permission, action,
        sensitive: (isEmailNotifications || isReferralConfig) && isWrite,
      });

      if (isReferralConfig && !isWrite) {
        const saved = await db.collection('referral_settings').find_one(
          { id: 'referral_settings' }, { _id: 0 },
        );
        const rate = saved ? Number(saved.rate_percent) : 2;
        if (!Number.isFinite(rate) || rate < 2 || rate > 2.5) {
          throw fail(503, 'Le taux de parrainage enregistré est invalide.');
        }
        reply(res, 200, { rate_percent: rate });
        return true;
      }
      if (isEmailNotifications && !isWrite) {
        reply(res, 200, transactionEmailView(await transactionEmailSettings(db), env));
        return true;
      }
      if (isFeeCatalog && !isWrite) {
        reply(res, 200, await getConfigDocument(db,
          isDepositConfig ? 'deposit_config' : 'transfer_config',
          ['mobile_money', 'crypto']));
        return true;
      }
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
      if (isEmailNotifications) {
        if (typeof body.enabled !== 'boolean') {
          throw fail(422, 'enabled doit être un booléen');
        }
        if (body.withdrawal_otp_enabled !== undefined
            && typeof body.withdrawal_otp_enabled !== 'boolean') {
          throw fail(422, 'withdrawal_otp_enabled doit être un booléen');
        }
        if (!Array.isArray(body.event_types)
            || body.event_types.some(value => !EMAIL_EVENT_TYPES.has(value))) {
          throw fail(422, 'event_types est invalide');
        }
        if (!Array.isArray(body.content_fields)
            || body.content_fields.some(value => !EMAIL_CONTENT_FIELDS.has(value))) {
          throw fail(422, 'content_fields est invalide');
        }
        if (body.sender_email !== undefined && body.sender_email !== null
            && typeof body.sender_email !== 'string') {
          throw fail(422, 'sender_email est invalide');
        }
        const senderEmail = String(body.sender_email || '').trim().toLowerCase();
        if (senderEmail.length > 320) throw fail(422, 'sender_email est trop long');
        const current = await transactionEmailSettings(db);
        const withdrawalOtpEnabled = body.withdrawal_otp_enabled === undefined
          ? Boolean(current.withdrawal_otp_enabled) : body.withdrawal_otp_enabled;
        const candidate = {
          ...TRANSACTION_EMAIL_DEFAULTS,
          enabled: body.enabled,
          withdrawal_otp_enabled: withdrawalOtpEnabled,
          sender_email: senderEmail,
          recipient_type: 'transaction_user',
          event_types: [...new Set(body.event_types)],
          content_fields: [...new Set(body.content_fields)],
          updated_at: new Date().toISOString(),
          updated_by: admin.id,
        };
        const deliveryStatus = transactionEmailView(candidate, env);
        if (body.enabled && !deliveryStatus.ready_to_send) {
          throw fail(409,
            'Configurez Resend et une adresse d’expédition valide avant d’activer les e-mails.');
        }
        if (withdrawalOtpEnabled && !deliveryStatus.ready_to_send) {
          throw fail(409,
            'Configurez Resend et une adresse d’expédition valide avant d’activer le code OTP.');
        }
        await db.collection('settings').update_one(
          { id: TRANSACTION_EMAIL_DEFAULTS.id }, { $set: candidate }, true,
        );
        await db.collection('admin_logs').insert_one({
          id: crypto.randomUUID(),
          admin_id: admin.id,
          admin_username: admin.username || null,
          action,
          details: {
            enabled: candidate.enabled,
            withdrawal_otp_enabled: candidate.withdrawal_otp_enabled,
            event_types: candidate.event_types,
            content_fields: candidate.content_fields,
            sender_configured: deliveryStatus.sender_configured,
          },
          created_at: candidate.updated_at,
          ip: '',
        });
        reply(res, 200, transactionEmailView(candidate, env));
        return true;
      }

      if (isFeeCatalog) {
        const allowedSections = isTransferConfig
          ? new Set(['mobile_money', 'bank', 'crypto'])
          : new Set(['mobile_money', 'crypto']);
        const updates = {};
        for (const [section, value] of Object.entries(body)) {
          if (!allowedSections.has(section)) continue;
          objectConfig(value, `${section} doit être un objet`);
          if (section === 'mobile_money' && isTransferConfig) {
            validateWithdrawalCatalog(value);
          }
          if (section === 'crypto') validateCryptoConfig(value);
          updates[section] = value;
        }
        if (!Object.keys(updates).length) throw fail(400, 'Aucune modification');
        const id = isDepositConfig ? 'deposit_config' : 'transfer_config';
        const current = await getConfigDocument(db, id, Object.keys(updates));
        const dotUpdates = {};
        for (const [section, patch] of Object.entries(updates)) {
          const currentSection = current[section] || {};
          for (const [key, value] of Object.entries(patch)) {
            dotUpdates[`${section}.${key}`] = value;
          }
          if (!Object.keys(patch).length) dotUpdates[section] = currentSection;
        }
        await db.collection('settings').update_one({ id }, { $set: dotUpdates }, true);
        await db.collection('admin_logs').insert_one({
          id: crypto.randomUUID(),
          admin_id: admin.id,
          admin_username: admin.username || null,
          action,
          details: updates,
          created_at: new Date().toISOString(),
          ip: '',
        });
        reply(res, 200, await getConfigDocument(db, id, Object.keys(updates)));
        return true;
      }

      if (isReferralConfig) {
        const rate = Number(body.rate_percent);
        if (body.rate_percent === undefined || !Number.isFinite(rate)) {
          throw fail(422, 'Le taux de parrainage doit être numérique');
        }
        if (rate < 2 || rate > 2.5) {
          throw fail(400, 'Le taux de parrainage doit être compris entre 2 et 2,5 %');
        }
        const updatedAt = new Date().toISOString();
        await db.collection('referral_settings').update_one(
          { id: 'referral_settings' },
          {
            $set: { rate_percent: rate, updated_at: updatedAt },
            $setOnInsert: { id: 'referral_settings' },
          },
          true,
        );
        await db.collection('admin_logs').insert_one({
          id: crypto.randomUUID(),
          admin_id: admin.id,
          admin_username: admin.username || null,
          action,
          details: { rate_percent: rate },
          created_at: updatedAt,
          ip: '',
        });
        reply(res, 200, { rate_percent: rate });
        return true;
      }

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
