'use strict';

const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { applyWalletOperation } = require('./wallet.cjs');

function reply(res, status, body) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function readRaw(req, maxBytes = 512 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) {
      throw Object.assign(new Error('Webhook payload too large'), { status: 413 });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function verifySignature(raw, header, secret, now = Date.now()) {
  if (!secret) throw Object.assign(new Error('FedaPay webhook is not configured'), { status: 503 });
  if (!header) throw Object.assign(new Error('Missing webhook signature'), { status: 400 });
  const parts = Object.fromEntries(String(header).split(',').flatMap(chunk => {
    const index = chunk.indexOf('=');
    return index < 0 ? [] : [[chunk.slice(0, index).trim(), chunk.slice(index + 1).trim()]];
  }));
  const timestamp = parts.t || '';
  const supplied = parts.s || String(header).trim();
  if (!/^[a-f0-9]{64}$/i.test(supplied)) {
    throw Object.assign(new Error('Invalid webhook signature'), { status: 400 });
  }
  const body = raw.toString('utf8');
  const signed = timestamp ? `${timestamp}.${body}` : body;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest();
  const actual = Buffer.from(supplied, 'hex');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(expected, actual)) {
    throw Object.assign(new Error('Invalid webhook signature'), { status: 400 });
  }
  try {
    const event = JSON.parse(body);
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error();
    return event;
  } catch {
    throw Object.assign(new Error('Invalid webhook body'), { status: 400 });
  }
}

function safeWalletField(document, currency) {
  const explicit = String(document.wallet_field || document.metadata?.wallet_field || '');
  const derived = `balance_${String(currency || '').toLowerCase()}`;
  const field = explicit || derived;
  return ['balance_xof', 'balance_xaf'].includes(field) ? field : null;
}

