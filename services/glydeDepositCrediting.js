// services/glydeDepositCrediting.js
// Glyde virtual account deposit crediting, ported from ZeusODX (same rules:
// name check, deposit limit, flat fee, admin review of held deposits).
// Used by routes/nairawebhook.js (live events) and adminRoutes/deposits.js
// (reconciliation). Every caller MUST compute the same idempotency key for
// the same real-world deposit, or a deposit could be credited twice -
// keeping this in one place is what guarantees that. The dated production
// observations in the comments below come from ZeusODX, which shares this
// Glyde integration.
const mongoose = require('mongoose');
const crypto = require('crypto');
const GlydeVirtualAccount = require('../models/glydeVirtualAccount');
const User = require('../models/user');
const Transaction = require('../models/transaction');
const DepositFee = require('../models/depositFee');
const { updateUserBalance } = require('./portfolio');
const {
  sendDepositEmail, sendDepositNameMismatchEmail, sendDepositLimitExceededEmail,
  sendDepositFeeShortfallEmail, sendDepositRejectedEmail, sendGlydeDepositAdminNotify,
} = require('./EmailService');
const { sendDepositNotification } = require('./notificationService');
const { namesMatch, namesSimilar, nameSimilarityScore } = require('../utils/kycHelpers');
const logger = require('../utils/logger');

/**
 * Find the GlydeVirtualAccount a raw Glyde deposit event/transaction item
 * belongs to. Tries uid first (most reliable - what we store as the
 * primary key), then merchant_reference/customer.reference, then
 * account_number. Exported so the admin reconciliation view can match
 * accounts the exact same way the live crediting path does, instead of
 * trusting merchant_reference alone (which doesn't correspond to our
 * accounts - confirmed against real payloads 2026-09-28).
 */
async function findAccountForDeposit(data) {
  const vaUid = data.uid || data.virtual_account_uid || null;
  // Confirmed real field (2026-09-28): nested at data.payee.reference, not
  // top-level merchant_reference/customer.reference as originally assumed -
  // kept as fallbacks in case a different event shape uses those instead.
  const merchantReference = data.payee?.reference || data.merchant_reference || data.customer?.reference || null;
  const accountNumber = data.account_number || null;

  let account = null;
  if (vaUid) account = await GlydeVirtualAccount.findOne({ uid: vaUid });
  if (!account && merchantReference) account = await GlydeVirtualAccount.findOne({ reference: merchantReference });
  if (!account && accountNumber) account = await GlydeVirtualAccount.findOne({ accountNumber });

  return { account, vaUid, merchantReference, accountNumber };
}

/**
 * The exact reference every credited Transaction is stored under - must be
 * computed identically everywhere it's used (crediting, reconciliation),
 * or the reconciliation view can't find a deposit that was actually
 * credited (this happened: it used to build merchantReference-glydeReference
 * instead of account.reference-glydeReference, so it could never match).
 */
function computeIdempotencyReference(data, account) {
  // transaction_reference is the confirmed real per-transaction field.
  const glydeReference = data.transaction_reference || data.reference || data.id || null;
  if (glydeReference) {
    return `${account.reference}-${glydeReference}`;
  }
  // Fallback for a payload shape with no per-transaction reference at all -
  // hash the full event instead of uid+amount+timestamp. Confirmed
  // (2026-09-28) that the webhook payload's only timestamp field
  // (data.created_at) is actually the *account's* constant creation date,
  // not the deposit's - two different deposits of the same amount to the
  // same account would have collided on that key, silently dropping the
  // second one as "already processed" rather than crediting it. A hash of
  // the whole event is deterministic (safe retry) but collides only if the
  // event is byte-for-byte identical.
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
  return `${account.uid}-${fingerprint}`;
}

/**
 * Glyde's payer.account_name is sometimes a clean bank account holder name
 * (e.g. "ZEUSODX LIMITED") and sometimes a full transaction narration from
 * the originating bank (e.g. "Transfer 2000.00 To Godspower Odion") -
 * format varies by the SENDING bank, not something we control. A narration
 * is not the sender's identity, and critically, narrations commonly embed
 * the RECIPIENT's own name ("...To [recipient]") - which makes
 * namesPartiallyOverlap() always "match" against the account owner
 * regardless of who actually sent the money, since the recipient's own
 * registered name is exactly what's being compared against. Confirmed in
 * production (2026-10-01): a deposit's payer.account_name was literally
 * "Transfer 2000.00 To Godspower Odion" - matched the account owner
 * (Godspower Odion) purely because the narration mentions the recipient,
 * completely defeating the anti-fraud check for banks using this format.
 * Real account holder names never contain digits or these narration verbs,
 * so this is a safe, low-risk signal to fall back to "can't verify" (same
 * lenient pass-through already used when the field is missing entirely)
 * rather than risk a false "verified match".
 */
