'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createPaydunyaWebhookRoutes } = require('../src/paydunya-webhook-routes.cjs');

function createDb(deposit) {
  const rows = [structuredClone(deposit)];
  return {
    rows,
    collection(name) {
      assert.equal(name, 'momo_deposits');
      return {
        async find_one(query) {
          const row = rows.find(item => Object.entries(query)
            .every(([key, value]) => String(item[key]) === String(value)));
          return row ? structuredClone(row) : null;
        },
      };
    },
  };
}

function request(depositId, token = 'user-session') {
  const req = Readable.from([]);
  req.method = 'POST';
  req.url = `/api/deposits/mobile-money/${encodeURIComponent(depositId)}/finalize`;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  return req;
}

function response() {
  return {
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
}

test('PayDunya finalize rechecks provider status and returns persisted deposit', async () => {
  const db = createDb({
    id: 'deposit-1',
    user_id: 'user-1',
    provider: 'paydunya',
    status: 'pending',
    amount: 2500,
    currency: 'XOF',
    paydunya_token: 'private-token',
  });
  let checks = 0;
  const routes = createPaydunyaWebhookRoutes({
    db,
    sessionService: {
      async authenticate(token) {
        assert.equal(token, 'user-session');
        return { userId: 'user-1' };
      },
    },
    reconcileDeposit: async id => {
      checks += 1;
      assert.equal(id, 'deposit-1');
      db.rows[0].status = 'approved';
    },
  });

  const res = response();
  assert.equal(await routes.handleRoute(request('deposit-1'), res), true);
  assert.equal(res.status, 200);
  assert.equal(res.body.id, 'deposit-1');
  assert.equal(res.body.status, 'approved');
  assert.equal(res.body.paydunya_token, undefined);
  assert.equal(checks, 1);
});

test('mobile money finalize cannot reconcile another user’s deposit', async () => {
  const db = createDb({
    id: 'deposit-1', user_id: 'other-user', provider: 'paydunya', status: 'pending',
  });
  let checks = 0;
  const routes = createPaydunyaWebhookRoutes({
    db,
    sessionService: { async authenticate() { return { userId: 'user-1' }; } },
    reconcileDeposit: async () => { checks += 1; },
  });
  const res = response();
  assert.equal(await routes.handleRoute(request('deposit-1'), res), true);
  assert.equal(res.status, 404);
  assert.equal(checks, 0);
});

test('mobile money finalize requires an authenticated session', async () => {
  const db = createDb({
    id: 'deposit-1', user_id: 'user-1', provider: 'paydunya', status: 'pending',
  });
  const routes = createPaydunyaWebhookRoutes({
    db,
    sessionService: { async authenticate() { throw Object.assign(new Error('No session'), { status: 401 }); } },
    reconcileDeposit: async () => assert.fail('must not reconcile without a session'),
  });
  const res = response();
  assert.equal(await routes.handleRoute(request('deposit-1'), res), true);
  assert.equal(res.status, 401);
});

test('mobile money finalize refuses to settle another provider’s pending payment', async () => {
  const db = createDb({
    id: 'deposit-1', user_id: 'user-1', provider: 'mbiyo', status: 'pending',
  });
  const routes = createPaydunyaWebhookRoutes({
    db,
    sessionService: { async authenticate() { return { userId: 'user-1' }; } },
    reconcileDeposit: async () => assert.fail('must not use PayDunya for a Mbiyo payment'),
  });
  const res = response();
  assert.equal(await routes.handleRoute(request('deposit-1'), res), true);
  assert.equal(res.status, 409);
  assert.equal(db.rows[0].status, 'pending');
});
