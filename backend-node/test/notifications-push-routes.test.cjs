'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { createNotificationsPushRoutes, safeFcmError } = require('../src/notifications-push-routes.cjs');
const { SESSION_COOKIE_NAME } = require('../src/session-service.cjs');
const { matches, applyUpdate, project } = require('../src/document-store.cjs');

class MemoryCollection {
  constructor() { this.documents = []; }
  async insert_one(document) {
    this.documents.push(structuredClone(document));
    return { inserted_id: document.id };
  }
  async find_one(query, projectionSpec) {
    const found = this.documents.find(doc => matches(doc, query));
    return found ? project(found, projectionSpec) : null;
  }
  find(query, projectionSpec) {
    const collection = this;
    return {
      keys: [],
      sort(spec) { this.keys = typeof spec === 'string' ? [[spec, -1]] : spec; return this; },
      async to_list(limit) {
        let rows = collection.documents.filter(doc => matches(doc, query))
          .map(doc => structuredClone(doc));
        rows.sort((a, b) => {
          for (const [key, direction] of this.keys) {
            const av = key.split('.').reduce((value, part) => value?.[part], a);
            const bv = key.split('.').reduce((value, part) => value?.[part], b);
            if (av !== bv) return (av > bv ? 1 : -1) * direction;
          }
          return 0;
        });
        if (limit !== undefined) rows = rows.slice(0, limit);
        return rows.map(row => project(row, projectionSpec));
      },
    };
  }
  async count_documents(query) {
    return this.documents.filter(doc => matches(doc, query)).length;
  }
  async update_one(query, update, upsert = false) {
    const index = this.documents.findIndex(doc => matches(doc, query));
    if (index < 0) {
      if (upsert) this.documents.push(applyUpdate({}, update, true, query));
      return { matched_count: 0, modified_count: 0, upserted_id: null };
    }
    this.documents[index] = applyUpdate(this.documents[index], update, false, query);
    return { matched_count: 1, modified_count: 1 };
  }
  async update_many(query, update) {
    const selected = this.documents.filter(doc => matches(doc, query));
    for (const old of selected) {
      this.documents[this.documents.indexOf(old)] = applyUpdate(old, update, false, query);
    }
    return { matched_count: selected.length, modified_count: selected.length };
  }
  async delete_many(query) {
    const before = this.documents.length;
    this.documents = this.documents.filter(doc => !matches(doc, query));
    return { deleted_count: before - this.documents.length };
  }
}

class MemoryDatabase {
  constructor() { this.collections = new Map(); }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name);
  }
}

const firebaseService = JSON.stringify({
  project_id: 'example-project',
  client_email: 'fcm@example-project.iam.gserviceaccount.com',
  private_key: 'test-only-not-a-real-key',
});
const validEnv = {
  FIREBASE_SERVICE_ACCOUNT_JSON: firebaseService,
  FIREBASE_WEB_API_KEY: 'test-web-key',
  FIREBASE_PROJECT_ID: 'example-project',
  FIREBASE_MESSAGING_SENDER_ID: '123456789',
  FIREBASE_APP_ID: '1:123456789:web:test',
  FIREBASE_VAPID_KEY: 'test-vapid-key',
};

function setup({ env = {}, fetchImpl } = {}) {
  const db = new MemoryDatabase();
  const sessionService = {
    async authenticate(token) {
      if (token !== 'notification-session') {
        const error = new Error('Session requise');
        error.status = 401;
        throw error;
      }
      return { userId: 'owner' };
    },
  };
  const service = createNotificationsPushRoutes({
    db, sessionService, env, fetchImpl,
  });
  return { db, service };
}

function request(method, url, body) {
  const req = new EventEmitter();
  req.url = url;
  req.method = method;
  req.headers = { cookie: `${SESSION_COOKIE_NAME}=notification-session` };
  if (body !== undefined) req[Symbol.asyncIterator] = async function* stream() {
    yield Buffer.from(JSON.stringify(body));
  };
  return req;
}

function response() {
  const res = new EventEmitter();
  res.status = 0;
  res.headers = {};
  res.chunks = [];
  res.writeHead = function writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  };
  res.write = function write(chunk) { this.chunks.push(chunk); return true; };
  res.end = function end(body) { this.writableEnded = true; if (body) this.chunks.push(body); };
  return res;
}

async function call(service, method, url, body) {
  const res = response();
  await service.handleRoute(request(method, url, body), res);
  return { status: res.status, headers: res.headers, body: JSON.parse(res.chunks.join('') || '{}'), res };
}

test('notifications list, mark-read and unread count are scoped to the current user', async () => {
  const { db, service } = setup();
  await db.collection('notifications').insert_one({
    id: 'mine-unread', user_id: 'owner', read: false, title: 'Mine',
    created_at: '2026-01-02T00:00:00Z',
  });
  await db.collection('notifications').insert_one({
    id: 'mine-read', user_id: 'owner', read: true, title: 'Read',
    created_at: '2026-01-01T00:00:00Z',
  });
  await db.collection('notifications').insert_one({
    id: 'other', user_id: 'other', read: false, title: 'Private',
    created_at: '2026-01-03T00:00:00Z',
  });
  const list = await call(service, 'GET', '/api/notifications?unread_only=true');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map(item => item.id), ['mine-unread']);
  assert.deepEqual((await call(service, 'GET', '/api/notifications/unread-count')).body, { count: 1 });
  assert.equal((await call(service, 'POST', '/api/notifications/mine-unread/read')).status, 200);
  assert.deepEqual((await call(service, 'GET', '/api/notifications/unread-count')).body, { count: 0 });
  assert.equal((await call(service, 'POST', '/api/notifications/other/read')).status, 404);
});

