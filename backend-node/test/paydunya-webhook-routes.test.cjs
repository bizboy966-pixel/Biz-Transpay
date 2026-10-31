'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { createPaydunyaWebhookRoutes } = require('../src/paydunya-webhook-routes.cjs');
const { matches, applyUpdate, project } = require('../src/document-store.cjs');

const MASTER = 'mock-paydunya-master';
const STATIC_HASH = createHash('sha512').update(MASTER).digest('hex');

class Collection {
  constructor(rows = []) { this.rows = structuredClone(rows); }
  async find_one(query) {
    const row = this.rows.find(item => matches(item, query));
    return row ? project(structuredClone(row), { _id: 0 }) : null;
  }
  async update_one(query, update) {
    const index = this.rows.findIndex(item => matches(item, query));
    if (index < 0) return { matched_count: 0, modified_count: 0 };
    this.rows[index] = applyUpdate(this.rows[index], update, false, query);
    return { matched_count: 1, modified_count: 1 };
  }
}

function createDb({
  depositStatus = 'pending', expectedAmount = 1000, linkPayment = false, depositOverrides = {},
} = {}) {
  const collections = new Map([
    ['settings', new Collection([{
      id: 'payment_provider_paydunya', enabled: true, mode: 'test',
    }])],
    ['momo_deposits', new Collection([{
      id: 'deposit-1',
      user_id: 'user-1',
      ...(linkPayment ? { link_payment_id: 'link-payment-1', source: 'link_payment' } : {}),
      provider: 'paydunya',
      paydunya_token: 'provider-invoice-1',
      paydunya_reference: 'ref-1',
      provider_mode: 'test',
      status: depositStatus,
      initiation_state: 'ready',
      currency: 'XOF',
      amount: expectedAmount,
      requested_amount: expectedAmount,
      charged_amount: expectedAmount,
      wallet_credit_amount: 980,
      gateway_fee: 20,
      platform_fee: 0,
      total_fee: 20,
      country: 'TG',
      operator: 'tmoney',
      operator_name: 'T-Money',
      created_at: '2026-05-01T10:00:00.000Z',
      ...structuredClone(depositOverrides),
    }])],
    ['users', new Collection([{
      id: 'user-1', balance_xof: 0, wallet_credit_operation_ids: [],
    }])],
    ['wallet_operations', new Collection()],
    ['transactions', new Collection()],
    ['link_payments', new Collection(linkPayment ? [{
      id: 'link-payment-1', status: 'pending', amount: expectedAmount,
    }] : [])],
  ]);
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, new Collection());
      return collections.get(name);
    },
    async transaction(callback) {
      const working = new Map([...collections.entries()].map(([name, collection]) => (
        [name, structuredClone(collection.rows)]
      )));
      const repo = {
        async lockWallets() {},
        async get(table, id) {
          return structuredClone((working.get(table) || []).find(row => row.id === id) || null);
        },
        async insert(table, id, document) {
          if (!working.has(table)) working.set(table, []);
          if (working.get(table).some(row => row.id === id)) {
            throw new Error(`duplicate ${table}:${id}`);
          }
          working.get(table).push(structuredClone(document));
        },
        async replace(table, id, document) {
          if (!working.has(table)) working.set(table, []);
          const rows = working.get(table);
          const index = rows.findIndex(row => row.id === id);
          if (index < 0) rows.push(structuredClone(document));
          else rows[index] = structuredClone(document);
        },
      };
      const result = await callback(repo);
      for (const [name, rows] of working) {
        if (!collections.has(name)) collections.set(name, new Collection());
        collections.get(name).rows = rows;
      }
      return result;
    },
  };
}

function confirmation(amount = 1000) {
  return {
    response_code: '00',
    data: {
      status: 'completed',
      hash: STATIC_HASH,
      invoice: {
        token: 'provider-invoice-1',
        total_amount: amount,
        currency: 'XOF',
      },
      custom_data: {
        biztranspay_token: 'deposit-1',
        biztranspay_amount: String(amount),
        biztranspay_currency: 'XOF',
      },
    },
  };
}

