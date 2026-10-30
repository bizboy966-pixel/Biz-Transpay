'use strict';

const { authorizeAdmin } = require('./admin-authorization.cjs');
const { escapeRegex } = require('./admin-user-routes.cjs');
const { enrichWalletSnapshot } = require('./user-data-routes.cjs');
const { readJson } = require('./auth-login.cjs');
const { applyWalletOperation } = require('./wallet.cjs');

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

function transactionWalletField(tx, user) {
  const currency = String(tx.currency || '').toLowerCase();
  const meta = tx.metadata || {};
  const field = String(meta.wallet_field || meta.walletField || `balance_${currency}`);
  if (!/^balance_[a-z0-9_]{2,40}$/.test(field)
      || (!Object.hasOwn(user, field)
        && !['balance_xof', 'balance_xaf', 'balance_usdt'].includes(field))) {
    return null;
  }
  return field;
}

function adminLog(admin, action, tx, details, now) {
  return {
    id: `admin-tx:${action}:${tx.id}`,
    admin_id: String(admin.id),
    admin_username: String(admin.username || ''),
    action,
    target_user_id: String(tx.user_id || ''),
    target_username: null,
    details: { tx_id: String(tx.id), type: String(tx.type || ''), ...details },
    created_at: now,
  };
}

function createAdminTransactionRoutes({
  db, sessionService, env = process.env, notify, getCryptoPayout,
  authorizeAdminImpl = authorizeAdmin,
}) {
  async function handleRoute(req, res) {
    let url;
    try { url = new URL(req.url || '/', 'http://localhost'); }
    catch { return false; }
    const conversionsRoute = url.pathname === '/api/admin/conversions';
    const listRoute = url.pathname === '/api/admin/transactions';
    const logsRoute = url.pathname === '/api/admin/logs';
    const detailMatch = /^\/api\/admin\/transactions\/([^/]+)$/.exec(url.pathname);
    const actionMatch = req.method === 'POST'
      ? /^\/api\/admin\/transactions\/([^/]+)\/(approve|reject|refresh)$/.exec(url.pathname)
      : null;
    if (!((req.method === 'GET' && (listRoute || conversionsRoute || logsRoute))
        || (req.method === 'GET' && detailMatch) || actionMatch)) {
      return false;
    }

    const action = actionMatch ? `admin_transaction_${actionMatch[2]}`
      : logsRoute ? 'read_admin_logs'
      : conversionsRoute ? 'admin_conversions_list'
      : detailMatch ? 'admin_transaction_detail' : 'admin_transactions_list';
    let authorized;
    try {
      authorized = await authorizeAdminImpl(req, {
        db, sessionService, env,
        permission: actionMatch ? 'transactions:write'
          : logsRoute ? 'audit:read'
          : conversionsRoute ? 'finance:read' : 'transactions:read',
        action,
        ...(actionMatch ? { sensitive: true } : {}),
      });
    } catch (error) {
      reply(res, error.status || 500, {
        detail: error.code ? { code: error.code, message: error.message } : error.message || 'Erreur interne.',
      });
      return true;
    }
    void authorized;

    try {
      if (actionMatch?.[2] === 'refresh') {
        const txId = decodeURIComponent(actionMatch[1]);
        if (!txId || txId.length > 160) {
          reply(res, 422, { detail: 'Identifiant de transaction invalide.' });
          return true;
        }
        const tx = await db.collection('transactions').find_one({ id: txId }, { _id: 0 });
        if (!tx) {
          reply(res, 404, { detail: 'Transaction introuvable.' });
          return true;
        }
        if (tx.status !== 'pending') {
          reply(res, 200, {
            ok: true, unchanged: true, reason: `status=${tx.status || 'unknown'}`, tx,
          });
          return true;
        }
        const metadata = tx.metadata || {};
        const payoutId = String(metadata.izipay_payout_id || '').trim();
        if (!payoutId) {
          reply(res, 409, {
            detail: 'Cette transaction ne possède pas de référence de payout vérifiable.',
          });
          return true;
        }
        if (typeof getCryptoPayout !== 'function') {
          reply(res, 503, { detail: 'La vérification des payouts crypto est indisponible.' });
          return true;
        }

        let providerResponse;
        try {
          providerResponse = await getCryptoPayout(payoutId);
        } catch (error) {
          reply(res, error.status || 502, {
            detail: error.message || 'Statut du payout indisponible; aucun solde n’a été modifié.',
          });
          return true;
        }
        const providerData = providerResponse?.data && typeof providerResponse.data === 'object'
          ? providerResponse.data : providerResponse;
        const upstreamStatus = String(providerData?.status || '').trim().toLowerCase();
        if (!upstreamStatus) {
          reply(res, 502, { detail: 'Le prestataire n’a pas retourné de statut vérifiable.' });
          return true;
        }
        const successful = ['completed', 'confirmed', 'success', 'successful', 'sent_success'];
        const failed = ['failed', 'rejected', 'error', 'canceled', 'cancelled'];
        if (!successful.includes(upstreamStatus) && !failed.includes(upstreamStatus)) {
          reply(res, 200, {
            ok: true, unchanged: true, upstream_status: upstreamStatus, tx,
          });
          return true;
        }

        const now = new Date().toISOString();
        const updates = { 'metadata.izipay_status': upstreamStatus };
        const txHash = String(providerData.txHash || providerData.txhash || '').trim();
        if (txHash && txHash.length <= 256) updates['metadata.tx_hash'] = txHash;
        if (successful.includes(upstreamStatus)) {
          updates.status = 'completed';
          updates.completed_at = now;
          updates['metadata.izipay_confirmed_at'] = now;
          const changed = await db.collection('transactions').update_one(
            { id: txId, status: 'pending' }, { $set: updates },
          );
          if (!changed.modified_count) {
            const current = await db.collection('transactions').find_one({ id: txId }, { _id: 0 });
            reply(res, 200, { ok: true, unchanged: true, tx: current || tx });
            return true;
          }
          await db.collection('admin_logs').insert_one(adminLog(
            authorized.admin, 'tx_refresh_completed', tx,
            { payout_id: payoutId, upstream_status: upstreamStatus }, now,
          ));
          if (typeof notify === 'function') {
            try {
              await notify(
                String(tx.user_id), 'withdrawal_success', 'Retrait crypto confirmé',
                'Votre retrait crypto a été confirmé par le prestataire.',
                {
                  transaction_id: tx.id,
                  reference: tx.reference || null,
                  amount: tx.amount,
                  currency: tx.currency,
                  tx_hash: txHash || null,
                },
              );
            } catch { /* Notification delivery does not undo provider settlement. */ }
          }
        } else {
          // Re-read immediately before the refund. The wallet operation shares
          // the same stable refund id used by administrative rejection.
          const latest = await db.collection('transactions').find_one({ id: txId }, { _id: 0 });
          if (!latest || latest.status !== 'pending') {
            reply(res, 200, { ok: true, unchanged: true, tx: latest || tx });
            return true;
          }
          const userId = String(latest.user_id || '');
          const user = userId
            ? await db.collection('users').find_one({ id: userId }, { _id: 0 }) : null;
          const field = user && transactionWalletField(latest, user);
          const totalDebit = Number(latest.metadata?.total_debit ?? latest.amount);
          if (!field || !Number.isFinite(totalDebit) || totalDebit <= 0) {
            reply(res, 409, {
              detail: 'Le portefeuille source ou le montant réservé est introuvable; aucun remboursement effectué.',
            });
            return true;
          }
          updates.status = 'failed';
          updates.failed_at = now;
          updates['metadata.refunded'] = true;
          const operationId = `manual-reject:${txId}`;
          const walletResult = await applyWalletOperation(db, {
            userId,
            operationId,
            direction: 'credit',
            primaryField: field,
            increments: { [field]: totalDebit },
            legacyMarkers: [['wallet_credit_operation_ids', `transaction:${txId}`]],
            ledger: {
              id: `crypto-payout-refund:${txId}`,
              user_id: userId,
              type: 'refund',
              direction: 'in',
              amount: totalDebit,
              currency: String(latest.currency || 'USDT').toUpperCase(),
              status: 'completed',
              reference: latest.reference || `BTP-REFUND-${txId.slice(0, 16)}`,
              description: `Remboursement du payout crypto ${latest.reference || txId}`,
              created_at: now,
              completed_at: now,
              metadata: {
                source_transaction_id: txId,
                operation_id: operationId,
                wallet_operation_id: operationId,
                provider_reference: payoutId,
                provider_status: upstreamStatus,
              },
            },
            adminLog: adminLog(authorized.admin, 'tx_refresh_failed', latest, {
              operation_id: operationId,
              payout_id: payoutId,
              upstream_status: upstreamStatus,
              refunded: totalDebit,
            }, now),
          });
          if (!['applied', 'already'].includes(walletResult.state)) {
            reply(res, 409, {
              detail: 'Le remboursement atomique a échoué; le statut de la transaction reste inchangé.',
            });
            return true;
          }
          if (walletResult.snapshot) {
            updates.wallet_snapshot = walletResult.snapshot;
            updates.balance_before = walletResult.snapshot.balance_before;
            updates.balance_after = walletResult.snapshot.balance_after;
          }
          await db.collection('transactions').update_one(
            { id: txId, status: 'pending' }, { $set: updates },
          );
        }
        const refreshed = await db.collection('transactions').find_one({ id: txId }, { _id: 0 });
        reply(res, 200, {
          ok: true,
          tx: refreshed || tx,
          upstream_status: upstreamStatus,
          mapped_status: successful.includes(upstreamStatus) ? 'completed' : 'failed',
        });
        return true;
      }

      if (actionMatch) {
        const body = await readJson(req, 16 * 1024);
        if (String(body.confirmation || '').trim() !== 'CONFIRMER') {
          reply(res, 422, { detail: 'Confirmation requise.' });
          return true;
        }
        const txId = decodeURIComponent(actionMatch[1]);
        const tx = await db.collection('transactions').find_one({ id: txId }, { _id: 0 });
        if (!tx) {
          reply(res, 404, { detail: 'Transaction introuvable' });
          return true;
        }
        if (tx.status !== 'pending') {
          reply(res, 409, { detail: `Transaction déjà ${tx.status || 'traitée'}.` });
          return true;
        }
        const admin = authorized.admin;
        const now = new Date().toISOString();
        const metadata = tx.metadata || {};
        const type = String(tx.type || '').toLowerCase();
        const direction = String(tx.direction || '').toLowerCase();
        const amount = Number(tx.amount || 0);
        if (!Number.isFinite(amount) || amount <= 0 || !tx.user_id) {
          reply(res, 422, { detail: 'Transaction invalide.' });
          return true;
        }
        const user = await db.collection('users').find_one(
          { id: String(tx.user_id) }, { _id: 0 },
        );
        if (!user) {
          reply(res, 404, { detail: 'Utilisateur introuvable.' });
          return true;
        }

        const isApprove = actionMatch[2] === 'approve';
        const isDeposit = type === 'deposit';
        const isOutgoing = direction === 'out' || [
          'withdrawal', 'transfer', 'exchange', 'payout', 'crypto_payout',
        ].includes(type);
        if (isApprove && isOutgoing) {
          const kyc = await db.collection('kyc').find_one(
            { user_id: String(tx.user_id) }, { _id: 0 },
          );
          const kycStatus = String(user.kyc_status || kyc?.status || '').toLowerCase();
          if (!user.kyc_verified && !user.is_kyc_verified
              && !['approved', 'verified', 'complete', 'completed'].includes(kycStatus)) {
            reply(res, 403, { detail: 'KYC approuvé requis avant validation du retrait.' });
            return true;
          }
        }

        const providerOutcome = String(body.provider_outcome || '').trim();
        const evidenceReference = String(body.provider_outcome_evidence_reference || '').trim();
        if (providerOutcome && (
          ![
            'provider_confirmed_paid', 'operator_verified_manual_completion',
            'provider_confirmed_not_paid', 'provider_confirmed_rejected',
          ].includes(providerOutcome)
          || evidenceReference.length > 240
          || body.provider_outcome_attested !== true
        )) {
          reply(res, 422, { detail: 'Attestation prestataire invalide.' });
          return true;
        }

        let walletResult = null;
        let refunded = 0;
        let operationId = '';
        let field = '';
        if (isApprove && isDeposit) {
          field = transactionWalletField(tx, user);
          const creditAmount = Number(metadata.amount_net ?? tx.amount);
          if (!field || !Number.isFinite(creditAmount) || creditAmount <= 0) {
            reply(res, 422, { detail: 'Portefeuille ou montant du dépôt invalide.' });
            return true;
          }
          operationId = `manual-approve:${txId}`;
          const log = adminLog(admin, 'tx_approve', tx, {
            operation_id: operationId,
            amount,
            ...(providerOutcome ? {
              provider_outcome: providerOutcome,
              provider_outcome_evidence_reference: evidenceReference,
              provider_outcome_attested: true,
            } : {}),
          }, now);
          walletResult = await applyWalletOperation(db, {
            userId: String(tx.user_id),
            operationId,
            direction: 'credit',
            primaryField: field,
            increments: { [field]: creditAmount },
            ledger: {
              id: `manual-approve-ledger:${txId}`,
              user_id: String(tx.user_id),
              type: 'deposit',
              direction: 'in',
              amount: creditAmount,
              currency: String(tx.currency || 'XOF').toUpperCase(),
              status: 'completed',
              reference: tx.reference || `BTP-MANUAL-${txId.slice(0, 16)}`,
              description: `Validation administrative du dépôt ${tx.reference || txId}`,
              created_at: tx.created_at || now,
              completed_at: now,
              metadata: {
                ...metadata,
                operation_id: operationId,
                wallet_operation_id: operationId,
                source_transaction_id: txId,
              },
            },
            adminLog: log,
          });
          if (!['applied', 'already'].includes(walletResult.state)) {
            reply(res, 409, { detail: 'Crédit du dépôt refusé; aucun statut n’a été changé.' });
            return true;
          }
        } else if (!isApprove && ['withdrawal', 'transfer'].includes(type)
          && direction === 'out') {
          field = transactionWalletField(tx, user);
          refunded = Number(metadata.total_debit ?? (amount + Number(metadata.fee || 0)));
          if (!field || !Number.isFinite(refunded) || refunded <= 0) {
            reply(res, 422, { detail: 'Portefeuille ou montant du remboursement invalide.' });
            return true;
          }
          operationId = `manual-reject:${txId}`;
          const log = adminLog(admin, 'tx_reject', tx, {
            operation_id: operationId,
            reason: String(body.reason || '').slice(0, 500),
            refunded,
            ...(providerOutcome ? {
              provider_outcome: providerOutcome,
              provider_outcome_evidence_reference: evidenceReference,
              provider_outcome_attested: true,
            } : {}),
          }, now);
          walletResult = await applyWalletOperation(db, {
            userId: String(tx.user_id),
            operationId,
            direction: 'credit',
            primaryField: field,
            increments: { [field]: refunded },
            ledger: {
              id: `manual-reject-refund:${txId}`,
              user_id: String(tx.user_id),
              type: 'refund',
              direction: 'in',
              amount: refunded,
              currency: String(tx.currency || 'XOF').toUpperCase(),
              status: 'completed',
              reference: tx.reference || `BTP-REFUND-${txId.slice(0, 16)}`,
              description: `Remboursement administratif ${tx.reference || txId}`,
              created_at: now,
              completed_at: now,
              metadata: {
                source_transaction_id: txId,
                operation_id: operationId,
                wallet_operation_id: operationId,
                reason: String(body.reason || '').slice(0, 500),
              },
            },
            adminLog: log,
          });
          if (!['applied', 'already'].includes(walletResult.state)) {
            reply(res, 409, { detail: 'Remboursement refusé; le statut reste en attente.' });
            return true;
          }
        }

        const status = isApprove ? 'completed' : 'failed';
        const set = isApprove ? {
          status,
          approved_at: now,
          completed_at: now,
          approved_by: admin.username,
          manual_action: 'approved',
          ...(walletResult?.snapshot ? {
            wallet_snapshot: walletResult.snapshot,
            balance_before: walletResult.snapshot.balance_before,
            balance_after: walletResult.snapshot.balance_after,
          } : {}),
        } : {
          status,
          rejected_at: now,
          rejected_by: admin.username,
          manual_action: 'rejected',
          rejection_reason: String(body.reason || '').slice(0, 500),
          refunded_amount: refunded || null,
        };
        if (!walletResult) {
          await db.collection('admin_logs').insert_one(adminLog(
            admin, isApprove ? 'tx_approve' : 'tx_reject', tx, {
              ...(isApprove ? { amount } : {}),
              ...(isApprove ? {} : { reason: String(body.reason || '').slice(0, 500) }),
              ...(providerOutcome ? {
                provider_outcome: providerOutcome,
                provider_outcome_evidence_reference: evidenceReference,
                provider_outcome_attested: true,
              } : {}),
            }, now,
          ));
        }
        await db.collection('transactions').update_one(
          { id: txId, status: 'pending' }, { $set: set },
        );
        const updated = await db.collection('transactions').find_one({ id: txId }, { _id: 0 });
        if (typeof notify === 'function') {
          try {
            const title = isApprove ? 'Transaction validée' : 'Transaction rejetée';
            const message = isApprove
                ? `Votre transaction ${tx.reference || txId} a été validée.`
                : `Votre transaction ${tx.reference || txId} a été rejetée.`;
            await notify(
              String(tx.user_id),
              isApprove ? 'transaction_approved' : 'transaction_rejected',
              title,
              message,
              { kind: isApprove ? 'success' : 'warning', tx_id: txId, type },
            );
          } catch { /* Notification failure must not replay financial settlement. */ }
        }
        reply(res, 200, { ok: true, ...(refunded ? { refunded } : {}), tx: updated });
        return true;
      }

      if (logsRoute) {
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit == null ? 200 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
          reply(res, 422, { detail: 'Limite invalide (1–1000)' });
          return true;
        }
        const logs = await db.collection('admin_logs').find({}, { _id: 0 })
          .sort('created_at', -1).to_list(limit);
        reply(res, 200, logs);
        return true;
      }
      if (conversionsRoute) {
        const now = new Date();
        const period = String(url.searchParams.get('period') || 'month');
        let since = null;
        if (period === 'day') {
          const startOfDay = new Date(now);
          startOfDay.setUTCHours(0, 0, 0, 0);
          since = startOfDay.toISOString();
        } else if (period === 'week') {
          since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
        } else if (period === 'month') {
          since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
        }
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit == null ? 200 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
          reply(res, 422, { detail: 'Limite invalide (1–2000)' });
          return true;
        }
        const query = { type: 'exchange' };
        if (since) query.created_at = { $gte: since };
        const transactions = db.collection('transactions');
        const rows = await transactions.find(query, { _id: 0 })
          .sort('created_at', -1).to_list(limit);
        const userIds = [...new Set(rows.map(row => String(row.user_id || '')).filter(Boolean))];
        const users = userIds.length
          ? await db.collection('users').find({ id: { $in: userIds } }, {
            _id: 0, id: 1, username: 1, full_name: 1, email: 1,
          }).to_list(userIds.length)
          : [];
        const usersById = new Map(users.map(user => [String(user.id), user]));
        const startOfToday = new Date(now);
        startOfToday.setUTCHours(0, 0, 0, 0);
        const [totalAll, totalToday, validated, rejected, groupedVolumes] = await Promise.all([
          transactions.count_documents({ type: 'exchange' }),
          transactions.count_documents({
            type: 'exchange', created_at: { $gte: startOfToday.toISOString() },
          }),
          transactions.count_documents({ type: 'exchange', status: 'completed' }),
          transactions.count_documents({ type: 'exchange', status: 'failed' }),
          transactions.aggregate([
            { $match: { type: 'exchange', status: 'completed' } },
            { $group: { _id: '$currency', volume: { $sum: '$amount' } } },
          ]).to_list(100),
        ]);
        const volumeByCurrency = { USDT: 0, XOF: 0, XAF: 0 };
        for (const item of groupedVolumes) {
          const currency = String(item._id || '').toUpperCase();
          if (Object.hasOwn(volumeByCurrency, currency)) {
            volumeByCurrency[currency] = Number(item.volume) || 0;
          }
        }
        reply(res, 200, {
          data: rows.map(row => ({
            ...row,
            user: usersById.get(String(row.user_id)) || {},
          })),
          totals: {
            all: totalAll,
            today: totalToday,
            validated,
            rejected,
          },
          volume_by_currency: volumeByCurrency,
        });
        return true;
      }

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
