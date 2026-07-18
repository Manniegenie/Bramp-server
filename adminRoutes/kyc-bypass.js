const express = require('express');
const router = express.Router();
const validator = require('validator');
const User = require('../models/user');
const logger = require('../utils/logger');

// Find a user by email or username (identifier can be either)
async function findUserByIdentifier(identifier) {
  const value = String(identifier || '').trim();
  if (!value) return null;

  if (validator.isEmail(value)) {
    return User.findOne({ email: value.toLowerCase() });
  }
  return User.findOne({ username: new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
}

function bypassSummary(user) {
  return {
    id: user._id,
    email: user.email,
    username: user.username,
    kycLevel: user.kycLevel,
    kycStatus: user.kycStatus,
    bypass: {
      enabled: user.kycBypass?.enabled || false,
      reason: user.kycBypass?.reason || null,
      setBy: user.kycBypass?.setBy || null,
      setAt: user.kycBypass?.setAt || null
    }
  };
}

// POST /set — enable KYC bypass for a demo user (identifier = email or username)
router.post('/set', async (req, res) => {
  const { identifier, reason } = req.body;

  if (!identifier || typeof identifier !== 'string') {
    return res.status(400).json({ success: false, error: 'identifier (email or username) is required.' });
  }

  try {
    const user = await findUserByIdentifier(identifier);
    if (!user) {
      logger.warn('KYC bypass set failed — user not found', { identifier });
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    if (user.kycBypass?.enabled) {
      return res.status(400).json({
        success: false,
        error: 'KYC bypass is already enabled for this user.',
        user: bypassSummary(user)
      });
    }

    user.kycBypass = {
      enabled: true,
      reason: reason || 'Demo account',
      setBy: req.admin?.email || req.admin?.id || 'unknown',
      setAt: new Date()
    };
    await user.save();

    logger.info('KYC bypass enabled', {
      userId: user._id,
      email: user.email,
      setBy: user.kycBypass.setBy,
      reason: user.kycBypass.reason
    });

    return res.status(200).json({
      success: true,
      message: 'KYC bypass enabled.',
      user: bypassSummary(user)
    });
  } catch (error) {
    logger.error('Error enabling KYC bypass', { error: error.message, identifier });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// GET /list — all users with KYC bypass enabled
router.get('/list', async (req, res) => {
  try {
    const users = await User.find({ 'kycBypass.enabled': true })
      .select('email username kycLevel kycStatus kycBypass')
      .sort({ 'kycBypass.setAt': -1 })
      .lean();

    return res.status(200).json({
      success: true,
      count: users.length,
      users: users.map((u) => ({
        id: u._id,
        email: u.email,
        username: u.username,
        kycLevel: u.kycLevel,
        kycStatus: u.kycStatus,
        bypass: u.kycBypass
      }))
    });
  } catch (error) {
    logger.error('Error listing KYC bypass users', { error: error.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// GET /status/:identifier — check a single user's bypass state
router.get('/status/:identifier', async (req, res) => {
  try {
    const user = await findUserByIdentifier(req.params.identifier);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    return res.status(200).json({ success: true, user: bypassSummary(user) });
  } catch (error) {
    logger.error('Error checking KYC bypass status', { error: error.message });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

// DELETE /remove — disable KYC bypass (identifier = email or username)
router.delete('/remove', async (req, res) => {
  const { identifier } = req.body;

  if (!identifier || typeof identifier !== 'string') {
    return res.status(400).json({ success: false, error: 'identifier (email or username) is required.' });
  }

  try {
    const user = await findUserByIdentifier(identifier);
    if (!user) {
      logger.warn('KYC bypass remove failed — user not found', { identifier });
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    if (!user.kycBypass?.enabled) {
      return res.status(400).json({
        success: false,
        error: 'KYC bypass is not enabled for this user.',
        user: bypassSummary(user)
      });
    }

    user.kycBypass = { enabled: false, reason: null, setBy: null, setAt: null };
    await user.save();

    logger.info('KYC bypass removed', {
      userId: user._id,
      email: user.email,
      removedBy: req.admin?.email || req.admin?.id || 'unknown'
    });

    return res.status(200).json({
      success: true,
      message: 'KYC bypass removed. Normal KYC checks apply again.',
      user: bypassSummary(user)
    });
  } catch (error) {
    logger.error('Error removing KYC bypass', { error: error.message, identifier });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
