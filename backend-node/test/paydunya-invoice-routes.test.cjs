'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createPaydunyaInvoiceRoutes } = require('../src/paydunya-invoice-routes.cjs');

function matches(row, query) {
  return Object.entries(query || {}).every(([key, value]) => row[key] === value);
}

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query) {
    const row = this.rows.find(item => matches(item, query));
    return row ? structuredClone(row) : null;
  }
  async insert_one(row) { this.rows.push(structuredClone(row)); }
  async update_one(query, update) {
    const row = this.rows.find(item => matches(item, query));
    if (!row) return { matched_count: 0, modified_count: 0 };
    Object.assign(row, structuredClone(update.$set || {}));
    return { matched_count: 1, modified_count: 1 };
  }
}

function setup({ fetchImpl, modeEnabled = true } = {}) {
  const collections = {
    settings: new Collection([{
      id: 'payment_provider_paydunya',
      enabled: true,
      mode: 'test',
      store_name: 'Biz-transPay',
      modes: {
        psr: { enabled: modeEnabled },
        par_redirect: { enabled: modeEnabled },
      },
      catalog: [{
        provider: 'paydunya', country: 'TG', code: 'tmoney',
        name: 'T-Money', endpoint_slug: 't-money-togo', currency: 'XOF',
        active: true, visible: true, min: 500, max: 10000,
        gateway_fee_pct: 1, platform_fee_pct: 0,
      }],
    }]),
    momo_deposits: new Collection(),
  };
  const service = createPaydunyaInvoiceRoutes({
    db: { collection: name => collections[name] },
    sessionService: {
      async authenticate(token) {
        if (token !== 'merchant-session') {
          throw Object.assign(new Error('Session requise'), { status: 401 });
        }
        return { userId: 'merchant-1' };
      },
    },
    sessionSecret: 'test-session-secret-that-is-long-enough',
    env: {
      OFFICIAL_DOMAIN: 'https://biz-transpay.example',
      PAYDUNYA_MASTER_KEY: 'mock-master',
      PAYDUNYA_PRIVATE_KEY: 'mock-private',
      PAYDUNYA_TOKEN: 'mock-token',
    },
    fetchImpl,
  });
  return { service, collections };
}

async function call(service, path, body, idempotencyKey = 'payment-create-001') {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.url = path;
  req.headers = {
    authorization: 'Bearer merchant-session',
    'idempotency-key': idempotencyKey,
  };
  const res = {
    status: 500,
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
  const handled = await service.handleRoute(req, res);
  return { handled, status: res.status, body: res.body };
}

const depositRequest = {
  amount: 1000,
  currency: 'XOF',
  email: 'payer@example.test',
  full_name: 'Awa Example',
  country: 'TG',
  operator: 'T-Money',
  phone_number: '+22890000000',
  fee_bearer: 'client',
};

test('PayDunya PAR creates a pending local record before the provider request and is idempotent', async () => {
  let providerCalls = 0;
  let collections;
  const { service, collections: dbCollections } = setup({
    fetchImpl: async (url, options) => {
      providerCalls += 1;
      assert.equal(url, 'https://app.paydunya.com/sandbox-api/v1/checkout-invoice/create');
      assert.equal(dbCollections.momo_deposits.rows.length, 1);
      assert.equal(dbCollections.momo_deposits.rows[0].status, 'pending');
      const payload = JSON.parse(options.body);
      assert.equal(payload.invoice.total_amount, 1010);
      assert.equal(payload.custom_data.biztranspay_currency, 'XOF');
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            response_code: '00',
            token: 'provider-invoice-token',
            response_url: 'https://app.paydunya.com/checkout/merchant',
          };
        },
      };
    },
  });
  collections = dbCollections;
  const first = await call(service, '/api/deposits/paydunya/par', depositRequest);
  const retry = await call(service, '/api/deposits/mobile-money/par-redirect', depositRequest);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'pending');
  assert.equal(first.body.charged_amount, 1010);
  assert.equal(retry.body.id, first.body.id);
  assert.equal(providerCalls, 1);
  assert.equal(dbCollections.momo_deposits.rows.length, 1);
  assert.equal(dbCollections.momo_deposits.rows[0].initiation_state, 'ready');
  const conflict = await call(service, '/api/deposits/paydunya/par', {
    ...depositRequest, amount: 1200,
  });
  assert.equal(conflict.status, 409);
  assert.equal(providerCalls, 1);
});

test('PayDunya PSR stores the capability encrypted and returns the same short-lived URL on retry', async () => {
  let providerCalls = 0;
  const { service, collections } = setup({
    fetchImpl: async () => {
      providerCalls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return { response_code: '00', token: 'provider-psr-token' };
        },
      };
    },
  });
  const first = await call(service, '/api/deposits/mobile-money/psr', depositRequest, 'psr-key-001');
  const retry = await call(service, '/api/deposits/paydunya/psr', depositRequest, 'psr-key-001');
  const stored = collections.momo_deposits.rows[0];
  assert.equal(first.status, 200);
  assert.equal(first.body.psr_token_url, retry.body.psr_token_url);
  assert.equal(typeof stored.psr_capability_encrypted, 'string');
  assert.equal(Object.hasOwn(stored, 'psr_token_url'), false);
  assert.equal(stored.psr_capability_used, false);
  assert.equal(providerCalls, 1);
});

test('PayDunya invoice initiation refuses disabled modes and never credits a wallet', async () => {
  let providerCalls = 0;
  const { service, collections } = setup({
    modeEnabled: false,
    fetchImpl: async () => { providerCalls += 1; throw new Error('unexpected'); },
  });
  const result = await call(service, '/api/deposits/paydunya/par', depositRequest);
  assert.equal(result.status, 503);
  assert.equal(providerCalls, 0);
  assert.equal(collections.momo_deposits.rows.length, 0);
});

test('generic Mobile Money start uses the only enabled PayDunya flow', async () => {
  let providerCalls = 0;
  const { service, collections } = setup({
    fetchImpl: async () => {
      providerCalls += 1;
      return {
        ok: true,
        status: 200,
        async json() { return { response_code: '00', token: 'provider-psr-token' }; },
      };
    },
  });
  collections.settings.rows[0].modes = {
    psr: { enabled: true },
    par_redirect: { enabled: false },
  };

  const result = await call(
    service, '/api/deposits/mobile-money/start', depositRequest, 'generic-mobile-money-001',
  );
  assert.equal(result.status, 200);
  assert.equal(collections.momo_deposits.rows[0].provider, 'paydunya');
  assert.equal(collections.momo_deposits.rows[0].status, 'pending');
  assert.equal(providerCalls, 1);
});

test('generic Mobile Money start fails closed when multiple PayDunya flows are enabled', async () => {
  let providerCalls = 0;
  const { service, collections } = setup({
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error('must not choose a payment flow arbitrarily');
    },
  });
  const result = await call(
    service, '/api/deposits/mobile-money', depositRequest, 'generic-mobile-money-002',
  );
  assert.equal(result.status, 503);
  assert.equal(providerCalls, 0);
  assert.equal(collections.momo_deposits.rows.length, 0);
});
