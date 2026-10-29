'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createAdminSettingsRoutes } = require('../src/admin-settings-routes.cjs');

function assignPath(target, key, value) {
  const parts = key.split('.');
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts.at(-1)] = structuredClone(value);
}

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query) {
    const row = this.rows.find(item => Object.entries(query).every(([key, value]) => item[key] === value));
    return row ? structuredClone(row) : null;
  }
  async update_one(query, update, upsert = false) {
    let row = this.rows.find(item => Object.entries(query).every(([key, value]) => item[key] === value));
    if (!row && upsert) {
      row = { ...query, ...(update.$setOnInsert || {}) };
      for (const [key, value] of Object.entries(update.$set || {})) assignPath(row, key, value);
      this.rows.push(row);
      return { matched_count: 0, upserted_id: row.id };
    }
    if (!row) return { matched_count: 0 };
    for (const [key, value] of Object.entries(update.$set || {})) assignPath(row, key, value);
    return { matched_count: 1 };
  }
  async insert_one(document) { this.rows.push(structuredClone(document)); }
}

function setup({ user = {}, settings = [], env = {} } = {}) {
  const collections = {
    users: new Collection([{
      id: 'admin-1', username: 'owner', role: 'super_admin',
      two_fa_enabled: true, ...user,
    }]),
    settings: new Collection(settings),
    admin_logs: new Collection(),
    referral_settings: new Collection(),
  };
  const db = { collection: name => collections[name] };
  const authChecks = { recent: 0 };
  const sessionService = {
    authenticate: async token => {
      assert.equal(token, 'synthetic-admin-session');
      return { userId: 'admin-1', session: { admin_auth_method: 'totp' } };
    },
    requireRecentAuth() { authChecks.recent += 1; },
  };
  return {
    service: createAdminSettingsRoutes({ db, sessionService, env }),
    collections,
    authChecks,
  };
}

