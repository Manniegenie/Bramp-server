// routes/Nombadeposit.js
//
// Nomba NGN virtual-account deposits: user-facing provisioning + webhook intake.
//
// Two routes, two different auth strategies, mounted bare in server.js
// (app.use("/Nombadeposit", NombadepositRoutes) — no router-level auth) so each
// route can apply the correct middleware itself:
//   GET  /account  — authenticateToken (Bramp user JWT), "get or create my deposit account"
//   POST /webhook  — nombaWebhookAuth (HMAC signature, no user auth — Nomba calls this)
//
// The webhook path (`/Nombadeposit/webhook`) MUST be registered in the raw-body
// capture whitelist in server.js — nombaWebhookAuth reads req.rawBody and will
// fail closed (500) if it's missing, rather than silently skip verification.
//
// ⚠️ Nomba webhook event_type / payload field-name confirmation: see the
// comment block at the top of services/nomba/webhookProcessor.js.

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const User = require('../models/user');
const VirtualAccount = require('../models/virtualAccount');
const NombaWebhookEvent = require('../models/nombaWebhookEvent');
const { nombaClient, NombaError } = require('../services/nomba/client');
const { processWebhookEvent } = require('../services/nomba/webhookProcessor');
const nombaWebhookAuth = require('../auth/nombaWebhookAuth');
const logger = require('../utils/logger');

const DUPLICATE_KEY_ERROR = 11000;

/**
 * Build the deterministic account ref for a user. Safe to retry — this is the
 * unique mapper between a Bramp user and their Nomba virtual account.
 */
function accountRefForUser(userId) {
  return `bramp-va-${userId}`;
}

/**
 * Handle Nomba's "accountRef already exists" case (a previous create call
 * succeeded on Nomba's side but our DB write failed before persisting it).
 * Recovers from the account details embedded in Nomba's error response when
 * present; otherwise surfaces a clear error for manual reconciliation rather
 * than guessing at a nonexistent lookup-by-ref endpoint.
 */
function extractAccountFromDuplicateRefError(nombaError) {
  const d = nombaError?.details?.data || nombaError?.details;
  const accountNumber = d?.accountNumber || d?.virtualAccountNumber;
  if (!accountNumber) return null;
  return {
    accountNumber,
    accountName: d?.accountName,
    bankName: d?.bankName || d?.bank,
    nombaAccountId: d?.accountId || d?.id || null,
  };
}

/**
 * User JWT auth, scoped to this route only. This router is mounted bare in
 * server.js (no router-level auth) because /webhook below must NOT require a
 * Bramp user token — Nomba can't send one. server.js's own `authenticateToken`
 * is a local const there, not exported, and requiring server.js back from here
 * would be a circular require (server.js requires this file) that resolves to
 * an incomplete module — so this duplicates that exact same JWT-check logic
 * locally instead of risking a silently-disabled-auth fallback.
 */
function requireUserAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, error: 'Unauthorized: No token provided.' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, error: 'Forbidden: Invalid token.' });
    req.user = user;
    next();
  });
}

