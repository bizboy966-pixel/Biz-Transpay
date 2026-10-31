'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createAdminUserRoutes } = require('../src/admin-user-routes.cjs');

function matches(row, query) {
  return Object.entries(query).every(([key, expected]) => {
    if (expected && typeof expected === 'object' && '$ne' in expected) {
      return row[key] !== expected.$ne;
    }
    return row[key] === expected;
  });
}

function setup(target = {}) {
  const users = [
    {
      id: 'admin-1', username: 'admin', email: 'admin@example.test',
      role: 'super_admin', two_fa_enabled: true, platform_owner: true,
    },
    {
      id: 'user-1', username: 'customer', email: 'customer@example.test',
      full_name: 'Customer Name', role: 'user', account_type: 'personal',
      ...target,
    },
  ];
  const logs = [];
  const db = {
    collection(name) {
      if (name === 'admin_logs') {
        return { insert_one: async entry => { logs.push(structuredClone(entry)); } };
      }
      if (name !== 'users') throw new Error(`Unexpected collection ${name}`);
      return {
        async find_one(query) {
          const user = users.find(row => matches(row, query));
          return user ? structuredClone(user) : null;
        },
        async update_one(query, update) {
          const user = users.find(row => matches(row, query));
          if (!user) return { matched_count: 0 };
          Object.assign(user, structuredClone(update.$set || {}));
          for (const key of Object.keys(update.$unset || {})) delete user[key];
          return { matched_count: 1 };
        },
      };
    },
  };
  const sessionService = {
    async authenticate(token) {
      if (token !== 'admin-session') {
        const error = new Error('Session requise');
        error.status = 401;
        throw error;
      }
      return {
        userId: 'admin-1',
        session: { admin_auth_method: 'totp', admin_panel_unlocked_at: new Date() },
      };
    },
    requireRecentAuth() {},
  };
  return {
    users, logs,
    service: createAdminUserRoutes({ db, sessionService, env: {} }),
  };
}

async function call(
  service, body, path = '/api/admin/users/user-1', token = 'admin-session', method = 'PATCH',
) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = path;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = {
    writeHead(status) { this.statusCode = status; },
    end(value) { this.body = JSON.parse(value); },
  };
  const handled = await service.handleRoute(req, res);
  return { handled, ...res };
}

test('admin user profile updates require fresh admin auth, redact secrets and audit the change', async () => {
  const { service, users, logs } = setup();
  const response = await call(service, { full_name: 'Updated Name' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.full_name, 'Updated Name');
  assert.equal(response.body.password_hash, undefined);
  assert.equal(users[1].full_name, 'Updated Name');
  const updateLog = logs.find(entry => entry.action === 'update_user');
  assert.ok(updateLog);
  assert.equal(updateLog.target_user_id, 'user-1');
});

test('role changes require super-admin confirmation and an administrator role', async () => {
  const { service, users } = setup();
  const missingConfirmation = await call(service, { role: 'admin' });
  assert.equal(missingConfirmation.statusCode, 428);
  assert.equal(users[1].role, 'user');

  const changed = await call(service, {
    role: 'admin', admin_role: 'general', confirmation: 'CONFIRMER',
  });
  assert.equal(changed.statusCode, 200);
  assert.equal(users[1].role, 'admin');
  assert.equal(users[1].admin_role, 'general');
});

test('platform owner identity and role are protected from administrator edits', async () => {
  const { service, users } = setup({
    email: 'owner@example.test', role: 'super_admin',
    platform_owner: true, created_at: '2026-01-01T00:00:00.000Z',
  });
  const response = await call(service, {
    email: 'attacker@example.test', confirmation: 'CONFIRMER',
  });
  assert.equal(response.statusCode, 403);
  assert.equal(users[1].email, 'owner@example.test');
});

test('duplicate email/username and anonymous mutations are rejected', async () => {
  const { service, users } = setup();
  users.push({
    id: 'user-2', username: 'occupied', email: 'occupied@example.test', role: 'user',
  });
  const duplicateName = await call(service, { username: 'occupied' });
  assert.equal(duplicateName.statusCode, 409);
  const duplicateEmail = await call(service, { email: 'OCCUPIED@example.test' });
  assert.equal(duplicateEmail.statusCode, 409);
  const anonymous = await call(service, { full_name: 'Nope' }, undefined, '');
  assert.equal(anonymous.statusCode, 401);
  assert.equal(users[1].full_name, 'Customer Name');
});

test('user actions require step-up authentication and typed confirmation and protect owner', async () => {
  const { service, users, logs } = setup();
  const path = '/api/admin/users/user-1/action/ban';
  const missingPhrase = await call(service, { reason: 'risk' }, path, 'admin-session', 'POST');
  assert.equal(missingPhrase.statusCode, 428);
  assert.equal(users[1].is_banned, undefined);

  const banned = await call(
    service,
    { reason: 'confirmed review', confirmation: 'CONFIRMER' },
    path,
    'admin-session',
    'POST',
  );
  assert.equal(banned.statusCode, 200);
  assert.equal(users[1].is_banned, true);
  assert.equal(users[1].is_blocked, true);
  assert.ok(logs.some(entry => entry.action === 'ban'));

  const protectedTarget = setup({
    platform_owner: true,
    email: 'owner@example.test',
    role: 'super_admin',
    created_at: '2026-01-01T00:00:00.000Z',
  });
  const blockedOwner = await call(
    protectedTarget.service,
    { confirmation: 'CONFIRMER' },
    '/api/admin/users/user-1/action/block',
    'admin-session',
    'POST',
  );
  assert.equal(blockedOwner.statusCode, 403);
  assert.equal(protectedTarget.users[1].is_blocked, undefined);
});
