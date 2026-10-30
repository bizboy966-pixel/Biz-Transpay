'use strict';
const { Collection, safeCollection, matches } = require('./document-store.cjs');

// Deliberately has no default DATABASE_URL: cannot accidentally use the existing app DB.
function createPreviewPool(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid Preview MySQL URL'); }
  if (parsed.protocol !== 'mysql:' || !parsed.hostname || parsed.pathname.length < 2) {
    throw new Error('A dedicated Preview MySQL database is required');
  }
  // Do not log URLs or driver errors (they may contain credentials/SQL/document data).
  const mysql = require('mysql2/promise');
  return mysql.createPool({
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.slice(1)),
    charset: 'utf8mb4', timezone: 'Z',
    connectionLimit: 5, multipleStatements: false,
    supportBigNumbers: true, bigNumberStrings: true,
    ...(parsed.searchParams.get('ssl') === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
  });
}

function decodeDocument(value) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

class MySqlStore {
  constructor(pool) {
    this.pool = pool;
    this.columnCache = new Map();
    this.lockTableReady = null;
  }

  async columnsForCollection(name, executor = this.pool) {
    const collection = safeCollection(name);
    if (!this.columnCache.has(collection)) {
      const pending = executor.execute(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',
        [collection],
      ).then(([rows]) => {
        const columns = new Set(rows.map(row => row.COLUMN_NAME ?? row.column_name));
        if (!columns.has('doc_id') || !columns.has('raw_document')) {
          const error = new Error(`Split-table schema is missing required columns for ${collection}`);
          error.code = 'SPLIT_SCHEMA_MISSING';
          throw error;
        }
        return [...columns].filter(column => /^field_[A-Za-z0-9_]+$/.test(column)).sort();
      }).catch(error => {
        this.columnCache.delete(collection);
        throw error;
      });
      this.columnCache.set(collection, pending);
    }
    return this.columnCache.get(collection);
  }

  async healthCheck() {
    await this.pool.execute('SELECT 1');
    return true;
  }

  async ensureLockTable() {
    if (!this.lockTableReady) {
      this.lockTableReady = this.pool.execute(
        `CREATE TABLE IF NOT EXISTS migration_locks (
          lock_name VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
          PRIMARY KEY (lock_name)
        ) ENGINE=InnoDB`,
      ).catch(error => {
        this.lockTableReady = null;
        throw error;
      });
    }
    await this.lockTableReady;
  }

  async transaction(callback) {
    await this.ensureLockTable();
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const repo = {
        // InnoDB row locks are released with commit/rollback, unlike GET_LOCK().
        // Fixed collection order must be used by every future wallet writer.
        lockCollection: async name => {
          safeCollection(name);
          await connection.execute(
            'INSERT INTO migration_locks (lock_name) VALUES (?) ON DUPLICATE KEY UPDATE lock_name=VALUES(lock_name)',
            [name]);
          await connection.execute(
            'SELECT lock_name FROM migration_locks WHERE lock_name=? FOR UPDATE', [name]);
        },
        lockWallets: async () => {
          for (const name of ['users', 'wallet_operations']) await repo.lockCollection(name);
        },
        get: async (collection, id) => {
          return new Collection(this, collection)._getById(id, connection, true);
        },
        replace: async (collection, id, doc) => {
          return new Collection(this, collection)._updateDocument(id, id, doc, connection);
        },
        insert: async (collection, id, doc) => {
          return new Collection(this, collection)._insertDocument(id, doc, connection);
        },
        find: async (collection, query = {}) => {
          const table = new Collection(this, collection);
          const candidate = Object.fromEntries(Object.entries(query).filter(([field, value]) => (
            /^[A-Za-z0-9_]+$/.test(field) && typeof value === 'string'
          )));
          const docs = await table._all(
            Object.keys(candidate).length ? candidate : null, connection,
          );
          return docs.filter(document => matches(document, query));
        },
        deleteMany: async (collection, query = {}) => (
          new Collection(this, collection)._delete(query, true, connection)
        ),
      };
      const result = await callback(repo, connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  collection(name) {
    const { Collection } = require('./document-store.cjs');
    return new Collection(this, name);
  }

  async close() { await this.pool.end(); }
}

module.exports = { MySqlStore, createPreviewPool, decodeDocument };
