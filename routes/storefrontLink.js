// routes/storefrontLink.js — the Bramp app's side of linking a Bramp Shop
// (services/storefrontOnboarding.js). Mounted at /storefront-link behind
// authenticateToken. The push notification carries
// { type: 'STOREFRONT_LINK', requestId }.
//
//   GET  /requests                 — link requests waiting for this user
//   POST /requests/:id/approve     — { passwordpin }
//   POST /requests/:id/decline
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
    logger.error('Storefront link route error', { path: req.path, error: err.message, stack: err.stack });
    res.status(500).json({ success: false, message: 'Internal error.' });
  }
};

router.get('/requests', route((req) => onboarding.pendingForUser(req.user.id)));
router.post('/requests/:id/approve', route((req) => onboarding.approveInApp(req.user.id, req.params.id, req.body?.passwordpin)));
router.post('/requests/:id/decline', route((req) => onboarding.declineInApp(req.user.id, req.params.id)));

module.exports = router;
