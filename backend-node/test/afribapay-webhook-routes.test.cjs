'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const crypto = require('node:crypto');
const security = require('../src/security.cjs');
const { createAfriBaPayWebhookRoutes } = require('../src/afribapay-webhook-routes.cjs');

function createDb({ providerStatus } = {}) {
  const sessionSecret = 'webhook-test-session-secret';
  const key = security.fernetKey(sessionSecret);
  const apiKey = 'test-afribapay-key';
  const settings = {
    id: 'payment_provider_afribapay',
    mode: 'sandbox',
    api_user_encrypted: security.encryptFernet('test-api-user', key),
    api_key_encrypted: security.encryptFernet(apiKey, key),
    agent_id_encrypted: security.encryptFernet('must-not-be-sent', key),
  };
  const deposits = new Map([['order-1', {
    id: 'order-1',
    user_id: 'user-1',
    provider: 'afribapay',
    status: 'pending',
    country: 'CI',
    currency: 'XOF',
    operator: 'orange',
    phone_number: '0000000000',
    provider_submitted_amount: 2000,
    wallet_credit_amount: 1950,
    fee: 50,
    gateway_fee: 25,
    platform_fee: 25,
    created_at: '2026-01-01T00:00:00.000Z',
  }]]);
  const docs = new Map([['users:user-1', { id: 'user-1', balance_xof: 1000 }]]);
  let providerCalls = 0;
  const db = {
    collection(name) {
      if (name === 'settings') {
        return { find_one: async () => structuredClone(settings) };
      }
      if (name === 'momo_deposits') {
        return {
          find_one: async query => {
            const row = deposits.get(String(query.id || ''))
              || [...deposits.values()].find(item => item.afribapay_order_id === query.afribapay_order_id);
            return row ? structuredClone(row) : null;
          },
          update_one: async (query, update) => {
            const row = deposits.get(String(query.id || ''));
            if (!row || (query.status && row.status !== query.status)) return { modified_count: 0 };
            Object.assign(row, structuredClone(update.$set || {}));
            for (const field of Object.keys(update.$unset || {})) delete row[field];
            return { modified_count: 1 };
          },
        };
      }
      throw new Error(`Unexpected collection ${name}`);
    },
    transaction(callback) {
      const working = structuredClone(docs);
      const repo = {
        lockWallets: async () => {},
        get: async (collection, id) => structuredClone(working.get(`${collection}:${id}`) ?? null),
        replace: async (collection, id, value) => {
          working.set(`${collection}:${id}`, structuredClone(value));
        },
        insert: async (collection, id, value) => {
          if (working.has(`${collection}:${id}`)) throw new Error('duplicate');
          working.set(`${collection}:${id}`, structuredClone(value));
        },
      };
      return Promise.resolve(callback(repo)).then(result => {
        docs.clear();
        for (const [id, value] of working) docs.set(id, value);
        return result;
      });
    },
  };
  const fetchImpl = async (url, options) => {
    providerCalls += 1;
    const parsed = new URL(url);
    assert.equal(parsed.hostname, 'api-sandbox.afribapay.com');
    if (parsed.pathname === '/v1/token') {
      assert.equal(options.method, 'POST');
      assert.equal(options.headers.authorization,
        `Basic ${Buffer.from('test-api-user:test-afribapay-key').toString('base64')}`);
      assert.equal(JSON.stringify(options).includes('must-not-be-sent'), false);
      return { ok: true, json: async () => ({ data: { access_token: 'mock-provider-token' } }) };
    }
    assert.equal(parsed.pathname, '/v1/status');
    assert.equal(parsed.searchParams.get('order_id'), 'order-1');
    assert.equal(options.headers.authorization, 'Bearer mock-provider-token');
    assert.equal(JSON.stringify(options).includes('must-not-be-sent'), false);
    return { ok: true, json: async () => structuredClone(providerStatus || {
      data: {
        status: 'success',
        order_id: 'order-1',
        original_amount: '2000',
        currency: 'XOF',
        country_code: 'CI',
        transaction_id: 'provider-tx-1',
      },
    }) };
  };
  return {
    db, deposits, docs, apiKey, sessionSecret, fetchImpl,
    get providerCalls() { return providerCalls; },
  };
}

function makeRequest(raw, apiKey, signature = null) {
  const request = Readable.from([Buffer.from(raw)]);
  request.method = 'POST';
  request.url = '/api/webhooks/afribapay';
  request.headers = signature
    ? { afribapay_sign: signature }
    : {};
  return request;
}