function looksLikeNarrationNotAName(text) {
  if (!text) return false;
  if (/\d/.test(text)) return true;
  return /\b(transfer|payment|nip|pos|ussd|via|txn|trx)\b/i.test(text);
}

// Single-deposit cap for Glyde bank-transfer deposits - anything above this
// is held for manual review rather than auto-credited, regardless of
// whether the sender's name checks out. A clean name match only tells us
// the deposit probably isn't impersonating someone else; it says nothing
// about whether a deposit this large is expected/legitimate, which is a
// separate risk worth a human look.
const GLYDE_DEPOSIT_LIMIT = 5000000;

/**
 * Credit a single Glyde deposit event if it hasn't been credited already.
 * `data` is the raw event/transaction object from Glyde - shape varies by
 * source (webhook payload vs account-transactions list item), so every
 * field is read defensively. `data.uid` should always be set by the caller
 * to the owning GlydeVirtualAccount's uid (the webhook payload carries it
 * directly; a caller replaying an account's transaction list must inject it
 * since that endpoint is already scoped to one account).
 *
 * @returns {Promise<{outcome: string, transaction?: object}>} outcome is one
 *   of: 'credited', 'already_processed', 'no_account_match', 'no_amount',
 *   'failed_status', 'fee_shortfall', 'name_mismatch', 'name_unverifiable',
 *   'deposit_limit_exceeded'
 */
