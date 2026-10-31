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

test('Mobile Money payout uses the country currency wallet instead of XOF', async () => {
  const db = new MemoryDb();
  const user = db.rows.users.get('merchant-1');
  user.balance_gnf = 5000;
  const transfer = db.rows.settings.get('transfer_config');
  transfer.mobile_money.operators[0] = {
    ...transfer.mobile_money.operators[0],
    country: 'GN', code: 'mtn_gn', public_code: 'mtn_gn',
    operator: 'mtn', currency: 'GNF', name: 'MTN Guinée',
    min: 100, max: 100_000,
  };
  db.rows.settings.get('app_features').wallet_gnf_enabled = true;
  db.rows.settings.get('app_features').withdrawal_gnf_enabled = true;
  const service = createMobileMoneyPayoutService({
    db, sessionSecret: 'test-session-secret',
    env: { OFFICIAL_DOMAIN: 'https://biz-transpay.com' },
    fetchImpl: async () => providerResponse({
      data: { transaction_id: 'mb-gnf-1', status: 'pending' },
    }),
  });

  const result = await service.createIntegrationPayout(
    'merchant-1',
    payout({ country: 'GN', operator: 'mtn_gn', currency: 'GNF', amount: 500 }),
    'idempotency-key-gnf-001',
  );

  assert.equal(user.balance_xof, 10_000);
  assert.equal(db.rows.users.get('merchant-1').balance_gnf, 4_400);
  assert.equal(result.transaction.currency, 'GNF');
  assert.equal(result.transaction.metadata.wallet_field, 'balance_gnf');
});

test('Mobile Money payout rejects a currency that does not belong to the selected country', async () => {
  const db = new MemoryDb();
  let providerCalls = 0;
  const service = createMobileMoneyPayoutService({
    db, sessionSecret: 'test-session-secret',
    env: { OFFICIAL_DOMAIN: 'https://biz-transpay.com' },
    fetchImpl: async () => {
      providerCalls += 1;
      return providerResponse({});
    },
  });
  await assert.rejects(
    service.createIntegrationPayout(
      'merchant-1', payout({ country: 'TG', currency: 'GNF' }), 'idempotency-key-bad-cur',
    ),
    error => error.status === 422,
  );
  assert.equal(providerCalls, 0);
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 10_000);
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
  assert.equal(failed.metadata.manual_review_required, false);
  assert.equal(replay.status, 'failed');
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 10_000);
  assert.equal(requests.length, 2);
  assert.ok(db.rows.transactions.has(`payout-refund-${created.transaction.id}`));
});

test('PayDunya payout uses its two-step flow and the verified production callback host', async () => {
  const db = new MemoryDb();
  const transfer = db.rows.settings.get('transfer_config');
  transfer.mobile_money.operators[0] = {
    ...transfer.mobile_money.operators[0],
    provider: 'paydunya', withdraw_mode: 'tmoney_tg',
  };
  db.rows.settings.set('payment_provider_paydunya', {
    id: 'payment_provider_paydunya', enabled: true, mode: 'live',
  });
  const requests = [];
  const service = createMobileMoneyPayoutService({
    db, sessionSecret: 'test-session-secret',
    env: {
      OFFICIAL_DOMAIN: 'https://www.biz-transpay.com',
      PAYDUNYA_MASTER_KEY: 'master',
      PAYDUNYA_PRIVATE_KEY: 'private',
      PAYDUNYA_TOKEN: 'token',
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return requests.length === 1
        ? providerResponse({ response_code: '00', disburse_token: 'pd-invoice-1' })
        : providerResponse({ response_code: '00', status: 'pending' });
    },
  });
  const result = await service.createIntegrationPayout(
    'merchant-1', payout(), 'idempotency-paydunya-001',
  );
  assert.equal(result.transaction.status, 'pending');
  assert.equal(result.transaction.metadata.paydunya_invoice_token, undefined);
  assert.equal(
    db.rows.transactions.get(result.transaction.id).metadata.paydunya_invoice_token,
    'pd-invoice-1',
  );
  const replay = await service.createIntegrationPayout(
    'merchant-1', payout(), 'idempotency-paydunya-001',
  );
  assert.equal(replay.transaction.metadata.paydunya_invoice_token, undefined);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /\/api\/v2\/disburse\/get-invoice$/);
  assert.match(requests[1].url, /\/api\/v2\/disburse\/submit-invoice$/);
  const invoiceBody = JSON.parse(requests[0].options.body);
  const submitBody = JSON.parse(requests[1].options.body);
  assert.equal(invoiceBody.withdraw_mode, 't-money-togo');
  const callback = new URL(invoiceBody.callback_url);
  assert.equal(callback.origin, 'https://biz-transpay.com');
  assert.equal(callback.pathname, '/api/webhooks/paydunya/disbursement');
  assert.equal(callback.searchParams.get('ref'), result.transaction.id);
  assert.deepEqual(submitBody, {
    disburse_invoice: 'pd-invoice-1',
    disburse_id: result.transaction.id,
  });
});