function sign(raw, apiKey) {
  return crypto.createHmac('sha256', apiKey).update(Buffer.from(raw)).digest('hex');
}

async function send(service, raw, apiKey, signature = sign(raw, apiKey)) {
  const req = makeRequest(raw, apiKey, signature);
  const res = {
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  const handled = await service.handleRoute(req, res);
  return { handled, ...res };
}

test('AfribaPAY verifies the raw HMAC and provider status before one atomic credit', async () => {
  const fixture = createDb();
  const service = createAfriBaPayWebhookRoutes({
    db: fixture.db,
    env: { SESSION_SECRET: fixture.sessionSecret },
    fetchImpl: fixture.fetchImpl,
  });
  const raw = JSON.stringify({ order_id: 'order-1', status: 'success' });
  const first = await send(service, raw, fixture.apiKey);
  const second = await send(service, raw, fixture.apiKey);

  assert.equal(first.handled, true);
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.body, { received: true });
  assert.equal(second.statusCode, 200);
  assert.equal(fixture.providerCalls, 2);
  assert.equal(fixture.docs.get('users:user-1').balance_xof, 2950);
  assert.equal(fixture.deposits.get('order-1').status, 'approved');
  assert.equal(fixture.deposits.get('order-1').afribapay_transaction_id, 'provider-tx-1');
  const ledger = fixture.docs.get('transactions:afribapay-deposit-order-1');
  assert.equal(ledger.status, 'completed');
  assert.equal(ledger.amount, 1950);
  assert.equal(ledger.metadata.wallet_snapshot.balance_before, 1000);
  assert.equal(ledger.metadata.wallet_snapshot.balance_after, 2950);
});

test('AfribaPAY invalid signatures never call the provider or credit the wallet', async () => {
  const fixture = createDb();
  const service = createAfriBaPayWebhookRoutes({
    db: fixture.db, env: { SESSION_SECRET: fixture.sessionSecret }, fetchImpl: fixture.fetchImpl,
  });
  const raw = JSON.stringify({ order_id: 'order-1' });
  const result = await send(service, raw, fixture.apiKey, '00'.repeat(32));
  assert.equal(result.statusCode, 403);
  assert.equal(fixture.providerCalls, 0);
  assert.equal(fixture.docs.get('users:user-1').balance_xof, 1000);
});

test('AfribaPAY gross amount mismatches quarantine the deposit without credit', async () => {
  const fixture = createDb({
    providerStatus: {
      data: {
        status: 'success', order_id: 'order-1', original_amount: '1900',
        currency: 'XOF', country_code: 'CI', transaction_id: 'provider-tx-1',
      },
    },
  });
  const service = createAfriBaPayWebhookRoutes({
    db: fixture.db, env: { SESSION_SECRET: fixture.sessionSecret }, fetchImpl: fixture.fetchImpl,
  });
  const raw = JSON.stringify({ order_id: 'order-1' });
  const result = await send(service, raw, fixture.apiKey);
  assert.equal(result.statusCode, 200);
  assert.equal(fixture.deposits.get('order-1').status, 'quarantined');
  assert.equal(fixture.deposits.get('order-1').settlement_error, 'amount_mismatch');
  assert.equal(fixture.docs.get('users:user-1').balance_xof, 1000);
  assert.equal(fixture.docs.has('transactions:afribapay-deposit-order-1'), false);
});

test('AfribaPAY confirmed failures update status without changing balances', async () => {
  const fixture = createDb({
    providerStatus: {
      data: {
        status: 'failed', order_id: 'order-1', original_amount: '2000',
        currency: 'XOF', country_code: 'CI', transaction_id: 'provider-tx-1',
      },
    },
  });
  const service = createAfriBaPayWebhookRoutes({
    db: fixture.db, env: { SESSION_SECRET: fixture.sessionSecret }, fetchImpl: fixture.fetchImpl,
  });
  const raw = JSON.stringify({ order_id: 'order-1' });
  const result = await send(service, raw, fixture.apiKey);
  assert.equal(result.statusCode, 200);
  assert.equal(fixture.deposits.get('order-1').status, 'failed');
  assert.equal(fixture.docs.get('users:user-1').balance_xof, 1000);
  assert.equal(fixture.docs.has('transactions:afribapay-deposit-order-1'), false);
});