function createFedaPayWebhookRoutes({ db, env = process.env, notify = async () => {} }) {
  async function creditDeposit(deposit, eventId, eventName) {
    const currency = String(deposit.currency || deposit.requested_currency || 'XOF').toUpperCase();
    const field = safeWalletField(deposit, currency);
    const amount = Number(
      deposit.wallet_credit_amount ?? deposit.amount_net ?? deposit.amount,
    );
    if (!field || !Number.isFinite(amount) || amount <= 0 || !deposit.user_id) {
      throw Object.assign(new Error('Stored deposit is not eligible for settlement'), { status: 409 });
    }
    const operationId = `fedapay-deposit:${deposit.id}`;
    const result = await applyWalletOperation(db, {
      userId: String(deposit.user_id),
      operationId,
      aliases: [`fedapay:${eventId}:${eventName}`],
      direction: 'credit',
      primaryField: field,
      increments: { [field]: amount },
      ledger: {
        id: `fedapay-deposit-${deposit.id}`,
        user_id: String(deposit.user_id),
        type: 'deposit',
        direction: 'in',
        amount,
        currency,
        status: 'completed',
        reference: deposit.reference || `FEDAPAY-${deposit.id}`,
        description: 'Dépôt Mobile Money',
        metadata: {
          provider: 'fedapay',
          provider_transaction_id: String(deposit.fedapay_id),
          wallet_field: field,
          wallet_operation_id: operationId,
        },
        created_at: deposit.created_at || new Date().toISOString(),
      },
    });
    if (!['applied', 'already'].includes(result.state)) {
      throw Object.assign(new Error('Wallet settlement could not be applied'), {
        status: result.state === 'idempotency_conflict' ? 409 : 503,
      });
    }
    const updated = await db.collection('momo_deposits').update_one(
      { id: String(deposit.id), status: 'pending' },
      { $set: {
        status: 'approved',
        approved_at: deposit.approved_at || new Date().toISOString(),
        provider_status: 'approved',
        wallet_snapshot: result.snapshot || null,
        ...(result.snapshot ? {
          balance_before: result.snapshot.balance_before,
          balance_after: result.snapshot.balance_after,
        } : {}),
      } },
    );
    if (updated?.matched_count === 0) {
      const latest = await db.collection('momo_deposits').find_one({ id: String(deposit.id) });
      if (latest?.status !== 'approved') {
        throw Object.assign(new Error('Deposit status changed during settlement'), { status: 503 });
      }
    }
    if (result.state === 'applied') {
      await Promise.resolve().then(() => notify(
        String(deposit.user_id), 'deposit_success', 'Dépôt confirmé',
        'Votre dépôt Mobile Money a été confirmé.',
        {
          transaction_id: String(deposit.id),
          reference: deposit.reference || null,
          amount,
          currency,
          balance_before: result.snapshot?.balance_before ?? null,
          balance_after: result.snapshot?.balance_after ?? null,
        },
      )).catch(() => {});
    }
    return result;
  }

  async function refundPayout(transaction, eventId, eventName) {
    const metadata = transaction.metadata || {};
    const currency = String(transaction.currency || 'XOF').toUpperCase();
    const field = safeWalletField({ metadata }, currency);
    const amount = Number(metadata.total_debit ?? transaction.amount);
    if (!field || !Number.isFinite(amount) || amount <= 0 || !transaction.user_id) {
      throw Object.assign(new Error('Payout wallet cannot be identified safely'), { status: 409 });
    }
    const operationId = `fedapay-payout:${transaction.id}`;
    const result = await applyWalletOperation(db, {
      userId: String(transaction.user_id),
      operationId,
      aliases: [`fedapay:${eventId}:${eventName}`],
      direction: 'credit',
      primaryField: field,
      increments: { [field]: amount },
      ledger: {
        id: `fedapay-payout-refund-${transaction.id}`,
        user_id: String(transaction.user_id),
        type: 'withdrawal_refund',
        direction: 'in',
        amount,
        currency,
        status: 'completed',
        reference: transaction.reference || `FEDAPAY-PAYOUT-${transaction.id}`,
        description: 'Remboursement de retrait FedaPay',
        metadata: {
          provider: 'fedapay',
          provider_transaction_id: String(metadata.fedapay_payout_id || ''),
          wallet_field: field,
          wallet_operation_id: operationId,
          source_transaction_id: String(transaction.id),
        },
        created_at: new Date().toISOString(),
      },
    });
    if (!['applied', 'already'].includes(result.state)) {
      throw Object.assign(new Error('Payout refund could not be applied'), {
        status: result.state === 'idempotency_conflict' ? 409 : 503,
      });
    }
    const update = await db.collection('transactions').update_one(
      { id: String(transaction.id), status: 'pending' },
      { $set: {
        status: 'failed',
        'metadata.fedapay_status': eventName.split('.').at(-1),
        'metadata.refunded': true,
        'metadata.wallet_snapshot': result.snapshot || null,
      } },
    );
    if (update?.matched_count === 0) {
      const latest = await db.collection('transactions').find_one({ id: String(transaction.id) });
      if (latest?.status !== 'failed') {
        throw Object.assign(new Error('Payout status changed during refund'), { status: 503 });
      }
    }
    if (result.state === 'applied') {
      await Promise.resolve().then(() => notify(
        String(transaction.user_id),
        'withdrawal_failed',
        'Retrait Mobile Money échoué',
        'Le retrait a échoué. Le montant réservé a été recrédité.',
        {
          transaction_id: String(transaction.id),
          reference: transaction.reference || null,
          amount,
          currency,
          balance_before: result.snapshot?.balance_before ?? null,
          balance_after: result.snapshot?.balance_after ?? null,
        },
      )).catch(() => {});
    }
  }

  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method !== 'POST' || url.pathname !== '/api/webhooks/fedapay') return false;
    try {
      const raw = await readRaw(req);
      const event = verifySignature(
        raw,
        req.headers?.['x-fedapay-signature'] || req.headers?.['X-FEDAPAY-SIGNATURE'],
        String(env.FEDAPAY_WEBHOOK_SECRET || ''),
      );
      const eventName = String(event.name || event.event || event.type || '');
      const entity = event.entity || event.data || {};
      const eventId = String(event.id || entity.id || '');
      if (!eventName || !eventId || eventId.length > 191) {
        reply(res, 400, { detail: 'Événement FedaPay invalide.' });
        return true;
      }

      if (eventName === 'transaction.approved') {
        const deposit = await db.collection('momo_deposits').find_one(
          { fedapay_id: String(entity.id || '') },
        );
        if (deposit?.status === 'pending') await creditDeposit(deposit, eventId, eventName);
      } else if ([
        'transaction.canceled', 'transaction.declined', 'transaction.refunded',
      ].includes(eventName)) {
        const transactionId = String(entity.id || '');
        await db.collection('momo_deposits').update_one(
          { fedapay_id: transactionId, status: 'pending' },
          { $set: {
            status: 'failed',
            failed_reason: eventName.split('.').at(-1),
            failed_at: new Date().toISOString(),
          } },
        );
      } else if (eventName === 'payout.sent') {
        const transaction = await db.collection('transactions').find_one({
          'metadata.fedapay_payout_id': String(entity.id || ''),
        });
        if (transaction?.status === 'pending') {
          await db.collection('transactions').update_one(
            { id: String(transaction.id), status: 'pending' },
            { $set: {
              status: 'completed',
              'metadata.fedapay_status': 'sent',
              'metadata.fedapay_event_id': eventId,
            } },
          );
          await Promise.resolve().then(() => notify(
            String(transaction.user_id), 'withdrawal_success',
            'Retrait Mobile Money confirmé',
            'Votre retrait Mobile Money a été confirmé par le prestataire.',
            {
              transaction_id: String(transaction.id),
              reference: transaction.reference || null,
              amount: transaction.amount,
              currency: transaction.currency,
            },
          )).catch(() => {});
        }
      } else if (['payout.failed', 'payout.canceled'].includes(eventName)) {
        const transaction = await db.collection('transactions').find_one({
          'metadata.fedapay_payout_id': String(entity.id || ''),
        });
        if (transaction?.status === 'pending') {
          await refundPayout(transaction, eventId, eventName);
        }
      }
      reply(res, 200, { received: true });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 503;
      reply(res, status, {
        detail: status >= 500 ? 'Webhook FedaPay temporairement indisponible.' : error.message,
        retry: status >= 500,
      });
    }
    return true;
  }

  return { handleRoute };
}

module.exports = { createFedaPayWebhookRoutes, verifySignature, readRaw };