async function creditGlydeDepositIfNeeded(data) {
  if (data.status === 'failed') {
    return { outcome: 'failed_status' };
  }

  const amount = data.amount ?? data.total_collected ?? null;
  const merchantReference = data.payee?.reference || data.merchant_reference || data.customer?.reference || null;
  const glydeReference = data.transaction_reference || data.reference || data.id || null;
  const payerAccountName = data.payer?.account_name || null;

  if (!amount) {
    return { outcome: 'no_amount' };
  }

  const { account, vaUid, accountNumber } = await findAccountForDeposit(data);

  if (!account) {
    return { outcome: 'no_account_match', vaUid, merchantReference, accountNumber };
  }

  const idempotencyReference = computeIdempotencyReference(data, account);

  const alreadyProcessed = await Transaction.findOne({ reference: idempotencyReference });
  if (alreadyProcessed) {
    return { outcome: 'already_processed', transaction: alreadyProcessed };
  }

  const user = await User.findById(account.userId);
  if (!user) {
    logger.error('creditGlydeDepositIfNeeded: virtual account has no matching user', { userId: account.userId, uid: account.uid });
    return { outcome: 'no_account_match', reason: 'user_not_found' };
  }

  // Deposit limit: held for manual review regardless of name verification -
  // checked before the name check since it's a simpler, always-applicable
  // gate and there's no point computing a name-match score for a deposit
  // that's getting held either way.
  if (Number(amount) > GLYDE_DEPOSIT_LIMIT) {
    try {
      await Transaction.create({
        userId: user._id,
        type: 'DEPOSIT',
        currency: 'NGNB',
        amount: 0,
        fee: 0,
        status: 'FAILED',
        source: 'BANK',
        reference: idempotencyReference,
        narration: `NGNB deposit via bank transfer (${account.accountNumber}) - amount ₦${Number(amount).toLocaleString('en-NG')} exceeds the ₦${GLYDE_DEPOSIT_LIMIT.toLocaleString('en-NG')} deposit limit, held for manual review`,
        metadata: {
          glydeReference, merchantReference, virtualAccountUid: account.uid,
          grossAmount: Number(amount), payerAccountName,
          needsManualReview: true, depositLimitExceeded: true,
        },
      });
    } catch (createErr) {
      if (createErr.code !== 11000) throw createErr;
    }
    logger.warn('Glyde deposit held - exceeds deposit limit', {
      userId: user._id, uid: account.uid, amount: Number(amount), limit: GLYDE_DEPOSIT_LIMIT,
    });

    if (user.email) {
      sendDepositLimitExceededEmail(user.email, user.firstname || user.username, Number(amount), 'NGNB', idempotencyReference, GLYDE_DEPOSIT_LIMIT)
        .catch((err) => logger.error('Failed to send deposit limit-exceeded email', { userId: user._id, error: err.message }));
    }

    return { outcome: 'deposit_limit_exceeded', amount: Number(amount), limit: GLYDE_DEPOSIT_LIMIT };
  }

  // Anti-fraud: the depositing bank account's name must match the account
  // owner's registered name - either a full-subset word match (namesMatch,
  // handles reordered/extended legal names, e.g. "Abdul Yahaya" vs "Yahaya
  // Abdul Basit Omeiza") or a Jaro-Winkler near-match (namesSimilar, handles
  // typos - the industry-standard algorithm for this, used by OFAC sanctions
  // screening and UK Confirmation of Payee). Deliberately NOT plain
  // single-word overlap: tested against "Godspower Odion" vs the narration
  // "Transfer 2000.00 To Godspower Odion", Jaro-Winkler alone still scored
  // 0.91 (false match) - this check has no selfie-match backstop like KYC
  // does, so it leans on looksLikeNarrationNotAName below to catch that
  // case instead, rather than loosening the name comparison itself.
  // Confirmed via a real production payload (2026-09-28) that
  // data.payer.account_name can differ entirely from the account owner (a
  // deposit from "ZEUSODX LIMITED" into a customer's personal account was
  // credited with no check at all) - this closes that gap. If Glyde doesn't
  // send a payer name for some event shape, or it looks like a narration
  // rather than a clean name, we can't reliably verify either way, so it
  // proceeds rather than blocking/falsely-matching on unreliable data.
  const registeredName = `${user.firstname || ''} ${user.lastname || ''}`.trim();
  const isNarration = looksLikeNarrationNotAName(payerAccountName);
  const payerNameUsable = payerAccountName && !isNarration;
  const matchedBySubset = payerNameUsable && registeredName ? namesMatch(payerAccountName, registeredName) : false;
  const matchedBySimilarity = payerNameUsable && registeredName ? namesSimilar(payerAccountName, registeredName) : false;
  const similarityScore = payerNameUsable && registeredName ? nameSimilarityScore(payerAccountName, registeredName) : null;
  const nameIsAcceptableMatch = registeredName && (matchedBySubset || matchedBySimilarity);

  // Full decision breakdown for every deposit (not just mismatches) - the
  // raw payer name alone wasn't enough to diagnose why a specific deposit
  // was/wasn't flagged, since the outcome depends on several intermediate
  // checks (narration detection, subset match, similarity score) that
  // weren't otherwise visible without re-deriving them by hand. predictedGate
  // mirrors the three branches below exactly (credit / confirmed mismatch /
  // held-unverifiable) - a plain willCredit boolean went stale the moment a
  // third branch was added and silently lied about outcomes it didn't cover.
  const predictedGate = (payerNameUsable && registeredName && !nameIsAcceptableMatch)
    ? 'name_mismatch'
    : (!payerNameUsable || !registeredName)
      ? 'name_unverifiable'
      : 'credited';
  logger.info('Glyde deposit name-check decision', {
    userId: user._id, uid: account.uid,
    rawPayload: data,
    payerAccountName, registeredName,
    isNarration, payerNameUsable,
    matchedBySubset, matchedBySimilarity, similarityScore,
    predictedGate,
  });

  if (payerNameUsable && registeredName && !nameIsAcceptableMatch) {
    try {
      await Transaction.create({
        userId: user._id,
        type: 'DEPOSIT',
        currency: 'NGNB',
        amount: 0,
        fee: 0,
        status: 'FAILED',
        source: 'BANK',
        reference: idempotencyReference,
        narration: `NGNB deposit via bank transfer (${account.accountNumber}) - sender name "${payerAccountName}" does not match account owner "${registeredName}", not credited`,
        metadata: {
          glydeReference, merchantReference, virtualAccountUid: account.uid,
          grossAmount: Number(amount), payerAccountName, registeredName,
          needsManualReview: true, nameMismatch: true,
        },
      });
    } catch (createErr) {
      if (createErr.code !== 11000) throw createErr;
    }
    logger.warn('Glyde deposit blocked - sender name does not match account owner', {
      userId: user._id, uid: account.uid, payerAccountName, registeredName, amount,
    });

    if (user.email) {
      sendDepositNameMismatchEmail(user.email, user.firstname || user.username, amount, 'NGNB', idempotencyReference, payerAccountName)
        .catch((err) => logger.error('Failed to send deposit name-mismatch email', { userId: user._id, error: err.message }));
    }

    return { outcome: 'name_mismatch', payerAccountName, registeredName };
  }

  // Can't verify either way (narration-style or missing payer name, or no
  // registered name to compare against) - don't auto-credit on an unknown,
  // same as a confirmed mismatch, since a narration can embed the
  // recipient's own name and would otherwise sail through unverified (see
  // looksLikeNarrationNotAName). Held for manual review via
  // adminApproveHeldDeposit instead of blocked outright, since this is
  // genuinely ambiguous, not a confirmed fraud signal - no accusatory email
  // to the user, just a flag for staff to check the real bank record.
  if (!payerNameUsable || !registeredName) {
    try {
      await Transaction.create({
        userId: user._id,
        type: 'DEPOSIT',
        currency: 'NGNB',
        amount: 0,
        fee: 0,
        status: 'FAILED',
        source: 'BANK',
        reference: idempotencyReference,
        narration: `NGNB deposit via bank transfer (${account.accountNumber}) - sender name could not be verified ("${payerAccountName || 'not provided'}"), held for manual review`,
        metadata: {
          glydeReference, merchantReference, virtualAccountUid: account.uid,
          grossAmount: Number(amount), payerAccountName, registeredName,
          needsManualReview: true, nameUnverifiable: true,
        },
      });
    } catch (createErr) {
      if (createErr.code !== 11000) throw createErr;
    }
    logger.warn('Glyde deposit held - sender name could not be verified', {
      userId: user._id, uid: account.uid, payerAccountName, registeredName, amount,
    });

    return { outcome: 'name_unverifiable', payerAccountName, registeredName };
  }

  return executeCredit(user, account, idempotencyReference, Number(amount), { glydeReference, merchantReference, payerAccountName });
}

