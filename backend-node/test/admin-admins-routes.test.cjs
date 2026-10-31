'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { matches, project, SPLIT_COLLECTIONS } = require('../src/document-store.cjs');
const { createAdminUserRoutes } = require('../src/admin-user-routes.cjs');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query, projectionSpec) {
    const row = this.rows.find(item => matches(item, query));
    return row ? project(row, projectionSpec) : null;
  }
  find(query, projectionSpec) {
    const collection = this;
    return {
      key: null,
      direction: 1,
      sort(key, direction = 1) { this.key = key; this.direction = direction; return this; },
      async to_list(limit) {
        let rows = collection.rows.filter(item => matches(item, query))
          .map(item => project(item, projectionSpec));
        if (this.key) rows.sort((a, b) => (a[this.key] > b[this.key] ? 1 : -1) * this.direction);
        if (Number.isFinite(limit)) rows = rows.slice(0, limit);
        return rows;
      },
    };
  }
  async insert_one(row) { this.rows.push(structuredClone(row)); }
  async delete_many(query) {
    const oldLength = this.rows.length;
    this.rows = this.rows.filter(item => !matches(item, query));
    return { deleted_count: oldLength - this.rows.length };
  }
  async update_one(query, update) {
    const row = this.rows.find(item => matches(item, query));
    if (!row) return { matched_count: 0 };
    Object.assign(row, structuredClone(update.$set || {}));
    return { matched_count: 1 };
  }
}

function destructiveSetup(seed = {}) {
  const rows = {
    users: [
      { id: 'owner', role: 'super_admin', platform_owner: true, two_fa_enabled: true, username: 'owner' },
      { id: 'staff-admin', role: 'admin', two_fa_enabled: true, username: 'staff' },
      { id: 'customer', role: 'user', username: 'customer', email: 'customer@example.test' },
    ],
    transactions: [{ id: 'tx-1', user_id: 'customer' }],
    settings: [{ id: 'platform_config', support_email: 'support@example.test' }],
    ...seed,
  };
  const collections = Object.fromEntries([...SPLIT_COLLECTIONS].map(name => [
    name, new Collection(rows[name] || []),
  ]));
  const db = {
    collection: name => collections[name],
    async transaction(callback) {
      const repo = {
        async lockCollection() {},
        async get(collection, id) {
          return collections[collection].rows.find(row => String(row.id) === String(id)) || null;
        },
        async find(collection, query = {}) {
          return collections[collection].rows.filter(row => matches(row, query));
        },
        async deleteMany(collection, query = {}) {
          return collections[collection].delete_many(query);
        },
        async replace(collection, id, document) {
          const table = collections[collection];
          const index = table.rows.findIndex(row => String(row.id) === String(id));
          if (index < 0) table.rows.push(structuredClone(document));
          else table.rows[index] = structuredClone(document);
        },
        async insert(collection, id, document) {
          assert.equal(String(document.id), String(id));
          return collections[collection].insert_one(document);
        },
      };
      return callback(repo);
    },
  };
  const routes = createAdminUserRoutes({
    db,
    sessionService: {
      async authenticate(token) {
        if (token !== 'admin-session') throw Object.assign(new Error('Session requise'), { status: 401 });
        return { userId: 'owner', session: { admin_auth_method: 'totp', admin_panel_unlocked_at: new Date() } };
      },
      requireRecentAuth() {},
    },
    cryptoCatalog: { activeExchangeAssets: async () => [] },
    env: {},
  });
  return { routes, db, collections };
}