function setup({
  depositStatus, expectedAmount = 1000, providerResponse, linkPayment,
  depositOverrides, fetchImpl, sessionService, reconcileDeposit,
} = {}) {
  const db = createDb({ depositStatus, expectedAmount, linkPayment, depositOverrides });
  let providerCalls = 0;
  const service = createPaydunyaWebhookRoutes({
    db,
    env: {
      SESSION_SECRET: 'test-session-secret',
      PAYDUNYA_MASTER_KEY: MASTER,
      PAYDUNYA_PRIVATE_KEY: 'mock-private',
      PAYDUNYA_TOKEN: 'mock-token',
    },
    fetchImpl: async (url, options) => {
      providerCalls += 1;
      if (fetchImpl) return fetchImpl(url, options);
      assert.match(url, /^https:\/\/app\.paydunya\.com\/sandbox-api\/v1\/checkout-invoice\/confirm\//);
      assert.equal(options.method, 'GET');
      return {
        ok: true,
        status: 200,
        async json() { return providerResponse || confirmation(expectedAmount); },
      };
    },
    sessionService,
    reconcileDeposit,
  });
  return { db, service, providerCalls: () => providerCalls };
}

async function call(service, payload, { contentType = 'application/json', body } = {}) {
  const content = body ?? JSON.stringify(payload);
  const req = Readable.from([Buffer.from(content)]);
  req.method = 'POST';
  req.url = '/api/webhooks/paydunya';
  req.headers = { 'content-type': contentType };
  const res = {
    status: 500,
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
  const handled = await service.handleRoute(req, res);
  return { handled, status: res.status, body: res.body };
}

async function callReturn(service, path) {
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = path;
  req.headers = {};
  const res = {
    status: 500,
    headers: {},
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end() {},
  };
  const handled = await service.handleRoute(req, res);
  return { handled, status: res.status, location: res.headers.Location };
}

async function callFinalize(service, depositId, payload) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))]);
  req.method = 'POST';
  req.url = `/api/deposits/mobile-money/${encodeURIComponent(depositId)}/finalize`;
  req.headers = { 'content-type': 'application/json' };
  const res = {
    status: 500,
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
  const handled = await service.handleRoute(req, res);
  return { handled, status: res.status, body: res.body };
}

