'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { matches, project } = require('../src/document-store.cjs');
const {
  aggregateAdminHome,
  aggregateCustomerWallets,
  createAdminStatisticsRoutes,
} = require('../src/admin-statistics-routes.cjs');

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
      direction: 1,
      sort(key, direction = 1) { this.key = key; this.direction = direction; return this; },
      to_list: async limit => {
        let rows = collection.rows.filter(row => matches(row, query))
          .map(row => project(row, projection));
        if (this.key) rows.sort((a, b) => (a[this.key] > b[this.key] ? 1 : -1) * this.direction);
        if (Number.isFinite(limit)) rows = rows.slice(0, limit);
        return rows;
      },
    };
  }
  async insert_one(row) { this.rows.push(structuredClone(row)); }
}

function setup({ users = [], transactions = [], momo = [], crypto = [], settings = [] } = {}) {
  const collections = {
    users: new Collection(users),
    transactions: new Collection(transactions),
    momo_deposits: new Collection(momo),
    crypto_deposits: new Collection(crypto),
    settings: new Collection(settings),
    admin_logs: new Collection(),
  };
  const service = createAdminStatisticsRoutes({
    db: { collection: name => collections[name] },
    sessionService: {
      async authenticate(token) {
        if (token === 'admin-session') return { userId: 'admin-1' };
        throw Object.assign(new Error('Session requise'), { status: 401 });
      },
    },
  });
  return { service, collections };
}

function response() {
  return {
    status: 0,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
}

async function call(service, url, authorization = 'Bearer admin-session') {
  const res = response();
  const handled = await service.handleRoute({
    method: 'GET', url, headers: { authorization }, socket: { remoteAddress: '127.0.0.1' },
  }, res);
  return { handled, status: res.status, body: res.body };
}

function currentMonthDate(day = 10) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day)).toISOString();
}

const admin = { id: 'admin-1', role: 'super_admin', two_fa_enabled: true };

test('admin benefits aggregate only recorded platform margins and detail filters are owner-enriched', async () => {
  const createdAt = new Date().toISOString();
  const { service } = setup({
    users: [admin, { id: 'user-1', full_name: 'Awa Diallo', email: 'awa@example.test' }],
    transactions: [
      {
        id: 'deposit-margin', user_id: 'user-1', type: 'deposit',
        status: 'completed', amount: 1000, currency: 'XOF', created_at: createdAt,
        reference: 'BTP-001', description: 'Dépôt', metadata: { platform_fee: 10 },
      },
      {
        id: 'withdrawal-margin', user_id: 'user-1', type: 'withdrawal',
        status: 'completed', amount: 200, currency: 'XOF', created_at: createdAt,
        metadata: { platform_fee: 50 },
      },
      {
        id: 'api-crypto-margin', user_id: 'user-1', type: 'payment',
        status: 'paid', amount: 2, currency: 'USDT', created_at: createdAt,
        metadata: { platform_fee: 0.5 },
      },
      {
        id: 'failed-margin', user_id: 'user-1', type: 'deposit',
        status: 'failed', amount: 50, currency: 'XOF', created_at: createdAt,
        metadata: { platform_fee: 99 },
      },
    ],
  });
  const summary = await call(service, '/api/admin/benefits?period=all');
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.body.xof, { total: 10, count: 1 });
  assert.deepEqual(summary.body.usdt, { total: 0.5, count: 1 });

  const details = await call(
    service, '/api/admin/benefits/details?period=all&currency=XOF&q=awa',
  );
  assert.equal(details.status, 200);
  assert.equal(details.body.total, 1);
  assert.equal(details.body.items[0].tx_id, 'deposit-margin');
  assert.equal(details.body.items[0].platform_fee, 10);
  assert.equal(details.body.items[0].user.name, 'Awa Diallo');

  const withdrawals = await call(
    service, '/api/admin/benefits/details?period=all&type=withdrawal',
  );
  assert.equal(withdrawals.body.total, 0);
});

