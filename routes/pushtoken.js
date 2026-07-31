// routes/pushtoken.js
// End-user push-token registration only. The broadcast/admin endpoints
// (send-all, clear-all, stats, mock-test, etc.) live exclusively in
// adminRoutes/pushnotification.js, mounted at /admin/notification behind
// admin auth — they must never be reachable from here.
const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { savePushCredentials } = require('../utils/pushCredentials');

// POST /notification/register (recommended)
router.post('/register', async (req, res) => {
  try {
    const { expoPushToken, fcmToken, deviceId, userId, platform } = req.body;

    const user = await savePushCredentials({
      userId,
      deviceId,
      expoPushToken,
      fcmToken,
      platform,
    });

    return res.json({ message: 'Push token(s) registered successfully.', userId: user._id });
  } catch (error) {
    console.error('Error registering push tokens:', error);
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// GET /notification/check-token - Check if device has a token in DB
router.get('/check-token', async (req, res) => {
  try {
    const { deviceId } = req.query;

    if (!deviceId) {
      return res.status(400).json({
        success: false,
        error: 'deviceId is required'
      });
    }

    const user = await User.findOne({ deviceId }).select('expoPushToken deviceId');

    if (!user) {
      return res.json({
        success: true,
        hasToken: false,
        message: 'Device does not have a push token registered'
      });
    }

    const hasToken = !!(user.expoPushToken && user.expoPushToken.trim().length > 0);

    return res.json({
      success: true,
      hasToken,
      message: hasToken ? 'Device has a push token registered' : 'Device does not have a push token'
    });
  } catch (err) {
    console.error('❌ Error checking push token:', {
      error: err.message,
      stack: err.stack,
    });
    return res.status(500).json({
      success: false,
      error: 'Internal server error.'
    });
  }
});

// POST /notification/register-token (Expo legacy — what the app actually calls)
router.post('/register-token', async (req, res) => {
  try {
    const { expoPushToken, deviceId, userId, platform, fcmToken } = req.body;

    if (!expoPushToken) {
      return res.status(400).json({ error: 'expoPushToken is required.' });
    }

    if (!expoPushToken.startsWith('ExponentPushToken[') && !expoPushToken.startsWith('ExpoPushToken[')) {
      console.warn('⚠️ Unexpected token format:', expoPushToken.substring(0, 50));
    }

    let user;
    try {
      user = await savePushCredentials({
        userId,
        deviceId,
        expoPushToken,
        fcmToken,
        platform,
      });
    } catch (saveError) {
      console.error('❌ Failed to save push credentials:', {
        error: saveError.message,
        userId,
        deviceId,
        hasExpoToken: !!expoPushToken,
        platform
      });
      return res.status(saveError.status || 500).json({
        error: saveError.message || 'Failed to save push token to database',
      });
    }

    return res.json({
      message: 'Push token registered successfully.',
      userId: user._id,
      platform: platform || 'unknown',
    });
  } catch (err) {
    console.error('❌ Error registering push token:', {
      error: err.message,
      stack: err.stack,
    });
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

// POST /notification/unregister
router.post('/unregister', async (req, res) => {
  try {
    const { userId, deviceId } = req.body;

    if (!userId && !deviceId) {
      return res.status(400).json({ error: 'userId or deviceId is required.' });
    }

    const user = userId
      ? await User.findById(userId)
      : await User.findOne({ deviceId });

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    user.expoPushToken = null;
    user.fcmToken = null;

    if (deviceId && user.deviceId && user.deviceId !== deviceId) {
      console.warn(`⚠️ Device ID mismatch during unregister. Stored=${user.deviceId} Provided=${deviceId}`);
    }

    await user.save();

    return res.json({ message: 'Push tokens removed successfully.' });
  } catch (error) {
    console.error('Error unregistering push tokens:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

module.exports = router;
