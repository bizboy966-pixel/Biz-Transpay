'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const security = require('../src/security.cjs');
const mbiyo = require('../src/mbiyo-payin.cjs');
const { createPaydunyaInvoiceRoutes } = require('../src/paydunya-invoice-routes.cjs');
const { createMbiyoWebhookRoutes } = require('../src/mbiyo-webhook-routes.cjs');

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

function setupMbiyo({ fetchImpl, response = {
  data: { transaction_id: 'mbiyo-tx-1', status: 'pending', instructions: ['Validez sur votre téléphone'] },
} } = {}) {
  const sessionSecret = 'test-session-secret-that-is-long-enough';
  const key = security.fernetKey(sessionSecret);
  const settings = new Collection([
    {
      id: 'payment_provider_paydunya', enabled: false, modes: {}, catalog: [],
    },
    {
      id: 'payment_provider_mbiyo',
      enabled: true,
      api_key_encrypted: security.encryptFernet('mbiyo-test-api-key', key),
      webhook_secret_encrypted: security.encryptFernet('mbiyo-test-webhook-secret', key),
      catalog: [{
        provider: 'mbiyo',
        country: 'TG',
        code: 'mbiyo_tmoney_tg',
        public_code: 'tmoney',
        operator: 'tmoney',
        network: 'tmoney',
        name: 'T-Money',
        currency: 'XOF',
        active: true,
        visible: true,
        min: 100,
        max: 10000,
        gateway_fee_pct: 0,
        platform_fee_pct: 0,
      }],
    },
    { id: 'payment_provider_afribapay', enabled: false, catalog: [] },
    { id: 'deposit_config', mobile_money: { enabled: true } },
  ]);
  const collections = {
    settings,
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
    env: { NODE_ENV: 'test', OFFICIAL_DOMAIN: 'https://biz-transpay.example' },
    fetchImpl: fetchImpl || (async () => ({ ok: true, status: 200, json: async () => response })),
  });
  return { service, collections, sessionSecret, key };
}

async function callDeposit(service, body = {}, idempotencyKey = 'mbiyo-create-1') {
  const req = Readable.from([Buffer.from(JSON.stringify({
    amount: 1000,
    currency: 'XOF',
    email: 'payer@example.test',
    full_name: 'Awa Example',
    country: 'TG',
    operator: 'tmoney',
    phone_number: '90 00 00 00',
    fee_bearer: 'merchant',
    ...body,
  }))]);
  req.method = 'POST';
  req.url = '/api/deposits/mobile-money/start';
  req.headers = {
    authorization: 'Bearer merchant-session',
    'idempotency-key': idempotencyKey,
  };
  const res = {
    status: 500,
    setHeader() {},
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
  const handled = await service.handleRoute(req, res);
  return { handled, status: res.status, body: res.body };
}

function createWebhookRequest({ url, rawBody, signature, method = 'POST' }) {
  const req = Readable.from([rawBody]);
  req.method = method;
  req.url = url;
  req.rawBody = rawBody;
  req.headers = { 'x-mbiyo-signature': signature };
  const res = {
    headersSent: false,
    setHeader() {},
    end(text) { this.body = text ? JSON.parse(text) : null; this.headersSent = true; },
  };
  return { req, res };
}

test('Mbiyo picks the nested payment status before the API envelope status', () => {
  assert.equal(mbiyo.statusValue({
    status: 'success',
    data: { status: 'processing' },
  }), 'processing');
  assert.equal(mbiyo.statusValue({ data: { transaction_state: 'successfully completed' } }),
    'successfully_completed');
});

test('Mbiyo normalizes country phones and adds the documented five-unit pay-in rounding', () => {
  assert.equal(mbiyo.normalizePhoneNumber('TG', '90 00 00 00'), '+22890000000');
  assert.equal(mbiyo.normalizePhoneNumber('CM', '+237 671 234 567'), '+237671234567');
  assert.throws(() => mbiyo.normalizePhoneNumber('CM', '+2250700000000'), /ne correspond pas/);
  assert.equal(mbiyo.normalizeAmount('TG', 502), 500);
  assert.equal(mbiyo.normalizeAmount('CM', 502), 500);
});

test('Mbiyo pay-in stores the provider reference and replaying the idempotency key does not resubmit', async () => {
  let providerCalls = 0;
  const { service, collections } = setupMbiyo({
    fetchImpl: async (url, options) => {
      providerCalls += 1;
      assert.equal(url, 'https://dashboard.mbiyo.africa/api/v1/merchant/payin');
      assert.equal(options.method, 'POST');
      const sent = JSON.parse(options.body);
      assert.equal(sent.amount, 1000);
      assert.equal(sent.currency, 'XOF');
      assert.equal(sent.order_id, collections.momo_deposits.rows[0].id);
      assert.equal(sent.metadata.phone_number, '+22890000000');
      assert.equal(sent.callback_url,
        `https://biz-transpay.example/api/webhooks/mbiyo?ref=${encodeURIComponent(sent.order_id)}`);
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              transaction_id: 'mbiyo-tx-1',
              status: 'pending',
              instructions: ['Confirmez sur votre téléphone'],
            },
          };
        },
      };
    },
  });

  const first = await callDeposit(service);
  assert.equal(first.handled, true);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'pending');
  assert.equal(first.body.prompt_sent, true);
  assert.equal(first.body.payment_flow.kind, 'phone_confirmation');
  assert.equal(providerCalls, 1);
  assert.equal(collections.momo_deposits.rows[0].provider, 'mbiyo');
  assert.equal(collections.momo_deposits.rows[0].mbiyo_transaction_id, 'mbiyo-tx-1');
  assert.equal(collections.momo_deposits.rows[0].initiation_state, 'ready');

  const replay = await callDeposit(service);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, first.body.id);
  assert.equal(providerCalls, 1);
});

