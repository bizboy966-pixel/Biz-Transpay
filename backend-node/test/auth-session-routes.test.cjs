'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
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

const secret = 'synthetic-auth-session-route-test-secret';
const env = { CSRF_TRUSTED_ORIGINS: '' };

async function withServer(run) {
  const db = new MemoryDatabase();
  await db.collection('users').insert_one({
    id: 'user-session-test', role: 'user', username: 'tester',
    full_name: 'Test User', email: 'test@example.invalid',
    created_at: '2026-01-01T00:00:00.000Z', balance_xof: 500,
    balance_crypto_usdt_bep20: 2.5, user_pin_hash: 'redacted-hash',
  });
  const sessionService = new SessionService(db, { jwtSecret: secret });
  const server = createServer({ db, sessionService, env });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run({ db, sessionService, server, base: `http://127.0.0.1:${server.address().port}` }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

function sessionCookie(issue) {
  return issue.setCookie.find(value => value.startsWith(`${SESSION_COOKIE_NAME}=`)).split(';')[0];
}

test('session routes return the safe public profile and issue a readable CSRF cookie', async () => {
  await withServer(async ({ sessionService, base }) => {
    const issued = await sessionService.issue('user-session-test', {
      userPinRequired: true, userPinAuthenticated: true,
    });
    const me = await fetch(`${base}/api/auth/me`, {
      headers: { cookie: sessionCookie(issued) },
    });
    assert.equal(me.status, 200);
    const profile = await me.json();
    assert.equal(profile.username, 'tester');
    assert.equal(profile.balance_xof, 500);
    assert.equal(profile.crypto_wallet_balances['USDT.BEP20'], 2.5);
    assert.equal(profile.user_pin_enabled, true);
    assert.equal('password_hash' in profile, false);
    assert.equal('two_fa_secret_encrypted' in profile, false);

    const csrfResponse = await fetch(`${base}/api/auth/csrf`, {
      headers: { cookie: sessionCookie(issued) },
    });
    assert.equal(csrfResponse.status, 200);
    const csrf = await csrfResponse.json();
    assert.match(csrf.csrf_token, /^[A-Za-z0-9_-]{40,}$/);
    assert.match(csrfResponse.headers.get('set-cookie'), new RegExp(`${CSRF_COOKIE_NAME}=`));
    assert.match(csrfResponse.headers.get('set-cookie'), /Secure; SameSite=Strict/);
  });
});

test('session refresh requires same-origin CSRF, rotates the token and logout revokes it', async () => {
  await withServer(async ({ sessionService, base }) => {
    const issued = await sessionService.issue('user-session-test', {
      userPinRequired: true, userPinAuthenticated: true,
    });
    const cookie = `${sessionCookie(issued)}; ${CSRF_COOKIE_NAME}=${issued.csrfToken}`;
    const origin = new URL(base).origin.replace('http:', 'https:');

    const forged = await fetch(`${base}/api/auth/session/refresh`, {
      method: 'POST', headers: {
        cookie, origin: 'https://evil.invalid', 'x-csrf-token': issued.csrfToken,
      },
    });
    assert.equal(forged.status, 403);

    const refreshed = await fetch(`${base}/api/auth/session/refresh`, {
      method: 'POST', headers: {
        cookie, origin, 'x-csrf-token': issued.csrfToken,
      },
    });
    assert.equal(refreshed.status, 200);
    const setCookie = refreshed.headers.get('set-cookie');
    assert.match(setCookie, new RegExp(`${SESSION_COOKIE_NAME}=`));
    assert.equal((await sessionService.authenticate(issued.token).catch(error => error.status)), 401);

    const logoutSession = await sessionService.issue('user-session-test', {
      userPinRequired: true, userPinAuthenticated: true,
    });
    const logoutCookie = `${sessionCookie(logoutSession)}; ${CSRF_COOKIE_NAME}=${logoutSession.csrfToken}`;
    const loggedOut = await fetch(`${base}/api/auth/logout`, {
      method: 'POST', headers: {
        cookie: logoutCookie, origin, 'x-csrf-token': logoutSession.csrfToken,
      },
    });
    assert.equal(loggedOut.status, 200);
    assert.equal((await loggedOut.json()).ok, true);
    await assert.rejects(sessionService.authenticate(logoutSession.token), error => error.status === 401);
  });
});
