'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { matches, project } = require('../src/document-store.cjs');
const security = require('../src/security.cjs');
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
  async replace_one(query, replacement, upsert = false) {
    const index = this.rows.findIndex(item => matches(item, query));
    if (index < 0) {
      if (upsert) this.rows.push(structuredClone(replacement));
      return { matched_count: 0, upserted_count: upsert ? 1 : 0 };
    }
    this.rows[index] = structuredClone(replacement);
    return { matched_count: 1, modified_count: 1 };
  }
  async insert_one(document) {
    this.rows.push(structuredClone(document));
    return { inserted_id: document.id };
  }
  async update_one(query, update) {
    const row = this.rows.find(item => matches(item, query));
    if (!row) return { matched_count: 0, modified_count: 0 };
    Object.assign(row, structuredClone(update.$set || update));
    return { matched_count: 1, modified_count: 1 };
  }
  async delete_one(query) {
    const index = this.rows.findIndex(item => matches(item, query));
    if (index < 0) return { deleted_count: 0 };
    this.rows.splice(index, 1);
    return { deleted_count: 1 };
  }
  async delete_many(query) {
    const previous = this.rows.length;
    this.rows = this.rows.filter(item => !matches(item, query));
    return { deleted_count: previous - this.rows.length };
  }
}

function setup({
  userId = 'merchant-1', accountType = 'merchant', enabled = true,
  includeCredential = true, recentAuth = true,
  resolvedAddress = '93.184.216.34',
  fetchImpl = async () => ({ status: 204 }),
} = {}) {
  const collections = {
    users: new Collection([{ id: userId, account_type: accountType }]),
    settings: new Collection([{ id: 'app_features', payment_api_enabled: enabled }]),
    integration_credentials: new Collection(includeCredential ? [{
      id: 'cred-1', user_id: 'merchant-1', environment: 'live',
      public_key: 'pk_live_examplekey', secret_hash: 'must-not-leak',
      active: true, scopes: ['payments:create'], created_at: '2026-01-01T00:00:00.000Z',
    }] : []),
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
    env: { SESSION_SECRET: 'integration-test-session-secret' },
    resolveHostname: async () => [{ address: resolvedAddress, family: 4 }],
    fetchImpl,
    sessionService: {
      async authenticate(token) {
        if (token !== 'merchant-session') throw Object.assign(new Error('Session requise'), { status: 401 });
        return { userId, session: { last_auth_at: recentAuth ? new Date().toISOString() : null } };
      },
      requireRecentAuth(identity) {
        if (!identity.session?.last_auth_at) {
          throw Object.assign(new Error('Réauthentification requise'), { status: 428 });
        }
        return identity.userId;
      },
    },
  });
  return { service, collections };
}

test('webhook test endpoint sends a signed event and stores a sanitized delivery', async () => {
  const requests = [];
  const { service, collections } = setup({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { status: 204 };
    },
  });
  const encryptionKey = security.integrationEncryptionKey(
    'integration-test-session-secret',
    undefined,
  );
  collections.integration_webhooks.rows[0].secret_encrypted = security.encryptFernet(
    'webhook-test-secret', encryptionKey,
  );

  const result = await call(service, '/api/integration/webhooks/live/test', { method: 'POST' });
  assert.equal(result.status, 200);
  assert.equal(result.body.sent, true);
  assert.equal(result.body.event, 'webhook.test');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://merchant.example.test/hook');
  const timestamp = requests[0].options.headers['X-BizTransPay-Timestamp'];
  const body = requests[0].options.body;
  const expected = `sha256=${crypto.createHmac('sha256', 'webhook-test-secret')
    .update(`${timestamp}.${body}`, 'utf8').digest('hex')}`;
  assert.equal(requests[0].options.headers['X-BizTransPay-Signature'], expected);
  const delivery = collections.integration_webhook_deliveries.rows
    .find(row => row.id === result.body.delivery_id);
  assert.equal(delivery.status, 'delivered');
  assert.equal(delivery.attempts, 1);
  assert.equal(JSON.stringify(delivery).includes('webhook-test-secret'), false);
});

