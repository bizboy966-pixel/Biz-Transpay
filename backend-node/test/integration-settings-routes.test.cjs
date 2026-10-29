'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matches, project } = require('../src/document-store.cjs');
const { createIntegrationSettingsRoutes } = require('../src/integration-settings-routes.cjs');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query, projection) {
    const row = this.rows.find(item => matches(item, query));
    return row ? project(row, projection) : null;
  }
  find(query = {}, projection = null) {
    const collection = this;
    return {
      key: null, direction: 1,
      sort(key, direction = 1) { this.key = key; this.direction = direction; return this; },
      to_list: async limit => {
        let rows = collection.rows.filter(row => matches(row, query))
          .map(row => project(row, projection));
        if (this.key) rows.sort((a, b) => (a[this.key] > b[this.key] ? 1 : -1) * this.direction);
        if (Number.isFinite(limit)) rows = rows.slice(0, limit);
        return rows;
      },
    };
  }
}

function setup({ userId = 'merchant-1', accountType = 'merchant', enabled = true } = {}) {
  const collections = {
    users: new Collection([{ id: userId, account_type: accountType }]),
    settings: new Collection([{ id: 'app_features', payment_api_enabled: enabled }]),
    integration_credentials: new Collection([{
      id: 'cred-1', user_id: 'merchant-1', environment: 'live',
      public_key: 'pk_live_examplekey', secret_hash: 'must-not-leak',
      active: true, scopes: ['payments:create'], created_at: '2026-01-01T00:00:00.000Z',
    }]),
    integration_webhooks: new Collection([{
      id: 'merchant-1:live', user_id: 'merchant-1', environment: 'live',
      url: 'https://merchant.example.test/hook', active: true,
      secret_encrypted: 'must-not-leak',
    }]),
    integration_webhook_deliveries: new Collection([
      {
        id: 'delivery-1', user_id: 'merchant-1', environment: 'live',
        destination_id: 'merchant-1:live', status: 'succeeded',
        payload: { secret: 'must-not-leak' }, created_at: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'delivery-other-user', user_id: 'merchant-2', environment: 'live',
        destination_id: 'merchant-1:live', status: 'failed',
        created_at: '2026-01-03T00:00:00.000Z',
      },
    ]),
  };
  const service = createIntegrationSettingsRoutes({
    db: { collection: name => collections[name] },
    sessionService: {
      async authenticate(token) {
        if (token !== 'merchant-session') throw Object.assign(new Error('Session requise'), { status: 401 });
        return { userId };
      },
    },
  });
  return { service };
}

async function call(service, url, token = 'merchant-session') {
  const res = {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  const handled = await service.handleRoute({
    method: 'GET', url, headers: { authorization: `Bearer ${token}` },
  }, res);
  return { handled, status: res.status, body: res.body };
}

test('integration settings return only the caller merchant credential and webhook metadata', async () => {
  const { service } = setup();
  const result = await call(service, '/api/integration/settings?environment=live');
  assert.equal(result.status, 200);
  assert.equal(result.body.available, true);
  assert.equal(result.body.credentials.public_key, 'pk_live_examplekey');
  assert.equal(result.body.credentials.public_key_masked, 'pk_live_…');
  assert.equal(result.body.webhook.secret_configured, true);
  assert.equal(JSON.stringify(result.body).includes('must-not-leak'), false);
});

test('integration settings preserve sandbox restrictions and reject non-merchants', async () => {
  const { service } = setup();
  const sandbox = await call(service, '/api/integration/settings?environment=test');
  assert.equal(sandbox.status, 200);
  assert.equal(sandbox.body.available, false);
  assert.match(sandbox.body.message, /Sandbox/);

  const invalid = await call(service, '/api/integration/settings?environment=production');
  assert.equal(invalid.status, 422);
  const nonMerchant = await call(setup({ accountType: 'personal' }).service,
    '/api/integration/settings?environment=live');
  assert.equal(nonMerchant.status, 403);
});

test('integration settings require an authenticated session and honor the payment API switch', async () => {
  const unauthorized = await call(setup().service, '/api/integration/settings?environment=live', 'invalid');
  assert.equal(unauthorized.status, 401);

  const disabled = await call(setup({ enabled: false }).service,
    '/api/integration/settings?environment=live');
  assert.equal(disabled.status, 403);
  assert.equal(disabled.body.detail.code, 'PAYMENT_API_DISABLED');
});

test('webhook reads are owner-scoped and never expose stored secrets or payloads', async () => {
  const { service } = setup();
  const webhooks = await call(service, '/api/integration/webhooks/live');
  assert.equal(webhooks.status, 200);
  assert.equal(webhooks.body.webhooks.length, 1);
  assert.equal(webhooks.body.webhooks[0].secret_configured, true);
  assert.equal(JSON.stringify(webhooks.body).includes('must-not-leak'), false);

  const deliveries = await call(service, '/api/integration/webhooks/live/deliveries?limit=1');
  assert.equal(deliveries.status, 200);
  assert.equal(deliveries.body.length, 1);
  assert.equal(deliveries.body[0].id, 'delivery-1');
  assert.equal(Object.hasOwn(deliveries.body[0], 'payload'), false);

  const invalidLimit = await call(service, '/api/integration/webhooks/live/deliveries?limit=201');
  assert.equal(invalidLimit.status, 422);
});
