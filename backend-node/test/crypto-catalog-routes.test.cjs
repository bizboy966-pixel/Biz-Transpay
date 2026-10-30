'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createCryptoCatalogRoutes } = require('../src/crypto-catalog-routes.cjs');
const security = require('../src/security.cjs');
const { matches, project, applyUpdate } = require('../src/document-store.cjs');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query, projectionSpec) {
    const row = this.rows.find(item => matches(item, query));
    return row ? project(row, projectionSpec) : null;
  }
  async update_one(query, update, upsert = false) {
    const index = this.rows.findIndex(item => matches(item, query));
    if (index === -1) {
      if (upsert) this.rows.push(applyUpdate({}, update, true, query));
      return { matched_count: 0 };
    }
    this.rows[index] = applyUpdate(this.rows[index], update, false, query);
    return { matched_count: 1 };
  }
  async insert_one(document) { this.rows.push(structuredClone(document)); }
  async replace_one(query, replacement, upsert = false) {
    const index = this.rows.findIndex(item => matches(item, query));
    if (index === -1) {
      if (upsert) this.rows.push(structuredClone(replacement));
      return { matched_count: 0, upserted_count: upsert ? 1 : 0 };
    }
    this.rows[index] = structuredClone(replacement);
    return { matched_count: 1, modified_count: 1 };
  }
}

function makeResponse() {
  return {
    status: 0,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; },
  };
}

