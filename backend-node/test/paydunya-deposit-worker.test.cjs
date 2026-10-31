'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matches, applyUpdate } = require('../src/document-store.cjs');
const { createPaydunyaDepositWorker } = require('../src/paydunya-deposit-worker.cjs');

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
            async to_list(limit) { return structuredClone(selected.slice(0, limit)); },
          };
        },
        async update_one(query, update) {
          const row = documents.find(item => matches(item, query));
          if (!row) return { matched_count: 0, modified_count: 0 };
          Object.assign(row, applyUpdate(row, update, false, query));
          return { matched_count: 1, modified_count: 1 };
        },
      };
    },
  };
  return { db, documents };
}

test('PayDunya worker reconciles due pending invoices once and skips in-flight or tokenless deposits', async () => {
  const now = Date.parse('2026-10-31T12:00:00.000Z');
  const { db, documents } = fixture([
    {
      id: 'due-1', provider: 'paydunya', status: 'pending',
      initiation_state: 'ready', paydunya_token: 'invoice-1',
      next_reconcile_at: '2026-10-31T11:59:00.000Z',
    },
    {
      id: 'in-flight', provider: 'paydunya', status: 'pending',
      initiation_state: 'initiating', paydunya_token: 'invoice-2',
      next_reconcile_at: '2026-10-31T11:59:00.000Z',
    },
    {
      id: 'tokenless', provider: 'paydunya', status: 'pending',
      initiation_state: 'unknown', next_reconcile_at: '2026-10-31T11:59:00.000Z',
    },
    {
      id: 'not-due', provider: 'paydunya', status: 'pending',
      initiation_state: 'ready', paydunya_token: 'invoice-3',
      next_reconcile_at: '2026-10-31T12:01:00.000Z',
    },
  ]);
  const settled = [];
  const worker = createPaydunyaDepositWorker({
    db,
    settleDepositById: async id => {
      settled.push(id);
      documents.find(row => row.id === id).status = 'approved';
    },
    now: () => now,
    logger: { warn() {} },
  });

  const first = await worker.runOnce();
  const retry = await worker.runOnce();

  assert.deepEqual(first, { skipped: false, scanned: 4, attempted: 1 });
  assert.equal(retry.attempted, 0);
  assert.deepEqual(settled, ['due-1']);
  assert.equal(documents[0].paydunya_reconcile_attempts, 1);
  assert.ok(Date.parse(documents[0].next_reconcile_at) > now);
  assert.equal(documents[1].paydunya_reconcile_attempts, undefined);
});

test('PayDunya worker records a retry time after a temporary provider lookup error', async () => {
  const now = Date.parse('2026-10-31T12:00:00.000Z');
  const { db, documents } = fixture([{
    id: 'retry-1', provider: 'paydunya', status: 'pending',
    initiation_state: 'ready', paydunya_token: 'invoice-retry',
    next_reconcile_at: '2026-10-31T11:59:00.000Z',
  }]);
  const worker = createPaydunyaDepositWorker({
    db,
    settleDepositById: async () => { throw Object.assign(new Error('offline'), { status: 503 }); },
    now: () => now,
    logger: { warn() {} },
  });

  const result = await worker.runOnce();

  assert.equal(result.attempted, 1);
  assert.equal(documents[0].paydunya_last_reconcile_error, 'provider_status_unavailable');
  assert.ok(Date.parse(documents[0].next_reconcile_at) > now);
});
