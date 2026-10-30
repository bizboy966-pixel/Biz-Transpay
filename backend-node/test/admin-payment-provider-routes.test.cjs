'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createAdminPaymentProviderRoutes } = require('../src/admin-payment-provider-routes.cjs');
const { createServer } = require('../src/server.cjs');
const security = require('../src/security.cjs');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query) {
    const row = this.rows.find(item => Object.entries(query)
      .every(([key, value]) => item[key] === value));
    return row ? structuredClone(row) : null;
  }
  async update_one(query, update, upsert = false) {
    let row = this.rows.find(item => Object.entries(query)
      .every(([key, value]) => item[key] === value));
    if (!row && upsert) {
      row = { ...query };
      this.rows.push(row);
    }
    if (!row) return { matched_count: 0 };
    Object.assign(row, structuredClone(update.$set || {}));
    for (const key of Object.keys(update.$unset || {})) delete row[key];
    return { matched_count: 1 };
  }
  async insert_one(row) { this.rows.push(structuredClone(row)); }
}

function setup({ settings = [], user = {}, env = {}, adminAuthMethod = 'totp' } = {}) {
  const collections = {
    users: new Collection([{
      id: 'admin-1', username: 'owner', role: 'super_admin',
      two_fa_enabled: true, ...user,
    }]),
    settings: new Collection(settings),
    admin_logs: new Collection(),
  };
  const db = { collection: name => collections[name] };
  const authChecks = { recent: 0 };
  const sessionService = {
    authenticate: async token => {
      if (token !== 'synthetic-admin-session') {
        const error = new Error('Session requise');
        error.status = 401;
        throw error;
      }
      return {
        userId: 'admin-1',
        session: { admin_auth_method: adminAuthMethod },
      };
    },
    requireRecentAuth() { authChecks.recent += 1; },
  };
  const sessionSecret = 'test-provider-session-secret';
  return {
    service: createAdminPaymentProviderRoutes({ db, sessionService, sessionSecret, env }),
    collections,
    authChecks,
    sessionSecret,
    db,
    sessionService,
  };
}

async function call(service, method, path, body, authorized = true) {
  const request = body === undefined
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.url = path;
  request.headers = authorized
    ? { authorization: 'Bearer synthetic-admin-session' } : {};
  request.socket = { remoteAddress: '127.0.0.1' };
  const response = {
    status: 0,
    writeHead(status) { this.status = status; },
    end(text) { this.body = text ? JSON.parse(text) : null; },
  };
  const handled = await service.handleRoute(request, response);
  return { handled, status: response.status, body: response.body };
}

test('all four admin provider settings pages have authenticated read routes', async () => {
  const { service } = setup({
    settings: [
      {
        id: 'payment_provider_paydunya',
        enabled: true,
        master_key_encrypted: 'encrypted',
        private_key_encrypted: 'encrypted',
        token_encrypted: 'encrypted',
        catalog: [{ id: 'tmoney', country: 'TG', code: 'tmoney_tg', name: 'T-Money', currency: 'XOF', endpoint_slug: 't-money' }],
      },
      {
        id: 'payment_provider_izipay',
        api_key_encrypted: 'encrypted',
        webhook_secret_encrypted: 'encrypted',
      },
      {
        id: 'payment_provider_afribapay',
        enabled: true,
        mode: 'sandbox',
        api_user_encrypted: 'encrypted',
        api_key_encrypted: 'encrypted',
        merchant_key_encrypted: 'encrypted',
        agent_id_encrypted: 'encrypted',
        catalog: [{ id: 'route-1', country: 'TG', code: 'tmoney', name: 'T-Money', currency: 'XOF', active: true }],
      },
      {
        id: 'payment_provider_mbiyo',
        enabled: true,
        mode: 'test',
        secret_key_encrypted: 'encrypted',
        catalog: [{ id: 'mbiyo-tg-moov', country: 'TG', code: 'moov_tg', name: 'Moov', currency: 'XOF', network: 'moov', active: true }],
      },
    ],
  });

  for (const provider of ['paydunya', 'izipay', 'afribapay', 'mbiyo']) {
    const result = await call(service, 'GET', `/api/admin/payment-providers/${provider}`);
    assert.equal(result.handled, true);
    assert.equal(result.status, 200);
    assert.ok(result.body);
    assert.doesNotMatch(JSON.stringify(result.body), /encrypted/);
  }
  const paydunya = await call(service, 'GET', '/api/admin/payment-providers/paydunya');
  assert.equal(paydunya.body.master_key_configured, true);
  assert.equal(paydunya.body.catalog[0].code, 'tmoney_tg');
  const izipay = await call(service, 'GET', '/api/admin/payment-providers/izipay');
  assert.equal(izipay.body.configured, true);
  const afribapay = await call(service, 'GET', '/api/admin/payment-providers/afribapay');
  assert.equal(afribapay.body.payin_available, true);
  assert.equal(afribapay.body.api_key_configured, true);
  const mbiyo = await call(service, 'GET', '/api/admin/payment-providers/mbiyo');
  assert.equal(mbiyo.body.secret_key_configured, true);
});