async function callAdmin(routes, method, url, body = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method,
    url,
    headers: { authorization: 'Bearer admin-session' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  const res = {
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
  await routes.handleRoute(req, res);
  return res;
}

test('admin list returns only safe admin profile fields and applies the default role', async () => {
  const collections = {
    users: new Collection([
      { id: 'owner', role: 'super_admin', username: 'owner', email: 'owner@example.test', full_name: 'Owner', password_hash: 'secret', two_fa_enabled: true },
      { id: 'staff', role: 'admin', username: 'staff', email: 'staff@example.test', full_name: 'Staff', password_hash: 'secret', created_at: '2026-01-01' },
      { id: 'customer', role: 'user', username: 'customer' },
    ]),
    admin_logs: new Collection(),
  };
  const db = { collection: name => collections[name] };
  const routes = createAdminUserRoutes({
    db,
    cryptoCatalog: { activeExchangeAssets: async () => [] },
    sessionService: {
      async authenticate(token) {
        if (token !== 'admin-session') throw Object.assign(new Error('Session requise'), { status: 401 });
        return { userId: 'owner', session: { admin_auth_method: 'totp', admin_panel_unlocked_at: new Date() } };
      },
    },
    env: {},
  });
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = '/api/admin/admins';
  req.headers = { authorization: 'Bearer admin-session' };
  req.socket = { remoteAddress: '127.0.0.1' };
  let status = 0;
  let text = '';
  const res = { writeHead(code) { status = code; }, end(value) { text = value; } };
  assert.equal(await routes.handleRoute(req, res), true);
  assert.equal(status, 200, text);
  const admins = JSON.parse(text);
  assert.equal(admins.length, 2);
  assert.equal(admins.find(item => item.id === 'staff').admin_role, 'general');
  assert.equal(Object.hasOwn(admins[0], 'password_hash'), false);
});

test('destructive user cleanup requires step-up confirmation and preserves platform owners', async () => {
  const { routes, collections } = destructiveSetup();
  const denied = await callAdmin(routes, 'POST', '/api/admin/users/cleanup-test-users');
  assert.equal(denied.status, 428);
  assert.equal(collections.users.rows.length, 3);

  const result = await callAdmin(
    routes, 'POST', '/api/admin/users/cleanup-test-users',
    { confirmation: 'SUPPRIMER LES COMPTES NON-SUPERADMIN' },
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(collections.users.rows.map(user => user.id), ['owner']);
  assert.equal(collections.transactions.rows.length, 0);
  assert.equal(collections.settings.rows.length, 1);
  assert.equal(collections.admin_logs.rows.at(-1).action, 'cleanup_test_users');
});

test('platform reset needs exact confirmation, keeps owner/settings, and resets balances atomically', async () => {
  const { routes, collections } = destructiveSetup({
    users: [
      {
        id: 'owner', role: 'super_admin', platform_owner: true, two_fa_enabled: true,
        username: 'owner', balance_xof: 1000, balance_crypto_usdt_trc20: 2,
      },
      { id: 'customer', role: 'user', username: 'customer' },
    ],
  });
  const denied = await callAdmin(
    routes, 'POST', '/api/admin/platform/reset', { confirmation: 'bad' },
  );
  assert.equal(denied.status, 428);
  assert.equal(collections.transactions.rows.length, 1);

  const result = await callAdmin(
    routes, 'POST', '/api/admin/platform/reset', { confirmation: 'RÉINITIALISER' },
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(collections.users.rows.length, 1);
  assert.equal(collections.users.rows[0].platform_owner, true);
  assert.equal(collections.users.rows[0].balance_xof, 0);
  assert.equal(collections.users.rows[0].balance_crypto_usdt_trc20, 0);
  assert.equal(collections.transactions.rows.length, 0);
  assert.equal(collections.settings.rows.length, 1);
  assert.equal(collections.admin_logs.rows.at(-1).action, 'platform_reset');
});

test('user deletion is target-confirmed, owner-protected, and audited', async () => {
  const { routes, collections } = destructiveSetup();
  const denied = await callAdmin(routes, 'DELETE', '/api/admin/users/customer');
  assert.equal(denied.status, 428);
  assert.equal(collections.users.rows.some(user => user.id === 'customer'), true);

  const deleted = await callAdmin(
    routes, 'DELETE', '/api/admin/users/customer',
    { confirmation: 'SUPPRIMER customer' },
  );
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(collections.users.rows.some(user => user.id === 'customer'), false);
  assert.equal(collections.transactions.rows.length, 0);
  assert.equal(collections.users.rows.some(user => user.id === 'owner'), true);
  assert.equal(collections.admin_logs.rows.at(-1).action, 'delete_user');
});
