'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createAdminTransactionRoutes } = require('../src/admin-transaction-routes.cjs');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query) {
    const row = this.rows.find(item => Object.entries(query).every(([key, value]) => (
      item[key] === value
    )));
    return row ? structuredClone(row) : null;
  }
  async insert_one(row) { this.rows.push(structuredClone(row)); }
  async update_one(query, update) {
    const row = this.rows.find(item => Object.entries(query).every(([key, value]) => (
      item[key] === value
    )));
    if (!row) return { matched_count: 0, modified_count: 0 };
    Object.assign(row, structuredClone(update.$set || {}));
    return { matched_count: 1, modified_count: 1 };
  }
}

function createDb(transactions) {
  const collections = new Map([
    ['transactions', new Collection(transactions)],
    ['users', new Collection([{
      id: 'user-1', balance_xof: 0, wallet_credit_operation_ids: [],
    }])],
    ['kyc', new Collection()],
    ['wallet_operations', new Collection()],
    ['admin_logs', new Collection()],
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

function makeService(db, capture) {
  return createAdminTransactionRoutes({
    db,
    sessionService: {},
    env: {},
    authorizeAdminImpl: async (req, options) => {
      capture.options.push(options);
      return { admin: { id: 'admin-1', username: 'root' } };
    },
  });
}

async function call(service, txId, action, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.url = `/api/admin/transactions/${encodeURIComponent(txId)}/${action}`;
  req.headers = {};
  const res = {
    status: 500,
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
  const handled = await service.handleRoute(req, res);
  return { handled, status: res.status, body: res.body };
}

test('admin deposit approval requires fresh sensitive authorization and credits exactly once', async () => {
  const db = createDb([{
    id: 'tx-deposit-1',
    user_id: 'user-1',
    type: 'deposit',
    direction: 'in',
    amount: 1000,
    currency: 'XOF',
    reference: 'BTX-DEPOSIT-1',
    status: 'pending',
    created_at: '2026-01-01T00:00:00.000Z',
    metadata: { amount_net: 900 },
  }]);
  const capture = { options: [] };
  const service = makeService(db, capture);
  const approved = await call(service, 'tx-deposit-1', 'approve', { confirmation: 'CONFIRMER' });
  assert.equal(approved.status, 200);
  assert.equal(db.collection('users').rows[0].balance_xof, 900);
  assert.equal(approved.body.tx.status, 'completed');
  assert.equal(capture.options[0].permission, 'transactions:write');
  assert.equal(capture.options[0].sensitive, true);
  const ledger = db.collection('transactions').rows.find(
    row => row.id === 'manual-approve-ledger:tx-deposit-1',
  );
  assert.equal(ledger.metadata.wallet_snapshot.balance_before, 0);
  assert.equal(ledger.metadata.wallet_snapshot.balance_after, 900);
  assert.equal(db.collection('admin_logs').rows.length, 1);
  const retry = await call(service, 'tx-deposit-1', 'approve', { confirmation: 'CONFIRMER' });
  assert.equal(retry.status, 409);
  assert.equal(db.collection('users').rows[0].balance_xof, 900);
});

test('admin rejection refunds an outgoing withdrawal atomically and idempotently', async () => {
  const db = createDb([{
    id: 'tx-withdrawal-1',
    user_id: 'user-1',
    type: 'withdrawal',
    direction: 'out',
    amount: 500,
    currency: 'XOF',
    reference: 'BTX-WITHDRAWAL-1',
    status: 'pending',
    metadata: { total_debit: 550, fee: 50 },
  }]);
  const service = makeService(db, { options: [] });
  const result = await call(service, 'tx-withdrawal-1', 'reject', {
    confirmation: 'CONFIRMER',
    reason: 'Prestataire a refusé le retrait',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.refunded, 550);
  assert.equal(result.body.tx.status, 'failed');
  assert.equal(db.collection('users').rows[0].balance_xof, 550);
  const refundLedger = db.collection('transactions').rows.find(row => row.type === 'refund');
  assert.equal(refundLedger.amount, 550);
  assert.equal(db.collection('admin_logs').rows.length, 1);
});

test('admin transaction action rejects missing confirmation before changing data', async () => {
  const db = createDb([{
    id: 'tx-deposit-2', user_id: 'user-1', type: 'deposit',
    direction: 'in', amount: 100, currency: 'XOF', status: 'pending',
  }]);
  const service = makeService(db, { options: [] });
  const result = await call(service, 'tx-deposit-2', 'approve', {});
  assert.equal(result.status, 422);
  assert.equal(db.collection('users').rows[0].balance_xof, 0);
  assert.equal(db.collection('transactions').rows[0].status, 'pending');
});
