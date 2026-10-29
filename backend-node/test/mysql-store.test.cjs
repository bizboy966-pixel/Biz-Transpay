'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MySqlStore, createPreviewPool } = require('../src/mysql-store.cjs');
const { Collection } = require('../src/document-store.cjs');

function fakePool() {
  const calls = [];
  const metadataRows = [
    { COLUMN_NAME: 'doc_id' }, { COLUMN_NAME: 'raw_document' },
    { COLUMN_NAME: 'field_id' }, { COLUMN_NAME: 'field__id' },
  ];
  const connection = {
    beginTransaction: async () => calls.push('begin'),
    commit: async () => calls.push('commit'),
    rollback: async () => calls.push('rollback'),
    release: () => calls.push('release'),
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('information_schema.COLUMNS')) return [metadataRows];
      return sql.startsWith('SELECT raw_document') ? [[{ raw_document: '{"id":"alice"}' }]]
        : [{ affectedRows: 1 }];
    },
  };
  return {
    calls,
    getConnection: async () => connection,
    execute: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS migration_locks')) {
        calls.push('ensure-lock-table');
        return [{ affectedRows: 0 }];
      }
      if (sql.includes('information_schema.COLUMNS')) {
        return [metadataRows];
      }
      throw new Error(`Unexpected pool SQL: ${sql}`);
    },
  };
}

test('MySQL transaction uses parameterized SQL, ordered locks and a single connection', async () => {
  const pool = fakePool();
  await new MySqlStore(pool).transaction(async repo => {
    await repo.lockWallets();
    assert.deepEqual(await repo.get('users', "' OR 1=1"), { id: 'alice' });
    await repo.replace('users', 'alice', { id: 'alice' });
    await repo.insert('wallet_operations', 'id', { id: 'id' });
  });
  assert.equal(pool.calls.find(item => typeof item === 'string'), 'ensure-lock-table');
  assert.ok(pool.calls.includes('begin'));
  assert.deepEqual(pool.calls.slice(-2), ['commit', 'release']);
  const select = pool.calls.find(c => c.sql?.startsWith('SELECT raw_document'));
  assert.equal(select.sql.includes("' OR 1=1"), false);
  assert.deepEqual(select.params, ["' OR 1=1"]);
  assert.deepEqual(pool.calls.filter(c => c.sql?.startsWith('SELECT lock_name'))
    .map(c => c.params[0]), ['users', 'wallet_operations']);
});

test('MySQL failures roll back and release the connection', async () => {
  const pool = fakePool();
  await assert.rejects(new MySqlStore(pool).transaction(async () => { throw new Error('failure'); }));
  assert.deepEqual(pool.calls.filter(item => typeof item === 'string'),
    ['ensure-lock-table', 'begin', 'rollback', 'release']);
});

test('does not accept PostgreSQL URLs or a missing Preview database', () => {
  for (const url of [undefined, '', 'postgresql://example/test', 'mysql://example/']) {
    assert.throws(() => createPreviewPool(url));
  }
});

test('MySQL health check executes a lightweight SELECT 1 ping', async () => {
  const calls = [];
  const store = new MySqlStore({
    execute: async sql => {
      calls.push(sql);
      return [[{ 1: 1 }]];
    },
  });
  assert.equal(await store.healthCheck(), true);
  assert.deepEqual(calls, ['SELECT 1']);
});