test('PayDunya status polling verifies the invoice and reconciles success without resubmitting', async () => {
  const db = new MemoryDb();
  const transfer = db.rows.settings.get('transfer_config');
  transfer.mobile_money.operators[0] = {
    ...transfer.mobile_money.operators[0],
    provider: 'paydunya', withdraw_mode: 'tmoney_tg',
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
      if (url.endsWith('/get-invoice')) {
        return providerResponse({ response_code: '00', disburse_token: 'pd-poll-1' });
      }
      if (url.endsWith('/submit-invoice')) {
        return providerResponse({ response_code: '00', status: 'pending' });
      }
      return providerResponse({
        response_code: '00',
        status: 'completed',
        disburse_token: 'pd-poll-1',
        withdraw_mode: 't-money-togo',
        amount: 1000,
      });
    },
  });
  const created = await service.createIntegrationPayout(
    'merchant-1', payout(), 'idempotency-paydunya-poll-001',
  );
  const refreshed = await service.refreshPayoutStatus(created.transaction.id, 'merchant-1');
  assert.equal(requests.length, 3);
  assert.equal(refreshed.status, 'completed');
  assert.equal(refreshed.metadata.paydunya_invoice_token, undefined);
  assert.equal(db.rows.transactions.get(created.transaction.id).status, 'completed');
  assert.equal(requests.filter(({ url }) => url.endsWith('/submit-invoice')).length, 1);
  assert.equal(requests.filter(({ url }) => url.endsWith('/check-status')).length, 1);
});

test('PayDunya verified terminal failure refunds once during status polling', async () => {
  const db = new MemoryDb();
  const transfer = db.rows.settings.get('transfer_config');
  transfer.mobile_money.operators[0] = {
    ...transfer.mobile_money.operators[0],
    provider: 'paydunya', withdraw_mode: 'tmoney_tg',
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
      if (url.endsWith('/get-invoice')) {
        return providerResponse({ response_code: '00', disburse_token: 'pd-fail-1' });
      }
      if (url.endsWith('/submit-invoice')) {
        return providerResponse({ response_code: '00', status: 'pending' });
      }
      return providerResponse({
        response_code: '00',
        status: 'rejected',
        disburse_token: 'pd-fail-1',
        withdraw_mode: 't-money-togo',
        amount: 1000,
      });
    },
  });
  const created = await service.createIntegrationPayout(
    'merchant-1', payout(), 'idempotency-paydunya-poll-002',
  );
  const failed = await service.refreshPayoutStatus(created.transaction.id, 'merchant-1');
  const replay = await service.refreshPayoutStatus(created.transaction.id, 'merchant-1');
  assert.equal(requests.length, 3);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.metadata.refunded, true);
  assert.equal(replay.status, 'failed');
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 10_000);
  assert.equal(requests.filter(({ url }) => url.endsWith('/check-status')).length, 1);
  assert.ok(db.rows.transactions.has(`payout-refund-${created.transaction.id}`));
});

