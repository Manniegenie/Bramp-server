// adminRoutes/Nombadeposit.js
//
// Admin operations for Nomba virtual-account deposits. Already protected by
// authenticateAdminToken + requireSuperAdmin + adminRequire2FA at the mount
// site in server.js (matches /fund and /deleteuser — this touches money flow).
//
// NOTE — suspend is currently one-way: Nomba's ability to reactivate a
// suspended virtual account has not been confirmed against their docs (see
// spec Phase 7 open item). Do not add a reactivate endpoint until that's
// verified; a suspended user currently needs a new VA flow if reactivation
// isn't supported.

const express = require('express');
const router = express.Router();

const VirtualAccount = require('../models/virtualAccount');
const NombaDeposit = require('../models/nombaDeposit');
const NombaWebhookEvent = require('../models/nombaWebhookEvent');
const { nombaClient } = require('../services/nomba/client');
const { runReconciliation, runSweep } = require('../services/nomba/reconciliation');
const { creditPendingDeposit } = require('../services/nomba/depositCredit');
const logger = require('../utils/logger');

function paginationParams(req) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

// GET /deposits — list Nomba deposits, filterable by status/userId
router.get('/deposits', async (req, res) => {
  try {
    const { status, userId } = req.query;
    const { page, limit, skip } = paginationParams(req);

    const filter = {};
    if (status) filter.status = status;
    if (userId) filter.userId = userId;

    const [deposits, total] = await Promise.all([
      NombaDeposit.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      NombaDeposit.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: deposits,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error('Admin Nomba: list deposits failed', { error: err.message });
    return res.status(500).json({ success: false, message: 'Server error while fetching deposits.' });
  }
});

// GET /webhook-events — list recent webhook events, filterable by status (for debugging)
router.get('/webhook-events', async (req, res) => {
  try {
    const { processingStatus } = req.query;
    const { page, limit, skip } = paginationParams(req);

    const filter = {};
    if (processingStatus) filter.processingStatus = processingStatus;

    const [events, total] = await Promise.all([
      NombaWebhookEvent.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      NombaWebhookEvent.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      data: events,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error('Admin Nomba: list webhook events failed', { error: err.message });
    return res.status(500).json({ success: false, message: 'Server error while fetching webhook events.' });
  }
});

// GET /virtual-accounts/:userId — look up a user's virtual account
router.get('/virtual-accounts/:userId', async (req, res) => {
  try {
    const virtualAccount = await VirtualAccount.findOne({ userId: req.params.userId }).lean();
    if (!virtualAccount) {
      return res.status(404).json({ success: false, message: 'No virtual account found for this user.' });
    }
    return res.status(200).json({ success: true, data: virtualAccount });
  } catch (err) {
    logger.error('Admin Nomba: virtual account lookup failed', { error: err.message });
    return res.status(500).json({ success: false, message: 'Server error while fetching virtual account.' });
  }
});

// POST /deposits/:id/approve — manually release a flagged deposit (e.g. a
// sender-name mismatch that was reviewed and confirmed legitimate — bank
// transfer names are inconsistently formatted and can false-positive).
// Credits through the SAME creditPendingDeposit function the webhook and
// reconciliation use — no separate/parallel credit path, even for this.
router.post('/deposits/:id/approve', async (req, res) => {
  try {
    const deposit = await NombaDeposit.findById(req.params.id);
    if (!deposit) {
      return res.status(404).json({ success: false, message: 'Deposit not found.' });
    }
    if (deposit.status !== 'flagged') {
      return res.status(400).json({ success: false, message: `Deposit is '${deposit.status}', not 'flagged' — nothing to approve.` });
    }

    deposit.status = 'pending';
    deposit.reviewedBy = req.admin?.id || req.admin?._id;
    deposit.reviewedAt = new Date();
    deposit.reviewNotes = req.body?.notes || undefined;
    await deposit.save();

    const result = await creditPendingDeposit(deposit);
    if (result.outcome !== 'credited') {
      logger.error('Admin Nomba: manual approval failed to credit', { depositId: deposit._id, outcome: result.outcome, error: result.error });
      return res.status(500).json({ success: false, message: 'Approved but crediting failed. Check logs.', outcome: result.outcome });
    }

    logger.info('Admin Nomba: flagged deposit manually approved and credited', {
      depositId: deposit._id, adminId: req.admin?.id || req.admin?._id,
    });

    return res.status(200).json({ success: true, message: 'Deposit approved and credited.', data: result.deposit });
  } catch (err) {
    logger.error('Admin Nomba: approve deposit failed', { depositId: req.params.id, error: err.message });
    return res.status(500).json({ success: false, message: 'Server error while approving deposit.' });
  }
});

// POST /suspend/:userId — suspend a user's deposit account (one-way, see note above)
router.post('/suspend/:userId', async (req, res) => {
  try {
    const virtualAccount = await VirtualAccount.findOne({ userId: req.params.userId });
    if (!virtualAccount) {
      return res.status(404).json({ success: false, message: 'No virtual account found for this user.' });
    }
    if (virtualAccount.status === 'suspended') {
      return res.status(200).json({ success: true, message: 'Already suspended.', data: virtualAccount });
    }
    if (!virtualAccount.nombaAccountId) {
      logger.error('Admin Nomba: cannot suspend — missing nombaAccountId', { userId: req.params.userId });
      return res.status(500).json({ success: false, message: 'Cannot suspend: missing provider account id. Contact engineering.' });
    }

    await nombaClient.suspendVirtualAccount(virtualAccount.nombaAccountId);

    virtualAccount.status = 'suspended';
    await virtualAccount.save();

    logger.info('Admin Nomba: virtual account suspended', {
      userId: req.params.userId,
      adminId: req.admin?.id || req.admin?._id,
    });

    return res.status(200).json({ success: true, message: 'Deposit account suspended.', data: virtualAccount });
  } catch (err) {
    logger.error('Admin Nomba: suspend failed', { userId: req.params.userId, error: err.message });
    return res.status(500).json({ success: false, message: 'Server error while suspending deposit account.' });
  }
});

// POST /reconcile — trigger reconciliation on demand. Body: { startDate?, endDate? } (YYYY-MM-DD)
router.post('/reconcile', async (req, res) => {
  try {
    const { startDate, endDate } = req.body || {};
    const result = await runReconciliation({ startDate, endDate });
    return res.status(result.success ? 200 : 502).json(result);
  } catch (err) {
    logger.error('Admin Nomba: manual reconciliation failed', { error: err.message });
    return res.status(500).json({ success: false, message: 'Server error while running reconciliation.' });
  }
});

// POST /sweep — trigger the stuck-webhook-event sweeper on demand
router.post('/sweep', async (req, res) => {
  try {
    const result = await runSweep();
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    logger.error('Admin Nomba: manual sweep failed', { error: err.message });
    return res.status(500).json({ success: false, message: 'Server error while running sweep.' });
  }
});

module.exports = router;
