'use strict';

const crypto = require('node:crypto');

const OPERATION_SOURCES = Object.freeze({
  deposit: { collection: 'momo_deposits', eventType: 'deposit.status_changed', object: 'deposit' },
  payout: { collection: 'transactions', eventType: 'payout.status_changed', object: 'payout' },
  crypto_deposit: {
    collection: 'crypto_deposits',
    eventType: 'crypto.deposit.status_changed',
    object: 'crypto_deposit',
  },
  crypto_payout: {
    collection: 'transactions',
    eventType: 'crypto.payout.status_changed',
    object: 'crypto_payout',
  },
});

const SUCCESS_STATES = new Set(['completed', 'confirmed', 'success', 'successful', 'succeeded', 'paid']);
const FAILURE_STATES = new Set(['failed', 'rejected', 'cancelled', 'canceled', 'expired']);
const PENDING_STATES = [
  'pending', 'processing', 'created', 'submitted', 'accepted',
  'in_progress', 'awaiting_confirmation', 'pending_manual',
];

function finalStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (SUCCESS_STATES.has(status)) return 'completed';
  if (FAILURE_STATES.has(status)) return 'failed';
  return null;
}

function eventIdFor(operationId, status) {
  const digest = crypto.createHash('sha256')
    .update(`${operationId}:${status}`, 'utf8')
    .digest('hex')
    .slice(0, 48);
  return `evt_${digest}`;
}

function statusResponse(response, status) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return response;
  }
  const next = { ...response, status };
  for (const key of ['deposit', 'payout']) {
    if (next[key] && typeof next[key] === 'object' && !Array.isArray(next[key])) {
      next[key] = { ...next[key], status };
    }
  }
  return next;
}

async function findMany(collection, query, projection, sortField, limit) {
  const cursor = collection?.find?.(query, projection);
  if (Array.isArray(cursor)) return cursor.slice(0, limit);
  if (!cursor || typeof cursor.to_list !== 'function') return [];
  const sorted = sortField && typeof cursor.sort === 'function'
    ? cursor.sort(sortField) : cursor;
  return sorted.to_list(limit);
}