test('pending-confirmation notifications include only the current user’s unread confirmations', async () => {
  const { db, service } = setup();
  for (const notification of [
    { id: 'mine-confirmation', user_id: 'owner', read: false, requires_confirmation: true },
    { id: 'mine-ordinary', user_id: 'owner', read: false, requires_confirmation: false },
    { id: 'mine-confirmed', user_id: 'owner', read: true, requires_confirmation: true },
    { id: 'other-confirmation', user_id: 'other', read: false, requires_confirmation: true },
  ]) {
    await db.collection('notifications').insert_one({
      ...notification, title: notification.id, created_at: '2026-01-02T00:00:00Z',
    });
  }
  const result = await call(service, 'GET', '/api/notifications/pending-confirmation');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.map(item => item.id), ['mine-confirmation']);
});

test('read-all and delete-all preserve unread notifications requiring confirmation', async () => {
  const { db, service } = setup();
  for (const item of [
    { id: 'ordinary', read: false },
    { id: 'important', read: false, requires_confirmation: true },
    { id: 'confirmed', read: true, requires_confirmation: true },
  ]) await db.collection('notifications').insert_one({
    user_id: 'owner', title: item.id, created_at: item.id, ...item,
  });
  const readAll = await call(service, 'POST', '/api/notifications/read-all');
  assert.equal(readAll.status, 200);
  assert.equal(readAll.body.updated, 1);
  assert.equal(readAll.body.unread_count, 1);
  const deleteAll = await call(service, 'DELETE', '/api/notifications/all');
  assert.equal(deleteAll.body.deleted, 2);
  assert.equal(deleteAll.body.unread_count, 1);
  assert.equal(await db.collection('notifications').count_documents({ id: 'important' }), 1);
});

test('notification persistence is fanned out to the owner SSE stream', async () => {
  const { db, service } = setup();
  const req = request('GET', '/api/notifications/stream');
  const res = response();
  assert.equal(await service.handleRoute(req, res), true);
  assert.equal(res.status, 200);
  assert.match(res.chunks[0], /connected/);
  const saved = await service.notify('owner', 'deposit_success', 'ignored', 'Dépôt reçu', {
    transaction_id: 'tx-1',
  });
  assert.equal(saved.title, 'Dépôt Biz-transPay confirmé');
  assert.equal(await db.collection('notifications').count_documents({ user_id: 'owner' }), 1);
  assert.match(res.chunks.join(''), /event: notification/);
  assert.match(res.chunks.join(''), /tx-1/);
  res.emit('close');
});

test('push registration requires configured FCM, hashes tokens, and unregisters only its owner device', async () => {
  const { db, service } = setup({ env: validEnv });
  const token = 'browser-registration-token-123456789';
  const registered = await call(service, 'POST', '/api/push/devices', { token });
  assert.equal(registered.status, 200);
  const id = crypto.createHash('sha256').update(token).digest('hex');
  const saved = await db.collection('push_devices').find_one({ id });
  assert.equal(saved.user_id, 'owner');
  assert.equal(saved.token, token);
  const deleted = await call(service, 'DELETE', '/api/push/devices', { token });
  assert.deepEqual(deleted.body, { ok: true, deleted: 1 });
  assert.equal(await db.collection('push_devices').find_one({ id }), null);

  const missing = setup();
  const unconfigured = await call(missing.service, 'POST', '/api/push/devices', { token });
  assert.equal(unconfigured.status, 503);
});

test('push config exposes only public Firebase client values and safe missing names', async () => {
  const { service } = setup({ env: validEnv });
  const result = await call(service, 'GET', '/api/push/config');
  assert.equal(result.body.configured, true);
  assert.equal(result.body.server_configured, true);
  assert.equal(result.body.config.projectId, 'example-project');
  assert.equal(JSON.stringify(result.body).includes('private_key'), false);
});

test('FCM errors retire only tokens explicitly identified as permanently invalid', () => {
  assert.equal(safeFcmError({
    error: { status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] },
  }, 404).permanentlyInvalid, true);
  assert.equal(safeFcmError({
    error: { status: 'INVALID_ARGUMENT' },
  }, 400).permanentlyInvalid, false);
  assert.equal(safeFcmError({
    error: { status: 'INVALID_ARGUMENT', details: [{
      '@type': 'type.googleapis.com/google.rpc.BadRequest',
      fieldViolations: [{ field: 'message.token' }],
    }] },
  }, 400).permanentlyInvalid, true);
  assert.equal(safeFcmError({ error: { status: 'PERMISSION_DENIED' } }, 403).sanitized,
    'PERMISSION_DENIED');
});
