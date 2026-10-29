'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { Readable } = require('node:stream');
const { createUserSettingsRoutes } = require('../src/user-settings-routes.cjs');
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
  async update_one(query, update) {
    const index = this.documents.findIndex(doc => matches(doc, query));
    if (index < 0) return { matched_count: 0, modified_count: 0 };
    this.documents[index] = applyUpdate(this.documents[index], update, false, query);
    return { matched_count: 1, modified_count: 1 };
  }
}

class MemoryDatabase {
  constructor() { this.users = new MemoryCollection(); }
  collection(name) {
    if (name !== 'users') throw new Error(`Unexpected collection ${name}`);
    return this.users;
  }
}

async function setup(user) {
  const db = new MemoryDatabase();
  await db.collection('users').insert_one(user);
  const sessionService = {
    async authenticate(token) {
      assert.equal(token, 'test-session');
      return { userId: user.id };
    },
  };
  return { db, handle: createUserSettingsRoutes({
    db, sessionService, sessionSecret: 'settings-test-session-secret',
  }) };
}

async function invoke(handle, method, path, body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.url = path;
  req.method = method;
  req.headers = { cookie: `${SESSION_COOKIE_NAME}=test-session` };
  const res = {
    status: 0,
    writeHead(status) { this.status = status; },
    end(payload) { this.body = payload; },
  };
  await handle(req, res);
  return { status: res.status, body: JSON.parse(res.body || '{}') };
}

async function makeUser(overrides = {}) {
  return {
    id: 'user-1',
    email: 'user@example.invalid',
    username: 'user1',
    role: 'user',
    language: 'fr',
    default_currency: 'XOF',
    password_hash: await bcrypt.hash('Current-Pass-2026!', 12),
    ...overrides,
  };
}

test('profile settings update language and currency but keep identity fields admin-only', async () => {
  const { db, handle } = await setup(await makeUser());
  const saved = await invoke(handle, 'PATCH', '/api/settings/profile', {
    language: 'en', default_currency: 'XAF',
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.language, 'en');
  assert.equal(saved.body.default_currency, 'XAF');
  assert.equal(Object.hasOwn(saved.body, 'password_hash'), false);

  const identityEdit = await invoke(handle, 'PATCH', '/api/settings/profile', {
    full_name: 'New Name',
  });
  assert.equal(identityEdit.status, 403);
  assert.equal((await db.collection('users').find_one({ id: 'user-1' })).full_name, undefined);
});

test('profile settings cannot bypass MFA setup or accept scriptable avatars', async () => {
  const { handle } = await setup(await makeUser());
  assert.equal((await invoke(handle, 'PATCH', '/api/settings/profile', {
    two_fa_enabled: false,
  })).status, 400);
  assert.equal((await invoke(handle, 'PATCH', '/api/settings/profile', {
    avatar_url: 'data:image/svg+xml;base64,PHN2Zz4=',
  })).status, 422);
  assert.equal((await invoke(handle, 'PATCH', '/api/settings/profile', {
    default_currency: 'USD',
  })).status, 422);
});

test('password change verifies the current password and stores the compatible hash', async () => {
  const { db, handle } = await setup(await makeUser());
  const denied = await invoke(handle, 'POST', '/api/settings/password', {
    current_password: 'wrong-password', new_password: 'New-Pass-2026!Abc',
  });
  assert.equal(denied.status, 400);
  const changed = await invoke(handle, 'POST', '/api/settings/password', {
    current_password: 'Current-Pass-2026!', new_password: 'New-Pass-2026!Abc',
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.ok, true);
  const saved = await db.collection('users').find_one({ id: 'user-1' });
  assert.equal(await bcrypt.compare('New-Pass-2026!Abc', saved.password_hash), true);
  assert.equal(saved.password_policy_version, 1);
});

test('administrator password change requires a valid TOTP when MFA is enabled', async () => {
  const admin = await makeUser({ id: 'admin-1', role: 'admin', two_fa_enabled: true });
  const { db, handle } = await setup(admin);
  const response = await invoke(handle, 'POST', '/api/settings/password', {
    current_password: 'Current-Pass-2026!', new_password: 'Admin-New-Password2026!',
  });
  assert.equal(response.status, 401);
  const saved = await db.collection('users').find_one({ id: 'admin-1' });
  assert.equal(await bcrypt.compare('Current-Pass-2026!', saved.password_hash), true);
});
