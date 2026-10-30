'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createTransferRoutes } = require('../src/transfer-routes.cjs');

function clone(value) { return structuredClone(value); }

function matches(document, query) {
  if (query.$or && !query.$or.some(part => matches(document, part))) return false;
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return true;
    if (value && typeof value === 'object' && '$regex' in value) {
      return new RegExp(value.$regex, value.$options || '').test(String(document[key] || ''));
    }
    return String(document[key]) === String(value);
  });
}

class AtomicStore {
  constructor({ users, settings = [] }) {
    this.docs = {
      users: new Map(users.map(user => [String(user.id), clone(user)])),
      settings: new Map(settings.map(item => [String(item.id), clone(item)])),
      transactions: new Map(),
      wallet_operations: new Map(),
      withdrawal_email_otps: new Map(),
      withdrawal_email_otp_limits: new Map(),
    };
    this.tail = Promise.resolve();
  }

  collection(name) {
    return {
      find_one: async query => {
        const document = [...(this.docs[name]?.values() || [])].find(row => matches(row, query));
        return document ? clone(document) : null;
      },
      update_one: async (query, update) => {
        const document = [...(this.docs[name]?.values() || [])].find(row => matches(row, query));
        if (!document) return { matched_count: 0, modified_count: 0 };
        Object.assign(document, clone(update.$set || {}));
        for (const key of Object.keys(update.$unset || {})) delete document[key];
        return { matched_count: 1, modified_count: 1 };
      },
    };
  }

  transaction(callback) {
    const result = this.tail.then(async () => {
      const draft = Object.fromEntries(Object.entries(this.docs).map(([name, rows]) => [
        name, new Map([...rows].map(([id, document]) => [id, clone(document)])),
      ]));
      const repo = {
        lockCollection: async () => {},
        lockWallets: async () => {},
        get: async (collection, id) => clone(draft[collection]?.get(String(id)) ?? null),
        replace: async (collection, id, document) => {
          draft[collection].set(String(id), clone(document));
        },
        insert: async (collection, id, document) => {
          if (draft[collection].has(String(id))) throw new Error('duplicate document');
          draft[collection].set(String(id), clone(document));
        },
      };
      const output = await callback(repo);
      this.docs = draft;
      return output;
    });
    this.tail = result.catch(() => {});
    return result;
  }
}

function setup({
  kycStatus = 'verified', validPin = true, withdrawalOtp = false,
  emailSender = 'no-reply@example.test', settingsExtra = [],
} = {}) {
  const sentEmails = [];
  const store = new AtomicStore({
    users: [
      {
        id: 'sender', username: 'alice', email: 'alice@example.test',
        full_name: 'Alice Example', kyc_status: kycStatus,
        user_pin_hash: 'configured', balance_xof: 1000,
      },
      {
        id: 'recipient', username: 'bob', email: 'bob@example.test',
        full_name: 'Bob Example', kyc_status: 'verified', balance_xof: 50,
      },
    ],
    settings: [
      { id: 'app_features', wallet_crypto_enabled: true },
      {
        id: 'transaction_email_settings',
        withdrawal_otp_enabled: withdrawalOtp,
        sender_email: emailSender,
      },
      ...settingsExtra,
    ],
  });
  const sentNotifications = [];
  const service = createTransferRoutes({
    db: store,
    sessionSecret: 'test-session-secret',
    env: {},
    sessionService: {
      async authenticate(token) {
        if (token !== 'valid-session') throw Object.assign(new Error('Session requise'), { status: 401 });
        return { userId: 'sender', session: { last_auth_at: new Date() } };
      },
      requireRecentAuth(authenticated) { return authenticated.userId; },
    },
    verifyBot: async token => {
      if (token !== 'turnstile-ok') throw Object.assign(new Error('Vérification anti-bot requise'), { status: 403 });
    },
    verifyPinFn: async () => validPin,
    sendEmailFn: async (_env, message) => sentEmails.push(message),
    cryptoCatalog: { async activeExchangeAssets() { return new Map(); } },
    notify: async (...args) => sentNotifications.push(args),
  });
  return { store, service, sentNotifications, sentEmails };
}

