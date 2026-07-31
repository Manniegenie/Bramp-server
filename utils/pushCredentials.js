const User = require('../models/user');

// Shared by both the admin push-notification router and the end-user
// push-token router — the only piece of logic those two actually have
// in common.
async function savePushCredentials({ userId, deviceId, expoPushToken, fcmToken, platform }) {
  // Expo-only: fcmToken is ignored but kept for backward compatibility
  if (!expoPushToken) {
    const error = new Error('expoPushToken is required.');
    error.status = 400;
    throw error;
  }

  if (!userId && !deviceId) {
    const error = new Error('userId or deviceId is required.');
    error.status = 400;
    throw error;
  }

  let user = null;

  if (userId) {
    user = await User.findById(userId);
    // Stale/invalid userId (e.g. a session from before a DB reset): don't fail
    // the whole registration — fall through to device-based registration so the
    // push token is still stored against the device.
    if (!user) {
      console.warn('Push register: userId not found, falling back to deviceId', { userId });
    }
  }

  if (!user && deviceId) {
    user = await User.findOne({ deviceId });
  }

  if (!user && deviceId) {
    user = new User({
      deviceId,
      expoPushToken: expoPushToken || undefined,
      fcmToken: fcmToken || undefined,
      email: `device_${deviceId}@temp.com`,
      password: 'temp_password',
      isEmailVerified: false,
    });
  }

  if (!user) {
    const error = new Error('User not found.');
    error.status = 404;
    throw error;
  }

  if (deviceId) {
    user.deviceId = deviceId;
  }
  if (expoPushToken) {
    user.expoPushToken = expoPushToken;
  }
  // FCM removed - clear any existing FCM token
  user.fcmToken = null;
  if (platform) {
    user.pushPlatform = platform;
  }

  await user.save();

  return user;
}

module.exports = { savePushCredentials };