test('PayDunya nested form webhook verifies with the provider and credits once atomically', async () => {
  const { db, service, providerCalls } = setup();
  const form = new URLSearchParams({
    hash: STATIC_HASH,
    'data[invoice][token]': 'provider-invoice-1',
    'data[status]': 'completed',
  }).toString();
  const first = await call(service, null, {
    contentType: 'application/x-www-form-urlencoded',
    body: form,
  });
  const duplicate = await call(service, {
    hash: STATIC_HASH,
    data: { invoice: { token: 'provider-invoice-1' } },
  });
  assert.equal(first.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(providerCalls(), 1);
  assert.equal(db.collection('users').rows[0].balance_xof, 980);
  assert.equal(db.collection('transactions').rows.length, 1);
  assert.equal(db.collection('momo_deposits').rows[0].status, 'approved');
  assert.equal(db.collection('transactions').rows[0].metadata.wallet_snapshot.balance_before, 0);
  assert.equal(db.collection('transactions').rows[0].metadata.wallet_snapshot.balance_after, 980);
});

test('PayDunya link payment webhook credits the merchant once and records the paid link status', async () => {
  const { db, service, providerCalls } = setup({ linkPayment: true });
  const payload = {
    hash: STATIC_HASH,
    data: { invoice: { token: 'provider-invoice-1' } },
  };
  const first = await call(service, payload);
  const duplicate = await call(service, payload);
  assert.equal(first.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(providerCalls(), 1);
  assert.equal(db.collection('users').rows[0].balance_xof, 980);
  assert.equal(db.collection('transactions').rows.length, 1);
  assert.equal(db.collection('transactions').rows[0].type, 'link_payment');
  assert.equal(db.collection('transactions').rows[0].metadata.link_payment_id, 'link-payment-1');
  assert.equal(db.collection('link_payments').rows[0].status, 'paid');
  assert.equal(db.collection('link_payments').rows[0].balance_before, 0);
  assert.equal(db.collection('link_payments').rows[0].balance_after, 980);
});

test('PayDunya callback hash mismatch never calls provider or credits the wallet', async () => {
  const { db, service, providerCalls } = setup();
  const result = await call(service, {
    hash: '00'.repeat(64),
    data: { invoice: { token: 'provider-invoice-1' } },
  });
  assert.equal(result.status, 400);
  assert.equal(providerCalls(), 0);
  assert.equal(db.collection('users').rows[0].balance_xof, 0);
  assert.equal(db.collection('transactions').rows.length, 0);
});

test('PayDunya confirmed amount mismatch quarantines the deposit without credit', async () => {
  const { db, service } = setup({ providerResponse: confirmation(1001) });
  const result = await call(service, {
    hash: STATIC_HASH,
    data: { invoice: { token: 'provider-invoice-1' } },
  });
  assert.equal(result.status, 200);
  assert.equal(db.collection('users').rows[0].balance_xof, 0);
  assert.equal(db.collection('momo_deposits').rows[0].status, 'quarantined');
  assert.equal(db.collection('transactions').rows.length, 0);
});

test('an existing PayDunya invoice still settles after new checkouts are disabled', async () => {
  const { db, service } = setup();
  db.collection('settings').rows[0].enabled = false;
  const result = await call(service, {
    hash: STATIC_HASH,
    data: { invoice: { token: 'provider-invoice-1' } },
  });
  assert.equal(result.status, 200);
  assert.equal(db.collection('users').rows[0].balance_xof, 980);
  assert.equal(db.collection('momo_deposits').rows[0].status, 'approved');
});

test('PayDunya browser return independently verifies before redirecting to completed', async () => {
  const { db, service, providerCalls } = setup();
  const result = await callReturn(service, '/api/deposits/paydunya/return?ref=deposit-1');
  assert.equal(result.status, 303);
  assert.equal(result.location, '/dashboard?paydunya=completed');
  assert.equal(providerCalls(), 1);
  assert.equal(db.collection('users').rows[0].balance_xof, 980);
});

test('Wizall OTP confirmation is submitted once and then checked server-side', async () => {
  const providerRequests = [];
  const reconciled = [];
  const { db, service, providerCalls } = setup({
    depositOverrides: {
      country: 'SN',
      operator: 'wizall-sn',
      endpoint_slug: 'wizall-money-senegal',
      phone_number: '+221770000000',
      provider_reference: 'wizall-transaction-1',
      otp_required: true,
      challenge_status: 'required',
    },
    sessionService: { authenticate: async () => ({ userId: 'user-1' }) },
    fetchImpl: async (url, options) => {
      providerRequests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    },
    reconcileDeposit: async id => reconciled.push(id),
  });

  const first = await callFinalize(service, 'deposit-1', { otp: '987654' });
  assert.equal(first.status, 200);
  assert.equal(first.body.otp_required, false);
  assert.equal(providerCalls(), 1);
  assert.equal(providerRequests[0].url, 'https://app.paydunya.com/sandbox-api/api/v1/softpay/wizall-money-senegal/confirm');
  assert.deepEqual(JSON.parse(providerRequests[0].options.body), {
    authorization_code: '987654',
    phone_number: '770000000',
    transaction_id: 'wizall-transaction-1',
  });
  assert.deepEqual(reconciled, ['deposit-1']);

  const retry = await callFinalize(service, 'deposit-1', { otp: '987654' });
  assert.equal(retry.status, 200);
  assert.equal(providerCalls(), 1);
  const stored = await db.collection('momo_deposits').find_one({ id: 'deposit-1' });
  assert.equal(stored.paydunya_finalize_state, 'accepted');
});

test('invalid Wizall OTP is rejected before claiming or sending the confirmation', async () => {
  const { db, service, providerCalls } = setup({
    depositOverrides: {
      country: 'SN',
      operator: 'wizall-sn',
      endpoint_slug: 'wizall-money-senegal',
      provider_reference: 'wizall-transaction-1',
      otp_required: true,
      challenge_status: 'required',
    },
    sessionService: { authenticate: async () => ({ userId: 'user-1' }) },
    fetchImpl: async () => {
      throw new Error('Provider must not be called for an empty code.');
    },
  });

  const response = await callFinalize(service, 'deposit-1', { otp: ' ' });
  assert.equal(response.status, 422);
  assert.equal(providerCalls(), 0);
  const stored = await db.collection('momo_deposits').find_one({ id: 'deposit-1' });
  assert.equal(stored.challenge_status, 'required');
  assert.equal(stored.paydunya_finalize_state, undefined);
});
