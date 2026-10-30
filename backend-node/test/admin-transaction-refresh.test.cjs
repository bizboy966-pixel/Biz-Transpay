'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createAdminTransactionRoutes } = require('../src/admin-transaction-routes.cjs');

function clone(value) { return structuredClone(value); }
function getPath(object, path) {
  return path.split('.').reduce((value, key) => value == null ? undefined : value[key], object);
}
function setPath(object, path, value) {
  const keys = path.split('.');
  let target = object;
  for (const key of keys.slice(0, -1)) target = target[key] ||= {};
  target[keys.at(-1)] = value;
}

function createDb({ status = 'pending' } = {}) {
  const rows = {
    transactions: [{
      id: 'tx-crypto-1',
      user_id: 'user-1',
      type: 'crypto_payout',
      direction: 'out',
      amount: 4,
      currency: 'USDT',
      status,
      reference: 'BTX-PAYOUT-1',
      metadata: {
        izipay_payout_id: 'provider-payout-1',
        wallet_field: 'balance_usdt_trc20',
        total_debit: 4,
      },
    }],
    users: [{ id: 'user-1', balance_usdt_trc20: 10 }],
    wallet_operations: [],
    admin_logs: [],
  };
  const collection = name => ({
    async find_one(query) {
      const row = (rows[name] || []).find(item => Object.entries(query)
        .every(([key, value]) => String(getPath(item, key)) === String(value)));
      return row ? clone(row) : null;
    },
    async update_one(query, update) {
      const row = (rows[name] || []).find(item => Object.entries(query)
        .every(([key, value]) => String(getPath(item, key)) === String(value)));
      if (!row) return { matched_count: 0, modified_count: 0 };
      for (const [key, value] of Object.entries(update.$set || {})) setPath(row, key, value);
      return { matched_count: 1, modified_count: 1 };
    },
    async insert_one(document) {
      rows[name] ||= [];
      if (rows[name].some(item => item.id === document.id)) {
        throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
      }
      rows[name].push(clone(document));
    },
  });
  const db = {
    collection,
    async transaction(callback) {
      return callback({
        async lockWallets() {},
        async get(name, id) {
          const row = (rows[name] || []).find(item => item.id === id);
          return row ? clone(row) : null;
        },
        async replace(name, id, document) {
          rows[name] ||= [];
          const index = rows[name].findIndex(item => item.id === id);
          if (index < 0) rows[name].push(clone(document));
          else rows[name][index] = clone(document);
        },
        async insert(name, id, document) {
          rows[name] ||= [];
          if (!rows[name].some(item => item.id === id)) rows[name].push(clone(document));
        },
      });
    },
  };
  return { db, rows };
}

function request() {
  const req = Readable.from([]);
  req.method = 'POST';
  req.url = '/api/admin/transactions/tx-crypto-1/refresh';
  req.headers = {};
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function response() {
  return {
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
}

function createRoutes(db, getCryptoPayout) {
  return createAdminTransactionRoutes({
    db,
    sessionService: {},
    env: {},
    getCryptoPayout,
    authorizeAdminImpl: async (_req, options) => ({
      admin: { id: 'admin-1', username: 'finance' },
      options,
    }),
  });
}

test('confirmed crypto payout failure refunds its reserved wallet exactly once', async () => {
  const { db, rows } = createDb();
  let providerCalls = 0;
  const routes = createRoutes(db, async payoutId => {
    providerCalls += 1;
    assert.equal(payoutId, 'provider-payout-1');
    return { status: 'failed' };
  });

  const first = response();
  assert.equal(await routes.handleRoute(request(), first), true);
  assert.equal(first.status, 200);
  assert.equal(first.body.mapped_status, 'failed');
  assert.equal(rows.users[0].balance_usdt_trc20, 14);
  assert.equal(rows.transactions[0].status, 'failed');

  const retry = response();
  assert.equal(await routes.handleRoute(request(), retry), true);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.unchanged, true);
  assert.equal(rows.users[0].balance_usdt_trc20, 14);
  assert.equal(providerCalls, 1);
});

test('pending provider status does not change transaction or wallet', async () => {
  const { db, rows } = createDb();
  const routes = createRoutes(db, async () => ({ status: 'processing' }));
  const res = response();
  assert.equal(await routes.handleRoute(request(), res), true);
  assert.equal(res.status, 200);
  assert.equal(res.body.unchanged, true);
  assert.equal(rows.transactions[0].status, 'pending');
  assert.equal(rows.users[0].balance_usdt_trc20, 10);
});

test('confirmed crypto payout success updates status without refund', async () => {
  const { db, rows } = createDb();
  const routes = createRoutes(db, async () => ({
    data: { status: 'confirmed', txHash: 'chain-hash-1' },
  }));
  const res = response();
  assert.equal(await routes.handleRoute(request(), res), true);
  assert.equal(res.status, 200);
  assert.equal(res.body.mapped_status, 'completed');
  assert.equal(rows.transactions[0].status, 'completed');
  assert.equal(rows.transactions[0].metadata.tx_hash, 'chain-hash-1');
  assert.equal(rows.users[0].balance_usdt_trc20, 10);
});

test('provider timeout leaves payout pending and never refunds', async () => {
  const { db, rows } = createDb();
  const routes = createRoutes(db, async () => {
    throw Object.assign(new Error('provider unavailable'), { status: 502 });
  });
  const res = response();
  assert.equal(await routes.handleRoute(request(), res), true);
  assert.equal(res.status, 502);
  assert.equal(rows.transactions[0].status, 'pending');
  assert.equal(rows.users[0].balance_usdt_trc20, 10);
});
