'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MySqlStore, createPreviewPool } = require('../src/mysql-store.cjs');
const { Collection } = require('../src/document-store.cjs');

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

function documentPool() {
  const rows = new Map();
  const locks = new Set();
  const selectDocuments = params => {
    const docs = [...rows.entries()].filter(([key]) => key.startsWith(`${params[0]}:`)).map(([, doc]) => doc);
    const candidate = params.slice(1);
    const filtered = !candidate.length ? docs : docs.filter(doc => {
      for (let i = 0; i < candidate.length; i += 4) {
        const field = candidate[i].slice(2);
        const value = doc[field];
        if (value !== candidate[i + 1]
            && !(Array.isArray(value) && value.includes(candidate[i + 2]))) return false;
      }
      return true;
    });
    return [filtered.map(document => ({ document }))];
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
          if (sql.startsWith('INSERT INTO document_store')) {
            const [collection, id, raw] = params;
            const key = `${collection}:${id}`;
            if (rows.has(key)) { const error = new Error('duplicate'); error.code = 'ER_DUP_ENTRY'; throw error; }
            rows.set(key, JSON.parse(raw));
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith('SELECT document FROM document_store WHERE collection=? AND doc_id=?')) {
            const doc = rows.get(`${params[0]}:${params[1]}`);
            return [doc ? [{ document: doc }] : []];
          }
          if (sql.startsWith('SELECT document FROM document_store WHERE collection=?')) {
            return selectDocuments(params);
          }
          if (sql.startsWith('UPDATE document_store')) {
            let collection; let oldId; let newId; let doc;
            if (sql.includes('SET doc_id=?')) {
              const [nextId, raw, collectionName, previousId] = params;
              newId = nextId; oldId = previousId; collection = collectionName; doc = JSON.parse(raw);
              rows.delete(`${collection}:${oldId}`); rows.set(`${collection}:${newId}`, doc);
            } else if (sql.startsWith('UPDATE document_store SET document=')) {
              const [raw, collectionName, previousId] = params;
              collection = collectionName; oldId = previousId; doc = JSON.parse(raw);
              rows.set(`${collection}:${oldId}`, doc);
            } else { throw new Error(`Unexpected update: ${sql}`); }
            return [{ affectedRows: 1 }];
          }
          if (sql.startsWith('DELETE FROM document_store')) {
            rows.delete(`${params[0]}:${params[1]}`); return [{ affectedRows: 1 }];
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      };
    },
    async execute(sql, params) {
      if (sql.startsWith('SELECT document FROM document_store WHERE collection=?')) {
        return selectDocuments(params);
      }
      if (sql.startsWith('INSERT INTO document_store')) {
        const [collection, id, raw] = params;
        const key = `${collection}:${id}`;
        if (rows.has(key)) { const error = new Error('duplicate'); error.code = 'ER_DUP_ENTRY'; throw error; }
        rows.set(key, JSON.parse(raw)); return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected pool SQL: ${sql}`);
    },
    async end() {},
  };
  return { pool, rows, locks };
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
  assert.ok(fake.locks.has('users'));
  const groups = await users.aggregate([
    { $group: { _id: '$username', total: { $sum: '$balance_xof' } } },
  ]).to_list();
  assert.equal(groups.length, 2);
  assert.equal((await users.delete_one({ id: 'b' })).deleted_count, 1);
});
