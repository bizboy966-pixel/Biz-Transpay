'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { matches, project } = require('../src/document-store.cjs');
const { createPublicConfigRoutes } = require('../src/public-config-routes.cjs');
const { createIntegrationApiRoutes } = require('../src/integration-api-routes.cjs');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query, projection) {
    const row = this.rows.find(item => matches(item, query));
    return row ? project(row, projection) : null;
  }
  find(query = {}, projection = null) {
    const collection = this;
    return {
      key: null,
      sort(key, direction = 1) { this.key = key; this.direction = direction; return this; },
      to_list: async limit => {
        let rows = collection.rows.filter(item => matches(item, query))
          .map(item => project(item, projection));
        if (this.key) {
          rows.sort((a, b) => (a[this.key] > b[this.key] ? 1 : -1) * this.direction);
        }
        return Number.isFinite(limit) ? rows.slice(0, limit) : rows;
      },
    };
  }
  async update_one(query, update, upsert = false) {
    let row = this.rows.find(item => matches(item, query));
    if (!row && upsert) {
      row = { ...query };
      this.rows.push(row);
    }
    if (!row) return { matched_count: 0, modified_count: 0 };
    Object.assign(row, structuredClone(update.$set || {}));
    for (const [key, amount] of Object.entries(update.$inc || {})) {
      row[key] = Number(row[key] || 0) + Number(amount);
    }
    return { matched_count: 1, modified_count: 1 };
  }
  async replace_one(query, replacement, upsert = false) {
    const index = this.rows.findIndex(item => matches(item, query));
    if (index < 0) {
      if (upsert) this.rows.push(structuredClone(replacement));
      return { matched_count: 0, upserted_count: upsert ? 1 : 0 };
    }
    this.rows[index] = structuredClone(replacement);
    return { matched_count: 1, modified_count: 1 };
  }
}

const publicKey = 'pk_live_demo';
const secretKey = 'sk_live_demo';
const credentialId = 'merchant-1:live';
const secretHash = crypto.createHash('sha256').update(secretKey).digest('hex');
const now = 1_800_000_000_000;

