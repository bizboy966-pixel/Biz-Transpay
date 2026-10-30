'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { authorizeAdmin } = require('./admin-authorization.cjs');
const { readJson } = require('./auth-login.cjs');

const OLD_COLLECTIONS = [
  'api_keys', 'merchant_keys', 'merchant_webhooks',
  'merchant_payments', 'merchant_payouts', 'webhook_deliveries',
];
const SELECTOR = `(
  d.collection IN (${OLD_COLLECTIONS.map(() => '?').join(',')})
  OR (d.collection IN ('api_logs','idempotency_keys')
      AND (JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.path')) LIKE '/api/v1/%'
           OR JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.path')) = '/api/v1'))
  OR (d.collection IN ('momo_deposits','payment_transactions')
      AND (JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.source')) = 'merchant_api'
           OR JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.metadata.source')) = 'merchant_api')
      AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.idempotency_key')), '') NOT LIKE 'btpi_%'
      AND NOT EXISTS (
        SELECT 1 FROM document_store i
        WHERE i.collection = 'integration_operations'
          AND JSON_UNQUOTE(JSON_EXTRACT(i.document,'$.business_id'))
              = JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.id'))
          AND JSON_UNQUOTE(JSON_EXTRACT(i.document,'$.user_id'))
              = JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.user_id'))
      ))
  OR (d.collection = 'transactions'
      AND NOT EXISTS (
        SELECT 1 FROM document_store i
        WHERE i.collection = 'integration_operations'
          AND JSON_UNQUOTE(JSON_EXTRACT(i.document,'$.business_id'))
              = JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.id'))
          AND JSON_UNQUOTE(JSON_EXTRACT(i.document,'$.user_id'))
              = JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.user_id'))
      )
      AND (
        EXISTS (
          SELECT 1 FROM document_store p
          WHERE p.collection = 'merchant_payments'
            AND JSON_UNQUOTE(JSON_EXTRACT(p.document,'$.id'))
                = JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.metadata.merchant_payment_id'))
            AND JSON_UNQUOTE(JSON_EXTRACT(p.document,'$.merchant_id'))
                = JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.user_id'))
        )
        OR EXISTS (
          SELECT 1 FROM document_store p
          WHERE p.collection = 'merchant_payouts'
            AND JSON_UNQUOTE(JSON_EXTRACT(p.document,'$.id'))
                = JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.metadata.merchant_payout_id'))
            AND JSON_UNQUOTE(JSON_EXTRACT(p.document,'$.merchant_id'))
                = JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.user_id'))
        )
        OR EXISTS (
          SELECT 1 FROM document_store m
          WHERE m.collection = 'momo_deposits'
            AND JSON_UNQUOTE(JSON_EXTRACT(m.document,'$.source')) = 'merchant_api'
            AND JSON_UNQUOTE(JSON_EXTRACT(m.document,'$.user_id'))
                = JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.user_id'))
            AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.document,'$.idempotency_key')), '')
                NOT LIKE 'btpi_%'
            AND JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.id'))
                = CONCAT(JSON_UNQUOTE(JSON_EXTRACT(m.document,'$.provider')),
                         '-deposit-', JSON_UNQUOTE(JSON_EXTRACT(m.document,'$.id')))
        )
        OR (JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.metadata.source')) = 'merchant_api'
            AND JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.metadata.product')) = 'bizpush'
            AND JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.metadata.environment')) IN ('test','live')
            AND JSON_UNQUOTE(JSON_EXTRACT(d.document,'$.description')) LIKE 'BizPUSH%')
      ))
)`;