/**
 * Actually move money: compute the deposit fee, credit the user's balance,
 * and send the confirmation email/push. Shared by the normal auto-credit
 * path (name verified) and adminApproveHeldDeposit (a human verified it
 * instead) - both must apply the identical fee/balance/notification logic.
 */
async function executeCredit(user, account, idempotencyReference, grossAmount, { glydeReference, merchantReference, payerAccountName }) {
  let feeAmount = 0;
  try {
    const feeDoc = await DepositFee.getOrCreateCurrentFee();
    if (feeDoc && feeDoc.isActive) {
      feeAmount = feeDoc.feeAmount;
    }
  } catch (feeError) {
    logger.error('executeCredit: failed to load deposit fee config, defaulting to 0', { error: feeError.message });
  }

  const creditedAmount = Math.max(grossAmount - feeAmount, 0);

  if (creditedAmount <= 0) {
    try {
      await Transaction.create({
        userId: user._id,
        type: 'DEPOSIT',
        currency: 'NGNB',
        amount: 0,
        fee: feeAmount,
        status: 'FAILED',
        source: 'BANK',
        reference: idempotencyReference,
        narration: `NGNB deposit via bank transfer (${account.accountNumber}) - amount did not cover deposit fee, not credited`,
        metadata: { glydeReference, merchantReference, virtualAccountUid: account.uid, grossAmount, feeAmount, needsManualReview: true },
      });
    } catch (createErr) {
      if (createErr.code !== 11000) throw createErr;
    }

    // Unlike name_mismatch/deposit_limit_exceeded, this isn't a fraud
    // signal - the user's bank account was genuinely debited and the money
    // reached Glyde, it just didn't clear our fee. Silence here would mean
    // their money "disappears" with zero explanation anywhere they can see.
    if (user.email) {
      sendDepositFeeShortfallEmail(user.email, user.firstname || user.username, grossAmount, feeAmount, 'NGNB', idempotencyReference)
        .catch((err) => logger.error('Failed to send deposit fee-shortfall email', { userId: user._id, error: err.message }));
    }

    return { outcome: 'fee_shortfall' };
  }

  let transaction;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const created = await Transaction.create([{
        userId: user._id,
        type: 'DEPOSIT',
        currency: 'NGNB',
        amount: creditedAmount,
        fee: feeAmount,
        status: 'SUCCESSFUL',
        source: 'BANK',
        reference: idempotencyReference,
        narration: `NGNB deposit via bank transfer (${account.accountNumber})${feeAmount > 0 ? ` - ₦${feeAmount} deposit fee deducted` : ''}`,
        metadata: { glydeReference, merchantReference, virtualAccountUid: account.uid, grossAmount, feeAmount, payerAccountName },
      }], { session });
      transaction = created[0];

      await updateUserBalance(user._id, 'NGNB', creditedAmount, session);
    });
  } catch (txError) {
    if (txError.code === 11000) {
      return { outcome: 'already_processed' };
    }
    throw txError;
  } finally {
    await session.endSession();
  }

  logger.info('Glyde virtual account deposit credited', {
    userId: user._id, grossAmount, feeAmount, amount: creditedAmount,
    transactionId: transaction._id, merchantReference, glydeReference,
  });

  try {
    if (user.email) {
      await sendDepositEmail(user.email, user.firstname || user.username || 'User', creditedAmount, 'NGNB', idempotencyReference);
    }
  } catch (emailError) {
    logger.error('Failed to send Glyde deposit email', { userId: user._id, error: emailError.message });
  }

  // Alert admins / super admins of the naira deposit (fire-and-forget).
  sendGlydeDepositAdminNotify({
    username: user.username || user.firstname || user.email,
    userId: String(user._id),
    grossAmount, feeAmount, creditedAmount,
    reference: idempotencyReference, glydeReference,
    accountNumber: account.accountNumber, payerName: payerAccountName,
    transactionId: String(transaction._id),
  }).catch(err => logger.error('Glyde deposit admin notify failed', { userId: user._id, error: err.message }));

  try {
    const pushResult = await sendDepositNotification(user._id.toString(), creditedAmount, 'NGNB', 'confirmed', {
      reference: idempotencyReference,
      transactionId: transaction._id.toString(),
    });
    if (!pushResult.success && !pushResult.skipped) {
      logger.warn('Failed to send Glyde deposit push notification', { userId: user._id, message: pushResult.message });
    }
  } catch (pushError) {
    logger.error('Error sending Glyde deposit push notification', { userId: user._id, error: pushError.message });
  }

  return { outcome: 'credited', transaction };
}