test('an ambiguous Mbiyo response remains pending and cannot be resubmitted with the same key', async () => {
  let providerCalls = 0;
  const { service, collections } = setupMbiyo({
    fetchImpl: async () => {
      providerCalls += 1;
      return { ok: true, status: 200, async json() { return { message: 'accepted' }; } };
    },
  });
  const first = await callDeposit(service);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'pending');
  assert.equal(first.body.submission_unknown, true);
  assert.equal(collections.momo_deposits.rows[0].initiation_state, 'unknown');
  const replay = await callDeposit(service);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.submission_unknown, true);
  assert.equal(providerCalls, 1);
});

test('Mbiyo webhook signature is required and a signed callback only settles after provider status verification', async () => {
  const fixture = setupMbiyo();
  const depositId = 'mbiyo-deposit-1';
  const deposit = {
    id: depositId,
    user_id: 'merchant-1',
    provider: 'mbiyo',
    status: 'pending',
    initiation_state: 'ready',
    mbiyo_order_id: depositId,
    mbiyo_transaction_id: 'mbiyo-tx-1',
    provider_transaction_id: 'mbiyo-tx-1',
    amount: 100,
    charged_amount: 100,
    provider_submitted_amount: 100,
    total_fee: 0,
    gateway_fee: 0,
    platform_fee: 0,
    fee_bearer: 'merchant',
    currency: 'XOF',
    country: 'TG',
    operator: 'tmoney',
    phone_number: '+22890000000',
    created_at: new Date().toISOString(),
    pending_expires_at: new Date(Date.now() + 600_000).toISOString(),
  };
  fixture.collections.momo_deposits.rows.push(deposit);
  let statusCalls = 0;
  const routes = createMbiyoWebhookRoutes({
    db: { collection: name => fixture.collections[name] },
    sessionSecret: fixture.sessionSecret,
    env: {},
    fetchImpl: async url => {
      statusCalls += 1;
      assert.equal(url,
        'https://dashboard.mbiyo.africa/api/v1/merchant/transactions/mbiyo-tx-1');
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              transaction_id: 'mbiyo-tx-1',
              order_id: depositId,
              status: 'processing',
              amount: 100,
              currency: 'XOF',
            },
          };
        },
      };
    },
    logger: { warn() {} },
  });
  const rawBody = Buffer.from(JSON.stringify({ transaction_id: 'mbiyo-tx-1', status: 'success' }));
  const signature = require('node:crypto')
    .createHmac('sha256', 'mbiyo-test-webhook-secret').update(rawBody).digest('hex');
  const signed = createWebhookRequest({
    url: `/api/webhooks/mbiyo?ref=${depositId}`, rawBody, signature,
  });
  assert.equal(await routes.handleRoute(signed.req, signed.res), true);
  assert.equal(signed.res.statusCode, 200);
  assert.equal(statusCalls, 1);
  assert.equal(fixture.collections.momo_deposits.rows[0].status, 'pending');
  assert.equal(fixture.collections.momo_deposits.rows[0].provider_status, 'processing');

  const unsigned = createWebhookRequest({
    url: `/api/webhooks/mbiyo?ref=${depositId}`, rawBody, signature: '',
  });
  assert.equal(await routes.handleRoute(unsigned.req, unsigned.res), true);
  assert.equal(unsigned.res.statusCode, 401);
  assert.equal(statusCalls, 1);
});

