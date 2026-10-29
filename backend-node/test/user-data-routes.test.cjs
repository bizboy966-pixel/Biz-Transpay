'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const security = require('../src/security.cjs');
const { createServer } = require('../src/server.cjs');
const { SessionService, SESSION_COOKIE_NAME } = require('../src/session-service.cjs');
const { operationIdentity } = require('../src/wallet.cjs');
const { matches, applyUpdate, project, firstPath } = require('../src/document-store.cjs');

class MemoryCollection {
  constructor() { this.documents = []; }
  async insert_one(document) {
    this.documents.push(structuredClone(document));
    return { inserted_id: document.id };
  }
  async find_one(query, projectionSpec) {
    const found = this.documents.find(doc => matches(doc, query));
    return found ? project(found, projectionSpec) : null;
  }
  find(query, projectionSpec) {
    const collection = this;
    return {
      keys: [],
      sort(spec) { this.keys = typeof spec === 'string' ? [[spec, -1]] : spec; return this; },
      async to_list(limit) {
        let rows = collection.documents.filter(doc => matches(doc, query))
          .map(doc => structuredClone(doc));
        rows.sort((a, b) => {
          for (const [key, direction] of this.keys || []) {
            const av = firstPath(a, key); const bv = firstPath(b, key);
            if (av !== bv) return (av > bv ? 1 : -1) * direction;
          }
          return 0;
        });
        if (limit !== undefined) rows = rows.slice(0, limit);
        return rows.map(row => project(row, projectionSpec));
      },
    };
  }
  async count_documents(query) {
    return this.documents.filter(doc => matches(doc, query)).length;
  }
  async update_one(query, update) {
    const old = this.documents.find(doc => matches(doc, query));
    if (!old) return { matched_count: 0, modified_count: 0 };
    this.documents[this.documents.indexOf(old)] = applyUpdate(old, update, false, query);
    return { matched_count: 1, modified_count: 1 };
  }
  async update_many(query, update) {
    const selected = this.documents.filter(doc => matches(doc, query));
    for (const old of selected) {
      this.documents[this.documents.indexOf(old)] = applyUpdate(old, update, false, query);
    }
    return { matched_count: selected.length, modified_count: selected.length };
  }
}

class MemoryDatabase {
  constructor() { this.collections = new Map(); }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name);
  }
}

const jwtSecret = 'synthetic-user-data-jwt-secret';
const sessionSecret = 'synthetic-user-data-session-secret';

