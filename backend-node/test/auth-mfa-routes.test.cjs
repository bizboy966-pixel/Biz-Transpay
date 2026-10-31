'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const security = require('../src/security.cjs');
const { createServer } = require('../src/server.cjs');
const { SessionService, SESSION_COOKIE_NAME, CSRF_COOKIE_NAME } = require('../src/session-service.cjs');
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
}

class MemoryDatabase {
  constructor() { this.collections = new Map(); }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name);
  }
}

const jwtSecret = 'synthetic-mfa-jwt-secret';
const sessionSecret = 'synthetic-mfa-session-secret';

async function start(db) {
  const sessionService = new SessionService(db, { jwtSecret });
  const server = createServer({ db, sessionService, jwtSecret, sessionSecret, env: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    sessionService,
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function adminUser() {
  return {
    id: 'mfa-admin',
    full_name: 'MFA Admin',
    username: 'mfaadmin',
    account_type: 'merchant',
    country: 'TG',
    phone: '+22890000000',
    email: 'admin@example.invalid',
    password_hash: '',
    role: 'admin',
    admin_role: 'general',
    two_fa_enabled: false,
    created_at: new Date().toISOString(),
  };
}

function cookieHeader(issue, csrfToken = issue.csrfToken) {
  const session = issue.setCookie.find(cookie => cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).split(';')[0];
  return `${session}; ${CSRF_COOKIE_NAME}=${csrfToken}`;
}

test('administrator can enroll MFA, confirm recovery codes, and configure a PIN with fresh CSRF/TOTP', async () => {
  const db = new MemoryDatabase();
  const user = adminUser();
  user.password_hash = await bcrypt.hash('AdminStrongPassword123!', 12);
  await db.collection('users').insert_one(user);
  const app = await start(db);
  try {
    const issue = await app.sessionService.issue(user.id, {
      userPinRequired: false, userPinAuthenticated: false,
    });
    const origin = new URL(app.base).origin.replace('http:', 'https:');
    const setup = await fetch(`${app.base}/api/auth/2fa/setup`, {
      method: 'POST',
      headers: {
        cookie: cookieHeader(issue), origin, 'x-csrf-token': issue.csrfToken,
      },
    });
    assert.equal(setup.status, 200);
    const setupData = await setup.json();
    assert.match(setupData.secret, /^[A-Z2-7]+$/);
    assert.match(setupData.otpauth_uri, /^otpauth:\/\/totp\//);

    const code = security.totpCode(setupData.secret, Math.floor(Date.now() / 1000));
    const confirmation = await fetch(`${app.base}/api/auth/2fa/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setup_token: setupData.setup_token, code }),
    });
    const confirmationData = await confirmation.json();
    assert.equal(confirmation.status, 200, JSON.stringify(confirmationData));
    assert.equal(confirmationData.enabled, true);
    assert.equal(confirmationData.recovery_codes.length, 8);
    assert.equal(db.collection('users').documents[0].two_fa_enabled, true);

    const nextCounterTimestamp = (Math.floor(Date.now() / 30_000) + 1) * 30;
    const nextCode = security.totpCode(setupData.secret, nextCounterTimestamp);
    const pin = await fetch(`${app.base}/api/auth/admin-pin`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader(issue),
        origin,
        'x-csrf-token': issue.csrfToken,
      },
      body: JSON.stringify({
        current_password: 'AdminStrongPassword123!',
        code: nextCode,
        pin: '456789',
      }),
    });
    assert.equal(pin.status, 200);
    assert.equal((await pin.json()).enabled, true);
    assert.equal(await security.verifyPin(
      user.id, '456789', 'admin', db.collection('users').documents[0].admin_pin_hash, sessionSecret,
    ), true);
    assert.equal(db.collection('admin_logs').documents[0].action, 'admin_pin_updated');
  } finally {
    await app.close();
  }
});

test('administrator APIs stay locked until a valid TOTP opens the panel', async () => {
  const db = new MemoryDatabase();
  const secret = 'JBSWY3DPEHPK3PXP';
  const user = {
    ...adminUser(),
    two_fa_enabled: true,
    two_fa_secret_encrypted: security.encryptFernet(
      secret, security.fernetKey(sessionSecret),
    ),
  };
  await db.collection('users').insert_one(user);
  const app = await start(db);
  try {
    const issue = await app.sessionService.issue(user.id, {
      adminAuthMethod: 'pin',
      userPinRequired: false,
    });
    const origin = new URL(app.base).origin.replace('http:', 'https:');
    const initialCookie = cookieHeader(issue);

    const blocked = await fetch(`${app.base}/api/admin/settings/features`, {
      headers: { cookie: initialCookie.split(';')[0] },
    });
    assert.equal(blocked.status, 428);
    assert.equal((await blocked.json()).detail.code, 'ADMIN_PANEL_MFA_REQUIRED');

    const unlock = await fetch(`${app.base}/api/auth/admin-panel/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: initialCookie,
        origin,
        'x-csrf-token': issue.csrfToken,
      },
      body: JSON.stringify({
        code: security.totpCode(secret, Math.floor(Date.now() / 1000)),
      }),
    });
    const unlockBody = await unlock.json();
    assert.equal(unlock.status, 200, JSON.stringify(unlockBody));
    assert.equal(unlockBody.user.admin_panel_unlocked, true);
    assert.ok(unlock.headers.get('set-cookie'));

    const rotatedSessionCookie = unlock.headers.get('set-cookie')
      .match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))[0];
    const adminPageData = await fetch(`${app.base}/api/admin/settings/features`, {
      headers: { cookie: rotatedSessionCookie },
    });
    assert.equal(adminPageData.status, 200, JSON.stringify(await adminPageData.json()));

    const me = await fetch(`${app.base}/api/auth/me`, {
      headers: { cookie: rotatedSessionCookie },
    });
    const profile = await me.json();
    assert.equal(me.status, 200);
    assert.equal(profile.admin_panel_unlocked, true);
    assert.ok(profile.admin_panel_unlocked_until);
    assert.equal(db.collection('admin_logs').documents.at(-1).action, 'admin_panel_unlocked');
  } finally {
    await app.close();
  }
});