test('PayDunya payout rejects a mode that does not match the selected operator before debit', async () => {
  const db = new MemoryDb();
  const transfer = db.rows.settings.get('transfer_config');
  transfer.mobile_money.operators[0] = {
    ...transfer.mobile_money.operators[0],
    provider: 'paydunya',
    withdraw_mode: 'mtn_ci',
  };
  db.rows.settings.set('payment_provider_paydunya', {
    id: 'payment_provider_paydunya', enabled: true, mode: 'live',
  });
  let providerCalls = 0;
  const service = createMobileMoneyPayoutService({
    db,
    sessionSecret: 'test-session-secret',
    env: {
      OFFICIAL_DOMAIN: 'https://biz-transpay.com',
      PAYDUNYA_MASTER_KEY: 'master',
      PAYDUNYA_PRIVATE_KEY: 'private',
      PAYDUNYA_TOKEN: 'token',
    },
    fetchImpl: async () => {
      providerCalls += 1;
      return providerResponse({ response_code: '00' });
    },
  });

  await assert.rejects(
    service.createIntegrationPayout('merchant-1', payout(), 'idempotency-paydunya-mode'),
    error => error.code === 'PAYDUNYA_WITHDRAW_MODE_MISMATCH',
  );
  assert.equal(providerCalls, 0);
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 10_000);
});

test('PayDunya preflight rejection exposes its safe provider code and refunds the reservation', async () => {
  const db = new MemoryDb();
  const transfer = db.rows.settings.get('transfer_config');
  transfer.mobile_money.operators[0] = {
    ...transfer.mobile_money.operators[0],
    provider: 'paydunya',
    withdraw_mode: 't-money-togo',
  };
  db.rows.settings.set('payment_provider_paydunya', {
    id: 'payment_provider_paydunya', enabled: true, mode: 'live',
  });
  const service = createMobileMoneyPayoutService({
    db,
    sessionSecret: 'test-session-secret',
    env: {
      OFFICIAL_DOMAIN: 'https://biz-transpay.com',
      PAYDUNYA_MASTER_KEY: 'master',
      PAYDUNYA_PRIVATE_KEY: 'private',
      PAYDUNYA_TOKEN: 'token',
    },
    fetchImpl: async () => providerResponse({
      response_code: '1001',
      response_text: 'withdraw_mode unsupported',
    }),
  });

  await assert.rejects(
    service.createIntegrationPayout(
      'merchant-1', payout(), 'idempotency-paydunya-preflight',
    ),
    error => error.code === 'PAYDUNYA_1001'
      && error.message.includes('code 1001')
      && error.message.includes('remboursé'),
  );
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 10_000);
  const transaction = [...db.rows.transactions.values()][0];
  assert.equal(transaction.status, 'failed');
  assert.equal(transaction.metadata.provider_status, 'PAYDUNYA_1001');
});

test('PayDunya 4002 refuses preparation before submit and refunds the reserved amount', async () => {
  const db = new MemoryDb();
  const transfer = db.rows.settings.get('transfer_config');
  transfer.mobile_money.operators[0] = {
    ...transfer.mobile_money.operators[0],
    provider: 'paydunya',
    withdraw_mode: 't-money-togo',
  };
  db.rows.settings.set('payment_provider_paydunya', {
    id: 'payment_provider_paydunya', enabled: true, mode: 'live',
  });
  const requests = [];
  const service = createMobileMoneyPayoutService({
    db,
    sessionSecret: 'test-session-secret',
    env: {
      OFFICIAL_DOMAIN: 'https://www.biz-transpay.com',
      PAYDUNYA_MASTER_KEY: 'master',
      PAYDUNYA_PRIVATE_KEY: 'private',
      PAYDUNYA_TOKEN: 'token',
    },
    fetchImpl: async (url) => {
      requests.push(url);
      return providerResponse({
        response_code: '4002',
        response_text: 'Insufficient balance or callback unavailable',
      });
    },
  });

  await assert.rejects(
    service.createIntegrationPayout(
      'merchant-1', payout(), 'idempotency-paydunya-4002',
    ),
    error => error.code === 'PAYDUNYA_4002'
      && error.message.includes('code 4002')
      && error.message.includes('Insufficient balance or callback unavailable')
      && error.message.includes('remboursé'),
  );
  assert.equal(requests.length, 1);
  assert.match(requests[0], /\/api\/v2\/disburse\/get-invoice$/);
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 10_000);
  const transaction = [...db.rows.transactions.values()][0];
  assert.equal(transaction.status, 'failed');
  assert.equal(transaction.metadata.provider_status, 'PAYDUNYA_4002');
});

