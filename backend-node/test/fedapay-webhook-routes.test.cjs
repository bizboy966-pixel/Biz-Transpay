'use strict';

const { createHmac } = require('node:crypto');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createFedaPayWebhookRoutes } = require('../src/fedapay-webhook-routes.cjs');

function getPath(value, path) {
  return path.split('.').reduce((current, key) => current?.[key], value);
}
function setPath(value, path, nextValue) {
  const keys = path.split('.');
  let current = value;
  for (const key of keys.slice(0, -1)) current = current[key] ||= {};
  current[keys.at(-1)] = nextValue;
}
function createDb(initial = {}) {
  const rows = {
    users: [],
    momo_deposits: [],
    transactions: [],
    wallet_operations: [],
    ...structuredClone(initial),
  };
  const collection = name => ({
    async find_one(query) {
      const row = (rows[name] || []).find(item => Object.entries(query || {}).every(
        ([key, value]) => String(getPath(item, key)) === String(value),
      ));
      return row ? structuredClone(row) : null;
    },
    async update_one(query, update) {
      const row = (rows[name] || []).find(item => Object.entries(query || {}).every(
        ([key, value]) => String(getPath(item, key)) === String(value),
      ));
      if (!row) return { matched_count: 0, modified_count: 0 };
      for (const [key, value] of Object.entries(update.$set || {})) {
        setPath(row, key, structuredClone(value));
      }
      return { matched_count: 1, modified_count: 1 };
    },
  });
  const db = {
    rows,
    collection,
    async transaction(callback) {
      return callback({
        async lockWallets() {},
        async get(name, id) {
          const row = (rows[name] || []).find(item => String(item.id) === String(id));
          return row ? structuredClone(row) : null;
        },
        async replace(name, id, document) {
          const index = (rows[name] ||= []).findIndex(
            item => String(item.id) === String(id),
          );
          if (index < 0) rows[name].push(structuredClone(document));
          else rows[name][index] = structuredClone(document);
        },
        async insert(name, id, document) {
          rows[name] ||= [];
          if (!rows[name].some(item => String(item.id) === String(id))) {
            rows[name].push(structuredClone(document));
          }
        },
      });
    },
  };
  return db;
}

function signedRequest(event, secret = 'test-fedapay-webhook-secret') {
  const body = JSON.stringify(event);
  const timestamp = '1730000000';
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
  const req = Readable.from([Buffer.from(body)]);
  req.method = 'POST';
  req.url = '/api/webhooks/fedapay';
  req.headers = { 'x-fedapay-signature': `t=${timestamp},s=${signature}` };
  return req;
}

function response() {
  return {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
}

test('signed FedaPay approval credits the saved deposit once', async () => {
  const db = createDb({
    users: [{ id: 'user-1', balance_xof: 1200 }],
    momo_deposits: [{
      id: 'deposit-1',
      user_id: 'user-1',
      fedapay_id: 'provider-tx-1',
      status: 'pending',
      currency: 'XOF',
      amount: 10000,
      amount_net: 9500,
      reference: 'BTX-DEP-1',
    }],
  });
  const routes = createFedaPayWebhookRoutes({
    db,
    env: { FEDAPAY_WEBHOOK_SECRET: 'test-fedapay-webhook-secret' },
  });
  const event = {
    id: 'event-1',
    name: 'transaction.approved',
    entity: { id: 'provider-tx-1' },
  };

  const first = response();
  assert.equal(await routes.handleRoute(signedRequest(event), first), true);
  assert.equal(first.status, 200);
  assert.equal(db.rows.users[0].balance_xof, 10700);
  assert.equal(db.rows.momo_deposits[0].status, 'approved');
  assert.equal(db.rows.transactions.length, 1);

  const duplicate = response();
  assert.equal(await routes.handleRoute(signedRequest(event), duplicate), true);
  assert.equal(duplicate.status, 200);
  assert.equal(db.rows.users[0].balance_xof, 10700);
  assert.equal(db.rows.transactions.length, 1);
});

test('invalid FedaPay signature never changes a wallet', async () => {
  const db = createDb({
    users: [{ id: 'user-1', balance_xof: 1200 }],
    momo_deposits: [{
      id: 'deposit-1', user_id: 'user-1', fedapay_id: 'provider-tx-1',
      status: 'pending', currency: 'XOF', amount_net: 9500,
    }],
  });
  const routes = createFedaPayWebhookRoutes({
    db,
    env: { FEDAPAY_WEBHOOK_SECRET: 'test-fedapay-webhook-secret' },
  });
  const req = signedRequest({
    id: 'event-1', name: 'transaction.approved', entity: { id: 'provider-tx-1' },
  });
  req.headers['x-fedapay-signature'] = `s=${'0'.repeat(64)}`;
  const res = response();
  assert.equal(await routes.handleRoute(req, res), true);
  assert.equal(res.status, 400);
  assert.equal(db.rows.users[0].balance_xof, 1200);
  assert.equal(db.rows.momo_deposits[0].status, 'pending');
});

test('signed FedaPay payout failure refunds the reserved amount once', async () => {
  const db = createDb({
    users: [{ id: 'user-1', balance_xof: 700 }],
    transactions: [{
      id: 'payout-1',
      user_id: 'user-1',
      type: 'withdrawal',
      status: 'pending',
      currency: 'XOF',
      amount: 500,
      reference: 'BTX-PAYOUT-1',
      metadata: { fedapay_payout_id: 'provider-payout-1', total_debit: 550 },
    }],
  });
  const routes = createFedaPayWebhookRoutes({
    db,
    env: { FEDAPAY_WEBHOOK_SECRET: 'test-fedapay-webhook-secret' },
  });
  const event = {
    id: 'event-payout-1',
    name: 'payout.failed',
    entity: { id: 'provider-payout-1' },
  };

  const first = response();
  assert.equal(await routes.handleRoute(signedRequest(event), first), true);
  assert.equal(first.status, 200);
  assert.equal(db.rows.users[0].balance_xof, 1250);
  assert.equal(db.rows.transactions[0].status, 'failed');
  assert.equal(db.rows.transactions.length, 2);

  const retry = response();
  assert.equal(await routes.handleRoute(signedRequest(event), retry), true);
  assert.equal(retry.status, 200);
  assert.equal(db.rows.users[0].balance_xof, 1250);
});

test('FedaPay webhook fails closed when the signing secret is absent', async () => {
  const db = createDb();
  const routes = createFedaPayWebhookRoutes({ db, env: {} });
  const res = response();
  assert.equal(await routes.handleRoute(signedRequest({
    id: 'event-1', name: 'transaction.approved', entity: { id: 'missing' },
  }), res), true);
  assert.equal(res.status, 503);
});
