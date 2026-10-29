'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createExchangeRoutes, uuid5 } = require('../src/exchange-routes.cjs');

function clone(value) { return structuredClone(value); }

class AtomicStore {
  constructor({ user, settings = [], failLedgerInsert = false }) {
    this.docs = {
      users: new Map([[String(user.id), clone(user)]]),
      wallet_operations: new Map(),
      transactions: new Map(),
      settings: new Map(settings.map(item => [String(item.id), clone(item)])),
    };
    this.failLedgerInsert = failLedgerInsert;
    this.transactionQueue = Promise.resolve();
  }

  collection(name) {
    return {
      find_one: async query => {
        const rows = [...(this.docs[name]?.values() || [])];
        const row = rows.find(item => Object.entries(query).every(([key, value]) =>
          String(item[key]) === String(value)));
        return row ? clone(row) : null;
      },
      insert_one: async document => {
        if (name === 'transactions' && this.failLedgerInsert) {
          const error = new Error('transaction insert failed');
          error.code = 'ER_DUP_ENTRY';
          throw error;
        }
        const id = String(document.id);
        if (this.docs[name].has(id)) {
          const error = new Error('duplicate');
          error.code = 'ER_DUP_ENTRY';
          throw error;
        }
        this.docs[name].set(id, clone(document));
        return { inserted_id: id };
      },
    };
  }

  async transaction(callback) {
    const previous = this.transactionQueue;
    let unlock;
    this.transactionQueue = new Promise(resolve => { unlock = resolve; });
    await previous;
    const draft = Object.fromEntries(Object.entries(this.docs)
      .map(([name, rows]) => [name, new Map([...rows].map(([id, doc]) => [id, clone(doc)]))]));
    const repo = {
      lockWallets: async () => {},
      get: async (collection, id) => {
        const row = draft[collection]?.get(String(id));
        return row ? clone(row) : null;
      },
      replace: async (collection, id, document) => {
        draft[collection].set(String(id), clone(document));
      },
      insert: async (collection, id, document) => {
        if (collection === 'transactions' && this.failLedgerInsert) {
          const error = new Error('transaction insert failed');
          error.code = 'ER_DUP_ENTRY';
          throw error;
        }
        if (draft[collection].has(String(id))) {
          const error = new Error('duplicate');
          error.code = 'ER_DUP_ENTRY';
          throw error;
        }
        draft[collection].set(String(id), clone(document));
      },
    };
    try {
      const result = await callback(repo);
      this.docs = draft;
      return result;
    } finally {
      unlock();
    }
  }
}

function setup({ balanceXof = 2000, kycStatus = 'verified', lastAuthAt = new Date(),
  failLedgerInsert = false } = {}) {
  const store = new AtomicStore({
    user: {
      id: 'user-1', kyc_status: kycStatus,
      balance_xof: balanceXof, balance_xaf: 0,
      balance_crypto_usdt_trc20: 0,
    },
    settings: [
      {
        id: 'platform_config',
        conversion_rates: { XOF_XAF: 1 },
        conversion_limits: { XOF_XAF: { min: 500, max: 5000000 } },
        conversion_pairs_enabled: { XOF_XAF: true },
        conversion_fee: { enabled: true, type: 'percent', value: 0.5, min_fee: 0, max_fee: null },
      },
      { id: 'app_features', wallet_xof_enabled: true, wallet_xaf_enabled: true, wallet_crypto_enabled: true },
    ],
    failLedgerInsert,
  });
  const notifications = [];
  const cryptoCatalog = {
    async exchangeRateContext(_config, from, to) {
      assert.equal(from, 'XOF');
      assert.equal(to, 'XAF');
      return {
        source: { code: 'XOF', wallet_field: 'balance_xof', kind: 'fiat' },
        destination: { code: 'XAF', wallet_field: 'balance_xaf', kind: 'fiat' },
        rate: 1, pair: 'XOF_XAF', limits: { min: 500, max: 5000000 },
      };
    },
    computeConversionFee(config, amount) {
      if (config.enabled === false) return 0;
      return Math.round(amount * Number(config.value || 0) / 100 * 1_000_000) / 1_000_000;
    },
  };
  const service = createExchangeRoutes({
    db: store,
    sessionService: {
      async authenticate(token) {
        if (token === 'valid-session') {
          return {
            userId: 'user-1',
            session: { last_auth_at: lastAuthAt },
          };
        }
        throw Object.assign(new Error('Session requise'), { status: 401 });
      },
      requireRecentAuth(session) {
        if (new Date(session.session.last_auth_at).getTime() < Date.now() - 15 * 60 * 1000) {
          throw Object.assign(new Error('Réauthentification requise pour cette opération.'), {
            status: 428, code: 'REAUTH_REQUIRED',
          });
        }
        return session.userId;
      },
    },
    cryptoCatalog,
    notify: async (...args) => { notifications.push(args); },
  });
  return { store, service, notifications };
}

function request(body) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = 'POST';
  req.url = '/api/exchange';
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

async function call(service, body) {
  const res = response();
  const handled = await service.handleRoute(request(body), res);
  return { handled, status: res.status, body: res.body ? JSON.parse(res.body) : null };
}

