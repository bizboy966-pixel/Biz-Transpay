'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAdminFundsRoutes } = require('../src/admin-funds-routes.cjs');
const security = require('../src/security.cjs');

function setup({ enabled = true, fetchImpl } = {}) {
  const secret = 'test-session-secret';
  const key = security.fernetKey(secret);
  const apiKey = 'mbiyo-provider-secret';
  const settings = {
    id: 'payment_provider_mbiyo',
    enabled,
    mode: 'live',
    api_key_encrypted: security.encryptFernet(apiKey, key),
  };
  const logs = [];
  const db = {
    collection(name) {
      if (name === 'settings') {
        return { find_one: async () => structuredClone(settings) };
      }
      if (name === 'users') {
        return {
          find_one: async query => query.id === 'admin-1'
            ? { id: 'admin-1', username: 'admin', role: 'super_admin', two_fa_enabled: true }
            : null,
        };
      }
      if (name === 'admin_logs') {
        return { insert_one: async doc => { logs.push(structuredClone(doc)); } };
      }
      throw new Error(`Unexpected collection ${name}`);
    },
  };
  const sessionService = {
    async authenticate(token) {
      if (token !== 'admin-session') {
        const error = new Error('Non autorisé');
        error.status = 401;
        throw error;
      }
      return { userId: 'admin-1', session: { admin_auth_method: 'totp' } };
    },
    requireRecentAuth() {},
  };
  return {
    apiKey, logs,
    service: createAdminFundsRoutes({
      db, sessionService, env: { SESSION_SECRET: secret },
      fetchImpl: fetchImpl || globalThis.fetch,
    }),
  };
}

async function call(service, query = '', token = 'admin-session') {
  const req = {
    method: 'GET',
    url: `/api/admin/funds${query}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  const res = {
    writeHead(status) { this.statusCode = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  const handled = await service.handleRoute(req, res);
  return { handled, ...res };
}

test('Mbiyo fund balance read is admin-only, filtered, sanitized and provider-backed', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: new URL(url), options });
    const pathname = new URL(url).pathname;
    const payload = pathname.endsWith('/wallets')
      ? { wallets: [{
        id: 'wallet-xof', currency: 'XOF', country_code: 'CI',
        balance: '1000.50', capabilities: { topup: true },
        account_number: 'private-provider-data',
      }] }
      : pathname.endsWith('/balances')
        ? { balances: [
          { currency: 'XOF', balance: '1000.50' },
          { currency: 'XOF', balance: '2' },
        ] }
        : { data: [{
          network: 'orange', operator_name: 'Orange Money',
          country_code: 'CI', currency: 'XOF', balance: '4', wallet_id: 'wallet-xof',
          api_key: 'must-not-leak',
        }] };
    return { ok: true, json: async () => payload };
  };
  const { service, apiKey } = setup({ fetchImpl });
  const response = await call(service, '?currency=xof&country_code=ci');
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.provider, 'mbiyo');
  assert.equal(response.body.mode, 'live');
  assert.equal(response.body.wallets[0].balance, '1000.5');
  assert.deepEqual(response.body.wallet_totals, [{ currency: 'XOF', balance: '1002.5' }]);
  assert.equal(response.body.network_balances[0].operator, 'Orange Money');
  assert.equal(JSON.stringify(response.body).includes(apiKey), false);
  assert.equal(JSON.stringify(response.body).includes('private-provider-data'), false);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(item => item.options.headers.authorization === `Bearer ${apiKey}`));
  assert.ok(requests.every(item => item.url.searchParams.get('currency') === 'XOF'));
  assert.equal(requests[2].url.searchParams.get('country_code'), 'CI');
});

test('disabled and unconfigured Mbiyo balances fail closed without provider requests', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('must not call'); };
  const { service } = setup({ enabled: false, fetchImpl });
  const result = await call(service);
  assert.equal(result.statusCode, 409);
  assert.equal(calls, 0);
});

test('provider errors are sanitized and invalid filters are rejected before fetching', async () => {
  const fetchImpl = async () => ({
    ok: false, status: 500, json: async () => ({ message: 'secret provider response' }),
  });
  const { service } = setup({ fetchImpl });
  const invalid = await call(service, '?currency=not-a-currency');
  assert.equal(invalid.statusCode, 422);
  const unavailable = await call(service);
  assert.equal(unavailable.statusCode, 502);
  assert.equal(JSON.stringify(unavailable.body).includes('secret provider response'), false);
});
