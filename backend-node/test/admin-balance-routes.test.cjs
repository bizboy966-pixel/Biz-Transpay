'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createAdminBalanceRoutes } = require('../src/admin-balance-routes.cjs');

function clone(value) { return structuredClone(value); }

class AtomicStore {
  constructor({ failRepoInsert = null } = {}) {
    this.docs = {
      users: new Map([
        ['staff-1', {
          id: 'staff-1', username: 'financier', role: 'admin',
          admin_role: 'finance', two_fa_enabled: true,
        }],
        ['user-1', {
          id: 'user-1', username: 'awa', balance_xof: 1000, balance_xaf: 0,
          balance_usdt: 7, balance_crypto_usdt_trc20: 0,
        }],
      ]),
      wallet_operations: new Map(),
      transactions: new Map(),
      admin_logs: new Map(),
    };
    this.failRepoInsert = failRepoInsert;
    this.queue = Promise.resolve();
  }

  collection(name) {
    return {
      find_one: async query => {
        const rows = [...(this.docs[name]?.values() || [])];
        const item = rows.find(row => Object.entries(query).every(([key, value]) =>
          String(row[key]) === String(value)));
        return item ? clone(item) : null;
      },
      insert_one: async document => {
        const id = String(document.id);
        this.docs[name].set(id, clone(document));
        return { inserted_id: id };
      },
    };
  }

