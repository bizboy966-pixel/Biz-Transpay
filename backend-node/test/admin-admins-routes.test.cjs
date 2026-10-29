'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { matches, project } = require('../src/document-store.cjs');
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
        return { userId: 'owner', session: { admin_auth_method: 'totp' } };
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
