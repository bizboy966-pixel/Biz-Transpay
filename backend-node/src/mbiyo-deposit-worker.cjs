'use strict';

const DEFAULT_INTERVAL_MS = 30_000;
const FIRST_UNSCHEDULED_DELAY_MS = 30_000;
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 300_000];
const MAX_SCAN = 300;
const MAX_PER_TICK = 12;

function dueTimestamp(deposit) {
  const scheduled = deposit.next_reconcile_at ? Date.parse(deposit.next_reconcile_at) : NaN;
  if (Number.isFinite(scheduled)) return scheduled;
  const started = Date.parse(
    deposit.mbiyo_response_received_at || deposit.updated_at || deposit.created_at || '',
  );
  return Number.isFinite(started) ? started + FIRST_UNSCHEDULED_DELAY_MS : Infinity;
}

function isDue(deposit, nowMs) {
  return deposit.status === 'pending' && deposit.provider === 'mbiyo'
    && deposit.initiation_state !== 'initiating'
    && deposit.reconciliation_state !== 'quarantined'
    && deposit.mbiyo_reconcile_paused !== true
    && dueTimestamp(deposit) <= nowMs;
}

function createMbiyoDepositWorker({
  db, reconcileOrder, intervalMs = DEFAULT_INTERVAL_MS,
  now = () => Date.now(), logger = console,
} = {}) {
  let timer = null;
  let running = false;

  async function runOnce() {
    if (running) return { skipped: true, scanned: 0, attempted: 0 };
    running = true;
    try {
      const deposits = db.collection('momo_deposits');
      const rows = await deposits.find({
        provider: 'mbiyo',
        status: 'pending',
      }, {
        _id: 0,
        id: 1,
        provider: 1,
        status: 1,
        initiation_state: 1,
        reconciliation_state: 1,
        next_reconcile_at: 1,
        mbiyo_response_received_at: 1,
        mbiyo_reconcile_attempts: 1,
        created_at: 1,
        updated_at: 1,
      }).sort('next_reconcile_at', 1).limit(MAX_SCAN).to_list(MAX_SCAN);
      const nowMs = now();
      const dueRows = rows.filter(row => isDue(row, nowMs))
        .sort((a, b) => dueTimestamp(a) - dueTimestamp(b))
        .slice(0, MAX_PER_TICK);
      let attempted = 0;

      for (const row of dueRows) {
        const attempt = Math.max(0, Math.floor(Number(row.mbiyo_reconcile_attempts) || 0));
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        const attemptedAt = new Date(now()).toISOString();
        const nextAttemptAt = new Date(now() + delay).toISOString();
        const claim = {
          id: String(row.id),
          provider: 'mbiyo',
          status: 'pending',
          ...(row.initiation_state !== undefined
            ? { initiation_state: row.initiation_state } : {}),
          ...(row.reconciliation_state !== undefined
            ? { reconciliation_state: row.reconciliation_state } : {}),
        };
        claim.next_reconcile_at = row.next_reconcile_at === undefined
          ? { $exists: false } : row.next_reconcile_at;
        const claimed = await deposits.update_one(claim, { $set: {
          next_reconcile_at: nextAttemptAt,
          mbiyo_reconcile_attempts: attempt + 1,
          mbiyo_last_reconcile_at: attemptedAt,
          updated_at: attemptedAt,
        } });
        if (claimed.modified_count !== 1) continue;
        attempted += 1;
        try {
          await reconcileOrder(String(row.id));
        } catch (error) {
          await deposits.update_one({
            id: String(row.id),
            provider: 'mbiyo',
            status: 'pending',
          }, { $set: {
            mbiyo_last_reconcile_error: Number(error?.providerStatusCode) === 404
              ? 'provider_transaction_not_found' : 'provider_status_unavailable',
            ...(Number(error?.providerStatusCode) === 404
              ? { mbiyo_reconcile_paused: true, next_reconcile_at: null } : {}),
            updated_at: new Date(now()).toISOString(),
          } }).catch(() => {});
          logger.warn?.('Mbiyo deposit status check failed', {
            status: Number(error?.status) || 503,
          });
        }
      }
      return { skipped: false, scanned: rows.length, attempted };
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      runOnce().catch(() => {
        logger.warn?.('Mbiyo deposit reconciliation cycle failed');
      });
    }, intervalMs);
    timer.unref?.();
    runOnce().catch(() => {
      logger.warn?.('Mbiyo deposit reconciliation startup check failed');
    });
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop };
}

module.exports = {
  createMbiyoDepositWorker,
  isDue,
  RETRY_DELAYS_MS,
};
