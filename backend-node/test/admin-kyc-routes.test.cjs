'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { applyUpdate, matches, project } = require('../src/document-store.cjs');
const { createAdminUserRoutes } = require('../src/admin-user-routes.cjs');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query, projection) {
    const row = this.rows.find(item => matches(item, query));
    return row ? project(row, projection) : null;
  }
  find(query = {}, projection = null) {
    const collection = this;
    return {
      sort(field, direction = 1) {
        this.sortField = field;
        this.direction = direction;
        return this;
      },
      async to_list(limit) {
        let rows = collection.rows.filter(row => matches(row, query))
          .map(row => project(row, projection));
        if (this.sortField) {
          rows.sort((a, b) => String(a[this.sortField] || '')
            .localeCompare(String(b[this.sortField] || '')) * this.direction);
        }
        return Number.isFinite(limit) ? rows.slice(0, limit) : rows;
      },
    };
  }
  async update_one(query, update, upsert = false) {
    const index = this.rows.findIndex(row => matches(row, query));
    if (index < 0) {
      if (upsert) this.rows.push(applyUpdate({}, update, true, query));
      return { matched_count: 0 };
    }
    this.rows[index] = applyUpdate(this.rows[index], update, false, query);
    return { matched_count: 1 };
  }
  async insert_one(row) { this.rows.push(structuredClone(row)); }
}

function setup() {
  const collections = {
    users: new Collection([
      { id: 'admin-1', username: 'owner', role: 'super_admin', two_fa_enabled: true },
      { id: 'user-1', username: 'awa', full_name: 'Awa Traoré', country: 'TG', kyc_status: 'pending' },
    ]),
    kyc: new Collection([{
      user_id: 'user-1', status: 'pending', submitted_at: '2026-10-20T10:00:00Z',
      full_name: 'Awa Traoré', document_type: 'cni', document_number: 'ID-123',
    }]),
    admin_logs: new Collection(),
  };
  const db = { collection: name => collections[name] };
  const notifications = [];
  const telegramEvents = [];
  const service = createAdminUserRoutes({
    db,
    env: {},
    cryptoCatalog: { async activeExchangeAssets() { return new Map(); } },
    sessionService: {
      async authenticate(token) {
        if (token === 'admin-session') return { userId: 'admin-1', session: {} };
        throw Object.assign(new Error('Session requise'), { status: 401 });
      },
    },
    async notify(...args) { notifications.push(args); },
    async notifyAdminKyc(...args) { telegramEvents.push(args); },
  });
  return { service, collections, notifications, telegramEvents };
}

function response() {
  return {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
}

async function call(service, method, url, body, token = 'admin-session') {
  const req = {
    method, url,
    headers: { authorization: `Bearer ${token}` },
    socket: { remoteAddress: '127.0.0.1' },
  };
  if (body !== undefined) req[Symbol.asyncIterator] = async function* stream() {
    yield Buffer.from(JSON.stringify(body));
  };
  const res = response();
  const handled = await service.handleRoute(req, res);
  return { handled, status: res.status, body: res.body };
}

test('KYC administration lists filtered documents with only the linked user profile', async () => {
  const { service } = setup();
  const result = await call(service, 'GET', '/api/admin/kyc?status=pending');
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 1);
  assert.equal(result.body[0].user.username, 'awa');
  assert.equal(result.body[0].user.country, 'TG');
});

test('KYC approval updates both records, notifies the user and audits the decision', async () => {
  const { service, collections, notifications, telegramEvents } = setup();
  const result = await call(service, 'POST', '/api/admin/kyc/user-1/decision', {
    approve: true, reason: '',
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true });
  assert.equal(collections.users.rows[1].kyc_status, 'verified');
  assert.equal(collections.kyc.rows[0].status, 'verified');
  assert.ok(collections.kyc.rows[0].verified_at);
  assert.equal(notifications[0][1], 'kyc_verified');
  assert.equal(telegramEvents[0][1], 'kyc_verified');
  assert.ok(collections.admin_logs.rows.some(row => row.action === 'kyc_approve'));
});

test('KYC decision rejects unauthenticated requests and invalid decision bodies', async () => {
  const { service } = setup();
  const denied = await call(service, 'POST', '/api/admin/kyc/user-1/decision', {
    approve: true,
  }, 'bad-session');
  assert.equal(denied.status, 401);
  const invalid = await call(service, 'POST', '/api/admin/kyc/user-1/decision', {
    approve: 'yes',
  });
  assert.equal(invalid.status, 422);
});
