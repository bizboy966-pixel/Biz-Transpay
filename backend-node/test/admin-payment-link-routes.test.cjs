'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { matches, project } = require('../src/document-store.cjs');
const { createAdminPaymentLinkRoutes } = require('../src/admin-payment-link-routes.cjs');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query, projectionSpec) {
    const row = this.rows.find(item => matches(item, query));
    return row ? project(row, projectionSpec) : null;
  }
  find(query, projectionSpec) {
    const collection = this;
    return {
      sortKey: null,
      direction: 1,
      sort(key, direction = 1) { this.sortKey = key; this.direction = direction; return this; },
      async to_list(limit) {
        let rows = collection.rows.filter(item => matches(item, query))
          .map(item => project(item, projectionSpec));
        if (this.sortKey) {
          rows.sort((left, right) => (
            (left[this.sortKey] > right[this.sortKey] ? 1 : -1) * this.direction
          ));
        }
        return Number.isFinite(limit) ? rows.slice(0, limit) : rows;
      },
    };
  }
  async insert_one(row) { this.rows.push(structuredClone(row)); }
  async update_one(query, update) {
    const row = this.rows.find(item => matches(item, query));
    if (!row) return { matched_count: 0 };
    Object.assign(row, update.$set || {});
    return { matched_count: 1 };
  }
  async delete_one(query) {
    const index = this.rows.findIndex(item => matches(item, query));
    if (index < 0) return { deleted_count: 0 };
    this.rows.splice(index, 1);
    return { deleted_count: 1 };
  }
  async delete_many(query) {
    const before = this.rows.length;
    this.rows = this.rows.filter(item => !matches(item, query));
    return { deleted_count: before - this.rows.length };
  }
}

function request(url, token = 'admin-session', method = 'GET') {
  const req = Readable.from([]);
  req.method = method;
  req.url = url;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

async function invoke(handler, req) {
  let status = 0;
  let text = '';
  const res = { writeHead(code) { status = code; }, end(value) { text = value; } };
  assert.equal(await handler.handleRoute(req, res), true);
  return { status, data: JSON.parse(text) };
}

function setup() {
  const db = {
    collections: {
      users: new Collection([
        { id: 'admin', role: 'super_admin', username: 'root', two_fa_enabled: true },
        { id: 'merchant', role: 'user', username: 'shop', full_name: 'Shop Owner', email: 'shop@example.test', account_type: 'merchant' },
      ]),
      payment_links: new Collection([
        { id: 'link-1', user_id: 'merchant', slug: 'alpha-123', title: 'Alpha Store', amount: 500, currency: 'XOF', active: true, created_at: '2026-01-02', description: 'hidden field', logo: 'private-logo' },
        { id: 'link-2', user_id: 'merchant', slug: 'beta-123', title: 'Beta Store', amount: 800, currency: 'XOF', active: false, created_at: '2026-01-01' },
      ]),
      link_payments: new Collection([
        { id: 'payment-1', link_id: 'link-1', status: 'pending' },
        { id: 'payment-2', link_id: 'link-2', status: 'paid' },
      ]),
      admin_logs: new Collection(),
    },
    collection(name) { return this.collections[name]; },
  };
  const sessionService = {
    async authenticate(token) {
      if (token !== 'admin-session') {
        throw Object.assign(new Error('Session requise'), { status: 401 });
      }
      return { userId: 'admin', session: { admin_auth_method: 'totp' } };
    },
    requireRecentAuth() {},
  };
  const handler = createAdminPaymentLinkRoutes({ db, sessionService, env: {} });
  handler.testDb = db;
  return handler;
}

test('admin payment links list filters status/search and returns owner details without extra fields', async () => {
  const handler = setup();
  const result = await invoke(handler, request('/api/admin/links?q=shop%40example.test&status=active'));
  assert.equal(result.status, 200);
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].id, 'link-1');
  assert.equal(result.data[0].owner.email, 'shop@example.test');
  assert.equal(result.data[0].owner.account_type, 'merchant');
  assert.equal(Object.hasOwn(result.data[0], 'logo'), false);
});

test('admin payment links reject invalid limits and overlong searches', async () => {
  const handler = setup();
  assert.equal((await invoke(handler, request('/api/admin/links?limit=2001'))).status, 422);
  assert.equal((await invoke(handler, request(`/api/admin/links?q=${'x'.repeat(101)}`))).status, 422);
});

test('admin payment links require an authorized administrator', async () => {
  const result = await invoke(setup(), request('/api/admin/links', 'invalid'));
  assert.equal(result.status, 401);
});

test('admin link actions suspend, reactivate, and delete only the selected link', async () => {
  const handler = setup();
  const suspended = await invoke(
    handler, request('/api/admin/links/link-1/action/suspend', 'admin-session', 'POST'),
  );
  assert.equal(suspended.status, 200);
  assert.deepEqual(suspended.data, { ok: true });
  let active = await invoke(handler, request('/api/admin/links?status=active'));
  assert.equal(active.data.length, 0);

  const reactivated = await invoke(
    handler, request('/api/admin/links/link-1/action/reactivate', 'admin-session', 'POST'),
  );
  assert.equal(reactivated.status, 200);
  active = await invoke(handler, request('/api/admin/links?status=active'));
  assert.deepEqual(active.data.map(link => link.id), ['link-1']);

  const deleted = await invoke(
    handler, request('/api/admin/links/link-1/action/delete', 'admin-session', 'POST'),
  );
  assert.equal(deleted.status, 200);
  assert.equal(handler.testDb.collections.payment_links.rows.some(link => link.id === 'link-1'), false);
  assert.equal(handler.testDb.collections.link_payments.rows.some(payment => payment.link_id === 'link-1'), false);
  assert.equal(handler.testDb.collections.link_payments.rows.some(payment => payment.link_id === 'link-2'), true);
});

test('admin link actions reject unknown actions, missing links, and non-admin sessions', async () => {
  const handler = setup();
  assert.equal((await invoke(
    handler, request('/api/admin/links/link-1/action/remove', 'admin-session', 'POST'),
  )).status, 400);
  assert.equal((await invoke(
    handler, request('/api/admin/links/missing/action/suspend', 'admin-session', 'POST'),
  )).status, 404);
  assert.equal((await invoke(
    handler, request('/api/admin/links/link-1/action/suspend', 'invalid', 'POST'),
  )).status, 401);
});