test('user 2FA can be disabled only with the password and a valid authenticator code', async () => {
  const db = new MemoryDatabase();
  const secret = 'JBSWY3DPEHPK3PXP';
  const user = {
    id: 'mfa-user', role: 'user', email: 'user@example.invalid',
    password_hash: await bcrypt.hash('StrongPassword123!', 12),
    two_fa_enabled: true,
    two_fa_secret_encrypted: security.encryptFernet(secret, security.fernetKey(sessionSecret)),
  };
  await db.collection('users').insert_one(user);
  const app = await start(db);
  try {
    const issue = await app.sessionService.issue(user.id, {
      userPinRequired: true, userPinAuthenticated: true,
    });
    const origin = new URL(app.base).origin.replace('http:', 'https:');
    const response = await fetch(`${app.base}/api/auth/2fa/disable`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', cookie: cookieHeader(issue),
        origin, 'x-csrf-token': issue.csrfToken,
      },
      body: JSON.stringify({
        current_password: 'StrongPassword123!',
        code: security.totpCode(secret, Math.floor(Date.now() / 1000)),
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enabled: false });
    assert.equal(db.collection('users').documents[0].two_fa_enabled, false);
    assert.equal('two_fa_secret_encrypted' in db.collection('users').documents[0], false);
  } finally {
    await app.close();
  }
});

test('reauthentication verifies the current password and rotates the session', async () => {
  const db = new MemoryDatabase();
  const user = {
    id: 'reauth-user',
    role: 'user',
    email: 'reauth@example.invalid',
    password_hash: await bcrypt.hash('StrongPassword123!', 12),
    two_fa_enabled: false,
  };
  await db.collection('users').insert_one(user);
  const app = await start(db);
  try {
    const issue = await app.sessionService.issue(user.id, {
      userPinRequired: false, userPinAuthenticated: false,
    });
    const origin = new URL(app.base).origin.replace('http:', 'https:');
    const response = await fetch(`${app.base}/api/auth/reauth`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader(issue),
        origin,
        'x-csrf-token': issue.csrfToken,
      },
      body: JSON.stringify({ current_password: 'StrongPassword123!' }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.ok, true);
    assert.ok(Number.isFinite(body.expires_in));
    assert.ok(response.headers.get('set-cookie'));
  } finally {
    await app.close();
  }
});

test('mutating authenticated routes reject missing CSRF before touching credentials', async () => {
  const db = new MemoryDatabase();
  const user = adminUser();
  await db.collection('users').insert_one(user);
  const app = await start(db);
  try {
    const issue = await app.sessionService.issue(user.id, {
      userPinRequired: false, userPinAuthenticated: false,
    });
    const sessionOnly = issue.setCookie[0].split(';')[0];
    const response = await fetch(`${app.base}/api/auth/admin-pin`, {
      method: 'POST',
      headers: { cookie: sessionOnly, 'content-type': 'application/json' },
      body: JSON.stringify({ current_password: 'x', code: '000000', pin: null }),
    });
    assert.equal(response.status, 403);
    assert.equal(db.collection('users').documents[0].admin_pin_hash, undefined);
  } finally {
    await app.close();
  }
});