test('provider credentials are encrypted, omitted from responses, and audited by field name only', async () => {
  const { service, collections, authChecks, sessionSecret } = setup();
  const result = await call(service, 'PUT', '/api/admin/payment-providers/izipay', {
    api_key: 'sensitive-api-key',
    webhook_secret: 'sensitive-webhook-secret',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.configured, true);
  assert.equal(result.body.api_key_configured, true);
  assert.doesNotMatch(JSON.stringify(result.body), /sensitive/);
  assert.equal(authChecks.recent, 1);

  const saved = collections.settings.rows[0];
  const key = security.fernetKey(sessionSecret);
  assert.equal(security.decryptFernet(saved.api_key_encrypted, key), 'sensitive-api-key');
  assert.equal(security.decryptFernet(saved.webhook_secret_encrypted, key), 'sensitive-webhook-secret');
  assert.equal('api_key' in saved, false);
  const updateAudit = collections.admin_logs.rows.find(row => row.action === 'save_izipay_provider_settings');
  assert.ok(updateAudit);
  assert.match(JSON.stringify(updateAudit.details), /api_key_secret/);
  assert.doesNotMatch(JSON.stringify(updateAudit), /sensitive/);
});

test('provider step-up denial preserves REAUTH_REQUIRED so the frontend can prompt for verification', async () => {
  const { service, collections } = setup({ adminAuthMethod: 'password' });
  const result = await call(service, 'PUT', '/api/admin/payment-providers/paydunya', {
    enabled: false,
  });

  assert.equal(result.status, 428);
  assert.deepEqual(result.body.detail, {
    code: 'REAUTH_REQUIRED',
    message: 'Confirmez cette action sensible avec votre mot de passe et l’authentificateur.',
  });
  assert.equal(collections.settings.rows.length, 0);
});

test('provider settings preserve omitted credentials and clear them only explicitly', async () => {
  const { service, collections } = setup({
    settings: [{
      id: 'payment_provider_mbiyo',
      enabled: true,
      mode: 'test',
      secret_key_encrypted: 'kept-ciphertext',
      catalog: [],
    }],
  });
  const preserve = await call(service, 'PUT', '/api/admin/payment-providers/mbiyo', {
    enabled: false,
  });
  assert.equal(preserve.status, 200);
  assert.equal(preserve.body.secret_key_configured, true);
  assert.equal(collections.settings.rows[0].secret_key_encrypted, 'kept-ciphertext');

  const clear = await call(service, 'PUT', '/api/admin/payment-providers/mbiyo', {
    clear_secret_key: true,
  });
  assert.equal(clear.status, 200);
  assert.equal(clear.body.secret_key_configured, false);
  assert.equal('secret_key_encrypted' in collections.settings.rows[0], false);
});

test('legacy zero maximum remains unlimited when an operator catalogue is saved', async () => {
  const { service, collections } = setup({
    settings: [{
      id: 'payment_provider_paydunya',
      enabled: true,
      catalog: [{
        id: 'tmoney', country: 'TG', code: 'tmoney_tg', name: 'T-Money',
        currency: 'XOF', endpoint_slug: 't-money', min: 100, max: 0, active: true,
      }],
    }],
  });
  const get = await call(service, 'GET', '/api/admin/payment-providers/paydunya');
  assert.equal(get.status, 200);
  assert.equal(get.body.catalog[0].max, 0);
  const save = await call(service, 'PUT', '/api/admin/payment-providers/paydunya', {
    catalog: get.body.catalog,
  });
  assert.equal(save.status, 200);
  assert.equal(collections.settings.rows[0].catalog[0].max, null);
});

test('invalid provider settings are rejected without persisting partial changes', async () => {
  const { service, collections } = setup({
    settings: [{ id: 'payment_provider_afribapay', enabled: false, mode: 'sandbox', catalog: [] }],
  });
  const invalidUrl = await call(service, 'PUT', '/api/admin/payment-providers/afribapay', {
    enabled: true,
    live_api_base_url: 'http://untrusted.example/api',
  });
  assert.equal(invalidUrl.status, 422);
  assert.equal(collections.settings.rows[0].enabled, false);

  const invalidCatalog = await call(service, 'PUT', '/api/admin/payment-providers/paydunya', {
    catalog: [{ id: 'bad', country: 'TG', code: 'bad', name: 'Operator', currency: 'XOF' }],
  });
  assert.equal(invalidCatalog.status, 422);
  assert.equal(collections.settings.rows.length, 1);
});

test('provider settings require admin authorization and route unknown methods onward', async () => {
  const { service } = setup();
  const denied = await call(service, 'GET', '/api/admin/payment-providers/paydunya', undefined, false);
  assert.equal(denied.status, 401);
  const unsupported = await service.handleRoute({
    method: 'POST', url: '/api/admin/payment-providers/paydunya',
  }, { writeHead() {}, end() {} });
  assert.equal(unsupported, false);
});

test('server routes the payment provider page to Node instead of the migration fallback', async () => {
  const { db, sessionService } = setup({
    settings: [{
      id: 'payment_provider_paydunya',
      enabled: true,
      mode: 'test',
      catalog: [],
    }],
  });
  const server = createServer({
    db,
    sessionService,
    sessionSecret: 'test-provider-session-secret',
    env: {},
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/admin/payment-providers/paydunya`,
      { headers: { authorization: 'Bearer synthetic-admin-session' } },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mode, 'test');
    assert.equal(body.enabled, true);
    assert.notEqual(body.code, 'MIGRATION_INCOMPLETE');

  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
