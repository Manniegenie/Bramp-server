// adminRoutes/withdrawals.js
//
// Manual reconciliation for NGNB withdrawals whose Obiex webhook callback
// never landed correctly (e.g. while OBIEX_WEBHOOK_SECRET was unset and
// every callback crashed in auth/webhookauth.js before reaching the handler).
// Already protected by authenticateAdminToken + requireSuperAdmin +
// adminRequire2FA at the mount site in server.js (matches /admin/Nombadeposit
// — this touches money flow).

const express = require('express');
const router = express.Router();

const Transaction = require('../models/transaction');
const { resolveWithdrawalCallback } = require('../routes/chatbotwebhook');
const logger = require('../utils/logger');

// GET /pending — list NGNB/NGNX withdrawals stuck in a non-terminal state,
// so a stuck transactionId can be found without direct DB access.
router.get('/pending', async (req, res) => {
  try {
    const pending = await Transaction.find({
      type: 'WITHDRAWAL',
      currency: { $in: ['NGNB', 'NGNX'] },
      status: { $nin: ['SUCCESSFUL', 'SUCCESS', 'COMPLETED', 'CONFIRMED', 'FAILED', 'REJECTED'] },
    }).sort({ createdAt: -1 }).limit(100).lean();

    return res.status(200).json({ success: true, data: pending, count: pending.length });
  } catch (err) {
    logger.error('Admin withdrawals: list pending failed', { error: err.message });
    return res.status(500).json({ success: false, message: 'Server error while fetching pending withdrawals.' });
  }
});

// POST /:transactionId/resolve — manually apply a withdrawal outcome.
// Body: { status: 'SUCCESSFUL' | 'FAILED', narration? }
// Runs through the exact same code the live webhook uses — no separate/
// parallel status-update path, even for this.
router.post('/:transactionId/resolve', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const { status, narration } = req.body || {};

    const normalizedStatus = String(status || '').toUpperCase();
    if (!['SUCCESSFUL', 'FAILED'].includes(normalizedStatus)) {
      return res.status(400).json({ success: false, message: "status must be 'SUCCESSFUL' or 'FAILED'" });
    }

    // The path param might be the local withdrawal reference OR Obiex's actual
    // transaction id — resolveWithdrawalCallback's fallback matching checks both.
    const result = await resolveWithdrawalCallback({ transactionId, reference: transactionId, status: normalizedStatus, narration });

    logger.info('Admin withdrawals: manual resolution applied', {
      transactionId, status: normalizedStatus, adminId: req.admin?.id || req.admin?._id, result: result.body,
    });

    return res.status(result.httpStatus).json(result.body);
  } catch (err) {
    logger.error('Admin withdrawals: manual resolve failed', { transactionId: req.params.transactionId, error: err.message });
    return res.status(500).json({ success: false, message: 'Server error while resolving withdrawal.' });
  }
});

module.exports = router;
