// services/nomba/depositCredit.js
//
// THE single credit path for Nomba virtual-account deposits. Used by both the
// webhook processor and the daily reconciliation job — one code path for
// crediting, ever (per spec Phase 6).
//
// Atomicity note: this MongoDB deployment is standalone (no replica set), so
// multi-document transactions are not available here — nothing else in this
// repo uses mongoose sessions/transactions either. Atomicity is instead built
// from two facts that already hold at the DB level in this codebase:
//   1. `nombaTransactionRef` has a UNIQUE index on NombaDeposit — the very
//      first successful insert against a given ref is the only one that will
//      ever exist. A duplicate insert throws Mongo error 11000, which we treat
//      as "already claimed" and stop (no double credit).
//   2. `updateUserBalance` credits via a single-document `$inc`, which Mongo
//      guarantees is atomic on its own.
// If the process dies between (1) insert and (2) credit, the deposit is left
// in 'pending' — safe, because nothing has been credited yet — and the sweeper
// (services/nomba/reconciliation.js) picks it up and retries the credit step
// only, using the SAME function below, without re-inserting or double-crediting.

const NombaDeposit = require('../../models/nombaDeposit');
const VirtualAccount = require('../../models/virtualAccount');
const { updateUserBalance } = require('../portfolio');
const logger = require('../../utils/logger');

const DUPLICATE_KEY_ERROR = 11000;

/**
 * Fraud/compliance check: deposits must come from an account bearing the
 * account holder's own name (per compliance requirement — prevents third-party
 * funding being laundered through a Bramp wallet). Bank transfer sender names
 * arrive in inconsistent formats (surname-first, extra middle names/initials,
 * punctuation), so this is a token-containment match, not exact-string:
 * every token in the KYC legal name must appear somewhere in the sender name.
 *
 * Returns:
 *   'match'      — every legal-name token found in the sender name
 *   'mismatch'   — sender name present but doesn't contain the legal name
 *   'unverified' — no sender name on the payload at all (Nomba may omit it
 *                  for some transaction types — see webhookProcessor.js's
 *                  extraction caveats). Does NOT block crediting; logged for
 *                  visibility so this can be tightened once payload shapes
 *                  are confirmed live.
 */