function setup({
  active = true, accountType = 'merchant', blocked = false, enabled = true,
  initialRateCount = 0,
  getCryptoAssets = async direction => [{
    asset_code: direction === 'payout' ? 'USDT.BEP20' : 'USDT.TRC20',
    direction,
  }],
  getMobileMoneyOperators = async direction => ({
    direction, enabled: true, operators: [{ country: 'TG', code: 'tmoney_tg' }],
  }),
  getExchangeQuote = async (fromCurrency, toCurrency, amount) => ({
    from_currency: fromCurrency,
    to_currency: toCurrency,
    amount: Number(amount),
  }),
  scopes = ['transactions:read'],
  environment = 'live',
  executeExchange, createPaymentLink,
} = {}) {
  const selectedPublicKey = environment === 'test' ? 'pk_test_demo' : publicKey;
  const selectedSecretKey = environment === 'test' ? 'sk_test_demo' : secretKey;
  const selectedCredentialId = `merchant-1:${environment}`;
  const selectedSecretHash = crypto.createHash('sha256')
    .update(selectedSecretKey).digest('hex');
  const window = Math.floor(now / 60_000);
  const rateId = crypto.createHash('sha256')
    .update(`${selectedCredentialId}:${window}`).digest('hex');
  const collections = {
    settings: new Collection([{ id: 'app_features', payment_api_enabled: enabled }]),
    integration_credentials: new Collection([{
      id: selectedCredentialId, user_id: 'merchant-1', environment,
      public_key: selectedPublicKey, secret_hash: selectedSecretHash, active,
      scopes, created_at: '2026-01-01T00:00:00.000Z',
    }]),
    users: new Collection([{
      id: 'merchant-1', account_type: accountType, is_banned: blocked, is_blocked: false,
    }]),
    integration_rate_limits: new Collection(initialRateCount ? [{
      id: rateId, count: initialRateCount,
    }] : []),
    integration_operations: new Collection([
      {
        id: 'op-new', kind: 'deposit', user_id: 'merchant-1',
        environment: 'live', business_id: 'deposit-1', created_at: '2026-02-02',
      },
      {
        id: 'op-old', kind: 'payout', user_id: 'merchant-1',
        environment: 'live', business_id: 'payout-1', created_at: '2026-01-01',
      },
      {
        id: 'op-crypto-deposit', kind: 'crypto_deposit', user_id: 'merchant-1',
        environment: 'live', business_id: 'crypto-deposit-1', created_at: '2026-02-03',
      },
      {
        id: 'op-crypto-payout', kind: 'crypto_payout', user_id: 'merchant-1',
        environment: 'live', business_id: 'crypto-payout-1', created_at: '2026-02-04',
      },
      {
        id: 'op-exchange', kind: 'exchange', user_id: 'merchant-1',
        environment: 'live', business_id: 'exchange-1', created_at: '2026-02-01',
      },
      {
        id: 'op-link', kind: 'link', user_id: 'merchant-1',
        environment: 'live', business_id: 'link-1', created_at: '2026-01-15',
      },
      {
        id: 'op-other', kind: 'deposit', user_id: 'merchant-2',
        environment: 'live', created_at: '2026-03-01',
      },
      {
        id: 'op-test', kind: 'deposit', user_id: 'merchant-1',
        environment: 'test', created_at: '2026-03-01',
      },
    ]),
    payment_links: new Collection([
      {
        id: 'link-1', user_id: 'merchant-1', slug: 'public-slug',
        title: 'Merchant link', amount: 2500, currency: 'XOF',
      },
      {
        id: 'link-other', user_id: 'merchant-2', slug: 'other-slug',
        title: 'Another merchant link',
      },
    ]),
    link_payments: new Collection([
      { id: 'payment-1', link_id: 'link-1', status: 'succeeded', created_at: '2026-02-01' },
      { id: 'payment-other', link_id: 'link-other', status: 'succeeded', created_at: '2026-03-01' },
    ]),
    momo_deposits: new Collection([{
      id: 'deposit-1', user_id: 'merchant-1', status: 'succeeded',
      amount: 2500, currency: 'XOF', phone_number: '90000000',
      provider_secret: 'must-not-leak',
    }]),
    crypto_deposits: new Collection([{
      id: 'crypto-deposit-1', user_id: 'merchant-1', status: 'pending',
      amount: 12.5, asset_code: 'USDT.TRC20', deposit_address: 'T-public',
      provider_secret: 'must-not-leak',
    }]),
    transactions: new Collection([
      {
        id: 'payout-1', user_id: 'merchant-1', status: 'succeeded',
        amount: 2000, currency: 'XOF',
      },
      {
        id: 'crypto-payout-1', user_id: 'merchant-1', status: 'pending',
        amount: 12, currency: 'USDT',
        metadata: {
          amount_gross: 12, asset_code: 'USDT.BEP20', wallet_address: '0xwallet',
          manual_review_required: true,
        },
        created_at: '2026-02-05',
      },
    ]),
  };
  const db = { collection: name => collections[name] };
  const service = createIntegrationApiRoutes({
    db, now: () => now, getCryptoAssets, getMobileMoneyOperators, getExchangeQuote,
    executeExchange, createPaymentLink,
  });
  return { service, collections };
}

