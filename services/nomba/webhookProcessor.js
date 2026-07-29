// services/nomba/webhookProcessor.js
//
// Processes a single NombaWebhookEvent row: filters to payment-received events,
// extracts the fields creditNombaDeposit needs, and calls the shared credit path.
// Used both for immediate post-response processing (routes/Nombadeposit.js) and
// by the sweeper (services/nomba/reconciliation.js) re-processing stuck events —
// same function, same outcome either way.
//
// ⚠️ CONFIRM AGAINST NOMBA DOCS / A REAL SANDBOX EVENT BEFORE GOING LIVE:
//   - Exact `event_type` string(s) for a virtual-account credit. Configurable via
//     NOMBA_PAYMENT_EVENT_TYPES (comma-separated) so this doesn't need a code
//     change once confirmed — defaults below are best-effort candidates.
//   - Exact payload field paths for transaction ref / amount / account number /
//     sender details. extractDepositFields() tries several plausible shapes
//     (Nomba's docs describe a `data.transaction` + `data.merchant` / `data.account`
//     nesting) and logs the raw payload on failure so the real shape can be read
//     back out of NombaWebhookEvent.payload once a live event has been captured.
//   - Whether amount arrives in naira (decimal) or kobo (integer). Assumed naira
//     decimal below (Nomba's public docs show amounts like "100.00"); converted
//     once at this boundary via toKobo(). If it turns out to already be kobo,
//     change ONLY toKobo() — nothing downstream needs to know.

const NombaWebhookEvent = require('../../models/nombaWebhookEvent');
const { creditNombaDeposit } = require('./depositCredit');
const logger = require('../../utils/logger');

const PAYMENT_EVENT_TYPES = new Set(
  (process.env.NOMBA_PAYMENT_EVENT_TYPES || 'payment_success,payin_success,virtual_account_credit')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

/** Naira (decimal, possibly string) → integer kobo. Single conversion boundary. */
function toKobo(amount) {
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/**
 * Best-effort extraction across a few plausible Nomba payload shapes.
 * Returns null (not throw) if required fields can't be found, so the caller
 * can mark the event 'failed' with a clear reason instead of crashing.
 */
function extractDepositFields(payload) {
  const data = payload?.data || payload;
  const txn = data?.transaction || data;
  const account = data?.merchant || data?.account || data?.virtualAccount || {};
  const sender = data?.sender || data?.originator || {};

  const nombaTransactionRef =
    txn?.transactionRef || txn?.reference || txn?.ref || data?.transactionRef || data?.reference || null;

  const rawAmount = txn?.amount ?? data?.amount;
  const amountKobo = rawAmount != null ? toKobo(rawAmount) : null;

  const virtualAccountNumber =
    account?.walletAccountNumber || account?.accountNumber || account?.virtualAccountNumber ||
    data?.accountNumber || data?.virtualAccountNumber || null;

  if (!nombaTransactionRef || amountKobo == null || !virtualAccountNumber) {
    return null;
  }

  return {
    nombaTransactionRef: String(nombaTransactionRef),
    amountKobo,
    feeKobo: txn?.fee != null ? (toKobo(txn.fee) || 0) : 0,
    virtualAccountNumber: String(virtualAccountNumber),
    senderAccountNumber: sender?.accountNumber || null,
    senderBank: sender?.bank || sender?.bankName || null,
    senderName: sender?.name || sender?.accountName || null,
  };
}

/**
 * Process one NombaWebhookEvent document. Mutates and saves it with the
 * outcome. Never throws — always resolves so callers (route + sweeper) can
 * process a batch without one bad event stopping the rest.
 */
async function processWebhookEvent(eventDoc) {
  try {
    if (!eventDoc.signatureValid) {
      eventDoc.processingStatus = 'failed';
      eventDoc.error = 'Invalid signature';
      eventDoc.processedAt = new Date();
      await eventDoc.save();
      return { outcome: 'failed', reason: 'invalid_signature' };
    }

    const eventType = eventDoc.eventType || eventDoc.payload?.event_type || eventDoc.payload?.eventType;
    if (eventType && !PAYMENT_EVENT_TYPES.has(eventType)) {
      // Not a payment-received event (e.g. a payout/other Nomba event type) —
      // successfully handled by doing nothing. 'processed' so the sweeper never
      // retries it; error field left as a breadcrumb, not a real failure.
      eventDoc.processingStatus = 'processed';
      eventDoc.error = `Ignored — not a payment event_type: ${eventType}`;
      eventDoc.processedAt = new Date();
      await eventDoc.save();
      return { outcome: 'ignored', eventType };
    }

    const fields = extractDepositFields(eventDoc.payload);
    if (!fields) {
      eventDoc.processingStatus = 'failed';
      eventDoc.error = 'Could not extract required fields from payload — see payload field for raw body';
      eventDoc.processedAt = new Date();
      await eventDoc.save();
      logger.error('Nomba webhook: field extraction failed', { eventId: eventDoc.eventId, mongoId: eventDoc._id });
      return { outcome: 'failed', reason: 'extraction_failed' };
    }

    const result = await creditNombaDeposit(fields);

    if (result.outcome === 'credited') {
      eventDoc.processingStatus = 'processed';
    } else if (result.outcome === 'duplicate') {
      eventDoc.processingStatus = 'skipped_duplicate';
    } else if (result.outcome === 'flagged') {
      // Correctly handled, not a failure — a suspended account or a
      // sender-name mismatch was correctly detected and correctly held for
      // manual review. Terminal: the sweeper must NOT keep retrying this.
      eventDoc.processingStatus = 'processed';
      eventDoc.error = `Flagged, not credited: ${result.deposit?.flagReason || 'unknown reason'}`;
    } else {
      eventDoc.processingStatus = 'failed';
      eventDoc.error = result.error || result.outcome;
    }
    eventDoc.processedAt = new Date();
    await eventDoc.save();

    return result;
  } catch (error) {
    logger.error('Nomba webhook: unexpected processing error', { error: error.message, mongoId: eventDoc._id });
    try {
      eventDoc.processingStatus = 'failed';
      eventDoc.error = error.message;
      eventDoc.processedAt = new Date();
      await eventDoc.save();
    } catch (saveErr) {
      logger.error('Nomba webhook: failed to persist failure state', { error: saveErr.message });
    }
    return { outcome: 'error', error: error.message };
  }
}

module.exports = {
  processWebhookEvent,
  extractDepositFields, // exported for unit tests
  toKobo,
};