// GET /account — get or create the caller's NGN deposit account.
router.get('/account', requireUserAuth, async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ success: false, message: 'Unauthorized. Please provide a valid authentication token.' });
  }

  try {
    let virtualAccount = await VirtualAccount.findOne({ userId });

    if (virtualAccount) {
      if (virtualAccount.status === 'suspended') {
        return res.status(403).json({
          success: false,
          error: 'ACCOUNT_SUSPENDED',
          message: 'Your deposit account is currently suspended. Please contact support.',
        });
      }
      return res.status(200).json({
        success: true,
        data: {
          accountNumber: virtualAccount.accountNumber,
          accountName: virtualAccount.accountName,
          bankName: virtualAccount.bankName || null,
        },
      });
    }

    // Not found — provision. Precondition: Tier 2 KYC + verified BVN.
    const user = await User.findById(userId).select('firstname lastname bvn bvnVerified kycLevel kycStatus');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    if ((user.kycLevel || 0) < 2) {
      return res.status(403).json({
        success: false,
        error: 'KYC_TIER2_REQUIRED',
        message: 'You need to complete Tier 2 KYC first',
      });
    }

    if (!user.bvnVerified || !user.bvn) {
      return res.status(403).json({
        success: false,
        error: 'KYC_TIER2_REQUIRED',
        message: 'You need to complete Tier 2 KYC first',
      });
    }

    const accountRef = accountRefForUser(userId);
    const accountName = `${user.firstname || ''} ${user.lastname || ''}`.trim();
    if (!accountName) {
      return res.status(400).json({
        success: false,
        message: 'Your legal name is not set on your profile. Please contact support.',
      });
    }

    let created;
    try {
      created = await nombaClient.createVirtualAccount({ accountRef, accountName, bvn: user.bvn });
    } catch (err) {
      if (err instanceof NombaError && /already exists/i.test(err.message || '')) {
        const recovered = extractAccountFromDuplicateRefError(err);
        if (!recovered) {
          logger.error('Nomba: accountRef already exists but could not recover account details from error response — needs manual reconciliation', {
            userId, accountRef,
          });
          return res.status(502).json({
            success: false,
            message: 'Unable to set up your deposit account right now. Please try again shortly or contact support.',
          });
        }
        created = { data: recovered };
      } else {
        throw err;
      }
    }

    const accountData = created?.data || created;
    const accountNumber = accountData?.accountNumber || accountData?.virtualAccountNumber;
    if (!accountNumber) {
      logger.error('Nomba: createVirtualAccount response missing accountNumber', { userId, accountRef });
      return res.status(502).json({ success: false, message: 'Deposit account could not be created. Please try again shortly.' });
    }

    try {
      virtualAccount = await VirtualAccount.create({
        userId,
        accountRef,
        accountNumber,
        accountName: accountData.accountName || accountName,
        bankName: accountData.bankName || accountData.bank || null,
        nombaAccountId: accountData.accountId || accountData.id || null,
        status: 'active',
      });
    } catch (dbErr) {
      if (dbErr.code === DUPLICATE_KEY_ERROR) {
        // Race: a concurrent request already created it (unique on userId/accountRef/accountNumber).
        virtualAccount = await VirtualAccount.findOne({ userId });
        if (!virtualAccount) throw dbErr; // genuinely unexpected — surface it
      } else {
        throw dbErr;
      }
    }

    logger.info('Nomba: virtual account provisioned', { userId, accountRef });

    return res.status(200).json({
      success: true,
      data: {
        accountNumber: virtualAccount.accountNumber,
        accountName: virtualAccount.accountName,
        bankName: virtualAccount.bankName || null,
      },
    });
  } catch (err) {
    logger.error('Nomba: deposit account provisioning failed', { userId, error: err.message });
    return res.status(500).json({ success: false, message: 'Server error while setting up your deposit account.' });
  }
});

// Scoped to /webhook only (not the whole router) so it never affects the
// authenticated GET /account traffic — matches server.js's webhookLimiter
// config (50 req / 15 min), duplicated locally since that const isn't exported.
const nombaWebhookLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { success: false, error: 'Too many webhook requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /webhook — Nomba payment-received callback. Signature-verified, no user auth.
router.post('/webhook', nombaWebhookLimiter, nombaWebhookAuth, async (req, res) => {
  const eventType = req.body?.event_type || req.body?.eventType || null;
  const eventId = req.body?.event_id || req.body?.eventId || null;

  let eventDoc;
  try {
    eventDoc = await NombaWebhookEvent.create({
      eventId: eventId || undefined, // undefined, not null — avoids tripping the sparse-unique index with repeated nulls
      eventType,
      payload: req.body,
      signatureValid: !!req.nombaSignatureValid,
      processingStatus: 'received',
    });
  } catch (err) {
    // Duplicate eventId (Nomba redelivery of the same event before we processed
    // it the first time) — the earlier row is authoritative, ack and stop.
    if (err.code === DUPLICATE_KEY_ERROR) {
      logger.info('Nomba webhook: duplicate eventId on receipt — already logged', { eventId });
      return res.status(200).json({ success: true, message: 'Already received' });
    }
    logger.error('Nomba webhook: failed to persist event', { error: err.message });
    return res.status(500).json({ error: 'Failed to record webhook event' });
  }

  if (!req.nombaSignatureValid) {
    logger.warn('Nomba webhook: rejected — invalid signature', { mongoId: eventDoc._id });
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Respond immediately after persisting; all processing happens after ack.
  res.status(200).json({ success: true });

  // Fire-and-forget, matches this repo's existing background-work convention
  // (see routes/chatbotwebhook.js's triggerProviderNGNXConversion).
  processWebhookEvent(eventDoc).catch((err) => {
    logger.error('Nomba webhook: post-response processing threw', { mongoId: eventDoc._id, error: err.message });
  });
});

module.exports = router;
