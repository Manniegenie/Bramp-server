// services/nomba/reconciliation.js
//
// Two jobs:
//   1. Sweep: re-process NombaWebhookEvent rows stuck in 'received'/'failed'
//      (crash mid-processing, transient DB error, etc.) — capped attempts.
//   2. Daily reconciliation: diff Nomba's transaction listing for the parent
//      account against our `deposits` collection. Missed webhooks get credited
//      through the SAME path as the webhook processor (creditNombaDeposit) —
//      one code path for crediting, ever. Deposits we have that Nomba doesn't
//      confirm are a serious flag, not auto-resolved.
//
// This repo has no dedicated alert channel (Slack/PagerDuty/etc. — checked, none
// exists) — alerting here follows the codebase's existing convention of a
// clearly-prefixed logger.error() call (e.g. "CRITICAL: ..." in routes/airtime.js).
//
// No mongoose transactions are used anywhere in this repo (standalone MongoDB,
// no replica set) — see services/nomba/depositCredit.js for how atomicity is
// achieved here instead (unique-indexed insert + atomic $inc).

const cron = require('node-cron');
const NombaWebhookEvent = require('../../models/nombaWebhookEvent');
const NombaDeposit = require('../../models/nombaDeposit');
const { nombaClient } = require('./client');
const { processWebhookEvent, toKobo } = require('./webhookProcessor');
const { creditNombaDeposit } = require('./depositCredit');
const logger = require('../../utils/logger');

const SWEEP_STALE_MINUTES = Number(process.env.NOMBA_SWEEP_STALE_MINUTES || 15);
const SWEEP_MAX_ATTEMPTS = Number(process.env.NOMBA_SWEEP_MAX_ATTEMPTS || 5);
const SWEEP_BATCH_SIZE = 50;

/**
 * Re-process webhook events stuck in 'received' or 'failed', older than
 * SWEEP_STALE_MINUTES, capped at SWEEP_MAX_ATTEMPTS. Safe to run concurrently
 * with itself or with the immediate post-webhook processing path — every
 * outcome ultimately routes through creditNombaDeposit's unique-ref guard.
 */
async function runSweep() {
  const cutoff = new Date(Date.now() - SWEEP_STALE_MINUTES * 60 * 1000);

  const stuck = await NombaWebhookEvent.find({
    processingStatus: { $in: ['received', 'failed'] },
    createdAt: { $lt: cutoff },
    attempts: { $lt: SWEEP_MAX_ATTEMPTS },
  }).limit(SWEEP_BATCH_SIZE);

  if (stuck.length === 0) {
    logger.debug('Nomba sweep: nothing stuck');
    return { processed: 0 };
  }

  logger.info('Nomba sweep: reprocessing stuck webhook events', { count: stuck.length });

  let credited = 0, failed = 0, ignored = 0, duplicate = 0;
  for (const event of stuck) {
    event.attempts = (event.attempts || 0) + 1;
    await event.save();

    const result = await processWebhookEvent(event);
    if (result.outcome === 'credited') credited++;
    else if (result.outcome === 'duplicate') duplicate++;
    else if (result.outcome === 'ignored') ignored++;
    else failed++;
  }

  const exhausted = await NombaWebhookEvent.countDocuments({
    processingStatus: { $in: ['received', 'failed'] },
    attempts: { $gte: SWEEP_MAX_ATTEMPTS },
  });
  if (exhausted > 0) {
    logger.error(`ALERT: Nomba sweep — ${exhausted} webhook event(s) exhausted retry attempts and need manual review`);
  }

  logger.info('Nomba sweep: complete', { credited, duplicate, ignored, failed, total: stuck.length });
  return { processed: stuck.length, credited, duplicate, ignored, failed };
}

/**
 * Best-effort mapper from a Nomba transaction-listing item to the shape
 * creditNombaDeposit needs. Same caveat as webhookProcessor.extractDepositFields:
 * confirm exact field names against Nomba's transactions-listing response before
 * relying on this in production.
 */
function mapListingItemToDepositFields(item) {
  const nombaTransactionRef = item?.transactionRef || item?.reference || item?.ref;
  const rawAmount = item?.amount;
  const amountKobo = rawAmount != null ? toKobo(rawAmount) : null;
  const virtualAccountNumber = item?.accountNumber || item?.virtualAccountNumber || item?.destinationAccount;

  if (!nombaTransactionRef || amountKobo == null || !virtualAccountNumber) return null;

  return {
    nombaTransactionRef: String(nombaTransactionRef),
    amountKobo,
    feeKobo: item?.fee != null ? (toKobo(item.fee) || 0) : 0,
    virtualAccountNumber: String(virtualAccountNumber),
    senderAccountNumber: item?.senderAccountNumber || null,
    senderBank: item?.senderBank || null,
    senderName: item?.senderName || null,
  };
}

