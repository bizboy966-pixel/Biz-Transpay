'use strict';

const crypto = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matches, project } = require('../src/document-store.cjs');
const { createDepositStatusRoutes } = require('../src/deposit-status-routes.cjs');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query, projection) {
    const row = this.rows.find(item => matches(item, query));
    return row ? project(row, projection) : null;
  }
  async update_one(query, update) {
    const row = this.rows.find(item => matches(item, query));
    if (!row) return { matched_count: 0, modified_count: 0 };
    Object.assign(row, structuredClone(update.$set || {}));
    return { matched_count: 1, modified_count: 1 };
  }
}

function setup({
  enabled = true,
  capability = 'high-entropy-capability',
  expiresAt = new Date(Date.now() + 60_000).toISOString(),
  token = 'psr-invoice-token',
} = {}) {
  const collections = {
    settings: new Collection([{
      id: 'payment_provider_paydunya',
      enabled,
      mode: 'live',
      modes: { psr: { enabled } },
    }]),
    momo_deposits: new Collection([{
      id: 'deposit-psr-1',
      user_id: 'merchant-1',
      provider: 'paydunya',
      paydunya_flow: 'psr',
      status: 'pending',
      psr_capability_hash: crypto.createHash('sha256').update(capability).digest('hex'),
      psr_capability_used: false,
      psr_capability_expires_at: expiresAt,
      paydunya_token: token,
    }]),
  };
  const service = createDepositStatusRoutes({
    db: { collection: name => collections[name] },
    sessionService: {
      async authenticate() { throw new Error('Capability route must not require a session'); },
    },
  });
  return { service, collections, capability };
}

async function getToken(service, capability = 'high-entropy-capability') {
  const res = {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  const handled = await service.handleRoute({
    method: 'GET',
    url: `/api/deposits/paydunya/psr/deposit-psr-1/token/${encodeURIComponent(capability)}`,
    headers: {},
  }, res);
  return { handled, status: res.status, body: res.body };
}

test('PayDunya PSR capability returns the token once and consumes it atomically', async () => {
  const { service, collections, capability } = setup();
  const first = await getToken(service, capability);
  assert.equal(first.handled, true);
  assert.equal(first.status, 200);
  assert.deepEqual(first.body, { success: true, token: 'psr-invoice-token' });
  assert.equal(collections.momo_deposits.rows[0].psr_capability_used, true);
  const retry = await getToken(service, capability);
  assert.equal(retry.status, 404);
});

test('PayDunya PSR capability rejects expired credentials and disabled mode', async () => {
  const expired = setup({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
  assert.equal((await getToken(expired.service, expired.capability)).status, 404);
  const disabled = setup({ enabled: false });
  assert.equal((await getToken(disabled.service, disabled.capability)).status, 503);
});
