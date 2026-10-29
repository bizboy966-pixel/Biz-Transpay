'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPublicConfigRoutes } = require('../src/public-config-routes.cjs');
const { matches, applyUpdate, project } = require('../src/document-store.cjs');

class SettingsCollection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query, projectionSpec) {
    const row = this.rows.find(item => matches(item, query));
    return row ? project(row, projectionSpec) : null;
  }
  async update_one(query, update, upsert = false) {
    const index = this.rows.findIndex(item => matches(item, query));
    if (index === -1) {
      if (upsert) this.rows.push(applyUpdate({}, update, true, query));
      return { matched_count: 0 };
    }
    this.rows[index] = applyUpdate(this.rows[index], update, false, query);
    return { matched_count: 1 };
  }
}

function setup(settings = [], env = {}) {
  const collection = new SettingsCollection(settings);
  const db = { collection: name => name === 'settings' ? collection : null };
  const service = createPublicConfigRoutes({ db, env });
  return { service, collection };
}

function response() {
  return {
    status: 0,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; },
  };
}

async function call(service, path) {
  const res = response();
  const handled = await service.handleRoute({ method: 'GET', url: path }, res);
  return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

test('public feature endpoint returns configured switches without exposing storage fields', async () => {
  const { service } = setup([{
    id: 'app_features',
    payment_api_enabled: false,
    deposit_xof_enabled: false,
    mobile_money_coming_soon_message: 'En maintenance',
    internal_admin_note: 'private',
  }]);
  const result = await call(service, '/api/settings/features');
  assert.equal(result.status, 200);
  assert.equal(result.body.payment_api_enabled, false);
  assert.equal(result.body.deposit_xof_enabled, false);
  assert.equal(result.body.wallet_xof_enabled, true);
  assert.equal(result.body.mobile_money_coming_soon_message, 'En maintenance');
  assert.equal('id' in result.body, false);
  assert.equal('internal_admin_note' in result.body, false);
});

test('missing feature settings are initialized with backward-compatible defaults', async () => {
  const { service, collection } = setup();
  const result = await call(service, '/api/settings/features');
  assert.equal(result.status, 200);
  assert.equal(result.body.mobile_money_enabled, true);
  assert.equal(result.body.wallet_crypto_enabled, true);
  assert.equal(result.body.payment_api_enabled, true);
  assert.equal(collection.rows.length, 1);
});

test('Turnstile endpoint returns only the public site key and requires both keys to enable', async () => {
  const disabled = setup([], {
    CLOUDFLARE_TURNSTILE_SITE_KEY: 'public-site-key',
  });
  const result = await call(disabled.service, '/api/security/turnstile-config');
  assert.deepEqual(result.body, { enabled: false, site_key: 'public-site-key' });

  const enabled = setup([], {
    CLOUDFLARE_TURNSTILE_SITE_KEY: 'public-site-key',
    CLOUDFLARE_TURNSTILE_SECRET_KEY: 'server-secret',
  });
  const enabledResult = await call(enabled.service, '/api/security/turnstile-config');
  assert.equal(enabledResult.body.enabled, true);
  assert.equal(JSON.stringify(enabledResult.body).includes('server-secret'), false);
});

test('conversion configuration merges defaults while hiding unrelated platform settings', async () => {
  const { service } = setup([{
    id: 'platform_config',
    conversion_rates: { XOF_XAF: 1.1 },
    conversion_fee: { enabled: true, type: 'fixed', value: 25 },
    private_admin_note: 'not public',
  }]);
  const result = await call(service, '/api/conversion/config');
  assert.equal(result.body.rates.XOF_XAF, 1.1);
  assert.equal(result.body.rates.XAF_XOF, 1);
  assert.deepEqual(result.body.limits.XOF_XAF, { min: 500, max: 5000000 });
  assert.equal(result.body.pairs_enabled.XOF_XAF, true);
  assert.deepEqual(result.body.fee, { enabled: true, type: 'fixed', value: 25 });
  assert.equal(JSON.stringify(result.body).includes('private_admin_note'), false);
});

test('legacy exchange-rate endpoint preserves query currencies and configured fee values', async () => {
  const { service } = setup([{
    id: 'platform_config',
    conversion_rates: { XAF_XOF: 1.04 },
    conversion_fee: { enabled: false, type: 'percent', value: 0.75, min_fee: 12, max_fee: 500 },
  }]);
  const result = await call(service, '/api/exchange/rate?from_currency=XAF&to_currency=XOF');
  assert.deepEqual(result.body, {
    from: 'XAF', to: 'XOF', rate: 1.04,
    fee_enabled: false, fee_type: 'percent', fee_value: 0.75,
    fee_min: 12, fee_max: 500, fee_pct: 0.0075,
  });
});

test('public statistics endpoint retains the existing response contract', async () => {
  const { service } = setup();
  const result = await call(service, '/api/stats/public');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    users: 50000,
    partners: 5000,
    transactions: 1000000,
    uptime: 99.9,
  });
});