/**
 * Admin-triggered release of a held deposit (status FAILED,
 * metadata.needsManualReview true - either name_mismatch or
 * name_unverifiable) after a human has manually confirmed the deposit is
 * legitimate (e.g. checked the real bank statement/narration). Updates the
 * existing held Transaction document in place rather than creating a new
 * one, since its `reference` already holds the unique idempotency slot for
 * this deposit.
 *
 * @returns {Promise<{outcome: string, transaction?: object, message?: string}>}
 *   outcome: 'approved_and_credited' | 'not_found' | 'not_held' | 'amount_too_low'
 */
async function adminApproveHeldDeposit(transactionId, adminId) {
  const held = await Transaction.findById(transactionId);
  if (!held) {
    return { outcome: 'not_found' };
  }
  if (!(held.source === 'BANK' && held.currency === 'NGNB' && held.status === 'FAILED' && held.metadata?.needsManualReview)) {
    return { outcome: 'not_held', message: 'This transaction is not a held Glyde deposit awaiting review.' };
  }

  const user = await User.findById(held.userId);
  if (!user) {
    return { outcome: 'not_found', message: 'User no longer exists.' };
  }

  const grossAmount = Number(held.metadata.grossAmount) || 0;

  let feeAmount = 0;
  try {
    const feeDoc = await DepositFee.getOrCreateCurrentFee();
    if (feeDoc && feeDoc.isActive) feeAmount = feeDoc.feeAmount;
  } catch (feeError) {
    logger.error('adminApproveHeldDeposit: failed to load deposit fee config, defaulting to 0', { error: feeError.message });
  }

  const creditedAmount = Math.max(grossAmount - feeAmount, 0);
  if (creditedAmount <= 0) {
    return { outcome: 'amount_too_low', message: 'Gross amount does not cover the current deposit fee.' };
  }

  // The held check above is a read-then-act, so two concurrent approvals
  // (double-click, two admins) would both pass it and both credit. Claim
  // the row atomically instead - the filter only matches while it's still
  // held, so exactly one approval wins and the other moves no money.
  let claimed = null;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      claimed = await Transaction.findOneAndUpdate(
        { _id: held._id, status: 'FAILED', 'metadata.needsManualReview': true },
        {
          $set: {
            status: 'SUCCESSFUL',
            amount: creditedAmount,
            fee: feeAmount,
            narration: `NGNB deposit via bank transfer - manually approved by admin after review${feeAmount > 0 ? ` (₦${feeAmount} deposit fee deducted)` : ''}`,
            'metadata.feeAmount': feeAmount,
            'metadata.needsManualReview': false,
            'metadata.approvedBy': adminId,
            'metadata.approvedAt': new Date(),
          },
        },
        { new: true, session }
      );
      if (!claimed) return;

      await updateUserBalance(user._id, 'NGNB', creditedAmount, session);
    });
  } finally {
    await session.endSession();
  }

  if (!claimed) {
    return { outcome: 'not_held', message: 'This deposit was already approved or rejected.' };
  }

  logger.info('Glyde held deposit approved and credited by admin', {
    userId: user._id, transactionId: held._id, adminId, grossAmount, feeAmount, creditedAmount,
  });

  try {
    if (user.email) {
      await sendDepositEmail(user.email, user.firstname || user.username || 'User', creditedAmount, 'NGNB', held.reference);
    }
  } catch (emailError) {
    logger.error('Failed to send Glyde deposit email (admin approval)', { userId: user._id, error: emailError.message });
  }

  try {
    await sendDepositNotification(user._id.toString(), creditedAmount, 'NGNB', 'confirmed', {
      reference: held.reference,
      transactionId: held._id.toString(),
    });
  } catch (pushError) {
    logger.error('Error sending Glyde deposit push notification (admin approval)', { userId: user._id, error: pushError.message });
  }

  return { outcome: 'approved_and_credited', transaction: claimed };
}