function documentPool() {
  const rows = new Map();
  const locks = new Set();
  const writes = [];
  const selectDocuments = (table, params) => {
    const docs = [...rows.entries()].filter(([key]) => key.startsWith(`${table}:`)).map(([, doc]) => doc);
    const candidate = params;
    const filtered = !candidate.length ? docs : docs.filter(doc => {
      for (let i = 0; i < candidate.length; i += 4) {
        const field = candidate[i].slice(2).split('.').at(-1);
        const value = doc[field];
        if (value !== candidate[i + 1]
            && !(Array.isArray(value) && value.includes(candidate[i + 2]))) return false;
      }
      return true;
    });
    return filtered;
  };
  const pool = {
    async getConnection() {
      let snapshot;
      return {
        async beginTransaction() { snapshot = new Map(rows); },
        async commit() { snapshot = undefined; },
        async rollback() { rows.clear(); for (const [k, v] of snapshot ?? []) rows.set(k, v); },
        release() {},
        async execute(sql, params = []) {
          if (sql.startsWith('INSERT INTO migration_locks')) { locks.add(params[0]); return [{ affectedRows: 1 }]; }
          if (sql.startsWith('SELECT lock_name')) return [[{ lock_name: params[0] }]];
          if (sql.startsWith('INSERT INTO `')) {
            writes.push({ sql, params });
            const table = sql.match(/^INSERT INTO `([^`]+)`/)[1];
            const [id, raw] = params;
            const key = `${table}:${id}`;
            if (rows.has(key)) { const error = new Error('duplicate'); error.code = 'ER_DUP_ENTRY'; throw error; }
            rows.set(key, JSON.parse(raw));
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith('SELECT raw_document FROM `') && sql.includes('WHERE doc_id=?')) {
            const table = sql.match(/^SELECT raw_document FROM `([^`]+)`/)[1];
            const doc = rows.get(`${table}:${params[0]}`);
            return [doc ? [{ raw_document: doc }] : []];
          }
          if (sql.startsWith('SELECT raw_document FROM `')) {
            const table = sql.match(/^SELECT raw_document FROM `([^`]+)`/)[1];
            return [selectDocuments(table, params).map(raw_document => ({ raw_document }))];
          }
          if (sql.startsWith('UPDATE `')) {
            writes.push({ sql, params });
            const table = sql.match(/^UPDATE `([^`]+)`/)[1];
            const oldId = params.at(-1);
            const newId = params[0];
            const doc = JSON.parse(params[1]);
            if (oldId !== newId) rows.delete(`${table}:${oldId}`);
            rows.set(`${table}:${newId}`, doc);
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith('DELETE FROM `')) {
            const table = sql.match(/^DELETE FROM `([^`]+)`/)[1];
            rows.delete(`${table}:${params[0]}`); return [{ affectedRows: 1 }];
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      };
    },
    async execute(sql, params) {
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS migration_locks')) return [{ affectedRows: 0 }];
      if (sql.includes('information_schema.COLUMNS')) {
        return [[
          { COLUMN_NAME: 'doc_id' }, { COLUMN_NAME: 'raw_document' },
          { COLUMN_NAME: 'field__id' }, { COLUMN_NAME: 'field_balance_xof' },
          { COLUMN_NAME: 'field_id' }, { COLUMN_NAME: 'field_tags' },
          { COLUMN_NAME: 'field_username' },
        ]];
      }
      if (sql.startsWith('INSERT INTO `')) {
        writes.push({ sql, params });
        const table = sql.match(/^INSERT INTO `([^`]+)`/)[1];
        const [id, raw] = params;
        const key = `${table}:${id}`;
        if (rows.has(key)) { const error = new Error('duplicate'); error.code = 'ER_DUP_ENTRY'; throw error; }
        rows.set(key, JSON.parse(raw)); return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('SELECT raw_document FROM `')) {
        const table = sql.match(/^SELECT raw_document FROM `([^`]+)`/)[1];
        if (sql.includes('WHERE doc_id=?')) {
          const doc = rows.get(`${table}:${params[0]}`);
          return [doc ? [{ raw_document: doc }] : []];
        }
        return [selectDocuments(table, params).map(raw_document => ({ raw_document }))];
      }
      throw new Error(`Unexpected pool SQL: ${sql}`);
    },
    async end() {},
  };
  return { pool, rows, locks, writes };
}

test('document collections provide parameterized CRUD, filters and aggregation', async () => {
  const fake = documentPool();
  const store = new MySqlStore(fake.pool);
  const users = new Collection(store, 'users');
  await users.insert_one({ id: 'a', username: 'alpha', balance_xof: 500, tags: ['one'] });
  await users.insert_one({ id: 'b', username: 'beta', balance_xof: 200, tags: ['two'] });
  assert.equal((await users.find_one({ username: { $regex: '^ALPHA$', $options: 'i' } })).id, 'a');
  assert.equal(await users.count_documents({ balance_xof: { $gte: 300 } }), 1);
  assert.deepEqual(await users.distinct('tags'), [['one'], ['two']]);
  const changed = await users.update_one({ id: 'a' }, {
    $inc: { balance_xof: 25 }, $addToSet: { tags: 'one' },
  });
  assert.deepEqual(changed, { matched_count: 1, modified_count: 1 });
  assert.equal((await users.find_one({ id: 'a' })).balance_xof, 525);
  const insert = fake.writes.find(write => write.sql.startsWith('INSERT INTO `users`'));
  const insertColumns = [...insert.sql.matchAll(/`([^`]+)`/g)].map(match => match[1]);
  const insertedFields = insertColumns.filter(column => column.startsWith('field_'));
  assert.equal(insert.params[2 + insertedFields.indexOf('field_balance_xof')], '500');
  assert.equal(insert.params[2 + insertedFields.indexOf('field_tags')], '["one"]');
  const update = fake.writes.find(write => write.sql.startsWith('UPDATE `users`'));
  const updateColumns = [...update.sql.matchAll(/`([^`]+)`=\?/g)].map(match => match[1]);
  const updateValues = Object.fromEntries(updateColumns.map((column, index) =>
    [column, update.params[index]]));
  assert.equal(updateValues.field_balance_xof, '525');
  assert.equal(updateValues.field_tags, '["one"]');
  assert.equal(JSON.parse(updateValues.raw_document).balance_xof, 525);
  assert.ok(fake.locks.has('users'));
  const groups = await users.aggregate([
    { $group: { _id: '$username', total: { $sum: '$balance_xof' } } },
  ]).to_list();
  assert.equal(groups.length, 2);
  assert.equal((await users.delete_one({ id: 'b' })).deleted_count, 1);
});
