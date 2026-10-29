'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createAdminSettingsRoutes } = require('../src/admin-settings-routes.cjs');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query) {
    const row = this.rows.find(item => Object.entries(query).every(([key, value]) => item[key] === value));
    return row ? structuredClone(row) : null;
  }
  async update_one(query, update, upsert = false) {
    let row = this.rows.find(item => Object.entries(query).every(([key, value]) => item[key] === value));
    if (!row && upsert) {
      row = { ...query, ...(update.$setOnInsert || {}), ...(update.$set || {}) };
      this.rows.push(row);
      return { matched_count: 0, upserted_id: row.id };
    }
    if (!row) return { matched_count: 0 };
    Object.assign(row, update.$set || {});
    return { matched_count: 1 };
  }
  async insert_one(document) { this.rows.push(structuredClone(document)); }
}

function setup({ user = {}, settings = [] } = {}) {
  const collections = {
    users: new Collection([{
      id: 'admin-1', username: 'owner', role: 'super_admin',
      two_fa_enabled: true, ...user,
    }]),
    settings: new Collection(settings),
    admin_logs: new Collection(),
  };
  const db = { collection: name => collections[name] };
  const sessionService = {
    authenticate: async token => {
      assert.equal(token, 'synthetic-admin-session');
      return { userId: 'admin-1', session: { admin_auth_method: 'totp' } };
    },
    requireRecentAuth() {},
  };
  return { service: createAdminSettingsRoutes({ db, sessionService, env: {} }), collections };
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
