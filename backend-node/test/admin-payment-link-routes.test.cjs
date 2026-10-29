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
}

function request(url, token = 'admin-session') {
  const req = Readable.from([]);
  req.method = 'GET';
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
  };
  return createAdminPaymentLinkRoutes({ db, sessionService, env: {} });
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
