'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matches } = require('../src/document-store.cjs');
const { createAfriBaPayDepositWorker } = require('../src/afribapay-deposit-worker.cjs');

function fixture(rows) {
  const documents = structuredClone(rows);
  const db = {
    collection(name) {
      assert.equal(name, 'momo_deposits');
      return {
        find(query) {
          let selected = documents.filter(row => matches(row, query));
          return {
            sort(field, direction = 1) {
              selected = [...selected].sort((a, b) => (
                String(a[field] || '').localeCompare(String(b[field] || '')) * direction
              ));
              return this;
            },
            limit() { return this; },
            async to_list(limit) {
              return structuredClone(selected.slice(0, limit));
            },
          };
        },
        async update_one(query, update) {
          const row = documents.find(item => matches(item, query));
          if (!row) return { matched_count: 0, modified_count: 0 };
          Object.assign(row, structuredClone(update.$set || {}));
          return { matched_count: 1, modified_count: 1 };
        },
      };
    },
  };
  return { db, documents };
}

test('AfriBaPay fallback reconciliation claims due deposits once and leaves in-flight requests alone', async () => {
  const now = Date.parse('2026-10-30T12:00:00.000Z');
  const { db, documents } = fixture([
    {
      id: 'due-1',
      provider: 'afribapay',
      status: 'pending',
      initiation_state: 'ready',
      afribapay_order_id: 'provider-order-1',
      next_reconcile_at: '2026-10-30T11:59:00.000Z',
      afribapay_reconcile_attempts: 0,
    },
    {
      id: 'in-flight',
      provider: 'afribapay',
      status: 'pending',
      initiation_state: 'initiating',
      next_reconcile_at: '2026-10-30T11:59:00.000Z',
    },
    {
      id: 'not-due',
      provider: 'afribapay',
      status: 'pending',
      initiation_state: 'ready',
      next_reconcile_at: '2026-10-30T12:01:00.000Z',
    },
    {
      id: 'unscheduled-old-pending',
      provider: 'afribapay',
      status: 'pending',
      initiation_state: 'unknown',
      created_at: '2026-10-30T11:59:00.000Z',
    },
  ]);
  const checked = [];
  const worker = createAfriBaPayDepositWorker({
    db,
    reconcileOrder: async orderId => checked.push(orderId),
    now: () => now,
    logger: { warn() {} },
  });

  const first = await worker.runOnce();
  const second = await worker.runOnce();

  assert.equal(first.scanned, 4);
  assert.equal(first.attempted, 2);
  assert.equal(second.attempted, 0);
  assert.deepEqual(checked, ['provider-order-1', 'unscheduled-old-pending']);
  assert.equal(documents[0].afribapay_reconcile_attempts, 1);
  assert.equal(documents[3].afribapay_reconcile_attempts, 1);
  assert.ok(Date.parse(documents[0].next_reconcile_at) > now);
  assert.ok(Date.parse(documents[3].next_reconcile_at) > now);
});

test('AfriBaPay stops retrying an unknown provider identifier after a 404', async () => {
  let now = Date.parse('2026-10-30T12:00:00.000Z');
  const { db, documents } = fixture([{
    id: 'missing-at-provider',
    provider: 'afribapay',
    status: 'pending',
    initiation_state: 'ready',
    afribapay_order_id: 'order-not-found',
    next_reconcile_at: '2026-10-30T11:59:00.000Z',
  }]);
  let calls = 0;
  const worker = createAfriBaPayDepositWorker({
    db,
    reconcileOrder: async () => {
      calls += 1;
      const error = new Error('not found');
      error.providerStatusCode = 404;
      throw error;
    },
    now: () => now,
    logger: { warn() {} },
  });

  await worker.runOnce();
  now = Date.parse(documents[0].next_reconcile_at) + 1;
  const retry = await worker.runOnce();

  assert.equal(calls, 1);
  assert.equal(retry.attempted, 0);
  assert.equal(documents[0].afribapay_reconcile_paused, true);
  assert.equal(documents[0].afribapay_last_reconcile_error, 'provider_transaction_not_found');
});
