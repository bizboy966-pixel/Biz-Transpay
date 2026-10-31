'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDepositStatusRoutes } = require('../src/deposit-status-routes.cjs');

function matches(row, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$in' in expected) return expected.$in.includes(row[key]);
      if ('$gt' in expected) return String(row[key] || '') > String(expected.$gt);
    }
    return row[key] === expected;
  });
}

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query) {
    const row = this.rows.find(item => matches(item, query));
    return row ? structuredClone(row) : null;
  }
  find(query) {
    const rows = this.rows.filter(item => matches(item, query));
    let limit = rows.length;
    return {
      sort(field, direction = -1) {
        rows.sort((a, b) => String(a[field] || '').localeCompare(String(b[field] || '')) * direction);
        return this;
      },
      limit(value) { limit = value; return this; },
      async to_list(value = limit) { return structuredClone(rows.slice(0, Math.min(value, limit))); },
    };
  }
}

function setup({
  momo = [], crypto = [], reconcileAfriBaPayDepositById,
  reconcilePaydunyaDepositById,
} = {}) {
  const collections = {
    momo_deposits: new Collection(momo),
    crypto_deposits: new Collection(crypto),
  };
  const service = createDepositStatusRoutes({
    db: { collection: name => collections[name] },
    reconcileAfriBaPayDepositById,
    reconcilePaydunyaDepositById,
    sessionService: {
      async authenticate(token) {
        const userId = token === 'session-user-1' ? 'user-1'
          : token === 'session-user-2' ? 'user-2' : '';
        if (!userId) {
          const error = new Error('Session requise');
          error.status = 401;
          throw error;
        }
        return { userId };
      },
    },
  });
  return service;
}

async function call(service, path, token = 'session-user-1') {
  const req = {
    method: 'GET',
    url: path,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  const res = {
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  const handled = await service.handleRoute(req, res);
  return { handled, ...res };
}

test('mobile money deposit status is owner-scoped and exposes only customer-safe fields', async () => {
  const service = setup({
    momo: [{
      id: 'momo-1', user_id: 'user-1', status: 'pending',
      created_at: new Date().toISOString(), amount: 2500, currency: 'XOF',
      operator: 'moov-bf', phone_number: '+22670000000',
      provider: 'paydunya',
      instructions: ['<b>Confirmez le paiement</b>', { label: 'Saisissez votre PIN' }],
      finalize_capability: 'capability-1',
      paydunya_token: 'provider-secret', api_key: 'never-return',
    }],
  });
  const response = await call(service, '/api/deposits/mobile-money/momo-1');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.phone_number, '+22670000000');
  assert.deepEqual(response.body.instructions, [
    'Confirmez le paiement', 'Saisissez votre PIN',
  ]);
  assert.equal(response.body.provider, 'paydunya');
  assert.equal(response.body.finalize_capability, 'capability-1');
  assert.equal(response.body.api_key, undefined);
  assert.equal(response.body.paydunya_token, undefined);
  const otherOwner = await call(
    service, '/api/deposits/mobile-money/momo-1', 'session-user-2',
  );
  assert.equal(otherOwner.statusCode, 404);
});

test('pending mobile money recovery returns the newest eligible customer deposit', async () => {
  const now = Date.now();
  const service = setup({
    momo: [
      { id: 'older', user_id: 'user-1', provider: 'paydunya', status: 'pending',
        created_at: new Date(now - 60_000).toISOString(), amount: 100 },
      { id: 'newest', user_id: 'user-1', provider: 'mbiyo', status: 'pending',
        created_at: new Date(now).toISOString(), amount: 200 },
      { id: 'foreign', user_id: 'user-2', provider: 'paydunya', status: 'pending',
        created_at: new Date(now + 1000).toISOString(), amount: 999 },
      { id: 'unsupported', user_id: 'user-1', provider: 'other', status: 'pending',
        created_at: new Date(now + 2000).toISOString(), amount: 888 },
    ],
  });
  const response = await call(service, '/api/deposits/mobile-money/pending');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.id, 'newest');
});

test('pending direct PayDunya status verifies the invoice and keeps internal fields private', async () => {
  const row = {
    id: 'paydunya-direct-1',
    user_id: 'user-1',
    provider: 'paydunya',
    paydunya_flow: 'softpay_direct',
    paydunya_token: 'private-invoice-token',
    paydunya_softpay_state: 'sent',
    status: 'pending',
    amount: 500,
    currency: 'XOF',
  };
  let reconcileCalls = 0;
  const service = setup({
    momo: [row],
    reconcilePaydunyaDepositById: async depositId => {
      reconcileCalls += 1;
      assert.equal(depositId, row.id);
    },
  });

  const response = await call(service, '/api/deposits/mobile-money/paydunya-direct-1');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.status, 'pending');
  assert.equal(response.body.prompt_sent, true);
  assert.equal(response.body.paydunya_token, undefined);
  assert.equal(reconcileCalls, 1);
});

test('pending AfriBaPay status refresh stays with AfriBaPay and is throttled', async () => {
  const row = {
    id: 'afribapay-deposit-1',
    user_id: 'user-1',
    provider: 'afribapay',
    status: 'pending',
    amount: 500,
    currency: 'XOF',
  };
  let afriCalls = 0;
  let paydunyaCalls = 0;
  const service = setup({
    momo: [row],
    reconcileAfriBaPayDepositById: async depositId => {
      afriCalls += 1;
      assert.equal(depositId, row.id);
    },
    reconcilePaydunyaDepositById: async () => { paydunyaCalls += 1; },
  });

  const first = await call(service, '/api/deposits/mobile-money/afribapay-deposit-1');
  const second = await call(service, '/api/deposits/mobile-money/afribapay-deposit-1');
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(first.body.provider, 'afribapay');
  assert.equal(afriCalls, 1);
  assert.equal(paydunyaCalls, 0);
});

test('crypto deposit status is owner-scoped and strips internal provider fields', async () => {
  const service = setup({
    crypto: [{
      id: 'crypto-1', user_id: 'user-1', status: 'pending', amount: 10,
      coin: 'USDT', network: 'BEP20', deposit_address: '0x123',
      provider_payload: { secret: 'hidden' }, idempotency_key: 'private-key',
    }],
  });
  const response = await call(service, '/api/deposits/crypto/crypto-1');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.deposit_address, '0x123');
  assert.equal(response.body.user_id, undefined);
  assert.equal(response.body.provider_payload, undefined);
  assert.equal(response.body.idempotency_key, undefined);
  const missing = await call(service, '/api/deposits/crypto/crypto-1', 'session-user-2');
  assert.equal(missing.statusCode, 404);
});

test('unmatched paths are left for the next handler and anonymous reads are rejected', async () => {
  const service = setup();
  assert.equal(await service.handleRoute(
    { method: 'POST', url: '/api/deposits/crypto/x', headers: {} },
    { writeHead() {}, end() {} },
  ), false);
  const response = await call(service, '/api/deposits/mobile-money/pending', '');
  assert.equal(response.statusCode, 401);
});
