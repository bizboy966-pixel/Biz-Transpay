'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createServer } = require('../src/server.cjs');
const { matches, applyUpdate, project, firstPath } = require('../src/document-store.cjs');

class MemoryCollection {
  constructor() { this.documents = []; }
  async insert_one(document) {
    if (this.documents.some(row => row._id === document._id || (document.id && row.id === document.id))) {
      throw new Error('duplicate');
    }
    this.documents.push(structuredClone(document));
    return { inserted_id: document.id ?? document._id };
  }
  async find_one(query, projectionSpec) {
    const found = this.documents.find(doc => matches(doc, query));
    return found ? project(found, projectionSpec) : null;
  }
  find(query, projectionSpec) {
    const collection = this;
    return {
      sort() { return this; },
      async to_list(limit) {
        let rows = collection.documents.filter(doc => matches(doc, query))
          .map(doc => structuredClone(doc));
        if (limit !== undefined) rows = rows.slice(0, limit);
        return rows.map(row => project(row, projectionSpec));
      },
    };
  }
  async update_one(query, update) { return this.update(query, update, false); }
  async update_many(query, update) { return this.update(query, update, true); }
  async update(query, changes, many) {
    const found = this.documents.filter(doc => matches(doc, query));
    const selected = many ? found : found.slice(0, 1);
    for (const old of selected) this.documents[this.documents.indexOf(old)] = applyUpdate(old, changes);
    return { matched_count: selected.length, modified_count: selected.length };
  }
  async delete_one(query) {
    const index = this.documents.findIndex(doc => matches(doc, query));
    if (index < 0) return { deleted_count: 0 };
    this.documents.splice(index, 1);
    return { deleted_count: 1 };
  }
}

class MemoryDatabase {
  constructor() { this.collections = new Map(); this.queue = Promise.resolve(); }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name);
  }
  async transaction(callback) {
    const previous = this.queue;
    let release;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    const tx = {
      lockCollection: async () => {},
      get: async (collection, id) => this.collection(collection).find_one({ _id: id }, { _id: 0 }),
      insert: async (collection, id, document) =>
        this.collection(collection).insert_one({ ...document, _id: document._id ?? id }),
      replace: async (collection, id, document) => {
        const table = this.collection(collection);
        const index = table.documents.findIndex(row => row._id === id || row.id === id);
        if (index >= 0) {
          table.documents[index] = structuredClone({ ...document, _id: id });
          return { matched_count: 1, modified_count: 1 };
        }
        return this.collection(collection).insert_one({ ...document, _id: id });
      },
    };
    try { return await callback(tx); }
    finally { release(); }
  }
}

async function withServer(db, run) {
  const server = createServer({
    db,
    jwtSecret: 'synthetic-jwt-secret-for-register-test',
    sessionSecret: 'synthetic-session-secret-for-register-test',
    env: {},
    verifyBot: async (token, _request, action) => {
      assert.equal(token, 'test-turnstile');
      assert.equal(action, 'register');
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

function registration(overrides = {}) {
  return {
    full_name: 'New Customer',
    username: 'newcustomer',
    account_type: 'personal',
    country: 'TG',
    phone: '+22891111111',
    email: 'new@example.invalid',
    password: 'StrongPassword123!',
    turnstile_token: 'test-turnstile',
    ...overrides,
  };
}

const sponsorId = '11111111-1111-4111-8111-111111111111';

test('first signup atomically claims the initial admin and enforces the admin password policy', async () => {
  const db = new MemoryDatabase();
  await withServer(db, async base => {
    const rejected = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(registration({ password: 'Weak123!' })),
    });
    assert.equal(rejected.status, 422);
    assert.equal(db.collection('users').documents.length, 0);

    const response = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(registration({
        username: 'firstadmin',
        email: 'owner@example.invalid',
        password: 'AdminStrongPassword123!',
      })),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mfa_setup_required, true);
    assert.equal(body.user.role, 'super_admin');
    assert.equal(body.user.account_type, 'merchant');
    const owner = db.collection('users').documents[0];
    assert.equal(owner.platform_owner, true);
    assert.equal(owner.kyc_status, 'verified');
    const bootstrap = db.collection('platform_bootstrap').documents[0];
    assert.equal(bootstrap.status, 'complete');
    assert.equal(bootstrap.user_id, owner.id);
    assert.equal('claim_token' in bootstrap, false);
    assert.equal('expires_at' in bootstrap, false);
  });
});

test('serialized registrations prevent duplicate email claims and preserve referral attribution', async () => {
  const db = new MemoryDatabase();
  await db.collection('users').insert_one({
    _id: sponsorId, id: sponsorId, username: 'sponsor1',
    email: 'sponsor@example.invalid', phone: '+22892222222',
    is_blocked: false, is_banned: false,
  });
  await withServer(db, async base => {
    const payload = registration({ referral_code: sponsorId });
    const submit = () => fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const results = await Promise.all([submit(), submit()]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
    const created = db.collection('users').documents.find(user => user.email === payload.email);
    assert.ok(created);
    assert.equal(created.account_type, 'merchant');
    assert.equal(created.referred_by_user_id, sponsorId);
    assert.equal(db.collection('users').documents.filter(user => user.email === payload.email).length, 1);
  });
});

test('public registration cannot self-refer by username, email, or phone', async () => {
  const db = new MemoryDatabase();
  await db.collection('users').insert_one({
    _id: sponsorId, id: sponsorId, username: 'sponsor1',
    email: 'sponsor@example.invalid', phone: '+22892222222',
    is_blocked: false, is_banned: false,
  });
  await withServer(db, async base => {
    const response = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(registration({ referral_code: sponsorId, phone: '+228 92-22-22-22' })),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).detail, 'Auto-parrainage interdit');
    assert.equal(db.collection('users').documents.length, 1);
  });
});
