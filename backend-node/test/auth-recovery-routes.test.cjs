'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const security = require('../src/security.cjs');
const { createServer } = require('../src/server.cjs');
const { SessionService } = require('../src/session-service.cjs');
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
    for (const old of selected) {
      this.documents[this.documents.indexOf(old)] = applyUpdate(old, changes, false, query);
    }
    return { matched_count: selected.length, modified_count: selected.length };
  }
  async delete_one(query) {
    const index = this.documents.findIndex(doc => matches(doc, query));
    if (index < 0) return { deleted_count: 0 };
    this.documents.splice(index, 1);
    return { deleted_count: 1 };
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

const jwtSecret = 'synthetic-recovery-jwt-secret';
const sessionSecret = 'synthetic-recovery-session-secret';
const env = {
  PUBLIC_APP_URL: 'https://biz-transpay.example',
  RESEND_API_KEY: 'test-only-key',
};

async function start(db, sendEmail = async () => {}) {
  const sessionService = new SessionService(db, { jwtSecret });
  let verifiedActions = [];
  const routeErrors = [];
  const verifyBot = async (_token, _req, action) => { verifiedActions.push(action); };
  const server = createServer({
    db, sessionService, jwtSecret, sessionSecret, env, verifyBot, sendEmail,
    onAuthRecoveryError: error => routeErrors.push(error.stack || String(error)),
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    verifiedActions: () => verifiedActions,
    routeErrors: () => routeErrors,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function userRecord(overrides = {}) {
  return {
    id: 'recovery-user',
    email: 'person@example.invalid',
    username: 'person1',
    role: 'user',
    password_hash: '',
    recovery_codes: [],
    ...overrides,
  };
}

async function post(base, path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('reset request returns a generic message, rate limits, and sends a one-time email asynchronously', async () => {
  const db = new MemoryDatabase();
  await db.collection('settings').insert_one({
    id: 'transaction_email_settings', sender_email: 'no-reply@biz-transpay.example',
  });
  await db.collection('users').insert_one(userRecord());
  const sent = [];
  const app = await start(db, async (_env, message) => { sent.push(message); });
  try {
    const response = await post(app.base, '/api/auth/password-reset/request', {
      email: 'PERSON@example.invalid', turnstile_token: 'valid',
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message, 'Si cette adresse est liée à un compte, un lien de réinitialisation sera envoyé.');
    for (let attempt = 0; attempt < 30 && sent.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /30 minutes/);
    assert.match(sent[0].html, /Biz-transPay/);
    const token = db.collection('password_reset_tokens').documents[0];
    assert.equal(token.purpose, 'password');
    assert.equal(token.used, false);
    assert.equal(token.token_hash.length, 64);
    assert.deepEqual(app.verifiedActions(), ['password_reset']);

    const throttled = await post(app.base, '/api/auth/password-reset/request', {
      email: 'person@example.invalid', turnstile_token: 'valid',
    });
    assert.equal(throttled.status, 200);
  } finally {
    await app.close();
  }
});

test('user PIN reset request creates a purpose-bound one-time token', async () => {
  const db = new MemoryDatabase();
  await db.collection('settings').insert_one({
    id: 'transaction_email_settings', sender_email: 'no-reply@biz-transpay.example',
  });
  await db.collection('users').insert_one(userRecord({
    user_pin_hash: 'existing-test-pin-hash',
  }));
  const sent = [];
  const app = await start(db, async (_env, message) => { sent.push(message); });
  try {
    const response = await post(app.base, '/api/auth/user-pin/reset/request', {
      email: 'PERSON@example.invalid', turnstile_token: 'valid',
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message,
      'Si cette adresse est liée à un compte, un lien de réinitialisation sera envoyé.');
    for (let attempt = 0; attempt < 30 && sent.length === 0; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(sent.length, 1);
    assert.equal(db.collection('password_reset_tokens').documents[0].purpose, 'user_pin');
    assert.deepEqual(app.verifiedActions(), ['password_reset']);
  } finally {
    await app.close();
  }
});

test('password reset consumes its token once, updates credentials, and revokes sessions', async () => {
  const db = new MemoryDatabase();
  const oldHash = await bcrypt.hash('OldStrongPassword123!', 12);
  await db.collection('users').insert_one(userRecord({ password_hash: oldHash }));
  await db.collection('sessions').insert_one({ id: 'active-session', user_id: 'recovery-user' });
  const token = crypto.randomBytes(32).toString('base64url');
  await db.collection('password_reset_tokens').insert_one({
    id: 'reset-token',
    user_id: 'recovery-user',
    token_hash: crypto.createHash('sha256').update(token).digest('hex'),
    purpose: 'password',
    used: false,
    expires_at: new Date(Date.now() + 60_000),
  });
  const app = await start(db);
  try {
    const response = await post(app.base, '/api/auth/password-reset/confirm', {
      token, new_password: 'NewStrongPassword123!', turnstile_token: 'valid',
    });
    const result = await response.json();
    assert.equal(response.status, 200, `${JSON.stringify(result)}\n${app.routeErrors().join('\n')}`);
    assert.equal(result.ok, true);
    assert.equal(await security.verifyPassword('NewStrongPassword123!', db.collection('users').documents[0].password_hash), true);
    assert.equal(db.collection('sessions').documents[0].revocation_reason, 'password_reset');
    assert.equal(db.collection('password_reset_tokens').documents[0].used, true);
    const secondUse = await post(app.base, '/api/auth/password-reset/confirm', {
      token, new_password: 'AnotherStrongPassword456!', turnstile_token: 'valid',
    });
    assert.equal(secondUse.status, 400);
  } finally {
    await app.close();
  }
});

test('user PIN reset validates the current password and invalidates the previous PIN and sessions', async () => {
  const db = new MemoryDatabase();
  const user = userRecord({
    password_hash: await bcrypt.hash('CurrentStrongPassword123!', 12),
    user_pin_hash: await security.hashPin('recovery-user', '111222', 'user', sessionSecret),
    user_pin_version: 'old-version',
  });
  await db.collection('users').insert_one(user);
  await db.collection('sessions').insert_one({ id: 'active-session', user_id: user.id });
  const token = crypto.randomBytes(32).toString('base64url');
  await db.collection('password_reset_tokens').insert_one({
    id: 'pin-reset-token',
    user_id: user.id,
    token_hash: crypto.createHash('sha256').update(token).digest('hex'),
    purpose: 'user_pin',
    used: false,
    expires_at: new Date(Date.now() + 60_000),
  });
  const app = await start(db);
  try {
    const response = await post(app.base, '/api/auth/user-pin/reset/confirm', {
      token,
      current_password: 'CurrentStrongPassword123!',
      pin: '333444',
      turnstile_token: 'valid',
    });
    assert.equal(response.status, 200);
    const updated = db.collection('users').documents[0];
    assert.equal(await security.verifyPin(user.id, '333444', 'user', updated.user_pin_hash, sessionSecret), true);
    assert.equal(await security.verifyPin(user.id, '111222', 'user', updated.user_pin_hash, sessionSecret), false);
    assert.notEqual(updated.user_pin_version, 'old-version');
    assert.equal(db.collection('sessions').documents[0].revocation_reason, 'user_pin_reset');
  } finally {
    await app.close();
  }
});

test('account recovery consumes only an unused recovery code and revokes sessions', async () => {
  const db = new MemoryDatabase();
  const hash = await bcrypt.hash('12345678-abcd1234', 12);
  await db.collection('users').insert_one(userRecord({
    password_hash: await bcrypt.hash('OldStrongPassword123!', 12),
    recovery_codes: [{ id: 'recovery-code-id', hash, used: false }],
  }));
  await db.collection('sessions').insert_one({ id: 'active-session', user_id: 'recovery-user' });
  const app = await start(db);
  try {
    const response = await post(app.base, '/api/auth/recover', {
      identifier: 'person1',
      recovery_code: '12345678-abcd1234',
      new_password: 'NewStrongPassword123!',
      turnstile_token: 'valid',
    });
    const result = await response.json();
    assert.equal(response.status, 200, `${JSON.stringify(result)}\n${app.routeErrors().join('\n')}`);
    assert.equal(await security.verifyPassword('NewStrongPassword123!', db.collection('users').documents[0].password_hash), true);
    assert.equal(db.collection('users').documents[0].recovery_codes[0].used, true);
    assert.equal(db.collection('sessions').documents[0].revocation_reason, 'account_recovery');
    assert.deepEqual(app.verifiedActions(), ['recover']);
  } finally {
    await app.close();
  }
});
