'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { matches, project } = require('../src/document-store.cjs');
const { createAdminPushRoutes } = require('../src/admin-push-routes.cjs');

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
        let rows = collection.rows.filter(row => matches(row, query)).map(row => structuredClone(row));
        if (this.key) rows.sort((a, b) => (a[this.key] > b[this.key] ? 1 : -1) * this.direction);
        if (Number.isFinite(limit)) rows = rows.slice(0, limit);
        return rows.map(row => project(row, projectionSpec));
      },
    };
  }
  async count_documents(query = {}) {
    return this.rows.filter(row => matches(row, query)).length;
  }
  async insert_one(row) {
    this.rows.push(structuredClone(row));
    return { inserted_id: row.id };
  }
}

class Database {
  constructor(seed) {
    this.collections = new Map(Object.entries(seed).map(([name, rows]) => [name, new Collection(rows)]));
  }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Collection());
    return this.collections.get(name);
  }
}

function setup() {
  const db = new Database({
    users: [
      { id: 'admin', role: 'super_admin', username: 'owner', two_fa_enabled: true },
      { id: 'u1', role: 'user', username: 'awa', full_name: 'Awa Diallo', country: 'TG', account_type: 'personal', kyc_status: 'verified', created_at: '2026-01-01' },
      { id: 'u2', role: 'user', username: 'kofi', full_name: 'Kofi Mensah', country: 'GH', account_type: 'merchant', kyc_status: 'pending', created_at: '2026-01-02' },
      { id: 'u3', role: 'user', username: 'blocked', is_blocked: true, country: 'TG' },
    ],
    push_devices: [
      { id: 'd1', user_id: 'u1', active: true },
      { id: 'd2', user_id: 'u2', active: false },
    ],
    push_campaigns: [
      { id: 'manual', title: 'Info', source: 'admin', created_at: '2026-01-03', status: 'sent' },
      { id: 'automatic', title: 'Auto', source: 'automatic', created_at: '2026-01-04', status: 'sent' },
    ],
    admin_logs: [],
  });
  const handle = createAdminPushRoutes({
    db,
    env: {},
    sessionService: {
      async authenticate(token) {
        if (token !== 'admin-session') throw Object.assign(new Error('Session requise'), { status: 401 });
        return { userId: 'admin', session: { admin_auth_method: 'totp' } };
      },
    },
  });
  return { db, handle };
}

async function call(handle, method, url, body, token = 'admin-session') {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = { authorization: `Bearer ${token}` };
  req.socket = { remoteAddress: '127.0.0.1' };
  let status = 200;
  let text = '';
  const res = { writeHead(code) { status = code; }, end(value) { text = value || ''; } };
  const handled = await handle(req, res);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

test('admin push audience options and user search return only eligible customer accounts', async () => {
  const { handle } = setup();
  const options = await call(handle, 'GET', '/api/admin/push/audience-options');
  assert.equal(options.status, 200, JSON.stringify(options.body));
  assert.deepEqual(options.body.countries, ['GH', 'TG']);
  assert.deepEqual(options.body.account_types, ['personal', 'merchant']);
  assert.deepEqual(options.body.kyc_statuses, ['pending', 'verified']);

  const search = await call(handle, 'GET', '/api/admin/push/users?q=awa');
  assert.equal(search.body.users.length, 1);
  assert.equal(search.body.users[0].id, 'u1');
});

test('admin push preview counts active devices for the selected audience', async () => {
  const { handle } = setup();
  const preview = await call(handle, 'POST', '/api/admin/push/preview', {
    audience: 'group', country: 'TG',
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual(preview.body, { users: 1, devices: 1 });
});

test('admin campaign history excludes automatic notifications and enforces authentication', async () => {
  const { handle } = setup();
  const campaigns = await call(handle, 'GET', '/api/admin/push/campaigns?limit=10');
  assert.equal(campaigns.status, 200, JSON.stringify(campaigns.body));
  assert.equal(campaigns.body.campaigns.length, 1);
  assert.equal(campaigns.body.campaigns[0].id, 'manual');
  const unauthorized = await call(handle, 'GET', '/api/admin/push/campaigns', undefined, 'invalid');
  assert.equal(unauthorized.status, 401);
});
