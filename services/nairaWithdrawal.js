// services/nairaWithdrawal.js
const axios = require('axios');
const crypto = require('crypto');
const ChatbotTransaction = require('../models/ChatbotTransaction');
const logger = require('../utils/logger');

let config = {};
try { config = require('../routes/config'); } catch (_) { config = {}; }

const { validateObiexConfig, attachObiexAuth } = require('../utils/obiexAuth');

const baseURL =
  (config.obiex && String(config.obiex.baseURL || '').replace(/\/+$/, '')) ||
  String(process.env.OBIEX_BASE_URL || '').replace(/\/+$/, '');

const obiex = axios.create({ baseURL, timeout: 30000 });
obiex.interceptors.request.use(attachObiexAuth);

// ---------- helpers ----------
function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString('hex');
}
function maskAcct(acct) {
  if (!acct) return '';
  const s = String(acct).replace(/\s+/g, '');
  return s.length <= 4 ? s : `${s.slice(0, 2)}****${s.slice(-2)}`;
}
function cleanStr(v) { return (v ?? '').toString().trim(); }

function sanitizeDestination(d = {}) {
  return {
    accountNumber: cleanStr(d.accountNumber),
    accountName: cleanStr(d.accountName),
    bankName: cleanStr(d.bankName),
    bankCode: cleanStr(d.bankCode),
    // Optional:
    pagaBankCode: d.pagaBankCode ? cleanStr(d.pagaBankCode) : undefined,
    merchantCode: d.merchantCode ? cleanStr(d.merchantCode) : undefined,
  };
}

/**
 * For Obiex /wallets/ext/debit/fiat:
 *   - currency MUST be a fiat-like ledger code (here: "NGNX")
 *   - amount MUST be an amount in that currency
 */
function sanitizeFiatPayload(body = {}) {
  const destination = sanitizeDestination(body.destination || {});
  const amount = Number(body.amount);
  const currency = cleanStr(body.currency || 'NGNX').toUpperCase(); // default to NGNX
  const narration =
    cleanStr(body.narration) ||
    `NGNX payout to ${destination.accountName || 'beneficiary'} (${maskAcct(destination.accountNumber)})`;

  return { destination, amount, currency, narration };
}

function validateFiatPayload(clean) {
  const errs = [];
  if (!clean.destination.accountNumber) errs.push('destination.accountNumber is required');
  if (!clean.destination.accountName) errs.push('destination.accountName is required');
  if (!clean.destination.bankName) errs.push('destination.bankName is required');
  if (!clean.destination.bankCode) errs.push('destination.bankCode is required');
  if (!clean.amount || isNaN(clean.amount) || clean.amount <= 0) errs.push('amount must be a positive number');
  if (!clean.currency) errs.push('currency is required');
  return errs;
}

function pickRequestId(headers = {}) {
  return (
    headers['x-request-id'] ||
    headers['x-correlation-id'] ||
    headers['cf-ray'] ||
    headers['traceparent'] ||
    null
  );
}

// NEW: Helper to calculate amount differences for audit
async function auditPayoutAmount(chatbotPaymentId, actualAmount, log = logger) {
  if (!chatbotPaymentId) return null;

  try {
    const transaction = await ChatbotTransaction.findOne({ paymentId: chatbotPaymentId }).lean();
    if (!transaction) return null;

    const originalQuoted = transaction.receiveAmount || 0;
    const difference = actualAmount - originalQuoted;
    const percentageDiff = originalQuoted > 0 ? ((difference / originalQuoted) * 100) : 0;

    const audit = {
      originalQuoted,
      actualAmount,
      difference,
      percentageDiff: Math.round(percentageDiff * 100) / 100, // 2 decimal places
      hasObservedAmount: !!transaction.observedAmount,
      observedAmount: transaction.observedAmount || null
    };

    if (Math.abs(difference) > 0.01) { // More than 1 kobo difference
      log.info('Payout amount differs from original quote', {
        paymentId: chatbotPaymentId,
        ...audit
      });
    }

    return audit;
  } catch (error) {
    log.error('Failed to audit payout amount', {
      paymentId: chatbotPaymentId,
      error: error.message
    });
    return null;
  }
}

