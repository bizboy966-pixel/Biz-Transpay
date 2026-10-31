'use strict';

const DEFAULT_INTERVAL_MS = 30_000;
const FIRST_UNSCHEDULED_DELAY_MS = 30_000;
const RETRY_DELAYS_MS = [60_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000];
const MAX_SCAN = 300;
const MAX_PER_TICK = 12;

function dueTimestamp(deposit) {
  const scheduled = deposit.next_reconcile_at ? Date.parse(deposit.next_reconcile_at) : NaN;
  if (Number.isFinite(scheduled)) return scheduled;
  const started = Date.parse(
    deposit.paydunya_softpay_sent_at || deposit.updated_at || deposit.created_at || '',
  );
  return Number.isFinite(started) ? started + FIRST_UNSCHEDULED_DELAY_MS : Infinity;
}

function isDue(deposit, nowMs) {
  return deposit.provider === 'paydunya'
    && deposit.status === 'pending'
    && deposit.initiation_state !== 'initiating'
    && deposit.paydunya_reconcile_paused !== true
    && Boolean(String(deposit.paydunya_token || '').trim())
    && dueTimestamp(deposit) <= nowMs;
}

function createPaydunyaDepositWorker({
  db,
  settleDepositById,
  intervalMs = DEFAULT_INTERVAL_MS,
  now = () => Date.now(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  logger = console,
} = {}) {
  let timer = null;
  let running = false;

  async function runOnce() {
    if (running || !db?.collection || typeof settleDepositById !== 'function') {
      return { skipped: true, scanned: 0, attempted: 0 };
    }
    running = true;
    try {
      const deposits = db.collection('momo_deposits');
      const rows = await deposits.find({
        provider: 'paydunya',
        status: 'pending',
      }, {
        _id: 0,
        id: 1,
        provider: 1,
        status: 1,
        initiation_state: 1,
        paydunya_token: 1,
        paydunya_softpay_sent_at: 1,
        next_reconcile_at: 1,
        paydunya_reconcile_attempts: 1,
        paydunya_reconcile_paused: 1,
        created_at: 1,
        updated_at: 1,
      }).sort('next_reconcile_at', 1).limit(MAX_SCAN).to_list(MAX_SCAN);
      const nowMs = now();
      const dueRows = rows
        .filter(row => isDue(row, nowMs))
        .sort((left, right) => dueTimestamp(left) - dueTimestamp(right))
        .slice(0, MAX_PER_TICK);
      let attempted = 0;

      for (const row of dueRows) {
        const attempt = Math.max(
          0,
          Math.floor(Number(row.paydunya_reconcile_attempts) || 0),
        );
        const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
        const attemptedAt = new Date(now()).toISOString();
        const nextAttemptAt = new Date(now() + delay).toISOString();
        const claim = {
          id: String(row.id),
          provider: 'paydunya',
          status: 'pending',
          ...(row.initiation_state !== undefined
            ? { initiation_state: row.initiation_state } : {}),
          ...(row.paydunya_reconcile_paused !== undefined
            ? { paydunya_reconcile_paused: row.paydunya_reconcile_paused } : {}),
          next_reconcile_at: row.next_reconcile_at === undefined
            ? { $exists: false } : row.next_reconcile_at,
        };
        const claimed = await deposits.update_one(claim, { $set: {
          next_reconcile_at: nextAttemptAt,
          paydunya_reconcile_attempts: attempt + 1,
          paydunya_last_reconcile_at: attemptedAt,
          updated_at: attemptedAt,
        } });
        if (Number(claimed?.modified_count ?? claimed?.modifiedCount ?? 0) !== 1) continue;

        attempted += 1;
        try {
          await settleDepositById(String(row.id));
        } catch (error) {
          await deposits.update_one({
            id: String(row.id),
            provider: 'paydunya',
            status: 'pending',
          }, { $set: {
            paydunya_last_reconcile_error: 'provider_status_unavailable',
            updated_at: new Date(now()).toISOString(),
          } }).catch(() => {});
          logger.warn?.('PayDunya deposit status check failed', {
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
    if (timer || !db?.collection || typeof settleDepositById !== 'function') return;
    timer = setIntervalImpl(() => {
      runOnce().catch(() => {
        logger.warn?.('PayDunya deposit reconciliation cycle failed');
      });
    }, intervalMs);
    timer?.unref?.();
    runOnce().catch(() => {
      logger.warn?.('PayDunya deposit reconciliation startup check failed');
    });
  }

  function stop() {
    if (!timer) return;
    clearIntervalImpl(timer);
    timer = null;
  }

  return { runOnce, start, stop };
}

module.exports = {
  createPaydunyaDepositWorker,
  dueTimestamp,
  isDue,
  RETRY_DELAYS_MS,
};