function createIntegrationWebhookWorker({
  db,
  deliverEvent = async () => ({ status: 'skipped' }),
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  logger = console,
} = {}) {
  let interval = null;
  let running = false;

  async function findBusinessRecord(operation) {
    const source = OPERATION_SOURCES[String(operation?.kind || '')];
    const id = String(operation?.business_id || '');
    if (!source || !id) return null;
    return db.collection(source.collection).find_one({
      id,
      user_id: String(operation.user_id),
    }, { _id: 0 });
  }

  async function createStatusEvent(operation, record, nextStatus) {
    const previousStatus = String(operation.status || 'pending').toLowerCase();
    if (previousStatus === nextStatus) return null;

    const userId = String(operation.user_id || '');
    const environment = String(operation.environment || '');
    const destinations = await findMany(
      db.collection('integration_webhooks'),
      { user_id: userId, environment, active: true },
      { _id: 0, id: 1 },
      'created_at',
      20,
    );
    if (!destinations.length) return null;

    const id = eventIdFor(String(operation.id), nextStatus);
    const timestamp = new Date(now()).toISOString();
    const source = OPERATION_SOURCES[operation.kind];
    const amount = Number(record.amount ?? operation.response?.amount);
    const currency = String(record.currency || record.fiat_currency
      || operation.response?.currency || '');
    const event = {
      id,
      type: source.eventType,
      created_at: timestamp,
      data: {
        id: String(operation.business_id),
        object: source.object,
        previous_status: previousStatus,
        status: nextStatus,
        ...(Number.isFinite(amount) ? { amount } : {}),
        ...(currency ? { currency } : {}),
        ...(operation.reference ? { reference: String(operation.reference) } : {}),
      },
    };
    const outbox = {
      id,
      user_id: userId,
      environment,
      operation_id: String(operation.id),
      business_id: String(operation.business_id),
      kind: String(operation.kind),
      event_type: event.type,
      from_status: previousStatus,
      to_status: nextStatus,
      destination_ids: destinations.map(destination => String(destination.id)),
      payload: event,
      status: 'pending',
      attempts: 0,
      next_attempt_at: timestamp,
      created_at: timestamp,
      updated_at: timestamp,
    };
    try {
      await db.collection('integration_webhook_events').insert_one(outbox);
    } catch (error) {
      const existing = await db.collection('integration_webhook_events')
        .find_one({ id }, { _id: 0 });
      if (!existing) throw error;
    }
    return outbox;
  }

  async function reconcileOperation(operation, knownRecord = null) {
    if (!operation || !OPERATION_SOURCES[operation.kind]) return null;
    const record = knownRecord || await findBusinessRecord(operation);
    if (!record) return null;
    const nextStatus = finalStatus(record.status);
    if (!nextStatus) return null;
    const previousFinalStatus = finalStatus(operation.status);
    if (previousFinalStatus && previousFinalStatus !== nextStatus) {
      logger.warn?.('Integration webhook status conflict requires review', {
        operation_id: String(operation.id || ''),
        stored_status: previousFinalStatus,
        business_status: nextStatus,
      });
      return { status: previousFinalStatus, conflict: true };
    }

    await createStatusEvent(operation, record, nextStatus);
    const timestamp = new Date(now()).toISOString();
    const response = statusResponse(operation.response, nextStatus);
    await db.collection('integration_operations').update_one({
      id: String(operation.id),
      user_id: String(operation.user_id),
      environment: String(operation.environment),
      status: String(operation.status || ''),
    }, { $set: {
      status: nextStatus,
      response,
      updated_at: timestamp,
    } });
    return { status: nextStatus, response };
  }

  async function reconcilePendingOperations() {
    const operations = await findMany(
      db.collection('integration_operations'),
      {
        environment: 'live',
        kind: { $in: Object.keys(OPERATION_SOURCES) },
        status: { $in: PENDING_STATES },
      },
      { _id: 0 },
      'updated_at',
      500,
    );
    for (const operation of operations) {
      try {
        await reconcileOperation(operation);
      } catch (error) {
        logger.warn?.('Integration webhook status reconciliation failed', {
          operation_id: String(operation.id || ''),
          error: error?.name || 'Error',
        });
      }
    }
  }

  async function claimEvent(event) {
    const timestamp = new Date(now()).toISOString();
    const previousLease = String(event.lease_until || '');
    const query = {
      id: String(event.id),
      status: String(event.status),
    };
    if (event.status === 'processing') query.lease_until = previousLease;
    const result = await db.collection('integration_webhook_events').update_one(query, {
      $set: {
        status: 'processing',
        lease_until: new Date(now() + 60_000).toISOString(),
        updated_at: timestamp,
      },
    });
    return Number(result?.matched_count ?? result?.matchedCount ?? 0) > 0;
  }

  async function deliverPendingEvents() {
    const candidates = await findMany(
      db.collection('integration_webhook_events'),
      { status: { $in: ['pending', 'retry', 'processing'] } },
      { _id: 0 },
      'created_at',
      200,
    );
    const current = now();
    for (const event of candidates) {
      const dueAt = Date.parse(event.next_attempt_at || event.created_at || '');
      const leaseUntil = Date.parse(event.lease_until || '');
      const due = event.status === 'processing'
        ? Number.isFinite(leaseUntil) && leaseUntil <= current
        : !Number.isFinite(dueAt) || dueAt <= current;
      if (!due || !(await claimEvent(event))) continue;

      let failed = false;
      for (const destinationId of Array.isArray(event.destination_ids)
        ? event.destination_ids : []) {
        try {
          const result = await deliverEvent(
            String(event.user_id),
            String(event.environment),
            String(destinationId),
            event.payload,
          );
          if (result?.status === 'failed') failed = true;
        } catch {
          failed = true;
        }
      }

      const attempts = Number(event.attempts || 0) + 1;
      const status = failed ? 'retry' : 'delivered';
      const backoffMs = Math.min(
        60_000 * (2 ** Math.min(Math.max(0, attempts - 1), 6)),
        3_600_000,
      );
      await db.collection('integration_webhook_events').update_one({
        id: String(event.id),
        status: 'processing',
      }, { $set: {
        status,
        attempts,
        ...(failed ? { next_attempt_at: new Date(now() + backoffMs).toISOString() } : {}),
        completed_at: status === 'delivered' ? new Date(now()).toISOString() : null,
        updated_at: new Date(now()).toISOString(),
      } });
    }
  }

  async function runOnce() {
    if (running || !db?.collection) return;
    running = true;
    try {
      await reconcilePendingOperations();
      await deliverPendingEvents();
    } catch (error) {
      logger.warn?.('Integration webhook worker pass failed', {
        error: error?.name || 'Error',
      });
    } finally {
      running = false;
    }
  }

  function start() {
    if (interval || !db?.collection) return;
    void runOnce();
    interval = setIntervalImpl(() => { void runOnce(); }, 15_000);
    interval?.unref?.();
  }

  function stop() {
    if (!interval) return;
    clearIntervalImpl(interval);
    interval = null;
  }

  return { start, stop, runOnce, reconcileOperation };
}

module.exports = { createIntegrationWebhookWorker, finalStatus, eventIdFor };