test('PayDunya rechecks a non-success submit response and retries the same invoice only when created', async () => {
  const db = new MemoryDb();
  const transfer = db.rows.settings.get('transfer_config');
  transfer.mobile_money.operators[0] = {
    ...transfer.mobile_money.operators[0],
    provider: 'paydunya',
    withdraw_mode: 't-money-togo',
  };
  db.rows.settings.set('payment_provider_paydunya', {
    id: 'payment_provider_paydunya', enabled: true, mode: 'live',
  });
  const requests = [];
  let payoutId = '';
  const service = createMobileMoneyPayoutService({
    db,
    sessionSecret: 'test-session-secret',
    env: {
      OFFICIAL_DOMAIN: 'https://biz-transpay.com',
      PAYDUNYA_MASTER_KEY: 'master',
      PAYDUNYA_PRIVATE_KEY: 'private',
      PAYDUNYA_TOKEN: 'token',
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (String(url).endsWith('/get-invoice')) {
        return providerResponse({ response_code: '00', disburse_token: 'pd-invoice-retry' });
      }
      if (String(url).endsWith('/submit-invoice')) {
        const body = JSON.parse(options.body);
        payoutId ||= body.disburse_id;
        if (requests.filter(item => String(item.url).endsWith('/submit-invoice')).length === 1) {
          return providerResponse({ response_code: '1001', response_text: 'temporary submit response' });
        }
        return providerResponse({
          response_code: '00', status: 'pending', transaction_id: 'paydunya-tx-1',
        });
      }
      return providerResponse({
        response_code: '00',
        status: 'created',
        token: 'pd-invoice-retry',
        withdraw_mode: 't-money-togo',
        amount: '1000.00',
        disburse_id: payoutId,
      });
    },
  });

  const result = await service.createIntegrationPayout(
    'merchant-1', payout(), 'idempotency-paydunya-retry',
  );
  assert.equal(result.transaction.status, 'pending');
  assert.equal(result.transaction.metadata.paydunya_status_check, 'created');
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 8_850);
  const submitBodies = requests
    .filter(item => String(item.url).endsWith('/submit-invoice'))
    .map(item => JSON.parse(item.options.body));
  assert.equal(submitBodies.length, 2);
  assert.deepEqual(submitBodies[0], submitBodies[1]);
  assert.equal(submitBodies[0].disburse_invoice, 'pd-invoice-retry');
  assert.equal(requests.filter(item => String(item.url).endsWith('/check-status')).length, 1);
});

test('PayDunya keeps a non-00 submission reserved while verified status is pending', async () => {
  const db = new MemoryDb();
  const transfer = db.rows.settings.get('transfer_config');
  transfer.mobile_money.operators[0] = {
    ...transfer.mobile_money.operators[0],
    provider: 'paydunya',
    withdraw_mode: 't-money-togo',
  };
  db.rows.settings.set('payment_provider_paydunya', {
    id: 'payment_provider_paydunya', enabled: true, mode: 'live',
  });
  let payoutId = '';
  let checkCalls = 0;
  const service = createMobileMoneyPayoutService({
    db,
    sessionSecret: 'test-session-secret',
    env: {
      OFFICIAL_DOMAIN: 'https://biz-transpay.com',
      PAYDUNYA_MASTER_KEY: 'master',
      PAYDUNYA_PRIVATE_KEY: 'private',
      PAYDUNYA_TOKEN: 'token',
    },
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/get-invoice')) {
        return providerResponse({ response_code: '00', disburse_token: 'pd-invoice-pending' });
      }
      if (String(url).endsWith('/submit-invoice')) {
        payoutId = JSON.parse(options.body).disburse_id;
        return providerResponse({ response_code: '1001' });
      }
      checkCalls += 1;
      return providerResponse({
        response_code: '00',
        status: 'pending',
        token: 'pd-invoice-pending',
        withdraw_mode: 't-money-togo',
        amount: '1000',
        disburse_id: payoutId,
        transaction_id: 'paydunya-tx-pending',
      });
    },
  });

  const result = await service.createIntegrationPayout(
    'merchant-1', payout(), 'idempotency-paydunya-pending',
  );
  assert.equal(result.transaction.status, 'pending');
  assert.equal(result.transaction.metadata.provider_status, 'pending');
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 8_850);
  assert.equal(checkCalls, 1);
  assert.equal(result.transaction.metadata.refunded, undefined);
});

