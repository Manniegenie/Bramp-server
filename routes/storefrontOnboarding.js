// routes/storefrontOnboarding.js — bramp.shop's backend linking a trader's
// Bramp account to their new store (services/storefrontOnboarding.js).
// Mounted at /storefront-onboarding behind auth/storefrontPlatformAuth.js.
//
//   GET  /terms                             — { version } the agreement bramp.shop must show
//   POST /link-requests                     — { username, slug, brandName, whatsapp?, agreement: { accepted, version }, ip?, userAgent? }
//                                             → { requestId, claimSecret, expiresAt, pushed, emailSent, maskedEmail }
//   GET  /link-requests/:id                 — { status: PENDING | APPROVED | DECLINED | EXPIRED | COMPLETED }   poll this
//   POST /link-requests/:id/verify-email    — { code } the 6-digit code from the email
//   POST /link-requests/:id/complete        — { claimSecret } after APPROVED → { slug, brandName, status, limits }
//
// After that, bramp.shop calls /storefront/* for the store with
// X-Bramp-Shop-Key plus X-Storefront-Slug (auth/storefrontAuth.js).
const express = require('express');
const router = express.Router();
const onboarding = require('../services/storefrontOnboarding');
const logger = require('../utils/logger');

const route = (fn) => async (req, res) => {
  try {
    res.json({ success: true, data: await fn(req) });
  } catch (err) {
    if (err.status) {
      const { status, message, ...extra } = err;
      return res.status(status).json({ success: false, message, ...extra });
    }
    logger.error('Storefront onboarding route error', { path: req.path, error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'Internal error.' });
  }
};

router.get('/terms', route(async () => ({ version: onboarding.TERMS_VERSION })));
router.post('/link-requests', route((req) => onboarding.start(req.body || {})));
router.get('/link-requests/:id', route((req) => onboarding.status(req.params.id)));
router.post('/link-requests/:id/verify-email', route((req) => onboarding.approveByEmailCode(req.params.id, req.body?.code)));
router.post('/link-requests/:id/complete', route((req) => onboarding.complete(req.params.id, req.body?.claimSecret)));

module.exports = router;
