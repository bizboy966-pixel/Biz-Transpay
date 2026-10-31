'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdminUserRoutes } = require('../src/admin-user-routes.cjs');
const { isAdminIpAllowed, ipMatchesRule } = require('../src/admin-authorization.cjs');

function matches(row, query) {
  for (const [key, value] of Object.entries(query)) {
    if (key === '$or') {
      if (!value.some(term => matches(row, term))) return false;
    } else if (value && typeof value === 'object' && '$regex' in value) {
      const regex = new RegExp(value.$regex, value.$options || '');
      if (!regex.test(String(row[key] ?? ''))) return false;
    } else if (row[key] !== value) return false;
  }
  return true;
}

function setup({ sessionUserId = 'staff-1', staff = {} } = {}) {
  const users = [
    {
      id: 'staff-1', role: 'admin', admin_role: 'support',
      username: 'supporter', two_fa_enabled: true, ...staff,
    },
    {
      id: 'user-1', full_name: 'Awa Traoré', username: 'awa_traore',
      email: 'awa@example.test', phone: '+228 90 12 34 56',
      created_at: '2026-01-03T00:00:00.000Z', is_blocked: false, is_banned: false,
      password_hash: 'password-secret', user_pin_hash: 'pin-secret',
      two_fa_secret_encrypted: 'mfa-secret', recovery_codes: ['recovery-secret'],
      balance_xof: 5000, balance_xaf: 100, balance_usdt: 0.5,
      balance_crypto_usdt_trc20: 1.5,
    },
    {
      id: 'user-2', full_name: 'Blaise Nguema', username: 'blaise',
      email: 'blaise@example.test', phone: '+22890123457',
      created_at: '2026-01-02T00:00:00.000Z', is_blocked: false, is_banned: false,
    },
  ];
  const transactions = [
    { id: 'tx-1', user_id: 'user-1', created_at: '2026-01-04T00:00:00.000Z' },
    { id: 'tx-2', user_id: 'user-1', created_at: '2026-01-03T00:00:00.000Z' },
    { id: 'tx-other', user_id: 'user-2', created_at: '2026-01-05T00:00:00.000Z' },
  ];
  const logs = [];
  const db = {
    collection(name) {
      if (name === 'admin_logs') {
        return { insert_one: async doc => { logs.push(structuredClone(doc)); } };
      }
      if (name === 'transactions') {
        return {
          count_documents: async query => transactions.filter(row => matches(row, query)).length,
          find: (query, projection) => {
            let rows = transactions.filter(row => matches(row, query)).map(row => ({ ...row }));
            return {
              sort(field, direction) {
                rows.sort((a, b) => String(a[field] || '').localeCompare(String(b[field] || ''))
                  * (direction < 0 ? -1 : 1));
                return this;
              },
              async to_list(limit) { return rows.slice(0, limit); },
            };
          },
        };
      }
      if (name !== 'users') throw new Error(`Unexpected collection ${name}`);
      return {
        find_one: async (query, projection = {}) => {
          const user = users.find(item => matches(item, query));
          if (!user) return null;
          const safe = { ...user };
          for (const [key, include] of Object.entries(projection)) {
            if (include === 0) delete safe[key];
          }
          return safe;
        },
        find: (query, projection) => {
          let rows = users.filter(user => matches(user, query)).map(user => {
            const safe = { ...user };
            for (const [key, include] of Object.entries(projection || {})) {
              if (include === 0) delete safe[key];
            }
            return safe;
          });
          return {
            sort(field, direction) {
              rows.sort((a, b) => String(a[field] || '').localeCompare(String(b[field] || ''))
                * (direction < 0 ? -1 : 1));
              return this;
            },
            async to_list(limit) { return rows.slice(0, limit); },
          };
        },
      };
    },
  };
  const service = createAdminUserRoutes({
    db,
    cryptoCatalog: {
      async activeExchangeAssets() {
        return new Map([['USDT.TRC20', {
          coin: 'USDT', network: 'TRC20', network_name: 'Tron (TRC20)',
          wallet_field: 'balance_crypto_usdt_trc20',
        }]]);
      },
    },
    env: {},
    sessionService: {
      async authenticate(token) {
        if (token !== 'admin-session') {
          throw Object.assign(new Error('Session requise'), { status: 401, code: 'SESSION_REQUIRED' });
        }
        return {
          userId: sessionUserId,
          session: { admin_auth_method: 'totp', admin_panel_unlocked_at: new Date() },
        };
      },
    },
  });
  return { service, users, logs };
}