async function start(db) {
  const sessionService = new SessionService(db, { jwtSecret });
  const server = createServer({ db, sessionService, jwtSecret, sessionSecret, env: {} })
    .listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const issued = await sessionService.issue('owner', {
    userPinRequired: false, userPinAuthenticated: true,
  });
  const session = issued.setCookie.find(value => value.startsWith(`${SESSION_COOKIE_NAME}=`)).split(';')[0];
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    cookie: session,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function user(id, overrides = {}) {
  return {
    id, email: `${id}@example.invalid`, username: id,
    role: 'user', account_type: 'personal', country: 'TG', phone: '+22890000000',
    balance_xof: 500, balance_xaf: 0, balance_cdf: 0, balance_gnf: 0,
    balance_usdt: 3.5, balance_crypto_usdt_bep20: 2.25,
    created_at: '2026-01-01T00:00:00.000Z', kyc_status: 'verified',
    ...overrides,
  };
}

async function get(app, path) {
  return fetch(`${app.base}${path}`, { headers: { cookie: app.cookie } });
}

test('wallet summary returns only the signed-in user balances and transaction count', async () => {
  const db = new MemoryDatabase();
  await db.collection('users').insert_one(user('owner'));
  await db.collection('users').insert_one(user('other', { balance_xof: 999 }));
  await db.collection('transactions').insert_one({ id: 't1', user_id: 'owner' });
  await db.collection('transactions').insert_one({ id: 't2', user_id: 'owner' });
  await db.collection('transactions').insert_one({ id: 'foreign', user_id: 'other' });
  const app = await start(db);
  try {
    const response = await get(app, '/api/wallet/summary');
    assert.equal(response.status, 200);
    const summary = await response.json();
    assert.equal(summary.balance_xof, 500);
    assert.equal(summary.balance_usdt, 3.5);
    assert.equal(summary.transactions_count, 2);
    assert.equal(summary.kyc_status, 'verified');
    assert.equal(summary.crypto_wallet_balances['USDT.BEP20'], 2.25);
  } finally {
    await app.close();
  }
});

test('history separates API pay-ins from direct deposits and omits unconfirmed incoming deposits', async () => {
  const db = new MemoryDatabase();
  await db.collection('users').insert_one(user('owner'));
  const row = (id, type, metadata = {}, extra = {}) => ({
    id, user_id: 'owner', type, direction: 'in', status: 'completed',
    amount: 500, currency: 'XOF', created_at: '2026-01-02T00:00:00.000Z',
    metadata, ...extra,
  });
  await db.collection('transactions').insert_one(row('direct-deposit', 'deposit'));
  await db.collection('transactions').insert_one(row('api-deposit', 'deposit', {
    payment_source: 'integration_api', operation_id: 'api-operation',
  }));
  await db.collection('transactions').insert_one(row('api-crypto-deposit', 'deposit_in', {
    operation_id: 'izipay:deposit:crypto-1',
  }));
  await db.collection('transactions').insert_one(row('link-payment', 'payment', {
    payment_source: 'link_payment',
  }));
  await db.collection('transactions').insert_one(row('pending-deposit', 'deposit', {}, {
    status: 'pending',
  }));
  await db.collection('transactions').insert_one(row('foreign-deposit', 'deposit', {}, {
    user_id: 'other',
  }));
  await db.collection('crypto_deposits').insert_one({
    id: 'crypto-1', user_id: 'owner', idempotency_key: 'btpi_crypto_operation',
    created_at: '2026-01-02T00:00:00.000Z',
  });
  const app = await start(db);
  try {
    const apiResponse = await get(app, '/api/transactions?type=payment');
    assert.equal(apiResponse.status, 200);
    const apiRows = await apiResponse.json();
    assert.deepEqual(apiRows.map(item => item.id).sort(), [
      'api-crypto-deposit', 'api-deposit', 'link-payment',
    ]);
    assert.equal(apiRows.find(item => item.id === 'api-deposit').history_type, 'payment');

    const depositResponse = await get(app, '/api/transactions?type=deposit');
    assert.equal(depositResponse.status, 200);
    const depositRows = await depositResponse.json();
    assert.deepEqual(depositRows.map(item => item.id), ['direct-deposit']);
  } finally {
    await app.close();
  }
});

test('transaction details are owner-scoped and use the persisted wallet snapshot', async () => {
  const db = new MemoryDatabase();
  await db.collection('users').insert_one(user('owner'));
  const transaction = {
    id: 'owner-tx', user_id: 'owner', type: 'deposit', direction: 'in',
    amount: 200, currency: 'XOF', created_at: '2026-01-03T00:00:00.000Z',
    provider_reference: 'PROVIDER-REF',
    metadata: { wallet_operation_id: 'deposit-operation' },
  };
  await db.collection('transactions').insert_one(transaction);
  await db.collection('wallet_operations').insert_one({
    id: operationIdentity('operation', 'owner:deposit-operation'),
    user_id: 'owner',
    snapshot: {
      wallet_field: 'balance_xof',
      balance_before: 300,
      balance_after: 500,
      wallet_balances_before: { balance_xof: 300 },
      wallet_balances_after: { balance_xof: 500 },
      direction: 'credit',
      amount: 200,
    },
  });
  const app = await start(db);
  try {
    const response = await get(app, '/api/transactions/owner-tx');
    assert.equal(response.status, 200);
    const detail = await response.json();
    assert.equal(detail.metadata.provider_reference, 'PROVIDER-REF');
    assert.equal(detail.metadata.wallet_balance_before, 300);
    assert.equal(detail.metadata.wallet_balance_after, 500);
    assert.deepEqual(detail.metadata.wallet_balances_after, { balance_xof: 500 });
    assert.equal((await get(app, '/api/transactions/foreign-tx')).status, 404);
  } finally {
    await app.close();
  }
});

test('invalid search limits and oversized query strings are rejected', async () => {
  const db = new MemoryDatabase();
  await db.collection('users').insert_one(user('owner'));
  const app = await start(db);
  try {
    assert.equal((await get(app, '/api/transactions?limit=1001')).status, 422);
    assert.equal((await get(app, `/api/transactions?q=${'x'.repeat(257)}`)).status, 422);
  } finally {
    await app.close();
  }
});
