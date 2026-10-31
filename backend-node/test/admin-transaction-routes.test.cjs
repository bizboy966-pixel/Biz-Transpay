'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createAdminTransactionRoutes } = require('../src/admin-transaction-routes.cjs');
const { operationIdentity } = require('../src/wallet.cjs');

function clone(value) { return structuredClone(value); }
function pathValue(document, path) {
  return path.split('.').reduce((value, key) => value == null ? undefined : value[key], document);
}
function conditionMatches(value, condition) {
  if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
    if (condition.$regex !== undefined) {
      const regex = new RegExp(condition.$regex, condition.$options || '');
      return regex.test(String(value ?? ''));
    }
    if (condition.$in) return condition.$in.some(entry => String(value) === String(entry));
    if (condition.$gte !== undefined) return String(value ?? '') >= String(condition.$gte);
  }
  return String(value ?? '') === String(condition ?? '');
}
function matches(document, query) {
  return Object.entries(query).every(([key, condition]) => {
    if (key === '$or') return condition.some(candidate => matches(document, candidate));
    return conditionMatches(pathValue(document, key), condition);
  });
}
function projected(document, projection) {
  if (!projection) return clone(document);
  const fields = Object.entries(projection).filter(([key, value]) => key !== '_id' && value === 1)
    .map(([key]) => key);
  if (!fields.length) return clone(document);
  return Object.fromEntries(fields.filter(key => document[key] !== undefined)
    .map(key => [key, clone(document[key])]));
}

class MemoryDb {
  constructor({ includeExchanges = false } = {}) {
    const now = new Date().toISOString();
    this.rows = {
      users: [
        {
          id: 'admin-1', role: 'admin', admin_role: 'finance',
          two_fa_enabled: true, username: 'financier',
        },
        {
          id: 'user-1', username: 'awa', full_name: 'Awa Diallo',
          email: 'awa@example.test', phone: '+228 90 11 22 33',
          country: 'TG', balance_xof: 1500, balance_usdt: 2,
        },
        {
          id: 'user-2', username: 'kofi', full_name: 'Kofi Mensah',
          email: 'kofi@example.test', phone: '+233 20 11 22 33',
          country: 'GH',
        },
      ],
      transactions: [
        {
          id: 'BTP-REF-001', user_id: 'user-1', type: 'deposit', direction: 'in',
          amount: 500, currency: 'XOF', status: 'completed',
          reference: 'BTP-REF-001', provider_reference: 'PJN-REF-778',
          created_at: now, metadata: { wallet_operation_id: 'deposit-op-1' },
        },
        {
          id: 'BTP-REF-002', user_id: 'user-2', type: 'withdrawal', direction: 'out',
          amount: 200, currency: 'XOF', status: 'pending',
          reference: 'BTP-REF-002', created_at: now, metadata: {},
        },
      ],
      wallet_operations: [],
      admin_logs: [],
    };
    if (includeExchanges) {
      this.rows.transactions.push(
        {
          id: 'EXCHANGE-001', user_id: 'user-1', type: 'exchange',
          amount: 1000, currency: 'XOF', status: 'completed',
          created_at: now, metadata: { from_currency: 'XOF', to_currency: 'XAF' },
        },
        {
          id: 'EXCHANGE-002', user_id: 'user-2', type: 'exchange',
          amount: 2, currency: 'USDT', status: 'completed',
          created_at: now, metadata: { from_currency: 'USDT', to_currency: 'XOF' },
        },
        {
          id: 'EXCHANGE-003', user_id: 'user-1', type: 'exchange',
          amount: 500, currency: 'XAF', status: 'failed',
          created_at: now, metadata: { from_currency: 'XAF', to_currency: 'XOF' },
        },
        {
          id: 'EXCHANGE-004', user_id: 'user-2', type: 'exchange',
          amount: 300, currency: 'XOF', status: 'pending',
          created_at: now, metadata: { from_currency: 'XOF', to_currency: 'XAF' },
        },
      );
    }
    this.rows.wallet_operations.push({
      id: operationIdentity('operation', 'user-1:deposit-op-1'),
      user_id: 'user-1',
      snapshot: {
        wallet_field: 'balance_xof', direction: 'credit', amount: 500,
        balance_before: 1000, balance_after: 1500,
        wallet_balances_before: { balance_xof: 1000 },
        wallet_balances_after: { balance_xof: 1500 },
      },
    });
  }
  collection(name) {
    return {
      find_one: async (query, projection) => {
        const document = this.rows[name].find(row => matches(row, query));
        return document ? projected(document, projection) : null;
      },
      find: (query = {}, projection) => {
        let result = this.rows[name].filter(row => matches(row, query)).map(row => projected(row, projection));
        const cursor = {
          sort(field, direction = 1) {
            const sign = direction < 0 ? -1 : 1;
            result = [...result].sort((a, b) => sign * String(a[field] || '').localeCompare(String(b[field] || '')));
            return cursor;
          },
          limit() { return cursor; },
          async to_list(limit) { return result.slice(0, limit); },
        };
        return cursor;
      },
      count_documents: async query => this.rows[name].filter(row => matches(row, query)).length,
      aggregate: pipeline => ({
        to_list: async limit => {
          let rows = [...this.rows[name]];
          for (const stage of pipeline) {
            if (stage.$match) rows = rows.filter(row => matches(row, stage.$match));
            if (stage.$group) {
              const groups = new Map();
              for (const row of rows) {
                const groupKey = stage.$group._id.startsWith('$')
                  ? pathValue(row, stage.$group._id.slice(1))
                  : stage.$group._id;
                const group = groups.get(groupKey) || { _id: groupKey };
                for (const [field, operation] of Object.entries(stage.$group)) {
                  if (field !== '_id' && operation.$sum) {
                    const source = operation.$sum.slice(1);
                    group[field] = (group[field] || 0) + Number(pathValue(row, source) || 0);
                  }
                }
                groups.set(groupKey, group);
              }
              rows = [...groups.values()];
            }
          }
          return rows.slice(0, limit);
        },
      }),
      insert_one: async document => {
        this.rows[name].push(clone(document));
        return { inserted_id: document.id };
      },
    };
  }
}

