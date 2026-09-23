const QAWithdrawalLog = require('../models/QALog');
const logger = require('../utils/logger');
const { scoreWithdrawal } = require('../services/fraudRiskEngine');

const REDACTED_FIELDS = ['passwordpin', 'twoFactorCode', 'pin', 'password'];

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return body;
  const clone = { ...body };

  // Only auth credentials are redacted here. Account numbers and addresses
  // are kept in full — this is an internal-only, super-admin-gated
  // compliance log, and masking the destination is actively counterproductive
  // for AML/fraud investigation (a reviewer needs the real account number to
  // cross-reference with the bank or file a SAR, not a last-4 fragment).
  for (const field of REDACTED_FIELDS) {
    if (clone[field] !== undefined) clone[field] = '[REDACTED]';
  }

  return clone;
}

/**
 * Reads the destination for a withdrawal request in whatever shape this
 * codebase actually uses per type — crypto nests it under `destination`,
 * NGNB and internal transfer send flat top-level fields.
 */
function extractDestination(withdrawalType, body = {}) {
  if (withdrawalType === 'CRYPTO') {
    return { address: body.destination?.address, network: body.destination?.network };
  }
  if (withdrawalType === 'NGNB') {
    return { accountNumber: body.account_number, bankCode: body.bank_code, bankName: body.bank_name };
  }
  if (withdrawalType === 'INTERNAL_USERNAME') {
    return { username: body.recipientUsername };
  }
  return {};
}

function summarizeDestination(withdrawalType, destination) {
  // Full destination shown, not masked — internal compliance surface only.
  if (destination.address) {
    return `${destination.address}${destination.network ? ` (${destination.network})` : ''}`;
  }
  if (destination.accountNumber) {
    return `${destination.bankName || 'bank'} ${destination.accountNumber}`;
  }
  if (destination.username) {
    return `@${destination.username}`;
  }
  return undefined;
}

function classifyOutcome(statusCode, responseBody) {
  if (statusCode >= 200 && statusCode < 300 && responseBody?.success !== false) return 'SUCCESS';
  if (statusCode === 401 || statusCode === 403 || statusCode === 423) return 'BLOCKED';
  if (statusCode >= 500) return 'ERROR';
  return 'REJECTED';
}

function extractOutcomeReason(responseBody) {
  if (!responseBody) return undefined;
  if (typeof responseBody.message === 'string') return responseBody.message;
  if (Array.isArray(responseBody.errors)) return responseBody.errors.join('; ');
  if (typeof responseBody.error === 'string') return responseBody.error;
  return undefined;
}

/**
 * Builds middleware that records an in-depth QA log entry for every call to the
 * given execution paths of a withdrawal router, without altering the router's
 * own logic. Mount it ahead of the withdrawal router in server.js.
 *
 * @param {string} withdrawalType - 'CRYPTO' | 'NGNB' | 'INTERNAL_USERNAME'
 * @param {string[]} executePaths - router-relative paths that actually move funds, e.g. ['/crypto']
 */
function createQaWithdrawalLogger(withdrawalType, executePaths) {
  return function qaWithdrawalLog(req, res, next) {
    if (req.method !== 'POST' || !executePaths.includes(req.path)) return next();

    const startedAt = Date.now();
    const originalJson = res.json.bind(res);
    let capturedBody;

    res.json = (body) => {
      capturedBody = body;
      return originalJson(body);
    };

    res.on('finish', () => {
      (async () => {
        try {
          const data = capturedBody?.data || {};
          const reqDestination = extractDestination(withdrawalType, req.body);

          const entry = {
            withdrawalType,
            route: req.originalUrl,
            method: req.method,
            userId: req.user?.id,
            username: req.user?.username,
            email: req.user?.email,
            requestBody: sanitizeBody(req.body),
            responseBody: capturedBody,
            statusCode: res.statusCode,
            outcome: classifyOutcome(res.statusCode, capturedBody),
            outcomeReason: extractOutcomeReason(capturedBody),
            amount: data.amount ?? data.totalAmount ?? req.body?.amount,
            currency: (req.body?.currency || (withdrawalType === 'NGNB' ? 'NGNB' : undefined))?.toString().toUpperCase(),
            network: data.network || reqDestination.network,
            fee: data.fee,
            destinationSummary: summarizeDestination(withdrawalType, reqDestination),
            transactionId: data.transactionId ? String(data.transactionId) : (data.withdrawalId || undefined),
            reference: data.reference,
            idempotencyKey: req.headers['x-idempotency-key'],
            ipAddress: req.ip,
            userAgent: req.get('User-Agent'),
            country: req.get('CF-IPCountry') || undefined,
            durationMs: Date.now() - startedAt,
          };

          // Shadow-mode fraud scoring — only meaningful once a withdrawal has
          // actually succeeded; never holds or blocks anything by itself.
          if (entry.outcome === 'SUCCESS' && req.user?.id) {
            const risk = await scoreWithdrawal({
              userId: req.user.id,
              withdrawalType,
              amount: entry.amount,
              currency: entry.currency,
              destination: reqDestination,
              ipAddress: entry.ipAddress,
            });
            entry.riskScore = risk.score;
            entry.riskBand = risk.band;
            entry.riskSignals = risk.signals;
          }

          QAWithdrawalLog.create(entry).catch((err) => {
            logger.error('QA withdrawal log write failed', { error: err.message, withdrawalType, route: req.originalUrl });
          });
        } catch (err) {
          // QA logging must never affect the withdrawal flow itself
          logger.error('QA withdrawal log capture failed', { error: err.message, withdrawalType });
        }
      })();
    });

    next();
  };
}

module.exports = { createQaWithdrawalLogger };
