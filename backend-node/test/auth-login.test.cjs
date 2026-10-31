'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const security = require('../src/security.cjs');
const { createServer } = require('../src/server.cjs');
const { SessionService, SESSION_COOKIE_NAME } = require('../src/session-service.cjs');
const { matches, applyUpdate, project, firstPath } = require('../src/document-store.cjs');

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
      sort(spec) { this.keys = spec; return this; },
      async to_list(limit) {
        let rows = collection.documents.filter(doc => matches(doc, query))
          .map(doc => structuredClone(doc));
        rows.sort((a, b) => {
          for (const [key, direction] of this.keys || []) {
            const av = firstPath(a, key); const bv = firstPath(b, key);
            if (av !== bv) return (av > bv ? 1 : -1) * direction;
          }
          return 0;
        });
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
  constructor() { this.collections = new Map(); }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name);
  }
}

const jwtSecret = 'synthetic-jwt-secret-for-login-tests';
const sessionSecret = 'synthetic-session-secret-for-login-tests';

async function withLoginServer(user, run) {
  const db = new MemoryDatabase();
  await db.collection('users').insert_one(user);
  const sessionService = new SessionService(db, { jwtSecret });
  const server = createServer({
    db, sessionService, jwtSecret, sessionSecret,
    env: {}, verifyBot: async () => {},
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await run({
      db, server, sessionService,
      base: `http://127.0.0.1:${server.address().port}`,
    });
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

function userRecord(overrides = {}) {
  return {
    id: 'login-user',
    full_name: 'Test User',
    username: 'testuser',
    account_type: 'merchant',
    country: 'TG',
    phone: '+22890000000',
    email: 'test@example.invalid',
    password_hash: '',
    role: 'user',
    kyc_status: 'not_started',
    balance_xof: 0,
    balance_xaf: 0,
    balance_usdt: 0,
    user_pin_hash: '',
    user_pin_version: 'pin-v1',
    user_pin_failures: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    two_fa_enabled: false,
    ...overrides,
  };
}

test('login preserves the password-then-user-PIN flow and establishes a session', async () => {
  const password = 'StrongPassword123!';
  const pin = '123456';
  const user = userRecord({
    password_hash: await bcrypt.hash(password, 12),
    user_pin_hash: await security.hashPin('login-user', pin, 'user', sessionSecret),
  });
  await withLoginServer(user, async ({ base, sessionService }) => {
    const initial = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password, turnstile_token: 'test-token' }),
    });
    assert.equal(initial.status, 200);
    const challenge = await initial.json();
    assert.equal(challenge.user_pin_required, true);
    assert.ok(challenge.user_pin_token);

    const completed = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: user.email, password, user_pin_token: challenge.user_pin_token, pin,
      }),
    });
    assert.equal(completed.status, 200);
    const body = await completed.json();
    assert.equal(body.token, null);
    assert.equal(body.user.id, user.id);
    const setCookie = completed.headers.get('set-cookie');
    assert.match(setCookie, new RegExp(`${SESSION_COOKIE_NAME}=`));
    assert.equal((await sessionService.authenticate(
      decodeURIComponent(setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))[1]),
    )).userId, user.id);
    assert.equal((await fetch(`${base}/api/auth/me`, {
      headers: { cookie: setCookie.split(';')[0] },
    })).status, 200);
  });
});

test('admin login without MFA starts enrollment instead of issuing a session', async () => {
  const user = userRecord({
    id: 'admin-user', role: 'admin', admin_role: 'general',
    password_hash: await bcrypt.hash('AdminStrongPassword123!', 12),
  });
  await withLoginServer(user, async ({ base, db }) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: user.email, password: 'AdminStrongPassword123!', turnstile_token: 'test-token',
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mfa_setup_required, true);
    assert.match(body.mfa_setup.otpauth_uri, /^otpauth:\/\/totp\//);
    assert.equal(db.collection('sessions').documents.length, 0);
    assert.equal(db.collection('mfa_enrollments').documents.length, 1);
    const encrypted = db.collection('mfa_enrollments').documents[0].secret_encrypted;
    assert.equal(
      security.decryptFernet(encrypted, security.fernetKey(sessionSecret)),
      body.mfa_setup.secret,
    );
  });
});

test('administrator with a PIN signs in to the user session but cannot choose TOTP at login', async () => {
  const password = 'AdminStrongPassword123!';
  const pin = '654321';
  const user = userRecord({
    id: 'admin-pin-user',
    role: 'admin',
    admin_role: 'general',
    password_hash: await bcrypt.hash(password, 12),
    two_fa_enabled: true,
    admin_pin_hash: await security.hashPin('admin-pin-user', pin, 'admin', sessionSecret),
    admin_pin_version: 'admin-pin-v1',
    admin_pin_failures: 0,
  });
  await withLoginServer(user, async ({ base, db, sessionService }) => {
    const initial = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: user.email, password, turnstile_token: 'test-token' }),
    });
    assert.equal(initial.status, 200);
    const challenge = await initial.json();
    assert.deepEqual(challenge.security_methods, ['pin']);

    const totpAttempt = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: user.email, password, mfa_token: challenge.mfa_token,
        security_method: 'totp', otp: '123456',
      }),
    });
    assert.equal(totpAttempt.status, 401);

    const completed = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: user.email, password, mfa_token: challenge.mfa_token,
        security_method: 'pin', pin,
      }),
    });
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).user.role, 'admin');
    const cookie = completed.headers.get('set-cookie')
      .match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))[1];
    const identity = await sessionService.authenticate(decodeURIComponent(cookie));
    assert.equal(identity.session.admin_auth_method, 'pin');
    assert.equal(identity.session.admin_panel_unlocked_at, undefined);
    assert.equal(db.collection('sessions').documents.length, 1);
  });
});

test('diagnostic mode keeps login unavailable until Preview storage is configured', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
      method: 'POST', body: '{}',
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'MIGRATION_INCOMPLETE');
  } finally {
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
});