async function call(service, path, { authorization } = {}) {
  const res = makeResponse();
  const handled = await service.handleRoute({
    method: 'GET', url: path, headers: { authorization: authorization || '' },
  }, res);
  return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

function makeSetup({
  settings = [], users = [], env = {}, providerAssets = [], fetchImpl,
} = {}) {
  const collections = {
    settings: new Collection(settings),
    users: new Collection(users),
    admin_logs: new Collection(),
    crypto_deposits: new Collection(),
    wallet_operations: new Collection(),
    transactions: new Collection(),
  };
  let providerCalls = 0;
  const fetcher = fetchImpl || (async (url, options) => {
    providerCalls += 1;
    assert.equal(url, 'https://mock.izipay.test/v1/assets');
    assert.equal(options.headers.authorization, 'Bearer test-api-key');
    return { ok: true, status: 200, text: async () => JSON.stringify(providerAssets) };
  });
  const db = {
    collection: name => collections[name],
    async transaction(callback) {
      const repo = {
        async lockWallets() {},
        async get(collection, id) {
          return collections[collection].find_one({ id: String(id) });
        },
        async replace(collection, id, document) {
          return collections[collection].replace_one({ id: String(id) }, document, true);
        },
        async insert(collection, id, document) {
          assert.equal(String(document.id), String(id));
          return collections[collection].insert_one(document);
        },
      };
      return callback(repo);
    },
  };
  const service = createCryptoCatalogRoutes({
    db,
    sessionService: {
      async authenticate(token) {
        if (token === 'valid-session') return { userId: 'user-1' };
        throw Object.assign(new Error('Session requise'), { status: 401 });
      },
      requireRecentAuth(authenticated) { return authenticated.userId; },
    },
    sessionSecret: 'test-session-secret',
    env: { IZIPAY_BASE_URL: 'https://mock.izipay.test', ...env },
    fetchImpl: fetcher,
  });
  return { service, collections, getProviderCalls: () => providerCalls };
}

async function post(service, path, body, authorization = 'Bearer valid-session') {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.url = path;
  req.headers = { authorization, 'content-type': 'application/json' };
  const res = makeResponse();
  const handled = await service.handleRoute(req, res);
  return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

function providerSettings(secret = 'test-session-secret') {
  const key = security.fernetKey(secret);
  return {
    id: 'payment_provider_izipay',
    api_key_encrypted: security.encryptFernet('test-api-key', key),
    webhook_secret_encrypted: security.encryptFernet('test-webhook-secret', key),
  };
}

test('public crypto catalog uses encrypted provider credentials, live assets, local switches and exact network wallets', async () => {
  const { service, getProviderCalls } = makeSetup({
    settings: [
      providerSettings(),
      {
        id: 'deposit_config',
        crypto: {
          enabled: true,
          disabled_assets: ['USDT.SOL'],
          hidden_coins: ['BTC'],
          fees: { 'USDT.TRC20': 3 },
          fees_gateway: { 'USDT.TRC20': 2 },
          fees_platform: { 'USDT.TRC20': 1 },
          fees_gateway_fixed: { 'USDT.TRC20': 0.1 },
          fees_platform_fixed: { 'USDT.TRC20': 0.05 },
        },
      },
      { id: 'platform_config', crypto_usdt_rates: { USDT: 1, USDC: 0.98 } },
    ],
    providerAssets: [
      { assetCode: 'USDT.TRC20', isActive: true, minimum: 5, maximum: 5000 },
      { assetCode: 'USDT.BEP20', isActive: false, minimum: 1, maximum: 2000 },
      { assetCode: 'USDT.SOL', isActive: true },
      { assetCode: 'USDC.POLYGON', isActive: true, minimum: 2, maximum: 900 },
      { assetCode: 'BTC.BTC', isActive: true },
    ],
  });

  const result = await call(service, '/api/crypto/assets');
  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.map(row => row.catalog_asset_id), ['USDC.POLYGON', 'USDT.TRC20']);
  const usdt = result.body.find(row => row.catalog_asset_id === 'USDT.TRC20');
  assert.equal(usdt.wallet_field, 'balance_crypto_usdt_trc20');
  assert.equal(usdt.minimum, 5);
  assert.equal(usdt.maximum, 5000);
  assert.equal(usdt.fee_pct, 3);
  assert.equal(usdt.gateway_fee_fixed, 0.1);
  assert.equal(usdt.platform_fee_fixed, 0.05);
  assert.equal(JSON.stringify(result.body).includes('test-api-key'), false);
  await call(service, '/api/crypto/assets');
  assert.equal(getProviderCalls(), 1);
});

test('admin crypto asset catalogue is permission checked and does not expose provider credentials', async () => {
  const { service } = makeSetup({
    users: [{ id: 'user-1', username: 'owner', role: 'super_admin', two_fa_enabled: true }],
    settings: [
      providerSettings(),
      { id: 'deposit_config', crypto: { enabled: true, fees: { 'USDT.TRC20': 2 } } },
      { id: 'platform_config', crypto_usdt_rates: { USDT: 1 } },
    ],
    providerAssets: [
      { assetCode: 'USDT.TRC20', isActive: true, minimum: 5, maximum: 5000 },
    ],
  });
  const response = await call(service, '/api/admin/crypto/coins?direction=deposit', {
    authorization: 'Bearer valid-session',
  });
  assert.equal(response.status, 200);
  const usdt = response.body.find(asset => asset.asset_id === 'USDT.TRC20');
  assert.equal(usdt.provider_available, true);
  assert.equal(usdt.provider_active, true);
  assert.equal(usdt.enabled, true);
  assert.equal(usdt.fee_pct, 2);
  assert.equal('api_key' in usdt, false);
});

test('admin crypto asset catalogue rejects invalid directions and unauthenticated requests', async () => {
  const { service } = makeSetup({
    users: [{ id: 'user-1', username: 'owner', role: 'super_admin', two_fa_enabled: true }],
  });
  const invalidDirection = await call(
    service, '/api/admin/crypto/coins?direction=unknown', { authorization: 'Bearer valid-session' },
  );
  assert.equal(invalidDirection.status, 400);
  const unauthenticated = await call(service, '/api/admin/crypto/coins');
  assert.equal(unauthenticated.status, 401);
});

test('conversion crypto wallets require a session and only return active rate-configured assets', async () => {
  const { service } = makeSetup({
    settings: [
      providerSettings(),
      { id: 'deposit_config', crypto: { enabled: true, disabled_assets: [], hidden_coins: [] } },
      { id: 'platform_config', crypto_usdt_rates: { USDT: 1 } },
    ],
    users: [{
      id: 'user-1',
      balance_crypto_usdt_bep20: 3.5,
      balance_crypto_usdt_trc20: 8,
    }],
    providerAssets: [
      { assetCode: 'USDT.BEP20', isActive: true },
      { assetCode: 'USDT.TRC20', isActive: true },
      { assetCode: 'USDC.POLYGON', isActive: true },
    ],
  });

  const denied = await call(service, '/api/conversion/crypto-wallets');
  assert.equal(denied.status, 401);
  const result = await call(service, '/api/conversion/crypto-wallets', {
    authorization: 'Bearer valid-session',
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, [
    {
      id: 'USDT.BEP20', code: 'USDT.BEP20', coin: 'USDT', network: 'BEP20',
      network_name: 'BNB Smart Chain (BEP20)', balance: 3.5, value_usdt: 3.5,
    },
    {
      id: 'USDT.TRC20', code: 'USDT.TRC20', coin: 'USDT', network: 'TRC20',
      network_name: 'Tron (TRC20)', balance: 8, value_usdt: 8,
    },
  ]);
});

test('crypto deposit uses a stable idempotency key and never credits before provider confirmation', async () => {
  const providerCalls = [];
  const { service, collections } = makeSetup({
    settings: [
      providerSettings(),
      {
        id: 'deposit_config',
        crypto: {
          enabled: true,
          fees_gateway: { 'USDT.TRC20': 2 },
          fees_platform: { 'USDT.TRC20': 1 },
          fees_gateway_fixed: { 'USDT.TRC20': 0.1 },
          fees_platform_fixed: { 'USDT.TRC20': 0.05 },
        },
      },
      { id: 'platform_config', crypto_usdt_rates: { USDT: 1 } },
    ],
    providerAssets: [
      { assetCode: 'USDT.TRC20', isActive: true, minimum: 5, maximum: 5000 },
    ],
    fetchImpl: async (url, options = {}) => {
      providerCalls.push({ url, options });
      if (String(url).endsWith('/v1/assets')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([
          { assetCode: 'USDT.TRC20', isActive: true, minimum: 5, maximum: 5000 },
        ]) };
      }
      return {
        ok: true,
        status: 201,
        text: async () => JSON.stringify({
          id: 'provider-intent-1',
          status: 'pending',
          depositAddress: 'TTestDepositAddress',
          amountToSend: '100',
          expiresAt: '2030-01-01T00:00:00Z',
        }),
      };
    },
  });
  const body = {
    amount: 100,
    asset_code: 'USDT.TRC20',
    full_name: 'Test User',
    email: 'test@example.com',
    refund_address: 'TTestRefundAddress',
    idempotency_key: 'crypto-deposit-001',
  };

  const first = await post(service, '/api/deposits/crypto', body);
  assert.equal(first.handled, true);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'pending');
  assert.equal(first.body.deposit_address, 'TTestDepositAddress');
  assert.equal(first.body.wallet_field, 'balance_crypto_usdt_trc20');
  assert.equal(collections.crypto_deposits.rows.length, 1);
  assert.equal(providerCalls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(providerCalls.find(call => call.options.method === 'POST')
    .options.headers['idempotency-key'], `izipay-deposit-${first.body.id}`);

  const replay = await post(service, '/api/deposits/crypto', body);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, first.body.id);
  assert.equal(providerCalls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(Object.hasOwn(collections.users.rows[0] || {}, 'balance_crypto_usdt_trc20'), false);
});

test('crypto deposit rejects unsupported amounts before creating a provider intent', async () => {
  let providerPostCount = 0;
  const { service, collections } = makeSetup({
    settings: [providerSettings()],
    fetchImpl: async () => {
      providerPostCount += 1;
      throw new Error('provider must not be called');
    },
  });
  const result = await post(service, '/api/deposits/crypto', {
    amount: 0,
    asset_code: 'USDT.TRC20',
    full_name: 'Test User',
    email: 'test@example.com',
    refund_address: 'TTestRefundAddress',
    idempotency_key: 'crypto-deposit-002',
  });
  assert.equal(result.status, 400);
  assert.equal(providerPostCount, 0);
  assert.equal(collections.crypto_deposits.rows.length, 0);
});

test('crypto payout reserves the exact network wallet atomically and binds idempotency to the destination', async () => {
  const providerAssets = [{
    assetCode: 'USDT.TRC20',
    coinCode: 'USDT',
    network: 'TRC20',
    isActive: true,
    minimum: 1,
    maximum: 1000,
  }];
  const { service, collections, getProviderCalls } = makeSetup({
    settings: [
      providerSettings(),
      {
        id: 'app_features',
        wallet_crypto_enabled: true,
        withdrawal_crypto_enabled: true,
      },
      {
        id: 'transfer_config',
        crypto: {
          enabled: true,
          fees: { USDT: 2 },
          fees_gateway: { USDT: 2 },
          fees_platform: {},
          fees_gateway_fixed: { USDT: 0.1 },
          fees_platform_fixed: {},
          disabled_assets: [],
          hidden_coins: [],
        },
      },
    ],
    users: [{
      id: 'user-1',
      balance_crypto_usdt_trc20: 20,
      wallet_debit_operation_ids: [],
    }],
    providerAssets,
  });
  const request = {
    amount: 10,
    asset_code: 'USDT.TRC20',
    network_code: 'TRC20',
    wallet_address: 'T123456789123456789123456789123456',
    fee_bearer: 'sender',
    description: 'Payout test',
  };
  const first = await service.createCryptoPayoutRequest(
    'user-1', request, 'btpi_0123456789abcdef0123456789abcdef0123456789abcdef',
  );
  assert.equal(first.status, 'pending');
  assert.equal(first.currency, 'USDT.TRC20');
  assert.equal(first.pending_manual, true);
  assert.equal(first.amount, 10.3);
  assert.equal(first.metadata.wallet_snapshot.balance_before, 20);
  assert.equal(first.metadata.wallet_snapshot.balance_after, 9.7);
  assert.equal(collections.users.rows[0].balance_crypto_usdt_trc20, 9.7);

  const replay = await service.createCryptoPayoutRequest(
    'user-1', request, 'btpi_0123456789abcdef0123456789abcdef0123456789abcdef',
  );
  assert.equal(replay.id, first.id);
  assert.equal(collections.users.rows[0].balance_crypto_usdt_trc20, 9.7);

  await assert.rejects(service.createCryptoPayoutRequest(
    'user-1',
    { ...request, wallet_address: 'T987654321987654321987654321987654' },
    'btpi_0123456789abcdef0123456789abcdef0123456789abcdef',
  ), error => error.status === 409);
  assert.equal(collections.users.rows[0].balance_crypto_usdt_trc20, 9.7);
  assert.equal(collections.transactions.rows.length, 1);
  assert.equal(collections.wallet_operations.rows.length, 1);
  assert.equal(getProviderCalls(), 1);
});

test('conversion quote returns the configured fee, rate, bounds, and received amount', async () => {
  const { service } = makeSetup({
    settings: [{
      id: 'platform_config',
      conversion_rates: { XOF_XAF: 1.1 },
      conversion_limits: { XOF_XAF: { min: 500, max: 5000000 } },
      conversion_fee: { enabled: true, type: 'percent', value: 0.5, min_fee: 0, max_fee: null },
      conversion_pairs_enabled: { XOF_XAF: true, XAF_XOF: false },
    }],
  });
  const result = await call(service, '/api/conversion/quote?from_currency=XOF&to_currency=XAF&amount=1000');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    from_currency: 'XOF', to_currency: 'XAF', amount: 1000,
    fee: 5, rate: 1.1, received: 1094.5, fee_currency: 'XOF',
  });

  const belowMinimum = await call(service, '/api/conversion/quote?from_currency=XOF&to_currency=XAF&amount=100');
  assert.equal(belowMinimum.status, 400);
  assert.match(belowMinimum.body.detail, /minimum/);
  const disabledPair = await call(service, '/api/conversion/quote?from_currency=XAF&to_currency=XOF&amount=1000');
  assert.equal(disabledPair.status, 400);
  assert.equal(disabledPair.body.detail, 'Cette paire de conversion est désactivée');
});