function request(url) {
  return {
    method: 'GET',
    url,
    headers: { authorization: 'Bearer admin-session' },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function response() {
  return {
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
}

async function call(service, url) {
  const res = response();
  const handled = await service.handleRoute(request(url), res);
  return { handled, status: res.status, body: res.body };
}

test('admin user search matches full name, email, username and formatted phone number', async () => {
  const { service, logs } = setup();
  for (const term of ['Awa Traoré', 'awa@example.test', '@awa_traore', '22890123456']) {
    const result = await call(service, `/api/admin/users?q=${encodeURIComponent(term)}`);
    assert.equal(result.status, 200, term);
    assert.deepEqual(result.body.map(user => user.id), ['user-1'], term);
  }
  assert.equal(logs.length, 4);
  assert.ok(logs.every(log => log.action === 'admin_list_users' && log.details.allowed));
});

test('admin user search treats punctuation as literal and never returns credential secrets', async () => {
  const { service } = setup();
  const result = await call(service, '/api/admin/users?q=%2E');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.map(user => user.id), ['user-1', 'user-2']);
  const target = result.body.find(user => user.id === 'user-1');
  assert.equal(target.password_hash, undefined);
  assert.equal(target.user_pin_hash, undefined);
  assert.equal(target.two_fa_secret_encrypted, undefined);
  assert.equal(target.recovery_codes, undefined);
});

test('admin user list preserves KYC/status filters and validates search bounds', async () => {
  const { service } = setup();
  const blocked = await call(service, '/api/admin/users?status=active&limit=1');
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.length, 1);
  const invalid = await call(service, `/api/admin/users?q=${'x'.repeat(101)}`);
  assert.equal(invalid.status, 422);
  assert.equal((await call(service, '/api/admin/users?limit=1001')).status, 422);
});

test('admin user detail is owner-scoped and wallet list uses active crypto networks', async () => {
  const { service } = setup();
  const detail = await call(service, '/api/admin/users/user-1');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.transactions_count, 2);
  assert.deepEqual(detail.body.recent_transactions.map(tx => tx.id), ['tx-1', 'tx-2']);
  assert.equal(detail.body.user.password_hash, undefined);

  const wallets = await call(service, '/api/admin/users/user-1/balance-wallets');
  assert.equal(wallets.status, 200);
  assert.deepEqual(wallets.body.wallets.map(wallet => wallet.id), ['XOF', 'XAF', 'USDT.TRC20']);
  assert.equal(wallets.body.wallets[0].balance, 5000);
  assert.equal(wallets.body.wallets[2].balance, 1.5);
  assert.equal(wallets.body.legacy_usdt_balance, 0.5);
  assert.equal((await call(service, '/api/admin/users/no-such-user')).status, 404);
});

test('admin user list rejects non-admin and staff without MFA and audits denied attempts', async () => {
  const ordinary = setup({ sessionUserId: 'user-1' });
  const notAdmin = await call(ordinary.service, '/api/admin/users');
  assert.equal(notAdmin.status, 403);
  assert.equal(ordinary.logs.at(-1).action, 'admin_access_denied');

  const noMfa = setup({ staff: { two_fa_enabled: false } });
  const mfaDenied = await call(noMfa.service, '/api/admin/users');
  assert.equal(mfaDenied.status, 403);
  assert.equal(mfaDenied.body.detail.code, 'ADMIN_MFA_REQUIRED');
  assert.equal(noMfa.logs.at(-1).action, 'admin_access_denied');
});

test('admin IP allowlist supports exact IPv4, IPv4 CIDR, IPv6 CIDR, and trusted proxy rules', () => {
  assert.equal(ipMatchesRule('192.168.2.20', '192.168.2.0/24'), true);
  assert.equal(ipMatchesRule('192.168.3.20', '192.168.2.0/24'), false);
  assert.equal(ipMatchesRule('2001:db8::4', '2001:db8::/32'), true);
  assert.equal(ipMatchesRule('::ffff:127.0.0.1', '127.0.0.1/32'), true);
  assert.equal(isAdminIpAllowed({
    headers: { 'x-forwarded-for': '198.51.100.10, 10.0.0.1' },
    socket: { remoteAddress: '10.0.0.1' },
  }, { ADMIN_ALLOWED_IPS: '198.51.100.0/24', ADMIN_TRUST_PROXY_HEADERS: 'true' }), true);
  assert.equal(isAdminIpAllowed({
    headers: { 'x-forwarded-for': '198.51.100.10' },
    socket: { remoteAddress: '10.0.0.1' },
  }, { ADMIN_ALLOWED_IPS: '198.51.100.0/24' }), false);
});
