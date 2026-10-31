'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createPaydunyaDisbursementRoutes } = require('../src/paydunya-disbursement-routes.cjs');

class MemoryDb {
  constructor(records) {
    this.docs = new Map(Object.entries(records).map(([key, value]) => [key, structuredClone(value)]));
  }

  collection(name) {
    return {
      find_one: async query => {
        for (const [key, doc] of this.docs) {
          if (!key.startsWith(`${name}:`)) continue;
          if (Object.entries(query).every(([field, value]) => doc[field] === value)) {
            return structuredClone(doc);
          }
        }
        return null;
      },
      update_one: async (query, update) => {
        for (const [key, doc] of this.docs) {
          if (!key.startsWith(`${name}:`)) continue;
          if (!Object.entries(query).every(([field, value]) => doc[field] === value)) continue;
          Object.assign(doc, structuredClone(update.$set || {}));
          this.docs.set(key, doc);
          return { modified_count: 1 };
        }
        return { modified_count: 0 };
      },
    };
  }

  async transaction(callback) {
    const working = new Map([...this.docs].map(([key, value]) => [key, structuredClone(value)]));
    const repo = {
      lockWallets: async () => {},
      get: async (collection, id) => structuredClone(working.get(`${collection}:${id}`) || null),
      replace: async (collection, id, document) => {
        working.set(`${collection}:${id}`, structuredClone(document));
      },
      insert: async (collection, id, document) => {
        const key = `${collection}:${id}`;
        if (working.has(key)) throw new Error('duplicate');
        working.set(key, structuredClone(document));
      },
    };
    const result = await callback(repo);
    this.docs = working;
    return result;
  }

  doc(collection, id) {
    return this.docs.get(`${collection}:${id}`);
  }
}

function setup({ providerStatus, status = 'failed' }) {
  const tx = {
    id: 'tx-payout-1',
    user_id: 'alice',
    reference: 'BTX-PAYOUT-1',
    type: 'withdrawal',
    amount: 500,
    currency: 'XOF',
    status: 'pending',
    metadata: {
      transfer_type: 'biz_to_mobile',
      provider: 'paydunya',
      paydunya_invoice_token: 'invoice-token-1',
      paydunya_disbursement_id: 'provider-payout-1',
      paydunya_withdraw_mode: 'orange-money-senegal',
      recipient_gets: 500,
      total_debit: 550,
      wallet_field: 'balance_xof',
    },
  };
  const db = new MemoryDb({
    'settings:payment_provider_paydunya': { id: 'payment_provider_paydunya', mode: 'live' },
    'users:alice': { id: 'alice', balance_xof: 1000 },
    [`transactions:${tx.id}`]: tx,
  });
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://app.paydunya.com/api/v2/disburse/check-status');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { disburse_invoice: 'invoice-token-1' });
    return {
      ok: true,
      async json() {
        return providerStatus || {
          response_code: '00',
          token: 'invoice-token-1',
          amount: 500,
          withdraw_mode: 'orange-money-senegal',
          disburse_id: 'provider-payout-1',
          status,
        };
      },
    };
  };
  const routes = createPaydunyaDisbursementRoutes({
    db,
    env: {
      PAYDUNYA_MASTER_KEY: 'test-master',
      PAYDUNYA_PRIVATE_KEY: 'test-private',
      PAYDUNYA_TOKEN: 'test-token',
    },
    fetchImpl,
  });
  return { db, routes, get calls() { return calls; } };
}

async function request(routes, response, method = 'POST') {
  const req = Readable.from(method === 'POST' ? ['callback-payload'] : []);
  req.method = method;
  req.url = '/api/webhooks/paydunya/disbursement?ref=tx-payout-1';
  const res = {
    writeHead(code) { this.statusCode = code; },
    end(body) { this.body = body; },
  };
  const handled = await routes.handleRoute(req, res);
  assert.equal(handled, true);
  return { ...res, json: JSON.parse(res.body) };
}

test('PayDunya callback checks the provider status before completing a payout', async () => {
  const context = setup({ status: 'completed' });
  const response = await request(context.routes);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.status, 'completed');
  assert.equal(context.db.doc('transactions', 'tx-payout-1').status, 'completed');
  assert.equal(context.db.doc('users', 'alice').balance_xof, 1000);
  assert.equal(context.calls, 1);
});

test('confirmed failed PayDunya payout refunds the exact debit once across repeated callbacks', async () => {
  const context = setup({ status: 'rejected' });
  const first = await request(context.routes);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json.status, 'failed');
  assert.equal(context.db.doc('transactions', 'tx-payout-1').status, 'failed');
  assert.equal(context.db.doc('users', 'alice').balance_xof, 1550);
  const second = await request(context.routes);
  assert.equal(second.statusCode, 200);
  assert.equal(second.json.status, 'failed');
  assert.equal(context.db.doc('users', 'alice').balance_xof, 1550);
  assert.equal(context.calls, 1);
});

test('mismatched PayDunya payout response cannot settle or refund the transaction', async () => {
  const context = setup({
    providerStatus: {
      response_code: '00',
      token: 'different-token',
      amount: 500,
      withdraw_mode: 'orange-money',
      disburse_id: 'provider-payout-1',
      status: 'rejected',
    },
  });
  const response = await request(context.routes);
  assert.equal(response.statusCode, 503);
  assert.equal(context.db.doc('transactions', 'tx-payout-1').status, 'pending');
  assert.equal(context.db.doc('users', 'alice').balance_xof, 1000);
});

test('missing provider response code is not treated as a successful status check', async () => {
  const context = setup({
    providerStatus: {
      token: 'invoice-token-1',
      amount: 500,
      withdraw_mode: 'orange-money',
      disburse_id: 'provider-payout-1',
      status: 'rejected',
    },
  });
  const response = await request(context.routes);
  assert.equal(response.statusCode, 503);
  assert.equal(context.db.doc('transactions', 'tx-payout-1').status, 'pending');
  assert.equal(context.db.doc('users', 'alice').balance_xof, 1000);
});