test('specific webhook test rejects private destinations and retries delivery failures', async () => {
  let attempts = 0;
  const { service, collections } = setup({
    fetchImpl: async () => { attempts += 1; return { status: 503 }; },
  });
  const encryptionKey = security.integrationEncryptionKey(
    'integration-test-session-secret',
    undefined,
  );
  collections.integration_webhooks.rows[0].secret_encrypted = security.encryptFernet(
    'webhook-test-secret', encryptionKey,
  );
  const failed = await call(
    service,
    '/api/integration/webhooks/live/merchant-1%3Alive/test',
    { method: 'POST' },
  );
  assert.equal(failed.status, 502);
  assert.equal(attempts, 3);
  assert.equal(
    collections.integration_webhook_deliveries.rows.at(-1).error,
    'HTTP 503',
  );

  const privateTarget = setup({ resolvedAddress: '127.0.0.1' });
  const privateResult = await call(
    privateTarget.service,
    '/api/integration/webhooks/live/merchant-1%3Alive/test',
    { method: 'POST' },
  );
  assert.equal(privateResult.status, 422);
});

async function call(service, url, tokenOrOptions = 'merchant-session') {
  const options = typeof tokenOrOptions === 'string'
    ? { token: tokenOrOptions } : tokenOrOptions;
  const body = options.body;
  const res = {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  const req = {
    method: options.method || 'GET',
    url,
    headers: { authorization: `Bearer ${options.token || 'merchant-session'}` },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
  const handled = await service.handleRoute(req, res);
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

test('credential creation returns the secret once and stores only its hash', async () => {
  const { service, collections } = setup({ includeCredential: false });
  const first = await call(service, '/api/integration/credentials', {
    method: 'POST', body: { environment: 'live', payout_opt_in: true },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.secret_returned_once, true);
  assert.match(first.body.credentials.public_key, /^pk_live_/);
  assert.match(first.body.secret_key, /^sk_live_/);
  const stored = collections.integration_credentials.rows[0];
  assert.equal(stored.secret_hash,
    crypto.createHash('sha256').update(first.body.secret_key, 'utf8').digest('hex'));
  assert.equal(stored.secret_key, undefined);
  assert.deepEqual(stored.scopes, [
    'deposits:write', 'exchanges:write', 'links:write',
    'transactions:read', 'payouts:write',
  ]);
  assert.equal(JSON.stringify(first.body).includes(stored.secret_hash), false);

  const repeated = await call(service, '/api/integration/credentials', {
    method: 'POST', body: { environment: 'live' },
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.secret_key, null);
  assert.equal(repeated.body.credentials.public_key, first.body.credentials.public_key);
});

test('credential regeneration rotates the key while preserving payout opt-in', async () => {
  const { service, collections } = setup();
  collections.integration_credentials.rows[0].payout_opt_in = true;
  collections.integration_credentials.rows[0].scopes.push('payouts:write');
  const oldPublicKey = collections.integration_credentials.rows[0].public_key;
  const result = await call(service, '/api/integration/credentials/live/regenerate', {
    method: 'POST',
  });
  assert.equal(result.status, 200);
  assert.notEqual(result.body.credentials.public_key, oldPublicKey);
  assert.match(result.body.secret_key, /^sk_live_/);
  assert.equal(result.body.secret_returned_once, true);
  assert.equal(collections.integration_credentials.rows[0].payout_opt_in, true);
  assert.ok(collections.integration_credentials.rows[0].scopes.includes('payouts:write'));
});

test('credential access changes are validated and can only enable payouts in live', async () => {
  const { service, collections } = setup();
  const disabled = await call(service, '/api/integration/credentials/live', {
    method: 'PATCH', body: { active: false, payout_opt_in: true },
  });
  assert.equal(disabled.status, 200);
  assert.equal(collections.integration_credentials.rows[0].active, false);
  assert.equal(collections.integration_credentials.rows[0].payout_opt_in, true);
  assert.ok(collections.integration_credentials.rows[0].scopes.includes('payouts:write'));

  const testEnvironment = await call(service, '/api/integration/credentials/test', {
    method: 'PATCH', body: { active: true, payout_opt_in: true },
  });
  assert.equal(testEnvironment.status, 404);
  const invalid = await call(service, '/api/integration/credentials/live', {
    method: 'PATCH', body: { active: 'yes' },
  });
  assert.equal(invalid.status, 422);
});

test('credential deletion requires recent authentication and confirmation, preserving deliveries', async () => {
  const stale = await call(setup({ recentAuth: false }).service,
    '/api/integration/credentials/live', {
      method: 'DELETE', body: { confirmation: 'SUPPRIMER' },
    });
  assert.equal(stale.status, 428);

  const { service, collections } = setup();
  const rejected = await call(service, '/api/integration/credentials/live', {
    method: 'DELETE', body: { confirmation: 'no' },
  });
  assert.equal(rejected.status, 422);
  assert.equal(collections.integration_credentials.rows.length, 1);

  const deleted = await call(service, '/api/integration/credentials/live', {
    method: 'DELETE', body: { confirmation: 'SUPPRIMER' },
  });
  assert.equal(deleted.status, 200);
  assert.equal(collections.integration_credentials.rows.length, 0);
  assert.equal(collections.integration_webhooks.rows.length, 0);
  assert.equal(collections.integration_webhook_deliveries.rows.length, 2);
});

test('webhook creation returns its secret once and stores only the encrypted secret', async () => {
  const { service, collections } = setup();
  const created = await call(service, '/api/integration/webhooks/live', {
    method: 'POST',
    body: { name: 'Orders', url: 'https://hooks.example.com/payments', active: true },
  });
  assert.equal(created.status, 200);
  assert.match(created.body.webhook_secret, /^whsec_/);
  assert.equal(created.body.secret_returned_once, true);
  assert.equal(created.body.webhook.name, 'Orders');
  assert.equal(created.body.webhook.secret_configured, true);
  const saved = collections.integration_webhooks.rows.find(row => row.name === 'Orders');
  assert.ok(saved);
  assert.notEqual(saved.secret_encrypted, created.body.webhook_secret);
  assert.equal(JSON.stringify(created.body).includes(saved.secret_encrypted), false);
});

test('webhook URLs reject local and privately resolved destinations', async () => {
  const invalidLiteral = await call(setup().service, '/api/integration/webhooks/live', {
    method: 'POST',
    body: { name: 'Local', url: 'http://127.0.0.1:8080/hook' },
  });
  assert.equal(invalidLiteral.status, 422);

  const privateDns = await call(setup({ resolvedAddress: '10.0.0.15' }).service,
    '/api/integration/webhooks/live', {
      method: 'POST',
      body: { name: 'Private', url: 'https://private.example.com/hook' },
    });
  assert.equal(privateDns.status, 422);

  const stale = await call(setup({ recentAuth: false }).service,
    '/api/integration/webhooks/live', {
      method: 'POST',
      body: { name: 'Stale', url: 'https://hooks.example.com/hook' },
    });
  assert.equal(stale.status, 428);
});

test('default webhook updates preserve an existing secret and rotate it only on request', async () => {
  const { service, collections } = setup();
  const configured = await call(service, '/api/integration/webhooks/live', {
    method: 'PUT',
    body: { url: 'https://hooks.example.com/first' },
  });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.secret_returned_once, false);
  assert.equal(configured.body.webhook_secret, null);

  const rotated = await call(service, '/api/integration/webhooks/live/regenerate-secret', {
    method: 'POST',
  });
  assert.equal(rotated.status, 200);
  assert.match(rotated.body.webhook_secret, /^whsec_/);
  assert.equal(rotated.body.secret_returned_once, true);
  const saved = collections.integration_webhooks.rows[0];
  assert.notEqual(saved.secret_encrypted, rotated.body.webhook_secret);

  const updated = await call(service, '/api/integration/webhooks/live', {
    method: 'PUT',
    body: { url: 'https://hooks.example.com/second', active: false },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.webhook_secret, null);
  assert.equal(updated.body.active, false);
});

test('webhook update, rotation and deletion are owner-scoped and retain deliveries', async () => {
  const { service, collections } = setup();
  const id = 'merchant-1:live';
  const updated = await call(service, `/api/integration/webhooks/live/${id}`, {
    method: 'PATCH',
    body: { active: false },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.webhook.active, false);

  const rotated = await call(service, `/api/integration/webhooks/live/${id}/regenerate-secret`, {
    method: 'POST',
  });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.body.webhook_id, id);
  assert.match(rotated.body.webhook_secret, /^whsec_/);

  const forbidden = await call(setup({ userId: 'merchant-2' }).service,
    `/api/integration/webhooks/live/${id}`, { method: 'DELETE' });
  assert.equal(forbidden.status, 404);

  const deleted = await call(service, `/api/integration/webhooks/live/${id}`, {
    method: 'DELETE',
  });
  assert.equal(deleted.status, 200);
  assert.equal(collections.integration_webhooks.rows.length, 0);
  assert.equal(collections.integration_webhook_deliveries.rows.length, 2);
});
