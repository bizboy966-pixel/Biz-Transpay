'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MySqlStore, createPreviewPool } = require('../src/mysql-store.cjs');

function fakePool() {
  const calls = [];
  const connection = {
    beginTransaction: async () => calls.push('begin'),
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
    release: () => calls.push('release'),
    execute: async (sql, params) => {
      calls.push({ sql, params });
      return sql.startsWith('SELECT document') ? [[{ document: '{"id":"alice"}' }]]
        : [{ affectedRows: 1 }];
    },
  };
  return { calls, getConnection: async () => connection };
}

test('MySQL transaction uses parameterized SQL, ordered locks and a single connection', async () => {
  const pool = fakePool();
  await new MySqlStore(pool).transaction(async repo => {
    await repo.lockWallets();
    assert.deepEqual(await repo.get('users', "' OR 1=1"), { id: 'alice' });
    await repo.replace('users', 'alice', { id: 'alice' });
    await repo.insert('wallet_operations', 'id', { id: 'id' });
  });
  assert.equal(pool.calls[0], 'begin');
  assert.deepEqual(pool.calls.slice(-2), ['commit', 'release']);
  const select = pool.calls.find(c => c.sql?.startsWith('SELECT document'));
  assert.equal(select.sql.includes("' OR 1=1"), false);
  assert.deepEqual(select.params, ['users', "' OR 1=1"]);
  assert.deepEqual(pool.calls.filter(c => c.sql?.startsWith('SELECT lock_name'))
    .map(c => c.params[0]), ['users', 'wallet_operations']);
});

test('MySQL failures roll back and release the connection', async () => {
  const pool = fakePool();
  await assert.rejects(new MySqlStore(pool).transaction(async () => { throw new Error('failure'); }));
  assert.deepEqual(pool.calls, ['begin', 'rollback', 'release']);
});

test('does not accept PostgreSQL URLs or a missing Preview database', () => {
  for (const url of [undefined, '', 'postgresql://example/test', 'mysql://example/']) {
    assert.throws(() => createPreviewPool(url));
  }
});
