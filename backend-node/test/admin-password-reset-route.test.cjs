'use strict';

const { Readable } = require('node:stream');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { createAdminUserRoutes } = require('../src/admin-user-routes.cjs');

function setup() {
  const admin = {
    id: 'admin-1', username: 'owner', role: 'super_admin',
    admin_role: 'owner', two_fa_enabled: true, is_active: true,
  };
  const target = {
    id: 'user-1', username: 'customer', role: 'user',
    password_hash: 'old-hash', password_policy_version: 1,
  };
  const logs = [];
  const db = {
    collection(name) {
      if (name === 'users') return {
        find_one: async filter => filter.id === admin.id
          ? structuredClone(admin)
          : filter.id === target.id ? structuredClone(target) : null,
        update_one: async (filter, update) => {
          if (filter.id === target.id) Object.assign(target, update.$set);
          return { matched_count: filter.id === target.id ? 1 : 0 };
        },
      };
      if (name === 'admin_logs') return {
        insert_one: async entry => { logs.push(structuredClone(entry)); },
      };
      throw new Error(`Unexpected collection ${name}`);
    },
  };
  const sessionService = {
    async authenticate(token) {
      if (token !== 'admin-session') {
        throw Object.assign(new Error('Session requise'), { status: 401 });
      }
      return {
        userId: admin.id,
        session: { admin_auth_method: 'totp' },
      };
    },
    requireRecentAuth() {},
  };
  return {
    target,
    logs,
    service: createAdminUserRoutes({ db, sessionService, env: {} }),
  };
}

async function post(service, payload) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  Object.assign(req, {
    method: 'POST',
    url: '/api/admin/users/user-1/reset-password',
    headers: { authorization: 'Bearer admin-session' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  const res = {
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  const handled = await service.handleRoute(req, res);
  return { handled, ...res };
}

test('admin password reset requires confirmation, hashes the password, and audits without secrets', async () => {
  const { service, target, logs } = setup();
  const newPassword = 'BlueOak!River2026';
  const result = await post(service, {
    new_password: newPassword,
    confirmation: 'CONFIRMER',
  });
  assert.equal(result.handled, true);
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body, { ok: true });
  assert.notEqual(target.password_hash, newPassword);
  assert.equal(await bcrypt.compare(newPassword, target.password_hash), true);
  const resetLogs = logs.filter(entry => entry.action === 'reset_password');
  assert.equal(resetLogs.length, 1);
  assert.equal(JSON.stringify(resetLogs).includes(newPassword), false);
});

test('admin password reset rejects missing confirmation without changing the password', async () => {
  const { service, target, logs } = setup();
  const result = await post(service, {
    new_password: 'BlueOak!River2026',
  });
  assert.equal(result.statusCode, 422);
  assert.equal(target.password_hash, 'old-hash');
  assert.equal(logs.some(entry => entry.action === 'reset_password'), false);
});
