'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMobileMoneyPayoutService } = require('../src/mobile-money-payout-service.cjs');

function clone(value) { return structuredClone(value); }

function setPath(document, path, value) {
  const parts = path.split('.');
  let cursor = document;
  for (const part of parts.slice(0, -1)) cursor = cursor[part] ||= {};
  cursor[parts.at(-1)] = clone(value);
}

class MemoryDb {
  constructor() {
    this.rows = {
      users: new Map([['merchant-1', {
        id: 'merchant-1', kyc_status: 'verified', balance_xof: 10_000,
        full_name: 'Test Merchant',
      }]]),
      settings: new Map([
        ['app_features', {
          id: 'app_features', wallet_xof_enabled: true, withdrawal_xof_enabled: true,
        }],
        ['transfer_config', {
          id: 'transfer_config',
          mobile_money: {
            enabled: true,
            operators: [{
              provider: 'mbiyo', country: 'TG', code: 'tmoney_tg',
              public_code: 'tmoney_tg', operator: 'tmoney', network: 'togocom',
              name: 'T-Money', currency: 'XOF', active: true,
              fee_pct: 10, fee_fixed: 50, min: 100, max: 500_000,
            }],
          },
        }],
        ['payment_provider_mbiyo', {
          id: 'payment_provider_mbiyo', enabled: true, mode: 'live',
          secret_key: 'test-mbiyo-secret',
        }],
        ['payment_provider_paydunya', { id: 'payment_provider_paydunya', enabled: false }],
        ['payment_provider_afribapay', { id: 'payment_provider_afribapay', enabled: false }],
      ]),
      transactions: new Map(),
      wallet_operations: new Map(),
    };
    this.tail = Promise.resolve();
  }

  matches(document, query) {
    return Object.entries(query || {}).every(([key, value]) => (
      String(document?.[key]) === String(value)
    ));
  }

  collection(name) {
    return {
      find_one: async query => {
        const row = [...(this.rows[name]?.values() || [])].find(item => this.matches(item, query));
        return row ? clone(row) : null;
      },
      update_one: async (query, update) => {
        const row = [...(this.rows[name]?.values() || [])].find(item => this.matches(item, query));
        if (!row) return { matched_count: 0, modified_count: 0 };
        for (const [path, value] of Object.entries(update.$set || {})) setPath(row, path, value);
        for (const path of Object.keys(update.$unset || {})) {
          const parts = path.split('.');
          let cursor = row;
          for (const part of parts.slice(0, -1)) cursor = cursor?.[part];
          if (cursor) delete cursor[parts.at(-1)];
        }
        return { matched_count: 1, modified_count: 1 };
      },
    };
  }

  transaction(callback) {
    const result = this.tail.then(async () => {
      const working = Object.fromEntries(Object.entries(this.rows).map(([name, rows]) => [
        name, new Map([...rows].map(([id, row]) => [id, clone(row)])),
      ]));
      const repo = {
        lockWallets: async () => {},
        get: async (collection, id) => clone(working[collection]?.get(String(id)) || null),
        replace: async (collection, id, row) => {
          working[collection].set(String(id), clone(row));
        },
        insert: async (collection, id, row) => {
          if (working[collection].has(String(id))) throw new Error('duplicate');
          working[collection].set(String(id), clone(row));
        },
      };
      const value = await callback(repo);
      this.rows = working;
      return value;
    });
    this.tail = result.catch(() => {});
    return result;
  }
}

const payout = overrides => ({
  amount: 1000,
  country: 'TG',
  operator: 'tmoney_tg',
  currency: 'XOF',
  recipient: '90123456',
  fee_bearer: 'sender',
  ...overrides,
});

function providerResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload),
  };
}

test('Mbiyo payout debits atomically and duplicate requests submit once', async () => {
  const db = new MemoryDb();
  const calls = [];
  const service = createMobileMoneyPayoutService({
    db, sessionSecret: 'test-session-secret',
    env: { OFFICIAL_DOMAIN: 'https://biz-transpay.com' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return providerResponse({ data: { transaction_id: 'mb-100', status: 'pending' } });
    },
  });
  const key = 'idempotency-key-123';
  const [first, second] = await Promise.all([
    service.createIntegrationPayout('merchant-1', payout(), key),
    service.createIntegrationPayout('merchant-1', payout(), key),
  ]);
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 8_850);
  assert.equal(calls.length, 1);
  assert.equal(first.transaction.id, second.transaction.id);
  assert.equal(first.transaction.status, 'pending');
  assert.equal(first.transaction.metadata.provider_transaction_id, 'mb-100');
  assert.equal(first.transaction.metadata.balance_before, 10_000);
  assert.equal(first.transaction.metadata.balance_after, 8_850);
});