// ---------- main service ----------
/**
 * Debit NGNX via Obiex (bank payout routed by provider).
 *
 * Pass:
 *   amount   => NGNX amount (1:1 with NGN) - should be actualReceiveAmount from webhook
 *   currency => "NGNX"
 */
async function debitNaira(payload, opts = {}) {
  validateObiexConfig();

  const clean = sanitizeFiatPayload(payload);
  const errors = validateFiatPayload(clean);
  if (errors.length) {
    return { success: false, statusCode: 400, message: errors.join('; ') };
  }

  const idempotencyKey =
    opts.idempotencyKey ||
    `fiat-${clean.currency}:${opts.userId || 'anon'}:${maskAcct(clean.destination.accountNumber)}:${clean.amount}:${Date.now()}:${uuid()}`;

  const { chatbotPaymentId, userId } = opts;

  // NEW: Audit the payout amount vs original quote
  const amountAudit = await auditPayoutAmount(chatbotPaymentId, clean.amount, logger);

  // Pre-write: REQUESTED with enhanced tracking
  if (chatbotPaymentId) {
    try {
      const updateFields = {
        payoutStatus: 'REQUESTED',
        payoutSuccess: false,
        payoutRequestedAt: new Date(),
        payoutCurrency: clean.currency,           // "NGNX"
        payoutAmount: Number(clean.amount),       // ACTUAL NGNX amount (not original quote)
        payoutNarration: clean.narration,
        payout: {
          bankName: clean.destination.bankName,
          bankCode: clean.destination.bankCode,
          accountNumber: clean.destination.accountNumber,
          accountName: clean.destination.accountName,
          ...(clean.destination.pagaBankCode ? { pagaBankCode: clean.destination.pagaBankCode } : {}),
          ...(clean.destination.merchantCode ? { merchantCode: clean.destination.merchantCode } : {}),
          capturedAt: new Date(),
        },
        'payoutResult.provider': 'OBIEX',
        'payoutResult.idempotencyKey': idempotencyKey,
      };

      // NEW: Store audit info if available
      if (amountAudit) {
        updateFields['payoutResult.amountAudit'] = amountAudit;

        // Store both amounts for historical tracking
        if (amountAudit.originalQuoted) {
          updateFields.originalQuotedAmount = amountAudit.originalQuoted;
        }
      }

      await ChatbotTransaction.findOneAndUpdate(
        { paymentId: chatbotPaymentId, ...(userId ? { userId } : {}) },
        { $set: updateFields },
        { new: true }
      );
    } catch (e) {
      logger.warn('Failed to pre-mark ChatbotTransaction payout REQUESTED', {
        e: e.message, paymentId: chatbotPaymentId, userId,
      });
    }
  }

  const payloadPreview = {
    destination: {
      accountNumber: maskAcct(clean.destination.accountNumber),
      accountName: clean.destination.accountName,
      bankName: clean.destination.bankName,
      bankCode: clean.destination.bankCode,
      ...(clean.destination.pagaBankCode ? { pagaBankCode: clean.destination.pagaBankCode } : {}),
      ...(clean.destination.merchantCode ? { merchantCode: clean.destination.merchantCode } : {}),
    },
    amount: clean.amount,            // ACTUAL NGNX amount
    currency: clean.currency,        // "NGNX"
    narration: clean.narration,
    idempotencyKey,
    ...(amountAudit && amountAudit.difference !== 0 ? {
      amountNote: `Actual: ${clean.amount}, Quoted: ${amountAudit.originalQuoted}, Diff: ${amountAudit.difference}`
    } : {})
  };

  try {
    logger.info('Initiating ACTUAL NGNX debit via Obiex', payloadPreview);

    const res = await obiex.post('/wallets/ext/debit/fiat', clean, {
      headers: {
        'Idempotency-Key': idempotencyKey,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      maxBodyLength: Infinity,
    });

    const d = res?.data?.data || res?.data || {};
    const out = {
      id: d.id || d.transactionId || null,
      reference: d.reference || d.ref || null,
      status: d.status || d.payout?.status || 'PENDING',
      payout: d.payout || null,
      raw: d,
    };

    logger.info('Obiex ACTUAL NGNX debit success', {
      obiexId: out.id,
      reference: out.reference,
      status: out.status,
      requestId: pickRequestId(res?.headers || {}),
      actualAmount: clean.amount,
      ...(amountAudit ? {
        quotedAmount: amountAudit.originalQuoted,
        amountDifference: amountAudit.difference
      } : {})
    });

    if (chatbotPaymentId) {
      try {
        await ChatbotTransaction.findOneAndUpdate(
          { paymentId: chatbotPaymentId, ...(userId ? { userId } : {}) },
          {
            $set: {
              status: 'COMPLETED',
              payoutStatus: 'SUCCESS',
              payoutSuccess: true,
              payoutCompletedAt: new Date(),
              'payoutResult.obiexId': out.id,
              'payoutResult.obiexReference': out.reference,
              'payoutResult.obiexStatus': out.status,
              'payoutResult.finalAmount': Number(clean.amount), // Final actual amount paid out
            },
          },
          { new: true }
        );
      } catch (e) {
        logger.warn('Failed to mark ChatbotTransaction payout SUCCESS', {
          e: e.message, paymentId: chatbotPaymentId, userId,
        });
      }
    }

    return {
      success: true,
      data: out,
      idempotencyKey,
      ...(amountAudit ? { amountAudit } : {})
    };
  } catch (err) {
    // RAW provider error logging (no normalization)
    const httpStatus = err.response?.status || 500;
    const httpStatusText = err.response?.statusText || null;
    const providerHeaders = err.response?.headers || {};
    const providerBody = err.response?.data; // RAW
    const requestId = pickRequestId(providerHeaders);
    const providerCode = Object.prototype.hasOwnProperty.call(providerBody || {}, 'code')
      ? providerBody.code
      : null;
    const providerMessage = Object.prototype.hasOwnProperty.call(providerBody || {}, 'message')
      ? providerBody.message
      : null;

    logger.error('Obiex ACTUAL NGNX debit failed', {
      axiosErrorCode: err.code || null,
      httpStatus,
      httpStatusText,
      payloadPreview,
      providerBody,     // RAW body as-is
      providerCode,     // RAW code if present
      providerHeaders,
      requestId,
      actualAmount: clean.amount,
      ...(amountAudit ? {
        quotedAmount: amountAudit.originalQuoted,
        amountDifference: amountAudit.difference
      } : {})
    });

    if (chatbotPaymentId) {
      try {
        await ChatbotTransaction.findOneAndUpdate(
          { paymentId: chatbotPaymentId, ...(userId ? { userId } : {}) },
          {
            $set: {
              payoutStatus: 'FAILED',
              payoutSuccess: false,
              payoutCompletedAt: new Date(),
              'payoutResult.httpStatus': httpStatus,
              'payoutResult.obiexStatus': 'FAILED',
              'payoutResult.errorCode': providerCode,
              'payoutResult.errorMessage': providerMessage || err.message || null,
              'payoutResult.providerRaw': providerBody || null,
              'payoutResult.requestId': requestId || null,
              'payoutResult.failedAmount': Number(clean.amount), // Amount that failed to pay out
            },
          }
        );
      } catch (e) {
        logger.warn('Failed to mark ChatbotTransaction payout FAILED', {
          e: e.message, paymentId: chatbotPaymentId, userId,
        });
      }
    }

    return {
      success: false,
      statusCode: httpStatus,
      message: providerMessage || err.message || 'Withdrawal service temporarily unavailable',
      providerCode,
      providerRaw: providerBody,
      requestId,
      ...(amountAudit ? { amountAudit } : {})
    };
  }
}

module.exports = {
  debitNaira,       // keep export name for compatibility
  obiexClient: obiex,
};