test('UUIDv5 transaction identity matches the legacy namespace layout', () => {
  assert.match(uuid5('user-1', 'exchange:user-1:abcdefgh'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('exchange commits both wallet legs and transaction history atomically, then notifies once', async () => {
  const { service, store, notifications } = setup();
  const body = {
    from_currency: 'XOF', to_currency: 'XAF', amount: 500,
    idempotency_key: 'exchange-2026-01',
  };
  const first = await call(service, body);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.fee, 2.5);
  assert.equal(first.body.received, 497.5);
  assert.equal(store.docs.users.get('user-1').balance_xof, 1500);
  assert.equal(store.docs.users.get('user-1').balance_xaf, 497.5);
  assert.equal(store.docs.transactions.size, 1);
  assert.equal(store.docs.wallet_operations.size, 1);
  assert.equal(notifications.length, 1);
  assert.equal(first.body.transaction.type, 'exchange');
  assert.equal(first.body.transaction.status, 'completed');
  assert.equal(first.body.transaction.metadata.wallet_operation_id,
    first.body.transaction.metadata.operation_id);

  const retry = await call(service, body);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.transaction.id, first.body.transaction.id);
  assert.equal(store.docs.users.get('user-1').balance_xof, 1500);
  assert.equal(store.docs.users.get('user-1').balance_xaf, 497.5);
  assert.equal(store.docs.transactions.size, 1);
  assert.equal(notifications.length, 1);
});

test('concurrent retries with the same exchange key create one ledger row and one wallet mutation', async () => {
  const { service, store, notifications } = setup();
  const body = {
    from_currency: 'XOF', to_currency: 'XAF', amount: 500,
    idempotency_key: 'exchange-concurrent-01',
  };
  const results = await Promise.all(Array.from({ length: 8 }, () => call(service, body)));
  assert.deepEqual(results.map(result => result.status), Array(8).fill(200));
  assert.equal(store.docs.users.get('user-1').balance_xof, 1500);
  assert.equal(store.docs.users.get('user-1').balance_xaf, 497.5);
  assert.equal(store.docs.transactions.size, 1);
  assert.equal(store.docs.wallet_operations.size, 1);
  assert.equal(notifications.length, 1);
});

test('exchange rejects key reuse with different input and insufficient balance without changing wallets', async () => {
  const { service, store } = setup({ balanceXof: 600 });
  const first = await call(service, {
    from_currency: 'XOF', to_currency: 'XAF', amount: 500,
    idempotency_key: 'exchange-2026-02',
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const conflict = await call(service, {
    from_currency: 'XOF', to_currency: 'XAF', amount: 550,
    idempotency_key: 'exchange-2026-02',
  });
  assert.equal(conflict.status, 409);
  assert.equal(store.docs.transactions.size, 1);
  assert.equal(store.docs.users.get('user-1').balance_xof, 100);

  const insufficient = await call(service, {
    from_currency: 'XOF', to_currency: 'XAF', amount: 500,
  });
  assert.equal(insufficient.status, 400);
  assert.equal(store.docs.users.get('user-1').balance_xof, 100);
  assert.equal(store.docs.users.get('user-1').balance_xaf, 497.5);
});

test('exchange requires approved KYC and rolls back wallet claims when the ledger insert fails', async () => {
  const requestBody = { from_currency: 'XOF', to_currency: 'XAF', amount: 500 };
  const kyc = setup({ kycStatus: 'pending' });
  const denied = await call(kyc.service, requestBody);
  assert.equal(denied.status, 403, JSON.stringify(denied.body));
  assert.equal(kyc.store.docs.users.get('user-1').balance_xof, 2000);
  assert.equal(kyc.store.docs.transactions.size, 0);

  const brokenLedger = setup({ failLedgerInsert: true });
  const failed = await call(brokenLedger.service, requestBody);
  assert.equal(failed.status, 500);
  assert.equal(brokenLedger.store.docs.users.get('user-1').balance_xof, 2000);
  assert.equal(brokenLedger.store.docs.users.get('user-1').balance_xaf, 0);
  assert.equal(brokenLedger.store.docs.wallet_operations.size, 0);
  assert.equal(brokenLedger.store.docs.transactions.size, 0);
});

test('integration exchange uses the same KYC, wallet, ledger, and idempotency path', async () => {
  const { service, store, notifications } = setup();
  const payload = {
    from_currency: 'XOF',
    to_currency: 'XAF',
    amount: 1000,
    idempotency_key: 'merchant-exchange-001',
  };
  const first = await service.handleIntegration('user-1', payload);
  const retry = await service.handleIntegration('user-1', payload);

  assert.equal(first.handled, true);
  assert.equal(first.status, 200);
  assert.equal(first.body.transaction.status, 'completed');
  assert.deepEqual(retry.body, first.body);
  assert.equal(store.docs.users.get('user-1').balance_xof, 1000);
  assert.equal(store.docs.users.get('user-1').balance_xaf, 995);
  assert.equal(store.docs.transactions.size, 1);
  assert.equal(store.docs.wallet_operations.size, 1);
  assert.equal(notifications.length, 1);
});

test('exchange requires recent authentication before parsing or mutating a transaction', async () => {
  const { service, store } = setup({ lastAuthAt: new Date(Date.now() - 16 * 60 * 1000) });
  const result = await call(service, {
    from_currency: 'XOF', to_currency: 'XAF', amount: 500,
  });
  assert.equal(result.status, 428);
  assert.equal(result.body.detail.code, 'REAUTH_REQUIRED');
  assert.equal(store.docs.users.get('user-1').balance_xof, 2000);
});