test('PayDunya refunds only after status lookup confirms a failed payout', async () => {
  const db = new MemoryDb();
  const transfer = db.rows.settings.get('transfer_config');
  transfer.mobile_money.operators[0] = {
    ...transfer.mobile_money.operators[0],
    provider: 'paydunya',
    withdraw_mode: 't-money-togo',
  };
  db.rows.settings.set('payment_provider_paydunya', {
    id: 'payment_provider_paydunya', enabled: true, mode: 'live',
  });
  let payoutId = '';
  const service = createMobileMoneyPayoutService({
    db,
    sessionSecret: 'test-session-secret',
    env: {
      OFFICIAL_DOMAIN: 'https://biz-transpay.com',
      PAYDUNYA_MASTER_KEY: 'master',
      PAYDUNYA_PRIVATE_KEY: 'private',
      PAYDUNYA_TOKEN: 'token',
    },
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/get-invoice')) {
        return providerResponse({ response_code: '00', disburse_token: 'pd-invoice-failed' });
      }
      if (String(url).endsWith('/submit-invoice')) {
        payoutId = JSON.parse(options.body).disburse_id;
        return providerResponse({ response_code: '5000' });
      }
      return providerResponse({
        response_code: '00',
        status: 'failed',
        token: 'pd-invoice-failed',
        withdraw_mode: 't-money-togo',
        amount: '1000',
        disburse_id: payoutId,
      });
    },
  });

  const result = await service.createIntegrationPayout(
    'merchant-1', payout(), 'idempotency-paydunya-failed',
  );
  assert.equal(result.transaction.status, 'failed');
  assert.equal(result.transaction.metadata.refunded, true);
  assert.equal(db.rows.users.get('merchant-1').balance_xof, 10_000);
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
      const target = String(url);
      if (target.endsWith('/v1/token')) {
        return providerResponse({ data: { access_token: 'af-token' } });
      }
      if (target.endsWith('/v1/pay/payout')) {
        return providerResponse({ data: { transaction_id: 'af-100', status: 'pending' } });
      }
      if (target.includes('/v1/status?')) {
        return providerResponse({ data: { status: 'completed' } });
      }
      throw new Error(`Unexpected AfriBaPay URL: ${target}`);
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

  const refreshed = await service.refreshPayoutStatus(result.transaction.id, 'merchant-1');
  assert.equal(refreshed.status, 'completed');
  assert.equal(refreshed.metadata.provider, 'afribapay');
  assert.equal(requests.length, 4);
  assert.match(requests[2].url, /api\.afribapay\.test\/v1\/token$/);
  assert.match(requests[3].url, /payout\.afribapay\.test\/v1\/status\?/);
  assert.equal(
    new URL(requests[3].url).searchParams.get('order_id'),
    result.transaction.id,
  );
});

test('AfriBaPay accepts mapped GNF and CDF payout routes with their exact wallet currencies', async () => {
  for (const route of [
    { country: 'GN', currency: 'GNF', code: 'mtn_gn', operator: 'mtn', wallet: 'balance_gnf' },
    { country: 'CD', currency: 'CDF', code: 'mtn_cd', operator: 'mtn', wallet: 'balance_cdf' },
  ]) {
    const db = new MemoryDb();
    db.rows.settings.get('transfer_config').mobile_money.operators[0] = {
      provider: 'afribapay',
      country: route.country,
      code: route.code,
      operator: route.operator,
      currency: route.currency,
      active: true,
      min: 100,
      max: 100_000,
    };
    db.rows.settings.get('app_features')[`wallet_${route.currency.toLowerCase()}_enabled`] = true;
    db.rows.settings.get('app_features')[`withdrawal_${route.currency.toLowerCase()}_enabled`] = true;
    db.rows.users.get('merchant-1')[route.wallet] = 5_000;
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
          : providerResponse({ data: { transaction_id: `af-${route.currency}`, status: 'pending' } });
      },
    });

    const result = await service.createIntegrationPayout(
      'merchant-1',
      payout({
        country: route.country,
        currency: route.currency,
        operator: route.code,
        amount: 500,
      }),
      `idempotency-afribapay-${route.currency.toLowerCase()}`,
    );
    const payload = JSON.parse(requests[1].options.body);

    assert.equal(result.transaction.currency, route.currency);
    assert.equal(result.transaction.metadata.wallet_field, route.wallet);
    assert.equal(payload.country, route.country);
    assert.equal(payload.currency, route.currency);
    assert.equal(payload.operator, route.operator);
  }
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