test('monthly dashboard distinguishes API payments and keeps revenue limited to recorded margins', async () => {
  const createdAt = currentMonthDate();
  const { service } = setup({
    users: [admin, { id: 'user-1', country_code: 'TG', country_name: 'Togo' }],
    transactions: [
      {
        id: 'deposit-1', user_id: 'user-1', type: 'deposit', status: 'completed',
        amount: 1000, currency: 'XOF', created_at: createdAt,
        metadata: { platform_fee: 2 },
      },
      {
        id: 'paydunya-deposit-api-1', user_id: 'user-1', type: 'deposit',
        status: 'completed', amount: 500, currency: 'XOF', created_at: createdAt,
        metadata: { platform_fee: 1 },
      },
      {
        id: 'link-1', user_id: 'user-1', type: 'deposit', status: 'completed',
        amount: 10, currency: 'USDT', created_at: createdAt,
        metadata: { source: 'payment_link', link_id: 'l-1', platform_fee: 0.1 },
      },
      {
        id: 'exchange-1', user_id: 'user-1', type: 'exchange', status: 'paid',
        amount: 1000, currency: 'XOF', created_at: createdAt,
        metadata: { to_currency: 'XOF', received: 990, platform_fee: 0.05 },
      },
      {
        id: 'payout-1', user_id: 'user-1', type: 'withdrawal', status: 'completed',
        amount: 100, currency: 'XOF', created_at: createdAt,
        metadata: { platform_fee: 99 },
      },
    ],
    momo: [{
      id: 'api-1', provider: 'paydunya', source: 'api',
      idempotency_key: 'btpi_example', created_at: createdAt,
    }],
    settings: [{
      id: 'platform_config',
      conversion_rates: { USDT_XOF: 600, XAF_XOF: 0.0017 },
      crypto_usdt_rates: { USDT: 1 },
    }],
  });
  const result = await call(service, '/api/admin/statistics/dashboard');
  assert.equal(result.status, 200);
  assert.equal(result.body.top_countries[0].country, 'Togo');
  assert.equal(result.body.top_countries[0].transaction_count, 5);
  assert.equal(result.body.top_countries[0].volume_xof, 8590);
  assert.equal(result.body.margins.categories.deposit_mobile_money.count, 1);
  assert.equal(result.body.margins.categories.api_payment_mobile_money.count, 1);
  assert.equal(result.body.margins.categories.link_payment_crypto.count, 1);
  assert.equal(result.body.margins.categories.conversion.count, 1);
  assert.equal(result.body.margins.total_by_currency.find(row => row.currency === 'XOF').amount, 3.05);
  assert.equal(result.body.margins.categories.transfer_mobile_money.count, 0);
});

test('period statistics return bounded activity, successful volumes, and country summaries', async () => {
  const createdAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { service } = setup({
    users: [admin, { id: 'user-1', country_code: 'TG', country_name: 'Togo' }],
    transactions: [
      {
        id: 'deposit-period', user_id: 'user-1', type: 'deposit',
        status: 'completed', amount: 1250, currency: 'XOF', created_at: createdAt,
      },
      {
        id: 'exchange-period', user_id: 'user-1', type: 'exchange',
        status: 'completed', amount: 10, currency: 'USDT', created_at: createdAt,
      },
      {
        id: 'payout-period', user_id: 'user-1', type: 'transfer', direction: 'out',
        status: 'pending', amount: 700, currency: 'XOF', created_at: createdAt,
        metadata: { transfer_type: 'biz_to_mobile' },
      },
    ],
  });
  const result = await call(service, '/api/admin/statistics?period=7d');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.period, '7d');
  assert.equal(result.body.summary.transaction_count, 3);
  assert.equal(result.body.summary.operations.deposits.count, 1);
  assert.equal(result.body.summary.operations.withdrawals.count, 1);
  assert.equal(result.body.summary.operations.exchanges.count, 1);
  assert.equal(result.body.summary.volume_by_currency.find(row => row.currency === 'XOF').total, 1250);
  assert.equal(result.body.summary.volume_by_currency.find(row => row.currency === 'USDT').total, 10);
  assert.equal(result.body.countries[0].country_code, 'TG');
  assert.equal(result.body.countries[0].transaction_count, 3);
  assert.ok(result.body.timeline.length > 0);
  assert.deepEqual(result.body.provider_liquidity, []);

  const invalid = await call(service, '/api/admin/statistics?period=all');
  assert.equal(invalid.status, 400);
});

