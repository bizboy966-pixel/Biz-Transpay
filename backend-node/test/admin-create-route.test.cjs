'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createAdminUserRoutes } = require('../src/admin-user-routes.cjs');

function matches(row, query) {
  for (const [key, value] of Object.entries(query || {})) {
    if (key === '$or') {
      if (!value.some(term => matches(row, term))) return false;
    } else if (row[key] !== value) return false;
  }
  return true;
}

function setup(role = 'super_admin') {
  const users = [{
    id: 'owner-1', role, admin_role: 'general', username: 'owner',
    email: 'owner@example.test', two_fa_enabled: true,
  }];
  const logs = [];
  const db = {
    collection(name) {
      if (name === 'users') return {
        find_one: async query => users.find(user => matches(user, query)) || null,
        async insert_one(user) {
          if (users.some(existing => existing.id === user.id)) {
            throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' });
          }
          users.push(structuredClone(user));
        },
      };
      if (name === 'admin_logs') return {
        async insert_one(log) { logs.push(structuredClone(log)); },
      };
      if (name === 'platform_bootstrap') return {
        async find_one() { return null; },
      };
      throw new Error(`Unexpected collection: ${name}`);
    },
  };
  const service = createAdminUserRoutes({
    db,
    cryptoCatalog: { async activeExchangeAssets() { return new Map(); } },
    env: { PLATFORM_OWNER_EMAIL: 'owner@example.test' },
    sessionService: {
      async authenticate(token) {
        if (token !== 'owner-session') {
          throw Object.assign(new Error('Session requise'), { status: 401 });
        }
        return {
          userId: 'owner-1',
          session: { admin_auth_method: 'totp' },
        };
      },
      requireRecentAuth() {},
    },
  });
  return { service, users, logs };
}

async function create(service, overrides = {}) {
  const body = {
    full_name: 'Admin Example',
    username: 'admin_example',
    email: 'admin@example.test',
    password: 'StrongAdminPassword!2026',
    admin_role: 'support',
    country: 'TG',
    phone: '+22890000000',
    confirmation: 'CONFIRMER',
    ...overrides,
  };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.url = '/api/admin/admins';
  req.headers = { authorization: 'Bearer owner-session' };
  req.socket = { remoteAddress: '127.0.0.1' };
  const res = {
    status: 200,
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
  const handled = await service.handleRoute(req, res);
  return { handled, status: res.status, body: res.body };
}

test('only the super admin can create a protected admin account', async () => {
  const { service, users, logs } = setup();
  const result = await create(service);
  assert.equal(result.handled, true);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.role, 'admin');
  assert.equal(result.body.admin_role, 'support');
  assert.equal(result.body.two_fa_enabled, false);
  assert.equal(Object.hasOwn(result.body, 'password_hash'), false);
  assert.equal(users.length, 2);
  assert.notEqual(users[1].password_hash, 'StrongAdminPassword!2026');
  assert.equal(logs.some(row => row.action === 'create_admin'), true);
});

test('admin creation enforces confirmation, uniqueness and password policy', async () => {
  const { service, users } = setup();
  assert.equal((await create(service, { confirmation: '' })).status, 422);
  assert.equal((await create(service, { username: 'owner' })).status, 409);
  assert.equal((await create(service, { password: 'weak' })).status, 422);
  assert.equal(users.length, 1);
});

test('non-owner admins cannot create additional administrators', async () => {
  const { service, users } = setup('admin');
  const result = await create(service);
  assert.equal(result.status, 403);
  assert.equal(users.length, 1);
});