  async transaction(callback) {
    const previous = this.queue;
    let unlock;
    this.queue = new Promise(resolve => { unlock = resolve; });
    await previous;
    const draft = Object.fromEntries(Object.entries(this.docs).map(([name, rows]) => [
      name, new Map([...rows].map(([id, doc]) => [id, clone(doc)])),
    ]));
    const repo = {
      lockWallets: async () => {},
      get: async (collection, id) => draft[collection].has(String(id))
        ? clone(draft[collection].get(String(id))) : null,
      replace: async (collection, id, document) => {
        draft[collection].set(String(id), clone(document));
      },
      insert: async (collection, id, document) => {
        if (collection === this.failRepoInsert) throw new Error('atomic audit write failed');
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

function setup({ role = 'finance', authMethod = 'totp', lastAuthAt = new Date(),
  activeAssets = true, failRepoInsert = null } = {}) {
  const db = new AtomicStore({ failRepoInsert });
  db.docs.users.get('staff-1').admin_role = role;
  const cryptoCatalog = {
    async activeExchangeAssets() {
      return activeAssets ? new Map([['USDT.TRC20', {
        code: 'USDT.TRC20', coin: 'USDT', network: 'TRC20',
        wallet_field: 'balance_crypto_usdt_trc20',
      }]]) : new Map();
    },
  };
  const sessionService = {
    async authenticate(token) {
      if (token !== 'staff-session') {
        throw Object.assign(new Error('Session requise'), { status: 401, code: 'SESSION_REQUIRED' });
      }
      return {
        userId: 'staff-1',
        session: {
          admin_auth_method: authMethod,
          last_auth_at: lastAuthAt,
          admin_panel_unlocked_at: new Date(),
        },
      };
    },
    requireRecentAuth(identity) {
      if (Date.parse(identity.session.last_auth_at) < Date.now() - 15 * 60 * 1000) {
        throw Object.assign(new Error('Réauthentification requise'), {
          status: 428, code: 'REAUTH_REQUIRED',
        });
      }
      return identity.userId;
    },
  };
  return {
    db,
    service: createAdminBalanceRoutes({ db, sessionService, cryptoCatalog, env: {} }),
  };
}

function request(body, path = '/api/admin/users/user-1/credit') {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.url = path;
  req.headers = { authorization: 'Bearer staff-session' };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}

function response() {
  return {
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
}

async function call(service, body, path) {
  const res = response();
  const handled = await service.handleRoute(request(body, path), res);
  return { handled, status: res.status, body: res.body };
}

function xofCredit(overrides = {}) {
  return {
    currency: 'XOF', amount: 500, reason: 'correction manuelle',
    action_id: 'credit-action-0001', confirmation: 'confirmer',
    ...overrides,
  };
}

test('admin credit requires fresh password-plus-TOTP and the explicit confirmation phrase', async () => {
  const pinLogin = setup({ authMethod: 'pin' });
  const pinDenied = await call(pinLogin.service, xofCredit());
  assert.equal(pinDenied.status, 428);
  assert.equal(pinDenied.body.detail.code, 'REAUTH_REQUIRED');
  assert.equal(pinLogin.db.docs.users.get('user-1').balance_xof, 1000);

  const stale = setup({ lastAuthAt: new Date(Date.now() - 16 * 60 * 1000) });
  assert.equal((await call(stale.service, xofCredit())).status, 428);
  assert.equal(stale.db.docs.users.get('user-1').balance_xof, 1000);

  const missingPhrase = setup();
  const noConfirmation = await call(missingPhrase.service, xofCredit({ confirmation: '' }));
  assert.equal(noConfirmation.status, 428);
  assert.equal(noConfirmation.body.detail.code, 'ADMIN_CONFIRMATION_REQUIRED');
  assert.equal(missingPhrase.db.docs.users.get('user-1').balance_xof, 1000);
});

test('admin credit updates wallet, ledger, snapshot and audit atomically; retries do not credit twice', async () => {
  const { db, service } = setup();
  const first = await call(service, xofCredit());
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  assert.equal(first.body.applied, true);
  assert.equal(db.docs.users.get('user-1').balance_xof, 1500);
  assert.equal(db.docs.transactions.size, 1);
  assert.equal(db.docs.wallet_operations.size, 1);
  const ledger = [...db.docs.transactions.values()][0];
  assert.equal(ledger.type, 'deposit');
  assert.equal(ledger.direction, 'in');
  assert.equal(ledger.currency, 'XOF');
  assert.equal(ledger.metadata.admin_id, 'staff-1');
  assert.equal(ledger.metadata.wallet_operation_id, ledger.metadata.operation_id);
  const snapshot = [...db.docs.wallet_operations.values()][0].snapshot;
  assert.equal(snapshot.balance_before, 1000);
  assert.equal(snapshot.balance_after, 1500);
  assert.ok([...db.docs.admin_logs.values()].some(log =>
    log.action === 'credit' && log.target_user_id === 'user-1'));

  const retry = await call(service, xofCredit());
  assert.equal(retry.status, 200);
  assert.equal(retry.body.applied, false);
  assert.equal(db.docs.users.get('user-1').balance_xof, 1500);
  assert.equal(db.docs.transactions.size, 1);

  const conflict = await call(service, xofCredit({ amount: 600 }));
  assert.equal(conflict.status, 409);
  assert.equal(db.docs.users.get('user-1').balance_xof, 1500);
});

test('crypto admin credit uses the exact active asset/network wallet, never legacy USDT', async () => {
  const { db, service } = setup();
  const result = await call(service, {
    currency: 'USDT', asset_id: 'USDT.TRC20', amount: 1.25,
    action_id: 'credit-crypto-0001', confirmation: 'CONFIRMER',
  });
  assert.equal(result.status, 200);
  assert.equal(db.docs.users.get('user-1').balance_crypto_usdt_trc20, 1.25);
  assert.equal(db.docs.users.get('user-1').balance_usdt, 7);
  const ledger = [...db.docs.transactions.values()][0];
  assert.equal(ledger.currency, 'USDT.TRC20');
  assert.equal(ledger.metadata.asset_id, 'USDT.TRC20');
  assert.equal(ledger.metadata.network, 'TRC20');

  const disabled = setup({ activeAssets: false });
  const rejected = await call(disabled.service, {
    currency: 'USDT', asset_id: 'USDT.TRC20', amount: 1,
    action_id: 'credit-crypto-0002', confirmation: 'CONFIRMER',
  });
  assert.equal(rejected.status, 400);
  assert.equal(disabled.db.docs.users.get('user-1').balance_crypto_usdt_trc20, 0);
});

test('admin debit checks funds atomically, records the withdrawal, and is idempotent', async () => {
  const { db, service } = setup();
  const body = xofCredit({ amount: 400, action_id: 'debit-action-0001' });
  const first = await call(service, body, '/api/admin/users/user-1/debit');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.applied, true);
  assert.equal(db.docs.users.get('user-1').balance_xof, 600);
  assert.equal(db.docs.transactions.size, 1);
  const ledger = [...db.docs.transactions.values()][0];
  assert.equal(ledger.type, 'withdrawal');
  assert.equal(ledger.direction, 'out');
  assert.equal(ledger.amount, 400);
  assert.equal(ledger.description, 'Débit administrateur (correction manuelle)');
  const snapshot = [...db.docs.wallet_operations.values()][0].snapshot;
  assert.equal(snapshot.balance_before, 1000);
  assert.equal(snapshot.balance_after, 600);

  const retry = await call(service, body, '/api/admin/users/user-1/debit');
  assert.equal(retry.status, 200);
  assert.equal(retry.body.applied, false);
  assert.equal(db.docs.users.get('user-1').balance_xof, 600);
  assert.equal(db.docs.transactions.size, 1);

  const insufficient = await call(service,
    xofCredit({ amount: 601, action_id: 'debit-action-0002' }),
    '/api/admin/users/user-1/debit');
  assert.equal(insufficient.status, 400);
  assert.equal(insufficient.body.detail, 'Solde utilisateur insuffisant');
  assert.equal(db.docs.users.get('user-1').balance_xof, 600);
  assert.equal(db.docs.transactions.size, 1);
});

test('finance permission is required and atomic ledger/audit failure rolls the credit back', async () => {
  const support = setup({ role: 'support' });
  const forbidden = await call(support.service, xofCredit());
  assert.equal(forbidden.status, 403);
  assert.equal(support.db.docs.users.get('user-1').balance_xof, 1000);

  const auditFailure = setup({ failRepoInsert: 'admin_logs' });
  const failed = await call(auditFailure.service, xofCredit());
  assert.equal(failed.status, 500);
  assert.equal(auditFailure.db.docs.users.get('user-1').balance_xof, 1000);
  assert.equal(auditFailure.db.docs.wallet_operations.size, 0);
  assert.equal(auditFailure.db.docs.transactions.size, 0);
});