function fingerprint(rows) {
  const sorted = [...rows].sort((a, b) => {
    const left = `${a.collection}/${a.doc_id}`;
    const right = `${b.collection}/${b.doc_id}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return createHash('sha256')
    .update(sorted.map(row => `${row.collection}/${row.doc_id}`).join('\n'))
    .digest('hex');
}
function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
function isOwner(admin) {
  return admin?.role === 'super_admin' && admin?.platform_owner === true;
}

function createAdminLegacyMerchantRoutes({
  db, sessionService, env = process.env, authorizeAdminImpl = authorizeAdmin,
}) {
  const params = OLD_COLLECTIONS;
  async function select(executor, forUpdate = false) {
    const [rows] = await executor.execute(
      `SELECT d.collection, d.doc_id FROM document_store d WHERE ${SELECTOR}
       ORDER BY d.collection, d.doc_id${forUpdate ? ' FOR UPDATE' : ''}`,
      params,
    );
    return rows;
  }
  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const isPreview = req.method === 'GET'
      && url.pathname === '/api/admin/maintenance/legacy-merchant-api';
    const isExecute = req.method === 'POST'
      && url.pathname === '/api/admin/maintenance/legacy-merchant-api';
    if (!isPreview && !isExecute) return false;
    try {
      const { admin } = await authorizeAdminImpl(req, {
        db, sessionService, env,
        permission: 'platform:reset',
        action: isPreview ? 'legacy_merchant_cleanup_preview' : 'legacy_merchant_cleanup',
        sensitive: true,
      });
      if (!isOwner(admin)) {
        reply(res, 403, { detail: 'Réservé au propriétaire de la plateforme.' });
        return true;
      }
      if (!db?.pool?.execute) {
        reply(res, 503, { detail: 'La base MySQL ne permet pas cet aperçu sécurisé.' });
        return true;
      }
      if (isPreview) {
        const rows = await select(db.pool);
        const counts = {};
        for (const row of rows) counts[row.collection] = (counts[row.collection] || 0) + 1;
        reply(res, 200, { counts, total: rows.length, fingerprint: fingerprint(rows) });
        return true;
      }
      const body = await readJson(req, 8 * 1024);
      if (body?.confirmation !== 'RETIRER_ANCIENNE_API'
          || typeof body?.fingerprint !== 'string'
          || !/^[a-f0-9]{64}$/.test(body.fingerprint)) {
        reply(res, 428, { detail: 'Aperçu récent et confirmation exacte requis.' });
        return true;
      }
      const connection = await db.pool.getConnection();
      try {
        await connection.beginTransaction();
        const rows = await select(connection, true);
        const counts = {};
        for (const row of rows) counts[row.collection] = (counts[row.collection] || 0) + 1;
        const currentFingerprint = fingerprint(rows);
        if (!rows.length || currentFingerprint !== body.fingerprint) {
          await connection.rollback();
          reply(res, 409, {
            detail: 'La sélection a changé ou est vide. Actualise l’aperçu avant de confirmer.',
          });
          return true;
        }
        for (const row of rows) {
          const [deleted] = await connection.execute(
            'DELETE FROM document_store WHERE collection = ? AND doc_id = ?',
            [row.collection, row.doc_id],
          );
          if (Number(deleted.affectedRows) !== 1) {
            await connection.rollback();
            reply(res, 409, {
              detail: 'La sélection a changé. Aucune suppression conservée.',
            });
            return true;
          }
        }
        const auditId = randomUUID();
        const audit = {
          id: auditId,
          admin_id: String(admin.id),
          action: 'legacy_merchant_api_data_cleanup',
          details: { counts, total: rows.length, fingerprint: currentFingerprint },
          created_at: new Date().toISOString(),
        };
        await connection.execute(
          'INSERT INTO document_store (collection, doc_id, document) VALUES (?, ?, ?)',
          ['admin_logs', auditId, JSON.stringify(audit)],
        );
        await connection.commit();
        reply(res, 200, { counts, total: rows.length, deleted: rows.length });
      } catch (error) {
        await connection.rollback().catch(() => {});
        throw error;
      } finally {
        connection.release();
      }
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 503;
      reply(res, status, {
        detail: status >= 500 ? 'Impossible de traiter le nettoyage sécurisé.' : error.message,
      });
    }
    return true;
  }
  return { handleRoute, fingerprint, OLD_COLLECTIONS, SELECTOR };
}

module.exports = { createAdminLegacyMerchantRoutes, fingerprint };