test('a provider-confirmed success is recorded as completed immediately', async () => {
  const db = new MemoryDb();
  let calls = 0;
  const service = createMobileMoneyPayoutService({
    db, sessionSecret: 'test-session-secret',
    env: { OFFICIAL_DOMAIN: 'https://biz-transpay.com' },
    fetchImpl: async () => {
      calls += 1;
      return providerResponse({
        data: { transaction_id: 'mb-completed', status: 'successful' },
      });
    },
  });
  const result = await service.createIntegrationPayout(
    'merchant-1', payout(), 'idempotency-key-success-1',
  );
  assert.equal(result.transaction.status, 'completed');
  assert.equal(result.pending_manual, false);
  assert.equal(result.transaction.metadata.provider_status, 'successful');
  assert.ok(result.transaction.metadata.provider_verified_at);
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 8_850);
  assert.equal(calls, 1);
});

test('payout enforces server-side amount limits and wallet withdrawal toggles', async () => {
  const db = new MemoryDb();
  let providerCalls = 0;
  const service = createMobileMoneyPayoutService({
    db, sessionSecret: 'test-session-secret',
    env: { OFFICIAL_DOMAIN: 'https://biz-transpay.com' },
    fetchImpl: async () => {
      providerCalls += 1;
      return providerResponse({ data: { transaction_id: 'mb-limits', status: 'pending' } });
    },
  });
  await assert.rejects(
    service.createIntegrationPayout('merchant-1', payout({ amount: 99 }), 'idempotency-min-001'),
    error => error.status === 422,
  );
  await assert.rejects(
    service.createIntegrationPayout('merchant-1', payout({ amount: 500_001 }), 'idempotency-max-001'),
    error => error.status === 422,
  );
  db.rows.settings.get('app_features').withdrawal_xof_enabled = false;
  await assert.rejects(
    service.createIntegrationPayout('merchant-1', payout(), 'idempotency-toggle-001'),
    error => error.status === 403,
  );
  assert.equal(providerCalls, 0);
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 10_000);
  assert.equal(db.rows.transactions.size, 0);
});

test('a reused payout key with different details is rejected without a second debit', async () => {
  const db = new MemoryDb();
  let calls = 0;
  const service = createMobileMoneyPayoutService({
    db, sessionSecret: 'test-session-secret',
    env: { OFFICIAL_DOMAIN: 'https://biz-transpay.com' },
    fetchImpl: async () => {
      calls += 1;
      return providerResponse({ data: { transaction_id: 'mb-101', status: 'pending' } });
    },
  });
  await service.createIntegrationPayout('merchant-1', payout(), 'idempotency-key-456');
  await assert.rejects(
    service.createIntegrationPayout(
      'merchant-1', payout({ amount: 1500 }), 'idempotency-key-456',
    ),
    error => error.status === 409,
  );
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 8_850);
  assert.equal(calls, 1);
});

test('an ambiguous provider response keeps the debit reserved and is not resubmitted', async () => {
  const db = new MemoryDb();
  let calls = 0;
  const service = createMobileMoneyPayoutService({
    db, sessionSecret: 'test-session-secret',
    env: { OFFICIAL_DOMAIN: 'https://biz-transpay.com' },
    fetchImpl: async () => {
      calls += 1;
      throw new Error('simulated timeout after request dispatch');
    },
  });
  const key = 'idempotency-key-789';
  const first = await service.createIntegrationPayout('merchant-1', payout(), key);
  const retry = await service.createIntegrationPayout('merchant-1', payout(), key);
  assert.equal(first.pending_manual, true);
  assert.equal(retry.idempotent_replay, true);
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 8_850);
  assert.equal(calls, 1);
});

test('missing public callback URL fails before reserving funds or contacting a provider', async () => {
  const db = new MemoryDb();
  let calls = 0;
  const service = createMobileMoneyPayoutService({
    db, sessionSecret: 'test-session-secret', env: {},
    fetchImpl: async () => { calls += 1; return providerResponse({}); },
  });
  await assert.rejects(
    service.createIntegrationPayout('merchant-1', payout(), 'idempotency-key-999'),
    error => error.status === 503,
  );
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 10_000);
  assert.equal(db.rows.transactions.size, 0);
  assert.equal(calls, 0);
});

test('provider confirmation completes the payout without a second wallet debit', async () => {
  const db = new MemoryDb();
  const requests = [];
  const service = createMobileMoneyPayoutService({
    db, sessionSecret: 'test-session-secret',
    env: { OFFICIAL_DOMAIN: 'https://biz-transpay.com' },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return options.method === 'GET'
        ? providerResponse({ data: { status: 'completed' } })
        : providerResponse({ data: { transaction_id: 'mb-confirmed', status: 'pending' } });
    },
  });
  const created = await service.createIntegrationPayout(
    'merchant-1', payout(), 'idempotency-status-001',
  );
  const refreshed = await service.refreshPayoutStatus(created.transaction.id, 'merchant-1');
  assert.equal(refreshed.status, 'completed');
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 8_850);
  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /\/merchant\/transactions\/mb-confirmed$/);
});