test('crypto quote only uses an active network-specific wallet and blocks legacy unassigned USDT', async () => {
  const { service, getProviderCalls } = makeSetup({
    settings: [
      providerSettings(),
      { id: 'deposit_config', crypto: { enabled: true, disabled_assets: [], hidden_coins: [] } },
      {
        id: 'platform_config',
        conversion_rates: { USDT_XOF: 600 },
        conversion_fee: { enabled: true, type: 'fixed', value: 1, min_fee: 0, max_fee: null },
      },
    ],
    providerAssets: [{ assetCode: 'USDT.TRC20', isActive: true }],
  });
  const quote = await call(service, '/api/conversion/quote?from_currency=USDT.TRC20&to_currency=XOF&amount=10');
  assert.equal(quote.status, 200);
  assert.deepEqual(quote.body, {
    from_currency: 'USDT.TRC20', to_currency: 'XOF',
    amount: 10, fee: 1, rate: 600, received: 5400, fee_currency: 'USDT.TRC20',
  });
  const unassigned = await call(service, '/api/conversion/quote?from_currency=USDT&to_currency=XOF&amount=10');
  assert.equal(unassigned.status, 400);
  assert.match(unassigned.body.detail, /non attribué/);
  assert.equal(getProviderCalls(), 1);
});

