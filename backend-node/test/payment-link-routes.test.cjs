'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { matches, applyUpdate, project } = require('../src/document-store.cjs');
const { SESSION_COOKIE_NAME } = require('../src/session-service.cjs');
const { createPaymentLinkRoutes } = require('../src/payment-link-routes.cjs');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query, projectionSpec) {
    const found = this.rows.find(row => matches(row, query));
    return found ? project(found, projectionSpec) : null;
  }
  find(query, projectionSpec) {
    const collection = this;
    return {
      key: null,
      direction: 1,
      sort(key, direction = 1) { this.key = key; this.direction = direction; return this; },
      async to_list(limit) {
        let rows = collection.rows.filter(row => matches(row, query))
          .map(row => structuredClone(row));
        if (this.key) rows.sort((a, b) => (a[this.key] > b[this.key] ? 1 : -1) * this.direction);
        if (Number.isFinite(limit)) rows = rows.slice(0, limit);
        return rows.map(row => project(row, projectionSpec));
      },
    };
  }
  async insert_one(row) { this.rows.push(structuredClone(row)); }
  async update_one(query, update) {
    const index = this.rows.findIndex(row => matches(row, query));
    if (index < 0) return { matched_count: 0 };
    this.rows[index] = applyUpdate(this.rows[index], update, false, query);
    return { matched_count: 1 };
  }
  async delete_one(query) {
    const index = this.rows.findIndex(row => matches(row, query));
    if (index < 0) return { deleted_count: 0 };
    this.rows.splice(index, 1);
    return { deleted_count: 1 };
  }
}

class Database {
  constructor() { this.collections = new Map([['payment_links', new Collection()]]); }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Collection());
    return this.collections.get(name);
  }
}

function setup() {
  const db = new Database();
  const handle = createPaymentLinkRoutes({
    db,
    sessionService: {
      async authenticate(token) {
        if (token === 'alice') return { userId: 'user-a' };
        if (token === 'bob') return { userId: 'user-b' };
        throw Object.assign(new Error('Session requise'), { status: 401 });
      },
    },
  });
  return { db, handle };
}

async function call(handle, method, url, body, token = 'alice') {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.url = url;
  request.headers = token ? { cookie: `${SESSION_COOKIE_NAME}=${token}` } : {};
  let responseBody = '';
  let status = 200;
  const response = {
    writeHead(code) { status = code; },
    end(value) { responseBody = value || ''; },
  };
  const handled = await handle(request, response);
  return { handled, status, body: responseBody ? JSON.parse(responseBody) : null };
}

test('payment link create/list/public view keep owner data private', async () => {
  const { handle } = setup();
  const created = await call(handle, 'POST', '/api/links', {
    title: 'Commande',
    amount_type: 'fixed',
    amount: 500,
    crypto_amount: 0.8,
    currency: 'XOF',
    fee_bearer: 'customer',
    logo: null,
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.user_id, 'user-a');
  assert.equal(created.body.amount, 500);
  const slug = created.body.slug;

  const publicResult = await call(handle, 'GET', `/api/links/public/${slug}`, undefined, null);
  assert.equal(publicResult.status, 200);
  assert.equal(publicResult.body.title, 'Commande');
  assert.equal(Object.hasOwn(publicResult.body, 'user_id'), false);

  const ownLinks = await call(handle, 'GET', '/api/links');
  assert.equal(ownLinks.body.length, 1);
  const otherLinks = await call(handle, 'GET', '/api/links', undefined, 'bob');
  assert.equal(otherLinks.body.length, 0);
});

test('payment link update and delete require ownership and validate amounts', async () => {
  const { handle } = setup();
  const created = await call(handle, 'POST', '/api/links', {
    title: 'Produit', amount_type: 'fixed', amount: 100, currency: 'XOF',
  });
  const id = created.body.id;
  const denied = await call(handle, 'PATCH', `/api/links/${id}`, { active: false }, 'bob');
  assert.equal(denied.status, 404);
  const updated = await call(handle, 'PATCH', `/api/links/${id}`, { active: false });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.active, false);
  const invalid = await call(handle, 'PATCH', `/api/links/${id}`, { amount: -1 });
  assert.equal(invalid.status, 422);
  const deleted = await call(handle, 'DELETE', `/api/links/${id}`);
  assert.equal(deleted.body.ok, true);
  assert.equal((await call(handle, 'GET', '/api/links')).body.length, 0);
});

test('payment link creation rejects invalid ranges and unauthenticated users', async () => {
  const { handle } = setup();
  const unauthorized = await call(handle, 'GET', '/api/links', undefined, null);
  assert.equal(unauthorized.status, 401);
  const invalid = await call(handle, 'POST', '/api/links', {
    title: 'Montant libre', amount_type: 'free',
    min_amount: 500, max_amount: 400, currency: 'XOF',
  });
  assert.equal(invalid.status, 422);
  const invalidFlag = await call(handle, 'POST', '/api/links', {
    title: 'Produit', amount_type: 'fixed', amount: 500,
    single_use: 'true', currency: 'XOF',
  });
  assert.equal(invalidFlag.status, 422);
});

test('integration payment-link creation binds ownership and replays the same idempotency key', async () => {
  const { db, handle } = setup();
  const payload = {
    title: 'API order',
    amount_type: 'fixed',
    amount: 750,
    currency: 'XOF',
    fee_bearer: 'customer',
  };
  const first = await handle.handleIntegration('user-a', payload, 'link-create-001');
  const retry = await handle.handleIntegration('user-a', payload, 'link-create-001');
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.id, first.body.id);
  assert.equal(retry.body.slug, first.body.slug);
  assert.equal(db.collection('payment_links').rows.length, 1);
  assert.equal(db.collection('payment_links').rows[0].user_id, 'user-a');

  const conflict = await handle.handleIntegration('user-a', {
    ...payload, amount: 900,
  }, 'link-create-001');
  assert.equal(conflict.status, 409);
  assert.equal(db.collection('payment_links').rows.length, 1);
});

test('public link-payment status returns a customer-safe snapshot only', async () => {
  const { db, handle } = setup();
  await db.collection('link_payments').insert_one({
    id: 'link-payment-public-1',
    user_id: 'merchant-secret',
    method: 'mobile_money',
    status: 'pending',
    amount: 1200,
    currency: 'XOF',
    country: 'TG',
    operator: 'tmoney',
    operator_name: 'T-Money',
    customer_phone: '+22890000000',
    provider_token: 'must-not-leak',
    internal_error: 'must-not-leak',
    created_at: '2026-05-01T10:00:00.000Z',
  });
  const status = await call(
    handle, 'GET', '/api/links/payments/link-payment-public-1', undefined, null,
  );
  assert.equal(status.status, 200);
  assert.equal(status.body.status, 'pending');
  assert.equal(status.body.customer_phone, '+22890000000');
  assert.equal(Object.hasOwn(status.body, 'user_id'), false);
  assert.equal(Object.hasOwn(status.body, 'provider_token'), false);
  assert.equal(Object.hasOwn(status.body, 'internal_error'), false);
  const missing = await call(
    handle, 'GET', '/api/links/payments/missing', undefined, null,
  );
  assert.equal(missing.status, 404);
});
