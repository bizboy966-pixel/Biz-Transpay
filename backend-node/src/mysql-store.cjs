'use strict';

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
  constructor(pool) { this.pool = pool; }

  async transaction(callback) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const repo = {
        // InnoDB row locks are released with commit/rollback, unlike GET_LOCK().
        // Fixed collection order must be used by every future wallet writer.
        lockCollection: async name => {
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
          const [rows] = await connection.execute(
            'SELECT document FROM document_store WHERE collection=? AND doc_id=? FOR UPDATE',
            [collection, id]);
          return rows.length ? decodeDocument(rows[0].document) : null;
        },
        replace: async (collection, id, doc) => {
          await connection.execute(
            'UPDATE document_store SET document=?, updated_at=UTC_TIMESTAMP(6) WHERE collection=? AND doc_id=?',
            [JSON.stringify(doc), collection, id]);
        },
        insert: async (collection, id, doc) => {
          await connection.execute(
            'INSERT INTO document_store (collection, doc_id, document) VALUES (?, ?, ?)',
            [collection, id, JSON.stringify(doc)]);
        },
      };
      const result = await callback(repo);
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

module.exports = { MySqlStore, createPreviewPool };
