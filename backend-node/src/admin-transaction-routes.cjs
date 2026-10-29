'use strict';

const { authorizeAdmin } = require('./admin-authorization.cjs');
const { escapeRegex } = require('./admin-user-routes.cjs');
const { enrichWalletSnapshot } = require('./user-data-routes.cjs');

const TX_SEARCH_FIELDS = [
  'id', 'reference', 'provider_reference', 'external_reference', 'counterparty',
  'description', 'currency', 'type', 'customer_email', 'payer_email',
  'izipay_intent_id', 'izipay_payout_id', 'tx_hash', 'txid', 'tx_id',
  'wallet_address', 'deposit_address', 'destination_address', 'crypto_address',
  'metadata.tx_hash', 'metadata.txid', 'metadata.tx_id', 'metadata.wallet_address',
  'metadata.deposit_address', 'metadata.destination_address', 'metadata.crypto_address',
  'metadata.recipient_address', 'metadata.customer_email', 'metadata.payer_email',
  'metadata.email', 'metadata.phone_number', 'metadata.customer_phone',
  'metadata.provider_reference', 'metadata.provider_id', 'metadata.transaction_id',
  'metadata.provider_transaction_id', 'metadata.merchant_reference',
  'metadata.transaction_reference', 'metadata.biztranspay_reference',
  'metadata.reference', 'metadata.paydunya_reference', 'metadata.paydunya_token',
  'metadata.mbiyo_transaction_id', 'metadata.afribapay_transaction_id',
  'metadata.izipay_intent_id', 'metadata.izipay_payout_id',
  'metadata.merchant_payment_id', 'metadata.external_reference', 'metadata.link_id',
  'metadata.coin', 'metadata.crypto', 'metadata.network', 'metadata.asset_code',
  'metadata.recipient', 'metadata.recipient_name',
];

function reply(res, status, body) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function createAdminTransactionRoutes({ db, sessionService, env = process.env }) {
  async function handleRoute(req, res) {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { return false; }
    const listRoute = url.pathname === '/api/admin/transactions';
    const detailMatch = /^\/api\/admin\/transactions\/([^/]+)$/.exec(url.pathname);
    if (!((req.method === 'GET' && listRoute) || (req.method === 'GET' && detailMatch))) {
      return false;
    }

    const action = detailMatch ? 'admin_transaction_detail' : 'admin_transactions_list';
    let authorized;
    try {
      authorized = await authorizeAdmin(req, {
        db, sessionService, env,
        permission: 'transactions:read',
        action,
      });
    } catch (error) {
      reply(res, error.status || 500, {
        detail: error.code ? { code: error.code, message: error.message } : error.message || 'Erreur interne.',
      });
      return true;
    }
    void authorized;

    try {
      if (detailMatch) {
        let txId;
        try { txId = decodeURIComponent(detailMatch[1]); }
        catch { reply(res, 400, { detail: 'Identifiant de transaction invalide' }); return true; }
        let transaction = await db.collection('transactions').find_one(
          { id: txId }, { _id: 0 },
        );
        if (!transaction) {
          reply(res, 404, { detail: 'Transaction introuvable' });
          return true;
        }
        transaction = await enrichWalletSnapshot(db, transaction);
        const user = await db.collection('users').find_one(
          { id: String(transaction.user_id) },
          {
            _id: 0, id: 1, username: 1, full_name: 1, email: 1,
            phone: 1, country: 1, balance_usdt: 1, balance_xof: 1,
          },
        );
        transaction.user = user || {};
        reply(res, 200, transaction);
        return true;
      }

      const query = {};
      const type = url.searchParams.get('type');
      const status = url.searchParams.get('status');
      if (type) {
        if (type.length > 32) {
          reply(res, 422, { detail: 'Type de transaction invalide' });
          return true;
        }
        query.type = type;
      }
      if (status) {
        if (status.length > 32) {
          reply(res, 422, { detail: 'Statut de transaction invalide' });
          return true;
        }
        query.status = status;
      }
      const rawLimit = url.searchParams.get('limit');
      const limit = rawLimit == null ? 500 : Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
        reply(res, 422, { detail: 'Limite invalide (1–2000)' });
        return true;
      }

      const searchText = String(url.searchParams.get('q') || '').trim();
      if (searchText) {
        if (searchText.length > 100) {
          reply(res, 422, { detail: 'Recherche trop longue' });
          return true;
        }
        const rx = { $regex: escapeRegex(searchText), $options: 'i' };
        const matchingUsers = await db.collection('users').find({
          $or: [
            { email: rx }, { username: rx }, { full_name: rx }, { phone: rx },
          ],
        }, { _id: 0, id: 1 }).to_list(1000);
        const userIds = matchingUsers.map(user => String(user.id));
        query.$or = TX_SEARCH_FIELDS.map(field => ({ [field]: rx }));
        if (userIds.length) query.$or.push({ user_id: { $in: userIds } });
      }

      const transactions = await db.collection('transactions').find(query, { _id: 0 })
        .sort('created_at', -1).to_list(limit);
      const userIds = [...new Set(transactions.map(tx => String(tx.user_id || '')).filter(Boolean))];
      const users = userIds.length
        ? await db.collection('users').find({ id: { $in: userIds } }, {
          _id: 0, id: 1, username: 1, full_name: 1, email: 1,
        }).to_list(userIds.length)
        : [];
      const usersById = new Map(users.map(user => [String(user.id), user]));
      reply(res, 200, transactions.map(tx => ({
        ...tx,
        user: usersById.get(String(tx.user_id)) || null,
      })));
    } catch (error) {
      reply(res, error.status || 500, {
        detail: error.code ? { code: error.code, message: error.message } : error.message || 'Erreur interne.',
      });
    }
    return true;
  }

  return { handleRoute };
}

module.exports = { createAdminTransactionRoutes, TX_SEARCH_FIELDS };
