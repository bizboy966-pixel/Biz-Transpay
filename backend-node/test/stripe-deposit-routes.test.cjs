'use strict';

const crypto = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createStripeDepositRoutes } = require('../src/stripe-deposit-routes.cjs');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query) {
    const row = this.rows.find(item => Object.entries(query).every(([key, value]) => (
      item[key] === value
    )));
    return row ? structuredClone(row) : null;
  }
  async insert_one(row) {
    if (this.rows.some(item => item.id === row.id)) throw new Error('duplicate id');
    this.rows.push(structuredClone(row));
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

function createDb() {
  const collections = new Map([
    ['users', new Collection([{
      id: 'user-1', balance_xof: 0, balance_xaf: 0, wallet_credit_operation_ids: [],
    }])],
    ['transactions', new Collection()],
    ['wallet_operations', new Collection()],
  ]);
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, new Collection());
      return collections.get(name);
    },
    async transaction(callback) {
      const working = new Map([...collections].map(([name, collection]) => (
        [name, structuredClone(collection.rows)]
      )));
      const repo = {
        async lockWallets() {},
        async get(table, id) {
          return structuredClone((working.get(table) || []).find(row => row.id === id) || null);
        },
        async insert(table, id, document) {
          if (!working.has(table)) working.set(table, []);
          if (working.get(table).some(row => row.id === id)) throw new Error('duplicate row');
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

function request(method, url, body = '', headers = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : []);
  req.method = method;
  req.url = url;
  req.headers = headers;
  return req;
}

async function call(service, req) {
  const res = {
    status: 500,
    writeHead(status) { this.status = status; },
    end(text) { this.body = text ? JSON.parse(text) : null; },
  };
  const handled = await service.handleRoute(req, res);
  return { handled, status: res.status, body: res.body };
}

function signedHeader(payload, secret) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function setup({ configured = true, recent = true } = {}) {
  const db = createDb();
  const calls = [];
  const env = {
    ...(configured ? { STRIPE_API_KEY: 'sk_test_dummy', STRIPE_WEBHOOK_SECRET: 'whsec_dummy' } : {}),
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'POST') {
      return {
        ok: true,
        json: async () => ({
          id: 'cs_test_123',
          url: 'https://checkout.stripe.com/c/pay/cs_test_123',
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        id: 'cs_test_123',
        status: 'complete',
        payment_status: 'paid',
        currency: 'usd',
        amount_total: 100,
        payment_intent: 'pi_test_123',
        metadata: { user_id: 'user-1', currency: 'XOF', amount_local: '600' },
      }),
    };
  };
  const service = createStripeDepositRoutes({
    db,
    sessionService: {
      authenticate: async token => (
        token === 'valid-session'
          ? { userId: 'user-1', session: { last_auth_at: new Date() } }
          : null
      ),
      requireRecentAuth: () => {
        if (!recent) throw new Error('reauth required');
        return 'user-1';
      },
    },
    env,
    fetchImpl,
  });
  return { db, service, calls, env };
}

test('Stripe checkout is owner-authenticated, idempotent, and does not credit before provider confirmation', async () => {
  const { db, service, calls } = setup();
  const body = JSON.stringify({
    amount: 600,
    currency: 'XOF',
    origin_url: 'https://biz-transpay.com',
    idempotency_key: 'stripe-deposit-600-xof',
  });
  const req = request('POST', '/api/deposits/checkout', body, {
    authorization: 'Bearer valid-session',
  });
  const result = await call(service, req);
  assert.equal(result.status, 200);
  assert.equal(result.body.session_id, 'cs_test_123');
  assert.equal(db.collection('transactions').rows.length, 1);
  assert.equal(db.collection('users').rows[0].balance_xof, 0);
  assert.ok(calls[0].options.headers['Idempotency-Key']);

  const status = await call(service, request(
    'GET', '/api/payments/status/cs_test_123', '', {
      authorization: 'Bearer valid-session',
    },
  ));
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.session_id, 'cs_test_123');
  assert.equal(status.body.payment_status, 'paid');
  assert.equal(db.collection('users').rows[0].balance_xof, 600);
});

test('Stripe webhook verifies signature and provider status before exactly-once credit', async () => {
  const { db, service, calls } = setup();
  const checkoutBody = JSON.stringify({
    amount: 600, currency: 'XOF', origin_url: 'https://biz-transpay.com',
    idempotency_key: 'stripe-deposit-600-xof',
  });
  await call(service, request('POST', '/api/deposits/checkout', checkoutBody, {
    authorization: 'Bearer valid-session',
  }));
  const payload = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_123' } },
  });
  const headers = { 'stripe-signature': signedHeader(payload, 'whsec_dummy') };
  const event = await call(service, request('POST', '/api/webhook/stripe', payload, headers));
  assert.equal(event.status, 200);
  assert.equal(db.collection('users').rows[0].balance_xof, 600);
  assert.equal(db.collection('transactions').rows[0].status, 'completed');
  assert.equal(calls.filter(entry => entry.options.method !== 'POST').length, 1);
  await call(service, request('POST', '/api/webhook/stripe', payload, headers));
  assert.equal(db.collection('users').rows[0].balance_xof, 600);
  assert.equal(db.collection('transactions').rows.length, 2);
});

test('Stripe webhook rejects an invalid signature before checking the provider', async () => {
  const { db, service, calls } = setup();
  const payload = JSON.stringify({
    type: 'checkout.session.completed',
    data: { object: { id: 'cs_test_123' } },
  });
  const result = await call(service, request('POST', '/api/webhook/stripe', payload, {
    'stripe-signature': 't=1,v1=00',
  }));
  assert.equal(result.status, 400);
  assert.equal(calls.length, 0);
  assert.equal(db.collection('users').rows[0].balance_xof, 0);
});

test('Stripe checkout fails explicitly when its server key is not configured', async () => {
  const { service, calls } = setup({ configured: false });
  const result = await call(service, request(
    'POST', '/api/deposits/checkout',
    JSON.stringify({
      amount: 600, currency: 'XOF', origin_url: 'https://biz-transpay.com',
    }),
    { authorization: 'Bearer valid-session' },
  ));
  assert.equal(result.status, 503);
  assert.equal(calls.length, 0);
});

test('Stripe checkout requires recent account authentication', async () => {
  const { service, calls } = setup({ recent: false });
  const result = await call(service, request(
    'POST', '/api/deposits/checkout',
    JSON.stringify({
      amount: 600, currency: 'XOF', origin_url: 'https://biz-transpay.com',
    }),
    { authorization: 'Bearer valid-session' },
  ));
  assert.equal(result.status, 428);
  assert.equal(calls.length, 0);
});