async function call(service, {
  authorization = `Bearer ${secretKey}`,
  key = publicKey,
  url = '/api/integration/v1/transactions',
  method = 'GET',
  body,
  idempotencyKey,
} = {}) {
  const res = {
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, {
    method, url,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(key ? { 'x-public-key': key } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
  });
  const handled = await service.handleRoute(req, res);
  return { handled, status: res.status, body: res.body };
}

test('integration exchange requires live scope and Idempotency-Key, then records a stable result', async () => {
  const executed = [];
  const transaction = {
    id: 'exchange-tx-1',
    status: 'completed',
    type: 'exchange',
    amount: 1000,
    currency: 'XOF',
    created_at: '2026-05-01T10:00:00.000Z',
  };
  const executeExchange = async (userId, payload) => {
    executed.push({ userId, payload });
    return { handled: true, status: 200, body: transaction };
  };
  const { service, collections } = setup({
    scopes: ['transactions:read', 'exchanges:write'],
    executeExchange,
  });
  const request = {
    method: 'POST',
    url: '/api/integration/v1/exchanges',
    idempotencyKey: 'exchange-request-001',
    body: { from_currency: 'XOF', to_currency: 'XAF', amount: 1000 },
  };
  const first = await call(service, request);
  const retry = await call(service, request);
  assert.equal(first.status, 200);
  assert.equal(first.body.id, transaction.id);
  assert.deepEqual(retry.body, first.body);
  assert.equal(executed.length, 2);
  assert.equal(executed[0].userId, 'merchant-1');
  assert.equal(executed[0].payload.idempotency_key, request.idempotencyKey);
  const records = collections.integration_operations.rows.filter(
    row => row.kind === 'exchange' && row.business_id === transaction.id,
  );
  assert.equal(records.length, 1);

  const noKey = await call(service, { ...request, idempotencyKey: undefined });
  assert.equal(noKey.status, 422);
  assert.equal(executed.length, 2);
  const noScope = setup({ executeExchange });
  assert.equal((await call(noScope.service, request)).status, 403);
  assert.equal(executed.length, 2);
  const testEnvironment = setup({
    environment: 'test',
    scopes: ['transactions:read', 'exchanges:write'],
    executeExchange,
  });
  assert.equal((await call(testEnvironment.service, {
    ...request,
    authorization: 'Bearer sk_test_demo',
    key: 'pk_test_demo',
  })).status, 403);
  assert.equal(executed.length, 2);
});

test('integration payment-link creation requires scope and persists an owner-scoped result', async () => {
  const calls = [];
  const link = {
    id: 'api-link-1', user_id: 'merchant-1', slug: 'public-slug',
    title: 'Order', amount: 750, currency: 'XOF',
    created_at: '2026-05-01T10:00:00.000Z',
  };
  const createPaymentLink = async (userId, body, idempotencyKey) => {
    calls.push({ userId, body, idempotencyKey });
    return { handled: true, status: 200, body: link };
  };
  const { service, collections } = setup({
    scopes: ['transactions:read', 'links:write'],
    createPaymentLink,
  });
  const request = {
    method: 'POST',
    url: '/api/integration/v1/links',
    idempotencyKey: 'link-create-001',
    body: { title: 'Order', amount: 750, currency: 'XOF' },
  };
  const created = await call(service, request);
  const retry = await call(service, request);
  assert.equal(created.status, 200);
  assert.equal(created.body.status, 'created');
  assert.equal(created.body.link.id, link.id);
  assert.deepEqual(retry.body, created.body);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].userId, 'merchant-1');
  assert.equal(calls[0].idempotencyKey, request.idempotencyKey);
  assert.equal(
    collections.integration_operations.rows.filter(
      row => row.kind === 'link' && row.business_id === link.id,
    ).length,
    1,
  );

  const noScope = setup({ createPaymentLink });
  assert.equal((await call(noScope.service, request)).status, 403);
  assert.equal(calls.length, 2);
});

test('integration transaction list authenticates paired keys, scopes by owner and records use', async () => {
  const { service, collections } = setup();
  const result = await call(service, { url: '/api/integration/v1/transactions?limit=1' });
  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.map(item => item.id), ['op-new']);
  assert.ok(collections.integration_credentials.rows[0].last_used_at);
  assert.equal(collections.integration_rate_limits.rows[0].count, 1);
  assert.equal(JSON.stringify(result.body).includes(secretHash), false);
});