async function call(service, method, path, body) {
  const req = body === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = path;
  req.headers = { authorization: 'Bearer synthetic-admin-session' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = {
    status: 0,
    writeHead(status) { this.status = status; },
    end(text) { this.body = text ? JSON.parse(text) : null; },
  };
  const handled = await service.handleRoute(req, res);
  return { handled, status: res.status, body: res.body };
}

test('admin feature settings preserve defaults and reject invalid value types', async () => {
  const { service, collections } = setup({
    settings: [{ id: 'app_features', payment_api_enabled: false, admin_note: 'private' }],
  });
  const get = await call(service, 'GET', '/api/admin/settings/features');
  assert.equal(get.status, 200);
  assert.equal(get.body.payment_api_enabled, false);
  assert.equal('admin_note' in get.body, true);

  const invalid = await call(service, 'PATCH', '/api/admin/settings/features', {
    payment_api_enabled: 'false',
  });
  assert.equal(invalid.status, 422);
  assert.equal(collections.settings.rows[0].payment_api_enabled, false);

  const update = await call(service, 'PATCH', '/api/admin/settings/features', {
    payment_api_enabled: true, deposit_xof_enabled: false,
  });
  assert.equal(update.status, 200);
  assert.equal(update.body.payment_api_enabled, true);
  assert.equal(update.body.deposit_xof_enabled, false);
});

test('admin conversion settings validate crypto rates and return supported pairs', async () => {
  const { service, collections } = setup();
  const update = await call(service, 'PATCH', '/api/admin/conversion/config', {
    conversion_rates: { XOF_XAF: 1.02 },
    crypto_usdt_rates: { usdc: 0.99, usdt: 999 },
  });
  assert.equal(update.status, 200);
  assert.equal(update.body.rates.XOF_XAF, 1.02);
  assert.deepEqual(update.body.crypto_usdt_rates, { USDT: 1, USDC: 0.99 });
  assert.equal(update.body.supported_pairs.includes('XOF_XAF'), true);
  assert.ok(update.body.crypto_usdt_rates_updated_at);

  const before = structuredClone(collections.settings.rows);
  const invalid = await call(service, 'PATCH', '/api/admin/conversion/config', {
    crypto_usdt_rates: { USDC: -1 },
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(collections.settings.rows, before);
});

test('platform config only accepts the legacy allowlisted fields', async () => {
  const { service } = setup();
  const update = await call(service, 'PATCH', '/api/admin/platform/config', {
    auto_withdrawals_disabled: true,
    conversion_fee: { enabled: false, type: 'fixed', value: 15 },
    unrelated_secret: 'not persisted',
  });
  assert.equal(update.status, 200);
  assert.equal(update.body.auto_withdrawals_disabled, true);
  assert.deepEqual(update.body.conversion_fee, { enabled: false, type: 'fixed', value: 15 });
  assert.equal('unrelated_secret' in update.body, false);
});

test('admin settings are permission-checked and unsupported paths fall through', async () => {
  const { service } = setup({
    user: { role: 'admin', admin_role: 'support' },
  });
  const denied = await call(service, 'PATCH', '/api/admin/settings/features', {
    payment_api_enabled: false,
  });
  assert.equal(denied.status, 403);
  assert.equal(await service.handleRoute({
    method: 'DELETE', url: '/api/admin/settings/features', headers: {},
  }, { writeHead() {}, end() {} }), false);
});

test('admin email settings redact secrets, expose readiness, and require fresh auth to update', async () => {
  const { service, collections, authChecks } = setup({
    env: {
      RESEND_API_KEY: 'test-resend-key',
      PUBLIC_APP_URL: 'https://biz-transpay.example',
    },
    settings: [{
      id: 'transaction_email_settings',
      enabled: true,
      withdrawal_otp_enabled: true,
      sender_email: 'notifications@biz-transpay.example',
      event_types: ['deposit_confirmed'],
      content_fields: ['reference'],
      api_key: 'must-not-be-returned',
    }],
  });
  const get = await call(service, 'GET', '/api/admin/email-notifications');
  assert.equal(get.status, 200);
  assert.equal(get.body.active, true);
  assert.equal(get.body.withdrawal_otp_active, true);
  assert.equal(get.body.password_reset_ready, true);
  assert.equal(get.body.api_key, undefined);

  const update = await call(service, 'PUT', '/api/admin/email-notifications', {
    enabled: true,
    withdrawal_otp_enabled: true,
    sender_email: 'alerts@biz-transpay.example',
    event_types: ['deposit_confirmed', 'kyc_verified', 'deposit_confirmed'],
    content_fields: ['reference', 'amount_currency'],
  });
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.deepEqual(update.body.event_types, ['deposit_confirmed', 'kyc_verified']);
  assert.deepEqual(update.body.content_fields, ['reference', 'amount_currency']);
  assert.equal(collections.settings.rows[0].sender_email, 'alerts@biz-transpay.example');
  assert.equal(authChecks.recent, 1);
  assert.equal(collections.admin_logs.rows.some(row =>
    row.action === 'update_transaction_email_settings'), true);
});

test('admin email notifications cannot be activated without Resend and a valid sender', async () => {
  const { service, collections } = setup();
  const rejected = await call(service, 'PUT', '/api/admin/email-notifications', {
    enabled: true,
    sender_email: 'not-an-email',
    event_types: ['deposit_confirmed'],
    content_fields: ['event_status'],
  });
  assert.equal(rejected.status, 409);
  assert.equal(collections.settings.rows.length, 0);
});

test('admin email settings reject unknown event or content fields without persisting', async () => {
  const { service, collections } = setup({
    env: { RESEND_API_KEY: 'test-resend-key' },
  });
  const rejected = await call(service, 'PUT', '/api/admin/email-notifications', {
    enabled: false,
    sender_email: '',
    event_types: ['unknown_event'],
    content_fields: ['reference'],
  });
  assert.equal(rejected.status, 422);
  assert.equal(collections.settings.rows.length, 0);
});

test('admin deposit and transfer configs preserve partial nested updates', async () => {
  const { service, collections } = setup({
    settings: [{
      id: 'transfer_config',
      mobile_money: { enabled: true, operators: [{ code: 'orange-ci', country: 'CI' }] },
      crypto: { enabled: true, fees: { USDT_TRC20: 3 } },
    }],
  });
  const update = await call(service, 'PATCH', '/api/admin/transfer/config', {
    crypto: { enabled: false, fees_gateway: { USDT_TRC20: 1.5 } },
  });
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.equal(update.body.crypto.enabled, false);
  assert.equal(update.body.crypto.fees.USDT_TRC20, 3);
  assert.equal(update.body.crypto.fees_gateway.USDT_TRC20, 1.5);
  assert.equal(update.body.mobile_money.operators[0].code, 'orange-ci');

  const deposit = await call(service, 'PATCH', '/api/admin/deposit/config', {
    crypto: { disabled_assets: ['USDT_TRC20'] },
  });
  assert.equal(deposit.status, 200, JSON.stringify(deposit.body));
  assert.deepEqual(deposit.body.crypto.disabled_assets, ['USDT_TRC20']);
  assert.equal(collections.settings.rows.some(row => row.id === 'deposit_config'), true);
});

test('admin payout config rejects ambiguous active routes and invalid fee values', async () => {
  const { service, collections } = setup();
  const duplicate = await call(service, 'PATCH', '/api/admin/transfer/config', {
    mobile_money: {
      enabled: true,
      operators: [
        {
          provider: 'paydunya', country: 'TG', currency: 'XOF',
          code: 't-money-togo', withdraw_mode: 't-money-togo',
        },
        {
          provider: 'mbiyo', country: 'TG', currency: 'XOF',
          code: 'tmoney', network: 'tmoney',
        },
      ],
    },
  });
  assert.equal(duplicate.status, 422);
  assert.equal(collections.settings.rows.length, 0);

  const invalidFee = await call(service, 'PATCH', '/api/admin/deposit/config', {
    crypto: { fees_gateway: { USDT_TRC20: -1 } },
  });
  assert.equal(invalidFee.status, 422);
  assert.equal(collections.settings.rows.length, 0);
});

test('admin referral rate preserves the allowed range and requires recent authentication', async () => {
  const { service, collections, authChecks } = setup();
  const getDefault = await call(service, 'GET', '/api/admin/referrals/config');
  assert.equal(getDefault.status, 200);
  assert.deepEqual(getDefault.body, { rate_percent: 2 });

  const updated = await call(service, 'PATCH', '/api/admin/referrals/config', {
    rate_percent: 2.5,
  });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body, { rate_percent: 2.5 });
  assert.equal(authChecks.recent, 1);

  const invalid = await call(service, 'PATCH', '/api/admin/referrals/config', {
    rate_percent: 2.6,
  });
  assert.equal(invalid.status, 400);
  assert.equal(collections.referral_settings.rows[0].rate_percent, 2.5);
});
