'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSupportRoutes } = require('../src/support-routes.cjs');
const { SESSION_COOKIE_NAME } = require('../src/session-service.cjs');
const { matches, applyUpdate, project } = require('../src/document-store.cjs');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query, projectionSpec) {
    const found = this.rows.find(row => matches(row, query));
    return found ? project(found, projectionSpec) : null;
  }
  find(query, projectionSpec) {
    const collection = this;
    return {
      sortKey: null,
      direction: 1,
      sort(key, direction = 1) { this.sortKey = key; this.direction = direction; return this; },
      async to_list(limit) {
        let rows = collection.rows.filter(row => matches(row, query)).map(row => structuredClone(row));
        if (this.sortKey) {
          rows.sort((a, b) => {
            const left = a[this.sortKey];
            const right = b[this.sortKey];
            return (left === right ? 0 : left > right ? 1 : -1) * this.direction;
          });
        }
        if (Number.isFinite(limit)) rows = rows.slice(0, limit);
        return rows.map(row => project(row, projectionSpec));
      },
    };
  }
  async insert_one(row) { this.rows.push(structuredClone(row)); }
  async update_one(query, update, upsert = false) {
    const index = this.rows.findIndex(row => matches(row, query));
    if (index < 0) {
      if (upsert) this.rows.push(applyUpdate({}, update, true, query));
      return { matched_count: 0, modified_count: 0 };
    }
    this.rows[index] = applyUpdate(this.rows[index], update, false, query);
    return { matched_count: 1, modified_count: 1 };
  }
  async update_many(query, update) {
    const found = this.rows.filter(row => matches(row, query));
    for (const row of found) {
      this.rows[this.rows.indexOf(row)] = applyUpdate(row, update, false, query);
    }
    return { matched_count: found.length, modified_count: found.length };
  }
}

class Database {
  constructor(seed = {}) {
    this.collections = new Map(Object.entries(seed).map(([name, rows]) => [name, new Collection(rows)]));
  }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Collection());
    return this.collections.get(name);
  }
}

function setup(seed = {}) {
  const db = new Database(seed);
  const service = createSupportRoutes({
    db,
    sessionService: {
      async authenticate(token) {
        if (token !== 'support-session') {
          const error = new Error('Session requise');
          error.status = 401;
          throw error;
        }
        return { userId: 'owner' };
      },
    },
  });
  return { db, service };
}

function request(method, url, body, token = 'support-session') {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { cookie: `${SESSION_COOKIE_NAME}=${token}` };
  if (body !== undefined) req[Symbol.asyncIterator] = async function* stream() {
    yield Buffer.from(JSON.stringify(body));
  };
  return req;
}

function response() {
  return {
    status: 0,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; },
  };
}

async function call(service, method, url, body, token) {
  const res = response();
  assert.equal(await service.handleRoute(request(method, url, body, token), res), true);
  return { status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

test('support config returns only active HTTP(S) social links and enabled FAQs', async () => {
  const { service } = setup({
    settings: [{
      id: 'support_config',
      telegram_url: 'https://t.me/help',
      whatsapp_url: 'https://wa.me/123',
      email: 'help@example.test',
      social_channels: {
        facebook: { url: 'https://facebook.com/biz', active: true },
        tiktok: { url: 'https://tiktok.com/@biz', active: false },
        instagram: { url: '', active: true },
        whatsapp: { url: 'https://wa.me/123', active: true },
      },
      faqs: [
        { id: 'visible', question: 'Question ?', answer: 'Réponse', active: true },
        { id: 'hidden', question: 'Masquée ?', answer: 'Non', active: false },
        { id: 'empty', question: '', answer: 'Non', active: true },
      ],
    }],
  });
  const result = await call(service, 'GET', '/api/support/config');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.social_channels, [
    { key: 'facebook', url: 'https://facebook.com/biz', active: true },
    { key: 'whatsapp', url: 'https://wa.me/123', active: true },
  ]);
  assert.deepEqual(result.body.faqs, [
    { id: 'visible', question: 'Question ?', answer: 'Réponse', active: true },
  ]);
});

test('ticket listing is scoped to the signed-in user and newest first', async () => {
  const { service } = setup({
    tickets: [
      { id: 'old', user_id: 'owner', created_at: '2026-01-01T00:00:00Z' },
      { id: 'new', user_id: 'owner', created_at: '2026-01-02T00:00:00Z' },
      { id: 'private', user_id: 'other', created_at: '2026-01-03T00:00:00Z' },
    ],
  });
  const result = await call(service, 'GET', '/api/support/tickets');
  assert.deepEqual(result.body.map(ticket => ticket.id), ['new', 'old']);
});

test('ticket creation applies category, length and owner validation', async () => {
  const { db, service } = setup();
  const result = await call(service, 'POST', '/api/support/tickets', {
    subject: 'Question de paiement',
    message: 'Veuillez vérifier mon paiement.',
    category: 'billing',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.user_id, 'owner');
  assert.equal(result.body.status, 'open');
  assert.deepEqual(result.body.replies, []);
  assert.equal(await db.collection('tickets').find_one({ user_id: 'other' }), null);
  const invalid = await call(service, 'POST', '/api/support/tickets', {
    subject: 'Sujet', message: 'Texte', category: 'admin',
  });
  assert.equal(invalid.status, 422);
});

test('support messages persist safe attachments and are marked read only for their conversation', async () => {
  const { db, service } = setup({
    users: [{ id: 'owner', username: 'alice', full_name: 'Alice' }],
    support_messages: [
      { id: 'admin-message', conversation_id: 'owner', sender: 'admin', read_by_user: false, created_at: '2026-01-01' },
      { id: 'other-admin', conversation_id: 'other', sender: 'admin', read_by_user: false, created_at: '2026-01-01' },
      { id: 'legacy', conversation_id: 'owner', sender: 'admin', read_by_user: true, attachments: [
        { name: 'good.jpg', type: 'image/jpeg', data: 'data:image/jpeg;base64,/9j/AA==' },
        { name: 'bad.svg', type: 'image/svg+xml', data: 'data:image/svg+xml;base64,PHN2Zz4=' },
      ], created_at: '2026-01-02' },
    ],
  });
  const imageData = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64')}`;
  const sent = await call(service, 'POST', '/api/support/messages', {
    text: 'Bonjour',
    attachments: [{ name: '../preuve.jpg', type: 'image/jpeg', data: imageData }],
  });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.sender_name, 'Alice');
  assert.equal(sent.body.attachments[0].name, 'preuve.jpg');
  const listed = await call(service, 'GET', '/api/support/messages');
  assert.equal(listed.body.length, 3);
  const legacy = listed.body.find(message => message.id === 'legacy');
  assert.equal(legacy.attachments.length, 1);
  assert.equal(legacy.attachments[0].name, 'good.jpg');
  assert.equal(await db.collection('support_messages').find_one({
    id: 'admin-message', read_by_user: true,
  }) !== null, true);
  assert.equal(await db.collection('support_messages').find_one({
    id: 'other-admin', read_by_user: true,
  }), null);
});

test('support endpoints reject unauthenticated requests and unsafe attachment payloads', async () => {
  const { service } = setup();
  const unauthorized = await call(service, 'GET', '/api/support/tickets', undefined, 'bad-session');
  assert.equal(unauthorized.status, 401);
  const invalid = await call(service, 'POST', '/api/support/messages', {
    text: '',
    attachments: [{ name: 'x.svg', type: 'image/jpeg', data: 'data:image/svg+xml;base64,PHN2Zz4=' }],
  });
  assert.equal(invalid.status, 422);
});