test('integration transaction list rejects missing, mismatched, inactive and non-merchant credentials', async () => {
  assert.equal((await call(setup().service, { authorization: '' })).status, 401);
  assert.equal((await call(setup().service, {
    authorization: 'Bearer sk_test_wrong',
  })).status, 401);
  assert.equal((await call(setup({ active: false }).service)).status, 403);
  assert.equal((await call(setup({ accountType: 'personal' }).service)).status, 403);
  assert.equal((await call(setup({ blocked: true }).service)).status, 403);
  assert.equal((await call(setup({ enabled: false }).service)).status, 403);
});

test('integration transaction list validates limits and enforces the per-key minute limit', async () => {
  const service = setup().service;
  assert.equal((await call(service, {
    url: '/api/integration/v1/transactions?limit=501',
  })).status, 422);
  const limited = await call(setup({ initialRateCount: 120 }).service);
  assert.equal(limited.status, 429);
});

test('integration operation lists return only the requested kind, user and environment', async () => {
  const service = setup().service;
  for (const [path, expectedId] of [
    ['/api/integration/v1/deposits', 'op-new'],
    ['/api/integration/v1/payouts', 'op-old'],
    ['/api/integration/v1/crypto/deposits', 'op-crypto-deposit'],
    ['/api/integration/v1/crypto/payouts', 'op-crypto-payout'],
    ['/api/integration/v1/exchanges', 'op-exchange'],
    ['/api/integration/v1/links', 'op-link'],
  ]) {
    const result = await call(service, { url: `${path}?limit=10` });
    assert.equal(result.status, 200, path);
    assert.deepEqual(result.body.map(operation => operation.id), [expectedId], path);
  }
});

test('integration crypto asset catalogue validates direction and delegates by owner', async () => {
  const calls = [];
  const service = setup({
    getCryptoAssets: async (direction, userId) => {
      calls.push({ direction, userId });
      return [{ asset_code: direction === 'payout' ? 'USDT.BEP20' : 'USDT.TRC20' }];
    },
  }).service;
  const deposits = await call(service, {
    url: '/api/integration/v1/crypto/assets',
  });
  assert.equal(deposits.status, 200);
  assert.equal(deposits.body[0].asset_code, 'USDT.TRC20');

  const payouts = await call(service, {
    url: '/api/integration/v1/crypto/assets?direction=payout',
  });
  assert.equal(payouts.status, 200);
  assert.equal(payouts.body[0].asset_code, 'USDT.BEP20');
  assert.deepEqual(calls, [
    { direction: 'deposit', userId: 'merchant-1' },
    { direction: 'payout', userId: 'merchant-1' },
  ]);
  assert.equal((await call(service, {
    url: '/api/integration/v1/crypto/assets?direction=exchange',
  })).status, 422);
});

test('integration Mobile Money catalogue validates direction and delegates by owner', async () => {
  const calls = [];
  const service = setup({
    getMobileMoneyOperators: async (direction, userId) => {
      calls.push({ direction, userId });
      return {
        direction, enabled: true,
        operators: [{ country: 'TG', code: direction === 'payout' ? 'tmoney-out' : 'tmoney-in' }],
        availability_source: 'serving_environment_configuration',
      };
    },
  }).service;
  const deposit = await call(service, {
    url: '/api/integration/v1/mobile-money/operators',
  });
  assert.equal(deposit.status, 200);
  assert.equal(deposit.body.operators[0].code, 'tmoney-in');

  const payout = await call(service, {
    url: '/api/integration/v1/mobile-money/operators?direction=payout',
  });
  assert.equal(payout.status, 200);
  assert.equal(payout.body.operators[0].code, 'tmoney-out');
  assert.deepEqual(calls, [
    { direction: 'deposit', userId: 'merchant-1' },
    { direction: 'payout', userId: 'merchant-1' },
  ]);
  assert.equal((await call(service, {
    url: '/api/integration/v1/mobile-money/operators?direction=withdrawal',
  })).status, 422);
});

