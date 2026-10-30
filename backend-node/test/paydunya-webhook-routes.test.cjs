'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { createPaydunyaWebhookRoutes } = require('../src/paydunya-webhook-routes.cjs');

const MASTER = 'mock-paydunya-master';
const STATIC_HASH = createHash('sha512').update(MASTER).digest('hex');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query) {
    const row = this.rows.find(item => Object.entries(query).every(([key, value]) => (
      item[key] === value
    )));
    return row ? structuredClone(row) : null;
  }
  async update_one(query, update) {
    const row = this.rows.find(item => Object.entries(query).every(([key, value]) => (
      item[key] === value
    )));
    if (!row) return { matched_count: 0, modified_count: 0 };
    Object.assign(row, structuredClone(update.$set || {}));
    return { matched_count: 1, modified_count: 1 };
  }
}

function createDb({ depositStatus = 'pending', expectedAmount = 1000 } = {}) {
  const collections = new Map([
    ['settings', new Collection([{
      id: 'payment_provider_paydunya', enabled: true, mode: 'test',
    }])],
    ['momo_deposits', new Collection([{
      id: 'deposit-1',
      user_id: 'user-1',
      provider: 'paydunya',
      paydunya_token: 'provider-invoice-1',
      paydunya_reference: 'ref-1',
      provider_mode: 'test',
      status: depositStatus,
      initiation_state: 'ready',
      currency: 'XOF',
      amount: expectedAmount,
      requested_amount: expectedAmount,
      charged_amount: expectedAmount,
      wallet_credit_amount: 980,
      gateway_fee: 20,
      platform_fee: 0,
      total_fee: 20,
      country: 'TG',
      operator: 'tmoney',
      operator_name: 'T-Money',
      created_at: '2026-05-01T10:00:00.000Z',
    }])],
    ['users', new Collection([{
      id: 'user-1', balance_xof: 0, wallet_credit_operation_ids: [],
    }])],
    ['wallet_operations', new Collection()],
    ['transactions', new Collection()],
  ]);
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, new Collection());
      return collections.get(name);
    },
    async transaction(callback) {
      const working = new Map([...collections.entries()].map(([name, collection]) => (
        [name, structuredClone(collection.rows)]
      )));
      const repo = {
        async lockWallets() {},
        async get(table, id) {
          return structuredClone((working.get(table) || []).find(row => row.id === id) || null);
        },
        async insert(table, id, document) {
          if (!working.has(table)) working.set(table, []);
          if (working.get(table).some(row => row.id === id)) {
            throw new Error(`duplicate ${table}:${id}`);
          }
          working.get(table).push(structuredClone(document));
        },
        async replace(table, id, document) {
          if (!working.has(table)) working.set(table, []);
          const rows = working.get(table);
          const index = rows.findIndex(row => row.id === id);
          if (index < 0) rows.push(structuredClone(document));
          else rows[index] = structuredClone(document);
        },
      };
      const result = await callback(repo);
      for (const [name, rows] of working) {
        if (!collections.has(name)) collections.set(name, new Collection());
        collections.get(name).rows = rows;
      }
      return result;
    },
  };
}

function confirmation(amount = 1000) {
  return {
    response_code: '00',
    data: {
      status: 'completed',
      hash: STATIC_HASH,
      invoice: {
        token: 'provider-invoice-1',
        total_amount: amount,
        currency: 'XOF',
      },
      custom_data: {
        biztranspay_token: 'deposit-1',
        biztranspay_amount: String(amount),
        biztranspay_currency: 'XOF',
      },
    },
  };
}

function setup({ depositStatus, expectedAmount = 1000, providerResponse } = {}) {
  const db = createDb({ depositStatus, expectedAmount });
  let providerCalls = 0;
  const service = createPaydunyaWebhookRoutes({
    db,
    env: {
      SESSION_SECRET: 'test-session-secret',
      PAYDUNYA_MASTER_KEY: MASTER,
      PAYDUNYA_PRIVATE_KEY: 'mock-private',
      PAYDUNYA_TOKEN: 'mock-token',
    },
    fetchImpl: async (url, options) => {
      providerCalls += 1;
      assert.match(url, /^https:\/\/app\.paydunya\.com\/sandbox-api\/v1\/checkout-invoice\/confirm\//);
      assert.equal(options.method, 'GET');
      return {
        ok: true,
        status: 200,
        async json() { return providerResponse || confirmation(expectedAmount); },
      };
    },
  });
  return { db, service, providerCalls: () => providerCalls };
}

async function call(service, payload, { contentType = 'application/json', body } = {}) {
  const content = body ?? JSON.stringify(payload);
  const req = Readable.from([Buffer.from(content)]);
  req.method = 'POST';
  req.url = '/api/webhooks/paydunya';
  req.headers = { 'content-type': contentType };
  const res = {
    status: 500,
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
  const handled = await service.handleRoute(req, res);
  return { handled, status: res.status, body: res.body };
}

test('PayDunya nested form webhook verifies with the provider and credits once atomically', async () => {
  const { db, service, providerCalls } = setup();
  const form = new URLSearchParams({
    hash: STATIC_HASH,
    'data[invoice][token]': 'provider-invoice-1',
    'data[status]': 'completed',
  }).toString();
  const first = await call(service, null, {
    contentType: 'application/x-www-form-urlencoded',
    body: form,
  });
  const duplicate = await call(service, {
    hash: STATIC_HASH,
    data: { invoice: { token: 'provider-invoice-1' } },
  });
  assert.equal(first.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(providerCalls(), 1);
  assert.equal(db.collection('users').rows[0].balance_xof, 980);
  assert.equal(db.collection('transactions').rows.length, 1);
  assert.equal(db.collection('momo_deposits').rows[0].status, 'approved');
  assert.equal(db.collection('transactions').rows[0].metadata.wallet_snapshot.balance_before, 0);
  assert.equal(db.collection('transactions').rows[0].metadata.wallet_snapshot.balance_after, 980);
});

test('PayDunya callback hash mismatch never calls provider or credits the wallet', async () => {
  const { db, service, providerCalls } = setup();
  const result = await call(service, {
    hash: '00'.repeat(64),
    data: { invoice: { token: 'provider-invoice-1' } },
  });
  assert.equal(result.status, 400);
  assert.equal(providerCalls(), 0);
  assert.equal(db.collection('users').rows[0].balance_xof, 0);
  assert.equal(db.collection('transactions').rows.length, 0);
});

test('PayDunya confirmed amount mismatch quarantines the deposit without credit', async () => {
  const { db, service } = setup({ providerResponse: confirmation(1001) });
  const result = await call(service, {
    hash: STATIC_HASH,
    data: { invoice: { token: 'provider-invoice-1' } },
  });
  assert.equal(result.status, 200);
  assert.equal(db.collection('users').rows[0].balance_xof, 0);
  assert.equal(db.collection('momo_deposits').rows[0].status, 'quarantined');
  assert.equal(db.collection('transactions').rows.length, 0);
});

test('an existing PayDunya invoice still settles after new checkouts are disabled', async () => {
  const { db, service } = setup();
  db.collection('settings').rows[0].enabled = false;
  const result = await call(service, {
    hash: STATIC_HASH,
    data: { invoice: { token: 'provider-invoice-1' } },
  });
  assert.equal(result.status, 200);
  assert.equal(db.collection('users').rows[0].balance_xof, 980);
  assert.equal(db.collection('momo_deposits').rows[0].status, 'approved');
});
