'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SessionService, SessionError } = require('../src/session-service.cjs');
const { matches, applyUpdate, project, firstPath } = require('../src/document-store.cjs');

class MemoryCollection {
  constructor() { this.documents = []; }
  async insert_one(document) {
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
      keys: [],
      sort(spec) { this.keys = typeof spec === 'string' ? [[spec, 1]] : spec; return this; },
      async to_list(limit) {
        let rows = collection.documents.filter(doc => matches(doc, query))
          .map(doc => structuredClone(doc));
        rows.sort((a, b) => {
          for (const [key, direction] of this.keys) {
            const av = firstPath(a, key); const bv = firstPath(b, key);
            const missing = (av === null || av === undefined ? 1 : 0)
              - (bv === null || bv === undefined ? 1 : 0);
            const comparison = (direction < 0 ? -missing : missing)
              || (av === bv ? 0 : av > bv ? 1 : -1) * (direction < 0 ? -1 : 1);
            if (comparison) return comparison;
          }
          return 0;
        });
        if (limit !== undefined) rows = rows.slice(0, limit);
        return rows.map(row => project(row, projectionSpec));
      },
    };
  }
  async update_one(query, update) { return this._update(query, update, false); }
  async update_many(query, update) { return this._update(query, update, true); }
  async _update(query, update, all) {
    const found = this.documents.filter(doc => matches(doc, query));
    const selected = all ? found : found.slice(0, 1);
    let modified = 0;
    for (const old of selected) {
      const next = applyUpdate(old, update);
      if (JSON.stringify(next) !== JSON.stringify(old)) modified++;
      this.documents[this.documents.indexOf(old)] = next;
    }
    return { matched_count: selected.length, modified_count: modified };
  }
}

class MemoryDatabase {
  constructor() { this.collections = new Map(); }
  collection(name) {
    if (!this.collections.has(name)) this.collections.set(name, new MemoryCollection());
    return this.collections.get(name);
  }
}

const signingSecret = 'synthetic-session-key-for-session-service-tests';

test('session issue, authentication, PIN gate, rotation, and logout', async () => {
  let now = 1700000000000;
  const db = new MemoryDatabase();
  const service = new SessionService(db, { jwtSecret: signingSecret, now: () => now });
  await db.collection('users').insert_one({ id: 'user-1', role: 'user' });

  const blocked = await service.issue('user-1', {
    userPinRequired: true, userPinAuthenticated: false, ip: '192.0.2.4',
    userAgent: 'synthetic browser',
  });
  assert.match(blocked.setCookie[0], /HttpOnly/);
  assert.doesNotMatch(blocked.setCookie[1], /HttpOnly/);
  assert.match(blocked.setCookie[0], /Secure; SameSite=Strict/);
  await assert.rejects(service.authenticate(blocked.token), error =>
    error instanceof SessionError && error.status === 428 && error.code === 'USER_PIN_REQUIRED');

  const authenticated = await service.issue('user-1', {
    userPinRequired: true, userPinAuthenticated: true,
  });
  const identity = await service.authenticate(authenticated.token);
  assert.equal(identity.userId, 'user-1');
  assert.equal(service.requireRecentAuth(identity), 'user-1');
  now += 1000;
  const rotated = await service.rotate(identity);
  await assert.rejects(service.authenticate(authenticated.token), error =>
    error instanceof SessionError && error.code === 'SESSION_REVOKED');
  const rotatedIdentity = await service.authenticate(rotated.token);
  assert.equal(rotatedIdentity.session.user_pin_authenticated, true);
  const clearCookies = await service.logout(rotatedIdentity);
  assert.equal(clearCookies.length, 2);
  await assert.rejects(service.authenticate(rotated.token), error =>
    error instanceof SessionError && error.code === 'SESSION_REVOKED');
});

test('legacy sessions receive the existing user-PIN gate and expire after inactivity', async () => {
  let now = 1700000000000;
  const db = new MemoryDatabase();
  const service = new SessionService(db, { jwtSecret: signingSecret, now: () => now });
  await db.collection('users').insert_one({ id: 'legacy-user', role: 'user' });
  const issued = await service.issue('legacy-user');
  delete db.collection('sessions').documents[0].user_pin_required;
  await assert.rejects(service.authenticate(issued.token), error =>
    error instanceof SessionError && error.code === 'USER_PIN_REQUIRED');
  assert.equal(db.collection('sessions').documents[0].user_pin_required, true);

  const pinned = await service.issue('legacy-user', {
    userPinRequired: true, userPinAuthenticated: true,
  });
  now += 31 * 60 * 1000;
  await assert.rejects(service.authenticate(pinned.token), error =>
    error instanceof SessionError && error.code === 'SESSION_EXPIRED');
  assert.equal(
    db.collection('sessions').documents.find(doc => doc.id === pinned.sessionId).revocation_reason,
    'expired',
  );
});

test('only the three newest active sessions remain, and stale timestamps fail closed', async () => {
  let now = 1700000000000;
  const db = new MemoryDatabase();
  const service = new SessionService(db, { jwtSecret: signingSecret, now: () => now });
  const issued = [];
  for (let i = 0; i < 4; i += 1) {
    issued.push(await service.issue('bounded-user'));
    now += 1000;
  }
  const active = db.collection('sessions').documents.filter(doc => !doc.revoked_at);
  assert.equal(active.length, 3);
  assert.equal(
    db.collection('sessions').documents.find(doc => doc.id === issued[0].sessionId).revocation_reason,
    'session_limit',
  );

  const current = active.at(-1);
  current.expires_at = 'not-a-date';
  await assert.rejects(service.authenticate(issued.at(-1).token), error =>
    error instanceof SessionError && error.code === 'SESSION_EXPIRED');
});

test('recent authentication step-up expires at the existing 15-minute boundary', async () => {
  let now = 1700000000000;
  const db = new MemoryDatabase();
  const service = new SessionService(db, { jwtSecret: signingSecret, now: () => now });
  const issued = await service.issue('step-up-user');
  const identity = await service.authenticate(issued.token);
  assert.equal(service.requireRecentAuth(identity), 'step-up-user');
  now += 15 * 60 * 1000;
  assert.throws(() => service.requireRecentAuth(identity), error =>
    error instanceof SessionError && error.code === 'REAUTH_REQUIRED');
});
