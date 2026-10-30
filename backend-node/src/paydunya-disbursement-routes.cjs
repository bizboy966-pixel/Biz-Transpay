'use strict';

const crypto = require('node:crypto');
const { loadCredentials } = require('./paydunya-invoice-routes.cjs');
const { applyWalletOperation } = require('./wallet.cjs');

const MAX_CALLBACK_BYTES = 64 * 1024;
const PAID_STATES = new Set(['completed', 'complete', 'success', 'successful', 'sent', 'paid', 'succeeded']);
const FAILED_STATES = new Set(['failed', 'failure', 'cancelled', 'canceled', 'rejected', 'declined', 'error', 'refunded']);

function reply(res, status, body) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function valueFrom(response, names) {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  const queue = [response];
  while (queue.length) {
    const value = queue.shift();
    if (Array.isArray(value)) {
      queue.push(...value);
    } else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (wanted.has(key.toLowerCase()) && child !== null && child !== undefined) {
          return child;
        }
        if (child && typeof child === 'object') queue.push(child);
      }
    }
  }
  return '';
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createPaydunyaDisbursementRoutes({
  db, sessionSecret = '', env = process.env, fetchImpl = globalThis.fetch, notify,
}) {
  async function verifyStatus(invoiceToken) {
    const config = await db.collection('settings').find_one(
      { id: 'payment_provider_paydunya' }, { _id: 0 },
    );
    if (!config) throw new Error('PayDunya configuration missing');
    const credentials = loadCredentials(config, sessionSecret, env);
    let response;
    try {
      response = await fetchImpl(
        'https://app.paydunya.com/api/v2/disburse/check-status',
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(12000),
          headers: {
            'PAYDUNYA-MASTER-KEY': credentials.master_key,
            'PAYDUNYA-PRIVATE-KEY': credentials.private_key,
            'PAYDUNYA-TOKEN': credentials.token,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ disburse_invoice: invoiceToken }),
        },
      );
    } catch {
      throw new Error('PayDunya status unavailable');
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || typeof payload !== 'object') {
      throw new Error('PayDunya status unavailable');
    }
    const rawResponseCode = String(valueFrom(payload, ['response_code', 'responseCode']) || '').trim();
    const responseCode = rawResponseCode.padStart(2, '0');
    if (!rawResponseCode || responseCode !== '00') {
      throw new Error('PayDunya status not confirmed');
    }
    return payload;
  }

  async function refundFailedPayout(tx, metadata, status) {
    const userId = String(tx.user_id || '');
    const user = await db.collection('users').find_one({ id: userId }, { _id: 0 });
    if (!user) throw new Error('Payout owner missing');
    const currency = String(tx.currency || '').toUpperCase();
    const field = String(metadata.wallet_field
      || (currency === 'XOF' ? 'balance_xof' : currency === 'XAF' ? 'balance_xaf' : ''));
    if (!/^balance_[a-z0-9_]{2,40}$/.test(field)
        || (!Object.hasOwn(user, field) && !['balance_xof', 'balance_xaf'].includes(field))) {
      throw new Error('Payout wallet is not safely identified');
    }
    const refundAmount = Number(
      metadata.total_debit ?? (Number(tx.amount) + Number(metadata.fee || 0)),
    );
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      throw new Error('Payout refund amount is invalid');
    }
    const operationId = `paydunya:payout-refund:${tx.id}`;
    const settledAt = new Date().toISOString();
    const result = await applyWalletOperation(db, {
      userId,
      operationId,
      direction: 'credit',
      primaryField: field,
      increments: { [field]: refundAmount },
      ledger: {
        id: `paydunya-payout-refund:${tx.id}`,
        user_id: userId,
        type: 'refund',
        direction: 'in',
        amount: refundAmount,
        currency,
        status: 'completed',
        reference: `${tx.reference || tx.id}-REFUND`,
        description: 'Remboursement après échec confirmé du retrait PayDunya',
        created_at: settledAt,
        completed_at: settledAt,
        metadata: {
          source_transaction_id: String(tx.id),
          operation_id: operationId,
          wallet_operation_id: operationId,
          provider_status: status,
        },
      },
    });
    if (!['applied', 'already'].includes(result.state)) {
      throw new Error('Payout refund could not be committed');
    }
    return { refundAmount, snapshot: result.snapshot, settledAt };
  }

  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!['GET', 'POST'].includes(req.method)
        || url.pathname !== '/api/webhooks/paydunya/disbursement') return false;
    if (req.method === 'POST') {
      let size = 0;
      try {
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk);
          if (size > MAX_CALLBACK_BYTES) {
            reply(res, 413, { detail: 'Notification PayDunya trop volumineuse.' });
            return true;
          }
        }
      } catch {
        reply(res, 400, { detail: 'Notification PayDunya invalide.' });
        return true;
      }
    }
    const reference = String(url.searchParams.get('ref') || '').trim();
    if (!reference || reference.length > 200) {
      reply(res, 400, { detail: 'Référence de retrait manquante.' });
      return true;
    }
    try {
      const tx = await db.collection('transactions').find_one(
        { reference, type: 'transfer' }, { _id: 0 },
      );
      const metadata = tx?.metadata || {};
      if (!tx || metadata.transfer_type !== 'biz_to_mobile'
          || metadata.provider === 'mbiyo') {
        reply(res, 404, { detail: 'Retrait PayDunya introuvable.' });
        return true;
      }
      if (['completed', 'failed'].includes(String(tx.status))) {
        reply(res, 200, { received: true, status: tx.status });
        return true;
      }
      if (metadata.provider === 'afribapay' || !metadata.paydunya_invoice_token) {
        reply(res, 200, { received: true, status: 'pending' });
        return true;
      }

      const provider = await verifyStatus(String(metadata.paydunya_invoice_token));
      const returnedToken = String(valueFrom(provider, [
        'token', 'invoice_token', 'disburse_token', 'disbursement_token',
      ]) || '');
      const returnedAmount = Number(valueFrom(provider, ['amount']));
      const returnedMode = String(valueFrom(provider, ['withdraw_mode', 'withdrawMode']) || '');
      const returnedReference = String(valueFrom(provider, ['disburse_id', 'disbursement_id']) || '');
      const expectedAmount = Number(metadata.recipient_gets ?? tx.amount);
      const expectedMode = String(metadata.paydunya_withdraw_mode || '');
      const expectedProviderId = String(metadata.paydunya_disbursement_id || '');
      const amountMatches = Number.isFinite(returnedAmount)
        && Math.abs(returnedAmount - expectedAmount) < 0.005;
      if (!sameSecret(returnedToken, metadata.paydunya_invoice_token)
          || !amountMatches
          || (expectedMode && !sameSecret(returnedMode, expectedMode))
          || (expectedProviderId && !sameSecret(returnedReference, expectedProviderId))) {
        throw new Error('PayDunya payout response does not match the local transaction');
      }
      const status = String(valueFrom(provider, [
        'status', 'disbursement_status', 'disburse_status',
      ]) || '').trim().toLowerCase();
      if (!status) {
        reply(res, 200, { received: true, status: 'pending' });
        return true;
      }
      const now = new Date().toISOString();
      let refundAmount = null;
      let walletSnapshot = null;
      if (FAILED_STATES.has(status)) {
        const refund = await refundFailedPayout(tx, metadata, status);
        refundAmount = refund.refundAmount;
        walletSnapshot = refund.snapshot;
        await db.collection('transactions').update_one(
          { id: tx.id, status: 'pending' },
          { $set: {
            status: 'failed',
            failed_at: refund.settledAt,
            metadata: {
              ...metadata,
              paydunya_status: status,
              refund_operation_id: `paydunya:payout-refund:${tx.id}`,
              wallet_snapshot: walletSnapshot,
              refunded_amount: refundAmount,
            },
          } },
        );
      } else if (PAID_STATES.has(status)) {
        await db.collection('transactions').update_one(
          { id: tx.id, status: 'pending' },
          { $set: {
            status: 'completed',
            completed_at: now,
            metadata: { ...metadata, paydunya_status: status },
          } },
        );
      } else {
        await db.collection('transactions').update_one(
          { id: tx.id, status: 'pending' },
          { $set: {
            metadata: { ...metadata, paydunya_status: status },
          } },
        );
      }
      const updated = await db.collection('transactions').find_one({ id: tx.id }, { _id: 0 });
      if (typeof notify === 'function' && updated?.status !== tx.status) {
        try {
          await notify(
            String(tx.user_id),
            updated.status === 'completed' ? 'withdrawal_success' : 'withdrawal_failed',
            updated.status === 'completed' ? 'Retrait Mobile Money confirmé' : 'Retrait Mobile Money échoué',
            updated.status === 'completed'
              ? `Votre retrait ${tx.reference || tx.id} a été envoyé au bénéficiaire.`
              : `Votre retrait ${tx.reference || tx.id} a échoué. Le portefeuille a été remboursé.`,
            {
              transaction_id: tx.id,
              reference: tx.reference,
              amount: tx.amount,
              currency: tx.currency,
              ...(refundAmount ? { refunded_amount: refundAmount } : {}),
            },
          );
        } catch { /* A notification retry must not repeat settlement. */ }
      }
      reply(res, 200, { received: true, status: updated?.status || 'pending' });
      return true;
    } catch {
      reply(res, 503, { detail: 'Vérification du retrait PayDunya indisponible.' });
      return true;
    }
  }

  return { handleRoute };
}

module.exports = { createPaydunyaDisbursementRoutes };