function normalizeNameTokens(str) {
  return String(str || '')
    .toUpperCase()
    .replace(/[^A-Z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1); // drop initials/punctuation remnants
}

function matchSenderName(senderName, legalName) {
  if (!senderName || !String(senderName).trim()) {
    return 'unverified';
  }
  const legalTokens = normalizeNameTokens(legalName);
  const senderTokens = new Set(normalizeNameTokens(senderName));

  if (legalTokens.length === 0) {
    return 'unverified'; // nothing to check against
  }

  const allPresent = legalTokens.every((t) => senderTokens.has(t));
  return allPresent ? 'match' : 'mismatch';
}

/**
 * @param {object} params
 * @param {string} params.nombaTransactionRef - Nomba's transaction reference (idempotency key)
 * @param {string} params.virtualAccountNumber - the account number the funds landed on
 * @param {number} params.amountKobo - integer kobo, already converted at the boundary
 * @param {number} [params.feeKobo]
 * @param {string} [params.senderAccountNumber]
 * @param {string} [params.senderBank]
 * @param {string} [params.senderName]
 * @returns {Promise<{ outcome: 'credited'|'duplicate'|'unknown_account'|'flagged'|'error', deposit?: object, error?: string }>}
 */
async function creditNombaDeposit({
  nombaTransactionRef,
  virtualAccountNumber,
  amountKobo,
  feeKobo = 0,
  senderAccountNumber,
  senderBank,
  senderName,
}) {
  if (!nombaTransactionRef || !virtualAccountNumber || !Number.isInteger(amountKobo) || amountKobo <= 0) {
    return { outcome: 'error', error: 'Invalid deposit parameters' };
  }

  const virtualAccount = await VirtualAccount.findOne({ accountNumber: virtualAccountNumber });
  if (!virtualAccount) {
    logger.error('Nomba deposit: unknown virtual account', { virtualAccountNumber, nombaTransactionRef });
    return { outcome: 'unknown_account' };
  }

  const nameCheckResult = matchSenderName(senderName, virtualAccount.accountName);

  let status = 'pending';
  let flagReason;
  if (virtualAccount.status === 'suspended') {
    status = 'flagged';
    flagReason = 'suspended_account';
  } else if (nameCheckResult === 'mismatch') {
    // Fraud/compliance: hold, do not credit. Deposits must come from an
    // account bearing the holder's own name.
    status = 'flagged';
    flagReason = 'sender_name_mismatch';
  } else if (nameCheckResult === 'unverified') {
    logger.info('Nomba deposit: sender name unverifiable — crediting anyway (see nameCheckResult caveats)', {
      nombaTransactionRef, userId: virtualAccount.userId,
    });
  }

  // Step 1: claim the ref. Unique index is the idempotency + concurrency guard —
  // this is the only place a duplicate/replay/concurrent-duplicate webhook stops.
  let deposit;
  try {
    deposit = await NombaDeposit.create({
      userId: virtualAccount.userId,
      virtualAccountId: virtualAccount._id,
      nombaTransactionRef,
      amountKobo,
      feeKobo,
      senderAccountNumber,
      senderBank,
      senderName,
      nameCheckResult,
      flagReason,
      status,
    });
  } catch (err) {
    if (err.code === DUPLICATE_KEY_ERROR) {
      logger.info('Nomba deposit: duplicate ref, already claimed — skipping', { nombaTransactionRef });
      return { outcome: 'duplicate' };
    }
    logger.error('Nomba deposit: failed to insert deposit row', { nombaTransactionRef, error: err.message });
    return { outcome: 'error', error: err.message };
  }

  if (deposit.status === 'flagged') {
    const logFn = flagReason === 'sender_name_mismatch' ? logger.error : logger.warn;
    logFn(`${flagReason === 'sender_name_mismatch' ? 'ALERT: ' : ''}Nomba deposit flagged, not credited`, {
      nombaTransactionRef,
      userId: virtualAccount.userId,
      flagReason,
      senderName,
      accountName: virtualAccount.accountName,
    });
    return { outcome: 'flagged', deposit };
  }

  return creditPendingDeposit(deposit);
}

/**
 * Credit a deposit that is already inserted (status 'pending') but not yet
 * credited — used both by the fresh-insert path above and by the sweeper when
 * resuming a deposit that was claimed but never credited (process died in between).
 */
async function creditPendingDeposit(deposit) {
  if (deposit.status === 'credited') {
    return { outcome: 'duplicate', deposit }; // already done — never re-credit
  }
  if (deposit.status !== 'pending') {
    return { outcome: 'error', error: `Cannot credit deposit in status '${deposit.status}'`, deposit };
  }

  const amountNaira = deposit.amountKobo / 100; // ngnbBalance is stored in naira units, matches every other deposit path in this repo

  try {
    await updateUserBalance(deposit.userId, 'NGNB', amountNaira);
  } catch (err) {
    logger.error('Nomba deposit: balance credit failed', {
      nombaTransactionRef: deposit.nombaTransactionRef,
      userId: deposit.userId,
      error: err.message,
    });
    return { outcome: 'error', error: err.message, deposit };
  }

  deposit.status = 'credited';
  deposit.creditedAt = new Date();
  await deposit.save();

  logger.info('Nomba deposit credited', {
    nombaTransactionRef: deposit.nombaTransactionRef,
    userId: deposit.userId,
    amountKobo: deposit.amountKobo,
  });

  return { outcome: 'credited', deposit };
}

module.exports = {
  creditNombaDeposit,
  creditPendingDeposit,
};