test('wallet balances aggregate every configured user wallet and report missing rates', async () => {
  const { service } = setup({
    users: [
      admin,
      {
        id: 'user-1',
        balance_xof: 1000,
        balance_xaf: 100000,
        balance_usdt: 3,
        balance_crypto_usdt_trc20: 2,
        balance_crypto_btc_btc: 0.01,
      },
    ],
    settings: [{
      id: 'platform_config',
      conversion_rates: { USDT_XOF: 600, XAF_XOF: 0.0017 },
      crypto_usdt_rates: { USDT: 1, BTC: 40000 },
    }],
  });
  const result = await call(service, '/api/admin/statistics/wallet-balances');
  assert.equal(result.status, 200);
  assert.ok(Math.abs(result.body.total_xof_equivalent - 244170) < 0.0001);
  assert.equal(result.body.conversion_complete, true);
  assert.equal(result.body.refresh_seconds, 60);
  assert.ok(result.body.wallets.some(row => row.currency === 'BTC.BTC' && row.balance === 0.01));
});

test('statistics endpoints require an authenticated administrator', async () => {
  const { service } = setup();
  const result = await call(service, '/api/admin/statistics/dashboard', '');
  assert.equal(result.status, 401);
});

test('MySQL wallet totals use one bounded aggregate query instead of loading every account', async () => {
  let query = '';
  const collection = {
    store: {
      pool: {
        async execute(sql) {
          query = sql;
          return [[{ balance_xof: '123.45', balance_usdt: '2' }]];
        },
      },
    },
  };
  const totals = await aggregateCustomerWallets(collection);
  assert.equal(totals.balance_xof, '123.45');
  assert.equal(totals.balance_usdt, '2');
  assert.match(query, /SUM\(CASE WHEN/);
  assert.match(query, /JSON_EXTRACT\(raw_document/);
  assert.match(query, /FROM `users`/);
});

test('admin home summary preserves channel and KYC counters', async () => {
  const summary = aggregateAdminHome([
    { id: 'u1', kyc_status: 'verified' },
    { id: 'u2', kyc_status: 'pending', is_blocked: true },
  ], [
    {
      id: 'd1', user_id: 'u1', type: 'deposit', direction: 'in',
      status: 'completed', amount: 500, currency: 'XOF',
      metadata: {},
    },
    {
      id: 'd2', user_id: 'u2', type: 'deposit', direction: 'in',
      status: 'pending', amount: 100, currency: 'USDT',
      metadata: { coin: 'USDT' },
    },
    {
      id: 'w1', user_id: 'u1', type: 'withdrawal', direction: 'out',
      status: 'failed', amount: 25, currency: 'XOF',
      metadata: {},
    },
    {
      id: 'x1', user_id: 'u1', type: 'exchange', status: 'completed',
      amount: 100, currency: 'XOF', metadata: {},
    },
  ], 'week');
  assert.equal(summary.period, 'week');
  assert.equal(summary.users.total, 2);
  assert.equal(summary.users.verified, 1);
  assert.equal(summary.users.kyc_pending, 1);
  assert.equal(summary.users.suspended, 1);
  assert.equal(summary.users.active, 2);
  assert.equal(summary.transactions.deposits_by_channel.mobile_money.valid.count, 1);
  assert.equal(summary.transactions.deposits_by_channel.crypto.pending.count, 1);
  assert.equal(summary.transactions.withdrawals.rejected.count, 1);
  assert.equal(summary.transactions.operations.exchanges.count, 1);
});
