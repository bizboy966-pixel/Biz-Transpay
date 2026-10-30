'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const security = require('../src/security.cjs');
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

function setupAfriBaPay({ fetchImpl } = {}) {
  const sessionSecret = 'test-session-secret-that-is-long-enough';
  const encryptionKey = security.fernetKey(sessionSecret);
  const collections = {
    settings: new Collection([
      {
        id: 'payment_provider_paydunya',
        enabled: false,
        catalog: [],
        modes: {},
      },
      {
        id: 'payment_provider_afribapay',
        enabled: true,
        mode: 'sandbox',
        api_user_encrypted: security.encryptFernet('mock-api-user', encryptionKey),
        api_key_encrypted: security.encryptFernet('mock-api-key', encryptionKey),
        merchant_key_encrypted: security.encryptFernet('mock-merchant-key', encryptionKey),
        agent_id_encrypted: security.encryptFernet('must-never-be-sent', encryptionKey),
        catalog: [{
          provider: 'afribapay',
          country: 'CM',
          code: 'afribapay_orange_cm',
          public_code: 'orange',
          operator: 'orange_cm',
          name: 'Orange Money Cameroun',
          currency: 'XAF',
          active: true,
          min: 100,
          max: 0,
          gateway_fee_pct: 1,
        }],
      },
      {
        id: 'deposit_config',
        mobile_money: { enabled: true },
      },
    ]),
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
    sessionSecret,
    env: { OFFICIAL_DOMAIN: 'https://biz-transpay.example' },
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
  const paydunyaAlias = await call(service, '/api/deposits/paydunya/par-redirect', depositRequest);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'pending');
  assert.equal(first.body.charged_amount, 1010);
  assert.equal(retry.body.id, first.body.id);
  assert.equal(paydunyaAlias.handled, true);
  assert.equal(paydunyaAlias.status, 200);
  assert.equal(paydunyaAlias.body.id, first.body.id);
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
  assert.equal(result.body.detail, 'Ce mode de paiement Mobile Money est désactivé.');
  assert.equal(providerCalls, 0);
  assert.equal(collections.momo_deposits.rows.length, 0);
});

test('PayDunya returns sanitized actionable provider errors instead of a generic deposit failure', async () => {
  const { service } = setup({
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      async json() { return { message: 'sensitive upstream payload' }; },
    }),
  });
  const result = await call(service, '/api/deposits/paydunya/par', depositRequest);

  assert.equal(result.status, 502);
  assert.equal(result.body.detail, 'PayDunya a refusé la création de facture.');
  assert.doesNotMatch(JSON.stringify(result.body), /sensitive upstream payload/);
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

