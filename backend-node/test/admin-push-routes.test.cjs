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
  async update_one(query, update) {
    const row = this.rows.find(item => matches(item, query));
    if (!row) return { matched_count: 0 };
    Object.assign(row, update.$set || {});
    return { matched_count: 1 };
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
  const scheduled = [];
  const deliveries = [];
  const env = {
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
      project_id: 'test-project',
      client_email: 'push@test-project.iam.gserviceaccount.com',
      private_key: 'test-private-key',
    }),
    FIREBASE_WEB_API_KEY: 'test-web-key',
    FIREBASE_MESSAGING_SENDER_ID: '123456',
    FIREBASE_APP_ID: '1:123456:web:test',
    FIREBASE_VAPID_KEY: 'test-vapid-key',
  };
  const handle = createAdminPushRoutes({
    db,
    env,
    schedule: callback => scheduled.push(callback),
    sendPushToUser: async (userId, message) => {
      deliveries.push({ userId, message });
      return ['sent'];
    },
    notify: async userId => ({ id: `notification-${userId}` }),
    sessionService: {
      async authenticate(token) {
        if (token !== 'admin-session') throw Object.assign(new Error('Session requise'), { status: 401 });
        return {
          userId: 'admin',
          session: { admin_auth_method: 'totp', admin_panel_unlocked_at: new Date() },
        };
      },
      requireRecentAuth() {},
    },
  });
  return { db, handle, scheduled, deliveries };
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

test('admin push campaign is confirmed, idempotently queued, and records delivery results', async () => {
  const { db, handle, scheduled, deliveries } = setup();
  const payload = {
    audience: 'user',
    user_id: 'u1',
    title: 'Information importante',
    body: 'Votre espace est à jour.',
    url: '/dashboard/transactions',
    confirmation: 'CONFIRMER',
    request_id: '11111111-1111-4111-8111-111111111111',
  };
  const queued = await call(handle, 'POST', '/api/admin/push/send', payload);
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  assert.deepEqual(queued.body, {
    id: payload.request_id, status: 'queued', users: 1, devices: 1,
  });
  assert.equal(scheduled.length, 1);

  const duplicate = await call(handle, 'POST', '/api/admin/push/send', payload);
  assert.equal(duplicate.status, 200);
  assert.equal(scheduled.length, 2);

  await scheduled[0]();
  await scheduled[1]();
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].userId, 'u1');
  assert.equal(deliveries[0].message.data.notification_id, 'notification-u1');
  const campaign = await db.collection('push_campaigns')
    .find_one({ id: payload.request_id }, { _id: 0 });
  assert.equal(campaign.status, 'sent');
  assert.equal(campaign.sent, 1);
  assert.equal(campaign.failed, 0);
  assert.equal(campaign.processed, 1);
});

test('admin push refuses missing confirmation and external notification links', async () => {
  const { handle, scheduled } = setup();
  const payload = {
    audience: 'user',
    user_id: 'u1',
    title: 'Information',
    body: 'Message',
    url: '/dashboard',
    request_id: '22222222-2222-4222-8222-222222222222',
  };
  const unconfirmed = await call(handle, 'POST', '/api/admin/push/send', payload);
  assert.equal(unconfirmed.status, 428);
  const external = await call(handle, 'POST', '/api/admin/push/send', {
    ...payload, confirmation: 'CONFIRMER', url: 'https://example.com',
  });
  assert.equal(external.status, 422);
  assert.equal(scheduled.length, 0);
});