function request(body, path = '/api/transfers', method = 'POST') {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
  req.method = method;
  req.url = path;
  req.headers = { authorization: 'Bearer valid-session' };
  return req;
}

function response() {
  return {
    status: 0,
    writeHead(status) { this.status = status; },
    end(body) { this.body = body; },
  };
}

async function call(service, body, path, method = 'POST') {
  const res = response();
  const handled = await service.handleRoute(request(body, path, method), res);
  return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

test('transfer config requires a session and exposes only active, configured payout routes', async () => {
  const { service } = setup({
    settingsExtra: [
      {
        id: 'transfer_config',
        mobile_money: {
          enabled: true,
          operators: [
            { provider: 'paydunya', country: 'TG', code: 'moov_tg', name: 'Moov Togo', currency: 'XOF', min: 100, fee_pct: 1.5, active: true },
            { provider: 'paydunya', country: 'TG', code: 'orange_tg', name: 'Orange Togo', currency: 'XOF', active: true },
            { provider: 'mbiyo', country: 'BF', code: 'mbiyo_moov', name: 'Moov Burkina', currency: 'XOF', fee_pct: 2, active: true },
            { provider: 'afribapay', country: 'BF', code: 'afribapay_moov', name: 'Duplicate route', currency: 'XOF', active: false },
            { provider: 'afribapay', country: 'UG', code: 'airtel_ug', name: 'Airtel Money', currency: 'UGX', active: true },
          ],
        },
      },
      { id: 'payment_provider_paydunya', enabled: true, master_key_encrypted: 'encrypted' },
      { id: 'payment_provider_mbiyo', enabled: true, secret_key_encrypted: 'encrypted' },
      {
        id: 'payment_provider_afribapay',
        enabled: true,
        api_user_encrypted: 'encrypted-user',
        api_key_encrypted: 'encrypted-key',
        merchant_key_encrypted: 'encrypted-merchant',
        agent_id_encrypted: 'encrypted-agent',
      },
    ],
  });
  const result = await call(service, undefined, '/api/transfer/config', 'GET');
  assert.equal(result.status, 200);
  assert.equal(result.body.mobile_money.enabled, true);
  assert.deepEqual(result.body.mobile_money.operators.map(item => item.code), [
    'moov_tg', 'orange_tg', 'moov',
  ]);
  assert.equal(JSON.stringify(result.body).includes('encrypted'), false);

  const unauthorized = await call(
    { handleRoute: (req, res) => service.handleRoute({ ...req, headers: { authorization: 'Bearer bad' } }, res) },
    undefined, '/api/transfer/config', 'GET',
  );
  assert.equal(unauthorized.status, 401);
});

function transferBody(overrides = {}) {
  return {
    transfer_type: 'biz_to_biz',
    recipient: 'bob',
    amount: 200,
    currency: 'XOF',
    description: 'Test internal transfer',
    idempotency_key: 'transfer-request-01',
    turnstile_token: 'turnstile-ok',
    pin: '123456',
    ...overrides,
  };
}

test('Biz-to-Biz transfer atomically updates both accounts and notifies once', async () => {
  const { store, service, sentNotifications } = setup();
  const first = await call(service, transferBody());
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.transaction.direction, 'out');
  assert.equal(first.body.transaction.metadata.wallet_snapshot.balance_before, 1000);
  assert.equal(first.body.transaction.metadata.wallet_snapshot.balance_after, 800);
  assert.equal(store.docs.users.get('sender').balance_xof, 800);
  assert.equal(store.docs.users.get('recipient').balance_xof, 250);
  assert.equal(store.docs.transactions.size, 2);
  assert.equal(sentNotifications.length, 1);

  const retry = await call(service, transferBody());
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent_replay, true);
  assert.equal(retry.body.transaction.id, first.body.transaction.id);
  assert.equal(store.docs.users.get('sender').balance_xof, 800);
  assert.equal(store.docs.users.get('recipient').balance_xof, 250);
  assert.equal(store.docs.transactions.size, 2);
  assert.equal(sentNotifications.length, 1);

  const conflictingRetry = await call(service, transferBody({ amount: 250 }));
  assert.equal(conflictingRetry.status, 409);
  assert.equal(store.docs.users.get('sender').balance_xof, 800);
  assert.equal(store.docs.users.get('recipient').balance_xof, 250);
});