test('public deposit Mobile Money catalogue adapter returns only available public fields', async () => {
  const settings = new Collection([]);
  const routes = createPublicConfigRoutes({
    db: { collection: name => name === 'settings' ? settings : new Collection([]) },
    env: {},
  });
  const result = await routes.integrationMobileMoneyOperators('deposit');
  assert.deepEqual(result, {
    direction: 'deposit',
    enabled: false,
    operators: [],
    availability_source: 'serving_environment_configuration',
  });
  await assert.rejects(
    routes.integrationMobileMoneyOperators('other'),
    error => error.status === 422,
  );
});

test('integration exchange quote delegates validation and preserves the public quote', async () => {
  const calls = [];
  const service = setup({
    getExchangeQuote: async (fromCurrency, toCurrency, amount) => {
      calls.push({ fromCurrency, toCurrency, amount });
      return { from_currency: fromCurrency, to_currency: toCurrency, amount };
    },
  }).service;
  const result = await call(service, {
    url: '/api/integration/v1/exchanges/quote?from_currency=XOF&to_currency=XAF&amount=2500',
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    from_currency: 'XOF', to_currency: 'XAF', amount: '2500',
  });
  assert.deepEqual(calls, [{ fromCurrency: 'XOF', toCurrency: 'XAF', amount: '2500' }]);
});

test('integration exchange and payment-link details are owner-scoped', async () => {
  const service = setup().service;
  const exchange = await call(service, {
    url: '/api/integration/v1/exchanges/exchange-1',
  });
  assert.equal(exchange.status, 200);
  assert.equal(exchange.body.business_id, 'exchange-1');

  const link = await call(service, { url: '/api/integration/v1/links/link-1' });
  assert.equal(link.status, 200);
  assert.equal(link.body.title, 'Merchant link');

  const payments = await call(service, {
    url: '/api/integration/v1/links/link-1/payments',
  });
  assert.equal(payments.status, 200);
  assert.deepEqual(payments.body.map(payment => payment.id), ['payment-1']);

  assert.equal((await call(service, {
    url: '/api/integration/v1/exchanges/not-owned',
  })).status, 404);
  assert.equal((await call(service, {
    url: '/api/integration/v1/links/link-other',
  })).status, 404);
});

test('integration deposit and payout details are owner-scoped and omit provider secrets', async () => {
  const service = setup().service;
  const deposit = await call(service, { url: '/api/integration/v1/deposits/deposit-1' });
  assert.equal(deposit.status, 200);
  assert.equal(deposit.body.phone_number, '90000000');
  assert.equal(Object.hasOwn(deposit.body, 'provider_secret'), false);

  const payout = await call(service, { url: '/api/integration/v1/payouts/payout-1' });
  assert.equal(payout.status, 200);
  assert.equal(payout.body.id, 'payout-1');

  const cryptoDeposit = await call(service, {
    url: '/api/integration/v1/crypto/deposits/crypto-deposit-1',
  });
  assert.equal(cryptoDeposit.status, 200);
  assert.equal(cryptoDeposit.body.asset_code, 'USDT.TRC20');
  assert.equal(cryptoDeposit.body.pending_manual, false);
  assert.equal(Object.hasOwn(cryptoDeposit.body, 'provider_secret'), false);

  const cryptoPayout = await call(service, {
    url: '/api/integration/v1/crypto/payouts/crypto-payout-1',
  });
  assert.equal(cryptoPayout.status, 200);
  assert.equal(cryptoPayout.body.asset_code, 'USDT.BEP20');
  assert.equal(cryptoPayout.body.wallet_address, '0xwallet');
  assert.equal(cryptoPayout.body.pending_manual, true);

  assert.equal((await call(service, {
    url: '/api/integration/v1/deposits/not-owned',
  })).status, 404);
});

test('integration API handler leaves unrelated routes untouched', async () => {
  const result = await call(setup().service, { url: '/api/integration/v1/not-a-route' });
  assert.equal(result.handled, false);
});
