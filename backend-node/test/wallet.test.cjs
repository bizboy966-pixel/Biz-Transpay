'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyWalletOperation, operationIdentity, operationSignature } = require('../src/wallet.cjs');

// Serialized transactional fake, not a substitute for MySQL/InnoDB integration testing.
class MemoryStore {
  constructor() {
    this.docs = new Map([['users:alice', { id: 'alice', balance_xof: 1000, balance_usdt: 5 }]]);
    this.tail = Promise.resolve();
  }
  transaction(callback) {
    const result = this.tail.then(async () => {
      const working = structuredClone(this.docs);
      const repo = {
        lockWallets: async () => {},
        get: async (c, id) => structuredClone(working.get(`${c}:${id}`) ?? null),
        replace: async (c, id, doc) => working.set(`${c}:${id}`, structuredClone(doc)),
        insert: async (c, id, doc) => {
          if (this.failInsert === true || this.failInsert === c) {
            throw new Error('injected storage failure');
          }
          if (working.has(`${c}:${id}`)) throw new Error('duplicate');
          working.set(`${c}:${id}`, structuredClone(doc));
        },
      };
      const result = await callback(repo);
      this.docs = working;
      return result;
    });
    this.tail = result.catch(() => {});
    return result;
  }
  user(id = 'alice') { return this.docs.get(`users:${id}`); }
}
const credit = overrides => ({
  userId: 'alice', operationId: 'deposit-1', direction: 'credit',
  primaryField: 'balance_xof', increments: { balance_xof: 500 },
  aliases: ['provider:payment-1'], ...overrides,
});

test('20 concurrent duplicate confirmations credit once and keep the original snapshot', async () => {
  const store = new MemoryStore();
  const results = await Promise.all(Array.from({ length: 20 }, () => applyWalletOperation(store, credit())));
  assert.equal(results.filter(r => r.state === 'applied').length, 1);
  assert.equal(store.user().balance_xof, 1500);
  for (const result of results) {
    assert.equal(result.snapshot.balance_before, 1000);
    assert.equal(result.snapshot.balance_after, 1500);
  }
});

test('provider event cannot credit another transaction or account', async () => {
  const store = new MemoryStore();
  store.docs.set('users:bob', { id: 'bob', balance_xof: 0 });
  await applyWalletOperation(store, credit());
  assert.equal((await applyWalletOperation(store, credit({ operationId: 'deposit-2' }))).state, 'duplicate_event');
  assert.equal((await applyWalletOperation(store, credit({ userId: 'bob' }))).state, 'duplicate_event');
  assert.equal(store.user('bob').balance_xof, 0);
});

test('idempotency key reused with a different amount is rejected', async () => {
  const store = new MemoryStore();
  await applyWalletOperation(store, credit());
  assert.equal((await applyWalletOperation(store, credit({ increments: { balance_xof: 600 } }))).state,
    'idempotency_conflict');
  assert.equal(store.user().balance_xof, 1500);
});

test('imported legacy marker prevents a second credit without inventing balances', async () => {
  const store = new MemoryStore();
  store.user().wallet_credit_operation_ids = ['deposit-1'];
  const result = await applyWalletOperation(store, credit());
  assert.equal(result.state, 'already');
  assert.equal(result.snapshot, null);
  assert.equal(store.user().balance_xof, 1000);
});

test('imported Python claim remains idempotent', async () => {
  const store = new MemoryStore();
  const input = credit();
  const id = operationIdentity('operation', 'alice:deposit-1');
  const snapshot = { balance_before: 500, balance_after: 1000 };
  store.docs.set(`wallet_operations:${id}`, { id, signature: operationSignature(input), snapshot });
  const result = await applyWalletOperation(store, input);
  assert.equal(result.state, 'already');
  assert.deepEqual(result.snapshot, snapshot);
  assert.equal(store.user().balance_xof, 1000);
});

test('two withdrawals cannot overspend and fees are included in the snapshot', async () => {
  const store = new MemoryStore();
  const debit = operationId => credit({
    operationId, direction: 'debit', increments: { balance_xof: -620 },
    requiredBalanceField: 'balance_xof', requiredBalanceAmount: 620, aliases: [],
  });
  const results = await Promise.all(['withdraw-1', 'withdraw-2'].map(id => applyWalletOperation(store, debit(id))));
  assert.deepEqual(results.map(r => r.state).sort(), ['applied', 'insufficient']);
  assert.equal(store.user().balance_xof, 380);
  assert.equal(results.find(r => r.snapshot).snapshot.amount, 620);
});

test('crypto fractions, exchange and refund are accounted for atomically', async () => {
  const store = new MemoryStore();
  const exchange = credit({
    operationId: 'exchange', direction: 'exchange', aliases: [],
    primaryField: 'balance_xof', increments: { balance_xof: -500, balance_usdt: 0.83 },
    requiredBalanceField: 'balance_xof', requiredBalanceAmount: 500,
  });
  await applyWalletOperation(store, exchange);
  assert.equal(store.user().balance_usdt, 5.83);
  assert.equal(store.user().balance_xof, 500);
  const refund = credit({ operationId: 'refund:exchange', aliases: [] });
  await applyWalletOperation(store, refund);
  await applyWalletOperation(store, refund);
  assert.equal(store.user().balance_xof, 1000);
});

test('failed claim insertion rolls the wallet mutation back', async () => {
  const store = new MemoryStore();
  store.failInsert = true;
  await assert.rejects(applyWalletOperation(store, credit()), /injected storage failure/);
  assert.equal(store.user().balance_xof, 1000);
  assert.equal(store.docs.size, 1);
});

test('failed financial audit insertion rolls wallet, idempotency marker, and ledger back', async () => {
  const store = new MemoryStore();
  store.failInsert = 'admin_logs';
  await assert.rejects(applyWalletOperation(store, credit({
    operationId: 'admin-balance:action-0001',
    ledger: {
      id: 'transaction-1', user_id: 'alice',
      metadata: { wallet_operation_id: 'admin-balance:action-0001' },
    },
    adminLog: {
      id: 'audit-1', admin_id: 'staff-1', target_user_id: 'alice',
      details: { operation_id: 'admin-balance:action-0001' },
    },
  })), /injected storage failure/);
  assert.equal(store.user().balance_xof, 1000);
  assert.equal([...store.docs.keys()].some(key => key.startsWith('wallet_operations:')), false);
  assert.equal(store.docs.has('transactions:transaction-1'), false);
  assert.equal(store.docs.has('admin_logs:audit-1'), false);
});

test('missing user and invalid amounts do not mutate wallets', async () => {
  const store = new MemoryStore();
  assert.equal((await applyWalletOperation(store, credit({ userId: 'unknown' }))).state, 'missing_user');
  for (const amount of [0, NaN, Infinity, '500']) {
    assert.equal((await applyWalletOperation(store, credit({ increments: { balance_xof: amount } }))).state, 'invalid');
  }
  assert.equal(store.user().balance_xof, 1000);
});