test('a provider-confirmed rejection refunds once and marks the payout failed', async () => {
  const db = new MemoryDb();
  const requests = [];
  const service = createMobileMoneyPayoutService({
    db, sessionSecret: 'test-session-secret',
    env: { OFFICIAL_DOMAIN: 'https://biz-transpay.com' },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return options.method === 'GET'
        ? providerResponse({ data: { status: 'rejected' } })
        : providerResponse({ data: { transaction_id: 'mb-rejected', status: 'pending' } });
    },
  });
  const created = await service.createIntegrationPayout(
    'merchant-1', payout(), 'idempotency-status-002',
  );
  const failed = await service.refreshPayoutStatus(created.transaction.id, 'merchant-1');
  const replay = await service.refreshPayoutStatus(created.transaction.id, 'merchant-1');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.metadata.refunded, true);
  assert.equal(replay.status, 'failed');
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 10_000);
  assert.equal(requests.length, 2);
  assert.ok(db.rows.transactions.has(`payout-refund-${created.transaction.id}`));
});

test('PayDunya payout uses its two-step disbursement flow with provider callbacks', async () => {
  const db = new MemoryDb();
  const transfer = db.rows.settings.get('transfer_config');
  transfer.mobile_money.operators[0] = {
    ...transfer.mobile_money.operators[0],
    provider: 'paydunya', withdraw_mode: 'mtn_ci',
  };
  db.rows.settings.set('payment_provider_paydunya', {
    id: 'payment_provider_paydunya', enabled: true, mode: 'live',
  });
  const requests = [];
  const service = createMobileMoneyPayoutService({
    db, sessionSecret: 'test-session-secret',
    env: {
      OFFICIAL_DOMAIN: 'https://biz-transpay.com',
      PAYDUNYA_MASTER_KEY: 'master',
      PAYDUNYA_PRIVATE_KEY: 'private',
      PAYDUNYA_TOKEN: 'token',
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return requests.length === 1
        ? providerResponse({ response_code: '00', token: 'pd-invoice-1' })
        : providerResponse({ response_code: '00', status: 'pending' });
    },
  });
  const result = await service.createIntegrationPayout(
    'merchant-1', payout(), 'idempotency-paydunya-001',
  );
  assert.equal(result.transaction.status, 'pending');
  assert.equal(result.transaction.metadata.paydunya_invoice_token, 'pd-invoice-1');
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/api\/v2\/disburse\/get-invoice$/);
  assert.match(requests[1].url, /\/api\/v2\/disburse\/submit-invoice$/);
  assert.match(JSON.parse(requests[0].options.body).callback_url, /\/api\/webhooks\/paydunya\/disbursement/);
});

test('AfriBaPay payout authenticates then submits once to its configured payout host', async () => {
  const db = new MemoryDb();
  const transfer = db.rows.settings.get('transfer_config');
  transfer.mobile_money.operators[0] = {
    ...transfer.mobile_money.operators[0], provider: 'afribapay',
    operator: 'tmoney', network: 'togocom',
  };
  db.rows.settings.set('payment_provider_afribapay', {
    id: 'payment_provider_afribapay', enabled: true, mode: 'live',
    api_user: 'merchant-user', api_key: 'merchant-key',
    merchant_key: 'merchant-id',
    live_api_base_url: 'https://api.afribapay.test',
    live_payout_base_url: 'https://payout.afribapay.test',
  });
  const requests = [];
  const service = createMobileMoneyPayoutService({
    db, sessionSecret: 'test-session-secret',
    env: { OFFICIAL_DOMAIN: 'https://biz-transpay.com' },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return requests.length === 1
        ? providerResponse({ data: { access_token: 'af-token' } })
        : providerResponse({ data: { transaction_id: 'af-100', status: 'pending' } });
    },
  });
  const result = await service.createIntegrationPayout(
    'merchant-1', payout(), 'idempotency-afribapay-001',
  );
  assert.equal(result.transaction.status, 'pending');
  assert.equal(result.transaction.metadata.provider_transaction_id, 'af-100');
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/v1\/token$/);
  assert.match(requests[1].url, /\/v1\/pay\/payout$/);
  const payload = JSON.parse(requests[1].options.body);
  assert.equal(payload.order_id, result.transaction.id);
  assert.equal(payload.notify_url, 'https://biz-transpay.com/api/webhooks/afribapay?ref=' + result.transaction.id);
  assert.equal(payload.merchant_key, 'merchant-id');
});

test('an explicit provider rejection refunds immediately and never leaves a false pending payout', async () => {
  const db = new MemoryDb();
  const service = createMobileMoneyPayoutService({
    db, sessionSecret: 'test-session-secret',
    env: { OFFICIAL_DOMAIN: 'https://biz-transpay.com' },
    fetchImpl: async () => providerResponse({
      data: { transaction_id: 'mb-rejected-now', status: 'rejected' },
    }),
  });
  const result = await service.createIntegrationPayout(
    'merchant-1', payout(), 'idempotency-reject-001',
  );
  assert.equal(result.transaction.status, 'failed');
  assert.equal(result.transaction.metadata.refunded, true);
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 10_000);
});