test('generic Mobile Money selects ready AfriBaPay when overlapping routes are unavailable', async () => {
  const requests = [];
  const { service, collections } = setupAfriBaPay({
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/v1/token')) {
        assert.equal(options.method, 'POST');
        assert.equal(
          options.headers.authorization,
          `Basic ${Buffer.from('mock-api-user:mock-api-key').toString('base64')}`,
        );
        return {
          ok: true,
          async json() { return { data: { access_token: 'mock-afri-token' } }; },
        };
      }
      assert.equal(String(url).endsWith('/v1/pay/payin'), true);
      assert.equal(options.headers.authorization, 'Bearer mock-afri-token');
      const submitted = JSON.parse(options.body);
      assert.deepEqual(submitted, {
        operator: 'orange_cm',
        phone_number: '237670123456',
        country: 'CM',
        amount: 505,
        currency: 'XAF',
        order_id: submitted.order_id,
        reference_id: 'afri-cm-orange-001',
        notify_url: `https://biz-transpay.example/api/webhooks/afribapay?ref=${submitted.order_id}`,
        lang: 'fr',
        merchant_key: 'mock-merchant-key',
      });
      assert.doesNotMatch(options.body, /must-never-be-sent/);
      return {
        ok: true,
        status: 200,
        async json() {
          return { data: { transaction_id: 'afri-tx-1', status: 'pending' } };
        },
      };
    },
  });
  const paydunya = collections.settings.rows.find(
    row => row.id === 'payment_provider_paydunya',
  );
  Object.assign(paydunya, {
    enabled: true,
    modes: { psr: true, par_redirect: true },
    catalog: [{
      provider: 'paydunya',
      country: 'CM',
      code: 'orange',
      name: 'Orange Cameroun',
      currency: 'XAF',
      active: true,
      visible: true,
    }],
  });
  collections.settings.rows.push({
    id: 'payment_provider_mbiyo',
    enabled: true,
    secret_key_encrypted: 'configured',
    catalog: [{
      provider: 'mbiyo',
      country: 'CM',
      code: 'orange',
      name: 'Orange Money Cameroun',
      currency: 'XAF',
      active: true,
    }],
  });
  const request = {
    amount: 500,
    currency: 'XAF',
    email: 'customer@example.com',
    full_name: 'Test Customer',
    country: 'CM',
    operator: 'orange',
    phone_number: '237670123456',
    fee_bearer: 'client',
    idempotency_key: 'afri-cm-orange-001',
  };

  const first = await call(
    service, '/api/deposits/mobile-money/start', request, 'afri-cm-orange-001',
  );
  const retry = await call(
    service, '/api/deposits/mobile-money/start', request, 'afri-cm-orange-001',
  );
  const stored = collections.momo_deposits.rows[0];

  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'pending');
  assert.equal(first.body.payment_kind, 'phone');
  assert.equal(first.body.charged_amount, 505);
  assert.equal(retry.body.id, first.body.id);
  assert.equal(stored.provider, 'afribapay');
  assert.equal(stored.afribapay_order_id, stored.id);
  assert.equal(stored.provider_submitted_amount, 505);
  assert.equal(stored.afribapay_transaction_id, 'afri-tx-1');
  assert.equal(stored.initiation_state, 'ready');
  assert.equal(stored.status, 'pending');
  assert.equal(requests.length, 2);
  assert.equal(JSON.stringify(requests).includes('must-never-be-sent'), false);
});

test('AfriBaPay network uncertainty stays pending and idempotency prevents a duplicate pay-in', async () => {
  let providerCalls = 0;
  const { service, collections } = setupAfriBaPay({
    fetchImpl: async url => {
      providerCalls += 1;
      if (String(url).endsWith('/v1/token')) {
        return { ok: true, async json() { return { data: { access_token: 'mock-afri-token' } }; } };
      }
      throw new Error('network timeout after submission');
    },
  });
  const request = {
    amount: 500,
    currency: 'XAF',
    email: 'customer@example.com',
    full_name: 'Test Customer',
    country: 'CM',
    operator: 'orange',
    phone_number: '237670123456',
    fee_bearer: 'client',
    idempotency_key: 'afri-timeout-001',
  };

  const first = await call(
    service, '/api/deposits/mobile-money/start', request, 'afri-timeout-001',
  );
  const retry = await call(
    service, '/api/deposits/mobile-money/start', request, 'afri-timeout-001',
  );

  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'pending');
  assert.equal(first.body.submission_unknown, true);
  assert.equal(collections.momo_deposits.rows[0].status, 'pending');
  assert.equal(collections.momo_deposits.rows[0].initiation_state, 'unknown');
  assert.equal(retry.status, 409);
  assert.equal(providerCalls, 2);
});

test('Wizall link finalization sends OTP only to PayDunya and returns sanitized instructions', async () => {
  let request;
  const { service } = setup({
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true, status: 200,
        async json() {
          return { response_code: '00', data: {
            transaction_id: 'provider-ref-2',
            instructions: ['Confirmez sur votre téléphone', '<script>alert(1)</script>'],
          } };
        },
      };
    },
  });
  const result = await service.finalizeLinkMobileMoney({
    id: 'deposit-link-1',
    provider: 'paydunya',
    endpoint_slug: 'wizall-money-senegal',
    paydunya_reference: 'provider-ref-1',
    phone_number: '+221770000000',
  }, '123456');
  assert.equal(request.url, 'https://app.paydunya.com/sandbox-api/api/v1/softpay/wizall-money-senegal/confirm');
  assert.deepEqual(JSON.parse(request.options.body), {
    authorization_code: '123456',
    phone_number: '+221770000000',
    transaction_id: 'provider-ref-1',
  });
  assert.equal(result.provider_reference, 'provider-ref-2');
  assert.deepEqual(result.instructions, ['Confirmez sur votre téléphone', 'alert(1)']);
  assert.equal(request.options.headers['PAYDUNYA-TOKEN'], 'mock-token');
});