test('Mbiyo credits the wallet exactly once only after the status endpoint confirms payment', async () => {
  const fixture = setupMbiyo();
  const depositId = 'mbiyo-settlement-1';
  fixture.collections.momo_deposits.rows.push({
    id: depositId,
    user_id: 'merchant-1',
    provider: 'mbiyo',
    status: 'pending',
    initiation_state: 'ready',
    mbiyo_order_id: depositId,
    mbiyo_transaction_id: 'mbiyo-tx-settle',
    provider_transaction_id: 'mbiyo-tx-settle',
    amount: 100,
    charged_amount: 100,
    provider_submitted_amount: 100,
    wallet_credit_amount: 100,
    total_fee: 0,
    gateway_fee: 0,
    platform_fee: 0,
    fee_bearer: 'merchant',
    currency: 'XOF',
    country: 'TG',
    operator: 'tmoney',
    phone_number: '+22890000000',
    full_name: 'Awa Example',
    email: 'payer@example.test',
    created_at: new Date().toISOString(),
    pending_expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  const tables = {
    users: new Map([['merchant-1', { id: 'merchant-1', balance_xof: 0 }]]),
    wallet_operations: new Map(),
    transactions: new Map(),
  };
  const db = {
    collection: name => fixture.collections[name],
    async transaction(callback) {
      return callback({
        async lockWallets() {},
        async get(name, id) {
          const row = tables[name]?.get(id);
          return row ? structuredClone(row) : null;
        },
        async replace(name, id, row) { tables[name].set(id, structuredClone(row)); },
        async insert(name, id, row) {
          if (tables[name].has(id)) throw new Error('duplicate');
          tables[name].set(id, structuredClone(row));
        },
      });
    },
  };
  let statusCalls = 0;
  const routes = createMbiyoWebhookRoutes({
    db,
    sessionSecret: fixture.sessionSecret,
    env: {},
    fetchImpl: async () => {
      statusCalls += 1;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            data: {
              transaction_id: 'mbiyo-tx-settle',
              order_id: depositId,
              status: 'completed',
              amount: 100,
              currency: 'XOF',
              country_code: 'TG',
            },
          };
        },
      };
    },
    logger: { warn() {} },
  });

  const first = await routes.reconcileDepositById(depositId, { force: true });
  assert.equal(first.status, 'approved');
  assert.equal(tables.users.get('merchant-1').balance_xof, 100);
  assert.equal(tables.transactions.size, 1);
  assert.equal(statusCalls, 1);

  const replay = await routes.reconcileDepositById(depositId, { force: true });
  assert.equal(replay.status, 'approved');
  assert.equal(tables.users.get('merchant-1').balance_xof, 100);
  assert.equal(tables.transactions.size, 1);
  assert.equal(statusCalls, 1);
});

test('Mbiyo post-init OTP is finalized once, then the verified transaction is polled', async () => {
  const fixture = setupMbiyo();
  const depositId = 'mbiyo-otp-1';
  const deposit = {
    id: depositId,
    user_id: 'merchant-1',
    provider: 'mbiyo',
    status: 'pending',
    initiation_state: 'ready',
    mbiyo_order_id: depositId,
    mbiyo_transaction_id: 'mbiyo-tx-otp',
    provider_transaction_id: 'mbiyo-tx-otp',
    amount: 100,
    charged_amount: 100,
    provider_submitted_amount: 100,
    wallet_credit_amount: 100,
    total_fee: 0,
    currency: 'XOF',
    country: 'TG',
    operator: 'tmoney',
    phone_number: '+22890000000',
    fee_bearer: 'merchant',
    otp_required: true,
    auth_mode: 'pin',
    challenge_status: 'required',
    pending_expires_at: new Date(Date.now() + 600_000).toISOString(),
  };
  fixture.collections.momo_deposits.rows.push(deposit);
  const calls = [];
  const routes = createMbiyoWebhookRoutes({
    db: { collection: name => fixture.collections[name] },
    sessionSecret: fixture.sessionSecret,
    env: {},
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() {
          return url.endsWith('/finalize')
            ? { data: { status: 'processing' } }
            : { data: {
              transaction_id: 'mbiyo-tx-otp',
              order_id: depositId,
              status: 'processing',
              amount: 100,
              currency: 'XOF',
            } };
        },
      };
    },
    logger: { warn() {} },
  });

  await routes.finalizeDepositById(deposit, '1234');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url,
    'https://dashboard.mbiyo.africa/api/v1/merchant/transactions/mbiyo-tx-otp/finalize');
  assert.deepEqual(JSON.parse(calls[0].options.body), { otp: '1234' });
  assert.equal(fixture.collections.momo_deposits.rows[0].challenge_status, 'submitted');
  assert.equal(fixture.collections.momo_deposits.rows[0].otp_required, false);
  assert.equal(fixture.collections.momo_deposits.rows[0].provider_status, 'processing');
});
