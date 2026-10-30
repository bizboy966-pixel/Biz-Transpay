'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
  createAdminLegacyMerchantRoutes,
  fingerprint,
} = require('../src/admin-legacy-merchant-routes.cjs');

function request(method, body) {
  const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  req.method = method;
  req.url = '/api/admin/maintenance/legacy-merchant-api';
  req.headers = body ? { 'content-type': 'application/json' } : {};
  return req;
}
function response() {
  return {
    writeHead(status) { this.status = status; },
    end(text) { this.body = JSON.parse(text); },
  };
}
function setup(rows, admin = { id: 'owner-1', role: 'super_admin', platform_owner: true }) {
  const state = { deleted: [], audit: null, committed: false, rolledBack: false };
  const pool = {
    async execute(sql) {
      assert.match(sql, /SELECT d\.collection, d\.doc_id/);
      return [structuredClone(rows), []];
    },
    async getConnection() {
      return {
        async beginTransaction() {},
        async execute(sql, params) {
          if (sql.startsWith('SELECT')) return [structuredClone(rows), []];
          if (sql.startsWith('DELETE')) {
            state.deleted.push(params);
            return [{ affectedRows: 1 }, []];
          }
          if (sql.startsWith('INSERT INTO document_store')) {
            state.audit = JSON.parse(params[2]);
            return [{ affectedRows: 1 }, []];
          }
          throw new Error('Unexpected SQL');
        },
        async commit() { state.committed = true; },
        async rollback() { state.rolledBack = true; },
        release() {},
      };
    },
  };
  const db = { pool };
  const routes = createAdminLegacyMerchantRoutes({
    db,
    sessionService: {},
    env: {},
    authorizeAdminImpl: async () => ({ admin }),
  });
  return { routes, state };
}

test('legacy merchant cleanup preview is owner-only and returns a stable fingerprint', async () => {
  const rows = [
    { collection: 'api_keys', doc_id: 'api-1' },
    { collection: 'merchant_keys', doc_id: 'merchant-1' },
  ];
  const { routes } = setup(rows);
  const res = response();
  assert.equal(await routes.handleRoute(request('GET'), res), true);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.counts, { api_keys: 1, merchant_keys: 1 });
  assert.equal(res.body.total, 2);
  assert.equal(res.body.fingerprint, fingerprint(rows));
});

test('legacy cleanup deletes only the fingerprinted rows and writes an audit entry', async () => {
  const rows = [
    { collection: 'api_keys', doc_id: 'api-1' },
    { collection: 'merchant_keys', doc_id: 'merchant-1' },
  ];
  const { routes, state } = setup(rows);
  const res = response();
  assert.equal(await routes.handleRoute(request('POST', {
    confirmation: 'RETIRER_ANCIENNE_API',
    fingerprint: fingerprint(rows),
  }), res), true);
  assert.equal(res.status, 200);
  assert.equal(res.body.deleted, 2);
  assert.equal(state.deleted.length, 2);
  assert.equal(state.committed, true);
  assert.equal(state.rolledBack, false);
  assert.equal(state.audit.action, 'legacy_merchant_api_data_cleanup');
});

test('stale fingerprint rolls the cleanup transaction back without deleting records', async () => {
  const rows = [{ collection: 'api_keys', doc_id: 'api-1' }];
  const { routes, state } = setup(rows);
  const res = response();
  assert.equal(await routes.handleRoute(request('POST', {
    confirmation: 'RETIRER_ANCIENNE_API',
    fingerprint: '0'.repeat(64),
  }), res), true);
  assert.equal(res.status, 409);
  assert.equal(state.deleted.length, 0);
  assert.equal(state.rolledBack, true);
});

test('legacy cleanup refuses non-owner administrators', async () => {
  const { routes, state } = setup(
    [{ collection: 'api_keys', doc_id: 'api-1' }],
    { id: 'admin-2', role: 'super_admin', platform_owner: false },
  );
  const res = response();
  assert.equal(await routes.handleRoute(request('GET'), res), true);
  assert.equal(res.status, 403);
  assert.equal(state.deleted.length, 0);
});
