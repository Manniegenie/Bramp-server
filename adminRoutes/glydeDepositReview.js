// adminRoutes/glydeDepositReview.js
// Admin approval/rejection of Glyde deposits held for manual review (a
// confirmed name mismatch, or a payer name we couldn't verify at all - see
// services/glydeDepositCrediting.js). Mounted on its own path with the same
// gate as /fund (requireAdmin + canManageBalances + 2FA), not the lighter
// requireModerator gate the rest of /admin/deposits uses, since approving
// one of these moves real money into a user's balance.
const express = require('express');
const router = express.Router();

const { adminApproveHeldDeposit, adminRejectHeldDeposit } = require('../services/glydeDepositCrediting');
const logger = require('../utils/logger');

// POST /admin/glyde-review/:transactionId/approve - admin has manually
// confirmed (e.g. against the real bank statement) that a held deposit is
// legitimate; credits the user now.
router.post('/:transactionId/approve', async (req, res) => {
  try {
    const adminId = req.admin?.id || req.admin?._id;
    const result = await adminApproveHeldDeposit(req.params.transactionId, adminId);

    if (result.outcome === 'not_found') {
      return res.status(404).json({ success: false, message: result.message || 'Transaction not found' });
    }
    if (result.outcome === 'not_held') {
      return res.status(400).json({ success: false, message: result.message });
    }
    if (result.outcome === 'amount_too_low') {
      return res.status(400).json({ success: false, message: result.message });
    }

    return res.json({
      success: true,
      message: 'Deposit approved and credited',
      data: { transactionId: result.transaction._id, amount: result.transaction.amount },
    });
  } catch (err) {
    logger.error('Admin approve held Glyde deposit error', { error: err.stack, transactionId: req.params?.transactionId });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// POST /admin/glyde-review/:transactionId/reject - admin has confirmed this
// held deposit should NOT be credited (e.g. genuinely fraudulent); clears it
// from the review queue without moving any money.
// body: { reason? }
router.post('/:transactionId/reject', async (req, res) => {
  try {
    const adminId = req.admin?.id || req.admin?._id;
    const result = await adminRejectHeldDeposit(req.params.transactionId, adminId, req.body?.reason);

    if (result.outcome === 'not_found') {
      return res.status(404).json({ success: false, message: result.message || 'Transaction not found' });
    }
    if (result.outcome === 'not_held') {
      return res.status(400).json({ success: false, message: result.message });
    }

    return res.json({ success: true, message: 'Deposit rejected, removed from review queue' });
  } catch (err) {
    logger.error('Admin reject held Glyde deposit error', { error: err.stack, transactionId: req.params?.transactionId });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
