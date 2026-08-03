const express = require('express');
const router = express.Router();
const TokenNetwork = require('../models/tokenNetwork');
const logger = require('../utils/logger');

/**
 * @route   GET /admin/token-networks
 * @desc    List every token's networks (enabled and disabled), grouped by token
 * @access  Admin
 */
router.get('/', async (req, res) => {
  try {
    const docs = await TokenNetwork.find({}).sort({ token: 1, order: 1 });

    const grouped = {};
    docs.forEach((doc) => {
      if (!grouped[doc.token]) grouped[doc.token] = [];
      grouped[doc.token].push({
        _id: doc._id,
        token: doc.token,
        networkId: doc.networkId,
        networkName: doc.networkName,
        enabled: doc.enabled,
        order: doc.order,
      });
    });

    const tokens = Object.keys(grouped).sort().map((token) => ({
      token,
      networks: grouped[token],
    }));

    res.status(200).json({ success: true, data: { tokens, totalTokens: tokens.length, totalNetworks: docs.length } });
  } catch (error) {
    logger.error('Error fetching admin token networks', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to fetch token networks', details: error.message });
  }
});

/**
 * @route   PATCH /admin/token-networks/:id/toggle
 * @desc    Enable or disable a single (token, network) pair
 * @access  Admin
 */
router.patch('/:id/toggle', async (req, res) => {
  try {
    const { id } = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'enabled (boolean) is required' });
    }

    const updated = await TokenNetwork.findByIdAndUpdate(id, { $set: { enabled } }, { new: true });
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Token network not found' });
    }

    logger.info('Token network toggled by admin', {
      token: updated.token,
      networkId: updated.networkId,
      enabled,
      adminAction: true,
    });

    res.status(200).json({ success: true, message: `${updated.token} ${updated.networkId} ${enabled ? 'enabled' : 'disabled'}`, data: updated });
  } catch (error) {
    logger.error('Error toggling token network', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to toggle token network', details: error.message });
  }
});

/**
 * @route   PATCH /admin/token-networks/reorder
 * @desc    Set display order for a token's networks
 * @body    { token: string, orderedIds: string[] }  — orderedIds are TokenNetwork _ids in the desired order
 * @access  Admin
 */
router.patch('/reorder', async (req, res) => {
  try {
    const { token, orderedIds } = req.body;

    if (!token || !Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ success: false, error: 'token and orderedIds (non-empty array) are required' });
    }

    const normalizedToken = String(token).toUpperCase();

    const existing = await TokenNetwork.find({ token: normalizedToken, _id: { $in: orderedIds } }).select('_id');
    if (existing.length !== orderedIds.length) {
      return res.status(400).json({ success: false, error: 'One or more ids do not belong to this token' });
    }

    await Promise.all(
      orderedIds.map((id, index) =>
        TokenNetwork.findByIdAndUpdate(id, { $set: { order: index } })
      )
    );

    const updated = await TokenNetwork.find({ token: normalizedToken }).sort({ order: 1 });

    logger.info('Token networks reordered by admin', { token: normalizedToken, adminAction: true });

    res.status(200).json({ success: true, message: `${normalizedToken} networks reordered`, data: updated });
  } catch (error) {
    logger.error('Error reordering token networks', { error: error.message });
    res.status(500).json({ success: false, error: 'Failed to reorder token networks', details: error.message });
  }
});

module.exports = router;