test('transfer enforces KYC, PIN, and idempotency key before changing balances', async () => {
  const unverified = setup({ kycStatus: 'pending' });
  const deniedKyc = await call(unverified.service, transferBody());
  assert.equal(deniedKyc.status, 403);
  assert.equal(unverified.store.docs.users.get('sender').balance_xof, 1000);

  const wrongPin = setup({ validPin: false });
  const deniedPin = await call(wrongPin.service, transferBody());
  assert.equal(deniedPin.status, 401);
  assert.equal(deniedPin.body.detail.code, 'USER_PIN_INVALID');
  assert.equal(wrongPin.store.docs.users.get('sender').balance_xof, 1000);

  const missingKey = await call(setup().service, transferBody({ idempotency_key: '' }));
  assert.equal(missingKey.status, 400);
});

test('legacy payout types stay fail-closed until their provider routes are migrated', async () => {
  const { store, service } = setup();
  const result = await call(service, transferBody({ transfer_type: 'biz_to_mobile' }));
  assert.equal(result.status, 503);
  assert.equal(result.body.detail.code, 'MIGRATION_INCOMPLETE');
  assert.equal(store.docs.users.get('sender').balance_xof, 1000);
  assert.equal(store.docs.users.get('recipient').balance_xof, 50);
});

test('email OTP setting blocks rather than bypassing confirmation during migration', async () => {
  const { store, service } = setup({ withdrawalOtp: true, emailSender: '' });
  const result = await call(service, transferBody());
  assert.equal(result.status, 503);
  assert.equal(store.docs.users.get('sender').balance_xof, 1000);
  assert.equal(store.docs.users.get('recipient').balance_xof, 50);
});

test('email OTP is sent, bound to the transfer, consumed once, and supports safe retry', async () => {
  const { store, service, sentEmails } = setup({ withdrawalOtp: true });
  const request = transferBody();
  const challenge = await call(service, request);
  assert.equal(challenge.status, 200);
  assert.equal(challenge.body.withdrawal_otp_required, true);
  assert.equal(challenge.body.email_hint, 'a***@example.test');
  assert.equal(sentEmails.length, 1);
  assert.equal(store.docs.users.get('sender').balance_xof, 1000);

  const code = sentEmails[0].text.match(/ : (\d{6})/)[1];
  const wrongCode = code === '000000' ? '000001' : '000000';
  const rejected = await call(service, {
    ...request,
    withdrawal_otp_challenge_id: challenge.body.challenge_id,
    withdrawal_otp_code: wrongCode,
  });
  assert.equal(rejected.status, 400);
  assert.equal(store.docs.users.get('sender').balance_xof, 1000);

  const confirmed = await call(service, {
    ...request,
    withdrawal_otp_challenge_id: challenge.body.challenge_id,
    withdrawal_otp_code: code,
  });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(store.docs.users.get('sender').balance_xof, 800);
  assert.equal(store.docs.users.get('recipient').balance_xof, 250);
  assert.equal(store.docs.withdrawal_email_otps.get('sender').status, 'used');

  const retry = await call(service, request);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.idempotent_replay, true);
  assert.equal(store.docs.users.get('sender').balance_xof, 800);
});

test('email OTP cancellation only changes the caller’s active challenge', async () => {
  const { store, service } = setup();
  store.docs.withdrawal_email_otps.set('sender', {
    id: 'sender', challenge_id: 'challenge-1', status: 'active',
  });
  const result = await call(service, { challenge_id: 'challenge-1' }, '/api/transfers/email-otp/cancel');
  assert.equal(result.status, 200);
  assert.equal(store.docs.withdrawal_email_otps.get('sender').status, 'cancelled');
  assert.equal(store.docs.withdrawal_email_otps.get('sender').challenge_id, 'challenge-1');
});