test('crypto withdrawal catalog returns only configured active networks with owner balances', async () => {
  const { service } = makeSetup({
    settings: [
      providerSettings(),
      {
        id: 'transfer_config',
        crypto: {
          enabled: true,
          disabled_assets: ['USDT.BEP20'],
          fees: { USDT: 3, 'USDT.TRC20': 2 },
          fees_gateway: { USDT: 2, 'USDT.TRC20': 1 },
          fees_platform: { USDT: 1, 'USDT.TRC20': 1 },
        },
      },
      { id: 'platform_config', crypto_usdt_rates: { USDT: 1 } },
    ],
    users: [{ id: 'user-1', balance_crypto_usdt_trc20: 12 }],
    providerAssets: [
      { assetCode: 'USDT.TRC20', isActive: true, minimum: 2, maximum: 1000 },
      { assetCode: 'USDT.BEP20', isActive: true },
    ],
  });
  const result = await call(service, '/api/crypto/coins', {
    authorization: 'Bearer valid-session',
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 1);
  assert.equal(result.body[0].coin, 'USDT');
  assert.equal(result.body[0].fee_pct, 3);
  assert.equal(result.body[0].networks.length, 1);
  assert.equal(result.body[0].networks[0].wallet_id, 'USDT.TRC20');
  assert.equal(result.body[0].networks[0].balance, 12);
  assert.equal(result.body[0].networks[0].min, 2);
  assert.equal(result.body[0].networks[0].fee_pct, 2);
});

test('crypto catalog fails closed on invalid encrypted provider credentials and unsupported hosts', async () => {
  const badEncrypted = makeSetup({
    settings: [{
      id: 'payment_provider_izipay',
      api_key_encrypted: 'not-a-valid-token',
      webhook_secret_encrypted: 'not-a-valid-token',
    }],
    env: { IZIPAY_API_KEY: 'must-not-fallback', IZIPAY_WEBHOOK_SECRET: 'must-not-fallback' },
  });
  const decryptFailure = await call(badEncrypted.service, '/api/crypto/assets');
  assert.equal(decryptFailure.status, 503);
  assert.deepEqual(decryptFailure.body, {
    detail: 'Les identifiants Easy Change Pay ne peuvent pas être déchiffrés',
  });

  const unsafeHost = makeSetup({
    env: { IZIPAY_BASE_URL: 'http://127.0.0.1:8080' },
  });
  const invalidConfig = await call(unsafeHost.service, '/api/crypto/assets');
  assert.equal(invalidConfig.status, 503);
  assert.equal(unsafeHost.getProviderCalls(), 0);
});
