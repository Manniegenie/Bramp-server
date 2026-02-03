const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');

// GET: /api/user/profile - Get user profile information
router.get('/profile', async (req, res) => {
  try {
    const userId = req.user.id; // From global JWT middleware

    if (!userId) {
      logger.warn('No user ID found in token', { source: 'get-profile' });
      return res.status(400).json({ message: 'Invalid token payload' });
    }

    // Fetch user from database with only required fields
    const user = await User.findById(userId).select(
      'username firstname lastname email phonenumber avatarUrl avatarLastUpdated assistantName emailVerified'
    );

    if (!user) {
      logger.warn('User not found', { userId, source: 'get-profile' });
      return res.status(404).json({ message: 'User not found' });
    }

    logger.info('Profile fetched successfully', { 
      userId, 
      username: user.username,
      email: user.email,
      source: 'get-profile' 
    });

    // Return profile information
    res.json({
      success: true,
      profile: {
        username: user.username || null,
        fullName: user.fullName, // This uses the virtual from the schema
        email: user.email,
        emailVerified: !!user.emailVerified,
        phoneNumber: user.phonenumber || null,
        assistantName: user.assistantName || null,
        avatar: {
          url: user.avatarUrl || null,
          lastUpdated: user.avatarLastUpdated || null
        }
      }
    });

  } catch (error) {
    logger.error('Error fetching user profile', { 
      error: error.message, 
      stack: error.stack,
      userId: req.user?.id,
      source: 'get-profile' 
    });
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT: /profile - Update user profile (e.g. assistant name)
router.put('/profile', async (req, res) => {
  try {
    const userId = req.user.id;
    if (!userId) {
      return res.status(400).json({ success: false, message: 'Invalid token payload' });
    }

    const { assistantName } = req.body || {};

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (assistantName !== undefined) {
      const trimmed = typeof assistantName === 'string' ? assistantName.trim() : '';
      if (trimmed.length > 10) {
        return res.status(400).json({ success: false, message: 'Assistant name cannot be more than 10 characters' });
      }
      if (/\s/.test(trimmed)) {
        return res.status(400).json({ success: false, message: 'Assistant name cannot contain spaces' });
      }
      user.assistantName = trimmed || null;
    }

    await user.save();

    const updated = await User.findById(userId).select(
      'username firstname lastname email phonenumber avatarUrl avatarLastUpdated assistantName'
    );

    res.json({
      success: true,
      profile: {
        username: updated.username || null,
        fullName: updated.fullName,
        email: updated.email,
        phoneNumber: updated.phonenumber || null,
        assistantName: updated.assistantName || null,
        avatar: {
          url: updated.avatarUrl || null,
          lastUpdated: updated.avatarLastUpdated || null
        }
      }
    });
  } catch (error) {
    logger.error('Error updating user profile', {
      error: error.message,
      stack: error.stack,
      userId: req.user?.id,
      source: 'put-profile'
    });
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;