function setup({ includeExchanges = false } = {}) {
  const db = new MemoryDb({ includeExchanges });
  const sessionService = {
    async authenticate(token) {
      if (token !== 'admin-session') {
        throw Object.assign(new Error('Session requise'), { status: 401, code: 'SESSION_REQUIRED' });
      }
      return {
        userId: 'admin-1',
        session: { admin_auth_method: 'totp', admin_panel_unlocked_at: new Date() },
      };
    },
  };
  return { db, routes: createAdminTransactionRoutes({ db, sessionService, env: {} }) };
}

function request(url, token = 'admin-session') {
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = url;
  req.headers = { authorization: `Bearer ${token}` };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}
function response() {
  return {
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
}
async function call(routes, url, token) {
  const res = response();
  const handled = await routes.handleRoute(request(url, token), res);
  return { handled, status: res.status, body: res.body };
}

test('admin transaction list filters type/status and searches provider references and user identity', async () => {
  const { db, routes } = setup();
  const byProvider = await call(routes,
    '/api/admin/transactions?q=PJN-REF-778&type=deposit&status=completed');
  assert.equal(byProvider.status, 200);
  assert.equal(byProvider.body.length, 1);
  assert.equal(byProvider.body[0].provider_reference, 'PJN-REF-778');
  assert.equal(byProvider.body[0].user.email, 'awa@example.test');

  const byPhone = await call(routes, '/api/admin/transactions?q=228%2090%2011%2022%2033');
  assert.equal(byPhone.status, 200);
  assert.equal(byPhone.body.length, 1);
  assert.equal(byPhone.body[0].user.username, 'awa');
  assert.ok(db.rows.admin_logs.some(log => log.action === 'admin_transactions_list'));
});

test('admin transaction detail adds persisted wallet snapshots and scoped user identity', async () => {
  const { routes } = setup();
  const detail = await call(routes, '/api/admin/transactions/BTP-REF-001');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.user.id, 'user-1');
  assert.equal(detail.body.user.country, 'TG');
  assert.equal(detail.body.metadata.wallet_balance_before, 1000);
  assert.equal(detail.body.metadata.wallet_balance_after, 1500);
  assert.equal(detail.body.metadata.wallet_operation_direction, 'credit');
});

test('admin audit log reads require an authorized admin and enforce the requested limit', async () => {
  const { db, routes } = setup();
  db.rows.users[0].role = 'super_admin';
  db.rows.admin_logs.push({
    id: 'audit-seeded', action: 'settings_changed', created_at: '2999-01-01T00:00:00.000Z',
  });
  const result = await call(routes, '/api/admin/logs?limit=1');
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 1);
  assert.equal(result.body[0].id, 'audit-seeded');

  const invalid = await call(routes, '/api/admin/logs?limit=1001');
  assert.equal(invalid.status, 422);
  const unauthorized = await call(routes, '/api/admin/logs', 'not-a-session');
  assert.equal(unauthorized.status, 401);
});

test('admin conversion route returns period rows, counts, and completed volume by currency', async () => {
  const { routes, db } = setup({ includeExchanges: true });
  const result = await call(routes, '/api/admin/conversions?period=month');
  assert.equal(result.status, 200);
  assert.equal(result.body.data.length, 4);
  assert.equal(result.body.data[0].user.username, 'awa');
  assert.deepEqual(result.body.totals, {
    all: 4, today: 4, validated: 2, rejected: 1,
  });
  assert.deepEqual(result.body.volume_by_currency, { USDT: 2, XOF: 1000, XAF: 0 });
  assert.ok(db.rows.admin_logs.some(log => log.action === 'admin_conversions_list'));

  const invalid = await call(routes, '/api/admin/conversions?limit=5000');
  assert.equal(invalid.status, 422);
});

test('transaction read rejects unauthenticated access and invalid query bounds', async () => {
  const { routes } = setup();
  assert.equal((await call(routes, '/api/admin/transactions', 'invalid')).status, 401);
  const longQuery = await call(routes, `/api/admin/transactions?q=${'x'.repeat(101)}`);
  assert.equal(longQuery.status, 422);
  const invalidLimit = await call(routes, '/api/admin/transactions?limit=2001');
  assert.equal(invalidLimit.status, 422);
  const missing = await call(routes, '/api/admin/transactions/no-such-id');
  assert.equal(missing.status, 404);
});
