const express = require('express');
const QAWithdrawalLog = require('../models/QALog');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * GET /admin/qa-logs
 * List withdrawal QA log entries (QAlogs DB) with filters + pagination.
 * Query params: page, limit, withdrawalType, outcome, userId, username,
 *               currency, from, to, minAmount, maxAmount, riskBand, reviewStatus
 */
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      withdrawalType,
      outcome,
      userId,
      username,
      currency,
      from,
      to,
      minAmount,
      maxAmount,
      riskBand,
      reviewStatus,
    } = req.query;

    const filter = {};
    if (withdrawalType) filter.withdrawalType = withdrawalType.toUpperCase();
    if (outcome) filter.outcome = outcome.toUpperCase();
    if (userId) filter.userId = userId;
    if (username) filter.username = { $regex: username, $options: 'i' };
    if (currency) filter.currency = currency.toUpperCase();
    if (riskBand) filter.riskBand = riskBand.toUpperCase();
    if (reviewStatus) filter.reviewStatus = reviewStatus.toUpperCase();
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }
    if (minAmount || maxAmount) {
      filter.amount = {};
      if (minAmount) filter.amount.$gte = Number(minAmount);
      if (maxAmount) filter.amount.$lte = Number(maxAmount);
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [logs, total] = await Promise.all([
      QAWithdrawalLog.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      QAWithdrawalLog.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      logs,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    logger.error('QA logs route error', { route: req.originalUrl, error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /admin/qa-logs/stats
 * Aggregate counts/volume by withdrawal type + outcome.
 * Query params: from, to
 */
router.get('/stats', async (req, res) => {
  try {
    const { from, to } = req.query;
    const match = {};
    if (from || to) {
      match.createdAt = {};
      if (from) match.createdAt.$gte = new Date(from);
      if (to) match.createdAt.$lte = new Date(to);
    }

    const stats = await QAWithdrawalLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: { withdrawalType: '$withdrawalType', outcome: '$outcome' },
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount' },
        },
      },
      { $sort: { '_id.withdrawalType': 1, '_id.outcome': 1 } },
    ]);

    return res.json({ success: true, stats });
  } catch (err) {
    logger.error('QA logs route error', { route: req.originalUrl, error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /admin/qa-logs/:id/review
 * Record a human disposition on a scored entry — approve (reviewed, looks
 * fine) or reject (reviewed, treat as real fraud). This is a record-keeping
 * action only: shadow mode never held or blocked the underlying withdrawal,
 * so there is nothing to release or reverse here, only an audit trail.
 * Body: { decision: 'APPROVED' | 'REJECTED', notes?: string }
 */
router.patch('/:id/review', async (req, res) => {
  try {
    const { decision, notes } = req.body;
    if (!['APPROVED', 'REJECTED'].includes(decision)) {
      return res.status(400).json({ success: false, message: "decision must be 'APPROVED' or 'REJECTED'" });
    }

    const log = await QAWithdrawalLog.findByIdAndUpdate(
      req.params.id,
      {
        reviewStatus: decision,
        reviewedBy: req.admin?.email || req.admin?.id || 'unknown',
        reviewedAt: new Date(),
        reviewNotes: notes || undefined,
      },
      { new: true }
    ).lean();

    if (!log) return res.status(404).json({ success: false, message: 'QA log not found' });

    return res.json({ success: true, log });
  } catch (err) {
    logger.error('QA logs route error', { route: req.originalUrl, error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /admin/qa-logs/:id
 * Full detail for a single QA log entry.
 */
router.get('/:id', async (req, res) => {
  try {
    const log = await QAWithdrawalLog.findById(req.params.id).lean();
    if (!log) return res.status(404).json({ success: false, message: 'QA log not found' });
    return res.json({ success: true, log });
  } catch (err) {
    logger.error('QA logs route error', { route: req.originalUrl, error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