/**
 * Admin-triggered dismissal of a held deposit (confirmed fraud, or
 * otherwise not to be credited) - clears needsManualReview so it stops
 * surfacing as pending in the reconciliation view, without moving any
 * money.
 */
async function adminRejectHeldDeposit(transactionId, adminId, reason) {
  const held = await Transaction.findById(transactionId);
  if (!held) {
    return { outcome: 'not_found' };
  }
  if (!(held.source === 'BANK' && held.currency === 'NGNB' && held.status === 'FAILED' && held.metadata?.needsManualReview)) {
    return { outcome: 'not_held', message: 'This transaction is not a held Glyde deposit awaiting review.' };
  }

  // Atomic for the same reason as approval - a reject racing an approve
  // must not leave a credited deposit marked as rejected.
  const rejected = await Transaction.findOneAndUpdate(
    { _id: held._id, status: 'FAILED', 'metadata.needsManualReview': true },
    {
      $set: {
        'metadata.needsManualReview': false,
        'metadata.rejectedBy': adminId,
        'metadata.rejectedAt': new Date(),
        'metadata.rejectionReason': reason || null,
      },
    },
    { new: true }
  );
  if (!rejected) {
    return { outcome: 'not_held', message: 'This deposit was already approved or rejected.' };
  }

  logger.info('Glyde held deposit rejected by admin', { transactionId: held._id, adminId, reason });

  // Deliberately generic, non-accusatory wording - the held deposit could
  // be a false positive (legitimate user, odd narration/name) as easily as
  // confirmed fraud, and either way the email shouldn't reveal which
  // specific detection caught it (tips off an actual bad actor on exactly
  // what to avoid next time).
  const user = await User.findById(held.userId);
  if (user?.email) {
    const grossAmount = Number(held.metadata?.grossAmount) || 0;
    sendDepositRejectedEmail(user.email, user.firstname || user.username, grossAmount, held.currency || 'NGNB', held.reference)
      .catch((err) => logger.error('Failed to send deposit rejected email', { userId: user._id, error: err.message }));
  }

  return { outcome: 'rejected', transaction: rejected };
}

module.exports = {
  creditGlydeDepositIfNeeded,
  findAccountForDeposit,
  computeIdempotencyReference,
  adminApproveHeldDeposit,
  adminRejectHeldDeposit,
};