/**
 * Diff Nomba's transaction listing for [startDate, endDate] against our
 * `deposits` collection. Missed webhooks are credited through the same path
 * as the webhook processor; deposits we have that Nomba doesn't confirm are
 * flagged for manual review, never auto-resolved.
 */
async function runReconciliation({ startDate, endDate } = {}) {
  const end = endDate || new Date().toISOString().slice(0, 10);
  const start = startDate || end; // default: just today

  let nombaTransactions = [];
  try {
    const response = await nombaClient.listTransactions({ startDate: start, endDate: end, pageSize: 500 });
    nombaTransactions = response?.data?.transactions || response?.data || response?.transactions || [];
    if (!Array.isArray(nombaTransactions)) nombaTransactions = [];
  } catch (err) {
    logger.error('Nomba reconciliation: failed to fetch transaction listing', { start, end, error: err.message });
    return { success: false, error: err.message };
  }

  const nombaRefs = new Set();
  let missedCount = 0, missedKobo = 0, matchedCount = 0;

  for (const item of nombaTransactions) {
    const fields = mapListingItemToDepositFields(item);
    if (!fields) {
      logger.warn('Nomba reconciliation: could not map listing item, skipping', { rawKeys: Object.keys(item || {}) });
      continue;
    }
    nombaRefs.add(fields.nombaTransactionRef);

    const existing = await NombaDeposit.findOne({ nombaTransactionRef: fields.nombaTransactionRef });
    if (existing) {
      matchedCount++;
      continue;
    }

    // In Nomba, not in Bramp — missed webhook. Credit via the same path.
    logger.warn('Nomba reconciliation: found un-credited deposit, crediting now', { ref: fields.nombaTransactionRef });
    const result = await creditNombaDeposit(fields);
    if (result.outcome === 'credited') {
      missedCount++;
      missedKobo += fields.amountKobo;
    } else if (result.outcome !== 'duplicate') {
      logger.error('ALERT: Nomba reconciliation — failed to credit a missed deposit found in Nomba listing', {
        ref: fields.nombaTransactionRef, outcome: result.outcome, error: result.error,
      });
    }
  }

  // In Bramp, not in Nomba's listing for this window — serious flag.
  const oursForWindow = await NombaDeposit.find({
    createdAt: { $gte: new Date(`${start}T00:00:00Z`), $lte: new Date(`${end}T23:59:59Z`) },
    status: 'credited',
  });

  let flaggedCount = 0, flaggedKobo = 0;
  for (const deposit of oursForWindow) {
    if (!nombaRefs.has(deposit.nombaTransactionRef)) {
      deposit.status = 'flagged';
      await deposit.save();
      flaggedCount++;
      flaggedKobo += deposit.amountKobo;
      logger.error('ALERT: Nomba reconciliation — deposit credited in Bramp but not found in Nomba listing', {
        ref: deposit.nombaTransactionRef, userId: deposit.userId, amountKobo: deposit.amountKobo,
      });
    }
  }

  const summary = {
    window: { start, end },
    nombaTransactionCount: nombaTransactions.length,
    matchedCount,
    missedCount,
    missedKobo,
    flaggedCount,
    flaggedKobo,
  };
  logger.info('Nomba reconciliation: summary', summary);
  return { success: true, summary };
}

let isRunning = false;
const jobs = [];

function start() {
  if (isRunning) {
    logger.warn('Nomba reconciliation/sweep jobs already running');
    return;
  }

  // Sweep every 10 minutes.
  const sweepJob = cron.schedule('*/10 * * * *', async () => {
    try {
      await runSweep();
    } catch (err) {
      logger.error('Nomba sweep job failed', { error: err.message });
    }
  }, { scheduled: false, timezone: 'Africa/Lagos' });

  // Daily reconciliation at 02:10 Africa/Lagos for the previous day.
  const reconcileJob = cron.schedule('10 2 * * *', async () => {
    try {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await runReconciliation({ startDate: yesterday, endDate: yesterday });
    } catch (err) {
      logger.error('Nomba reconciliation job failed', { error: err.message });
    }
  }, { scheduled: false, timezone: 'Africa/Lagos' });

  sweepJob.start();
  reconcileJob.start();
  jobs.push(sweepJob, reconcileJob);
  isRunning = true;
  logger.info('Nomba: sweep + reconciliation jobs started');
}

function stop() {
  jobs.forEach((j) => j.stop());
  jobs.length = 0;
  isRunning = false;
}

module.exports = {
  runSweep,
  runReconciliation,
  start,
  stop,
};
