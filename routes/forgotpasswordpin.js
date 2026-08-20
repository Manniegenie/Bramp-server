const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { sendEmailVerificationOTP } = require('../services/EmailService');
const EmailVerificationService = require('../services/VerifiedEmail');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const logger = require('../utils/logger');
const validator = require('validator');

// Generate numeric OTP (same as signup)
function generateOTP(length = 6) {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) {
    otp += digits[Math.floor(Math.random() * digits.length)];
  }
  return otp;
}

// Sanitize input
function sanitizeInput(input) {
  return validator.stripLow(validator.escape(input.trim()));
}

// POST: /initiate - Send OTP via email (no auth required - identified by phone number)
router.post('/initiate', async (req, res) => {
  let { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Email is required.' });
  }

  email = sanitizeInput(String(email).toLowerCase());

  try {
    const user = await User.findOne({ email });
    if (!user) {
      logger.warn('User not found for forgot pin', { email: email.slice(0, 6) + '****' });
      return res.status(404).json({ message: 'User not found.' });
    }

    // Check if 2FA is set up
    if (!user.twoFASecret || !user.is2FAEnabled) {
      return res.status(400).json({
        success: false,
        message: '2FA Setup Required'
      });
    }

    logger.info('✅ 2FA setup verified for forgot pin initiation', { userId: user._id });

    // Check if user is verified using EmailVerificationService
    if (!EmailVerificationService.isEmailVerifiedFromObject(user)) {
      logger.info('Unverified user attempted forgot pin', {
        userId: user._id,
        email: user.email?.slice(0, 3) + '****'
      });
      return res.status(403).json({ message: 'Kindly Verify Your Email Address' });
    }

    // Generate OTP and expiration
    const otp = generateOTP();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000); // 10 minutes

    user.pinChangeOtp = otp;
    user.pinChangeOtpCreatedAt = createdAt;
    user.pinChangeOtpExpiresAt = expiresAt;
    user.pinChangeOtpVerified = false;
    await user.save();

    try {
      const fullName = `${user.firstname} ${user.lastname}`;
      const emailResult = await sendEmailVerificationOTP(user.email, fullName, otp, 10, {
        ctaText: 'Reset PIN',
        companyName: 'Bramp',
        supportEmail: 'support@chatbramp.com'
      });

      logger.info('Forgot pin OTP sent successfully', {
        userId: user._id,
        email: user.email?.slice(0, 3) + '****',
        messageId: emailResult.messageId
      });

      res.status(200).json({
        message: 'Pin reset verification code sent to your email.'
      });

    } catch (emailError) {
      logger.error('Failed to send forgot pin OTP email', {
        userId: user._id,
        error: emailError.message,
        stack: emailError.stack
      });

      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      user.pinChangeOtpVerified = undefined;
      await user.save();

      return res.status(500).json({ message: 'Failed to send verification code. Please try again.' });
    }

  } catch (err) {
    logger.error('Forgot pin initiation error', { error: err.message, stack: err.stack });
    res.status(500).json({ message: 'Server error while initiating pin reset.' });
  }
});

// POST: /verify-otp - Verify OTP only
router.post('/verify-otp', async (req, res) => {
  let { otp, email } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Email is required.' });
  }
  if (!otp) {
    return res.status(400).json({ message: 'Please provide OTP.' });
  }

  email = sanitizeInput(String(email).toLowerCase());
  otp = sanitizeInput(otp);

  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ message: 'Invalid OTP format. OTP should be 6 digits.' });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (!user.pinChangeOtp) {
      logger.warn('No pending forgot pin request found for OTP verification', {
        userId: user._id,
        email: user.email?.slice(0, 3) + '****'
      });
      return res.status(400).json({ message: 'No pending pin reset request. Please initiate pin reset first.' });
    }

    if (new Date() > user.pinChangeOtpExpiresAt) {
      logger.warn('Expired forgot pin OTP used', { userId: user._id });

      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      user.pinChangeOtpVerified = undefined;
      await user.save();

      return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
    }

    if (user.pinChangeOtp !== otp) {
      logger.warn('Invalid forgot pin OTP provided', { userId: user._id });
      return res.status(400).json({ message: 'Invalid OTP.' });
    }

    user.pinChangeOtpVerified = true;
    await user.save();

    logger.info('✅ Forgot pin OTP verified successfully', { userId: user._id });

    res.status(200).json({
      message: 'OTP verified successfully. Please proceed with two-factor authentication.'
    });

  } catch (err) {
    logger.error('Forgot pin OTP verification error', { error: err.message, stack: err.stack });
    res.status(500).json({ message: 'Server error while verifying OTP.' });
  }
});

// POST: /change-pin - Verify 2FA and change pin
router.post('/change-pin', async (req, res) => {
  let { newPin, confirmPin, twoFactorCode, email } = req.body;

  if (!email) {
    return res.status(400).json({ message: 'Email is required.' });
  }
  if (!newPin || !confirmPin || !twoFactorCode) {
    return res.status(400).json({ message: 'Please provide all required fields.' });
  }
  if (!twoFactorCode?.trim()) {
    return res.status(400).json({ message: 'Two-factor authentication code is required.' });
  }

  email = sanitizeInput(String(email).toLowerCase());
  newPin = sanitizeInput(newPin);
  confirmPin = sanitizeInput(confirmPin);
  twoFactorCode = sanitizeInput(twoFactorCode);

  if (!/^\d{4,6}$/.test(newPin)) {
    return res.status(400).json({ message: 'Invalid pin format. Pin should be 4-6 digits.' });
  }
  if (newPin !== confirmPin) {
    return res.status(400).json({ message: 'New pin and confirm pin do not match.' });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (!user.twoFASecret || !user.is2FAEnabled) {
      return res.status(400).json({
        success: false,
        message: '2FA Setup Required'
      });
    }

    if (!user.pinChangeOtpVerified) {
      logger.warn('Attempt to change pin without OTP verification', { userId: user._id });
      return res.status(400).json({ message: 'Please verify OTP first before proceeding with pin change.' });
    }

    if (new Date() > user.pinChangeOtpExpiresAt) {
      logger.warn('OTP session expired during 2FA verification', { userId: user._id });

      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      user.pinChangeOtpVerified = undefined;
      await user.save();

      return res.status(400).json({ message: 'Session has expired. Please start the pin reset process again.' });
    }

    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      logger.warn('🚫 2FA validation failed for forgot pin completion', { userId: user._id });
      return res.status(403).json({
        success: false,
        error: 'INVALID_2FA_CODE',
        message: 'Invalid two-factor authentication code'
      });
    }

    logger.info('✅ 2FA validation successful for forgot pin completion', { userId: user._id });

    // Assign the plain PIN — models/user.js's pre-save hook hashes it on
    // save. Hashing it here too double-hashes it (the hook re-hashes
    // whatever's in the field once it sees the field was modified), leaving
    // a stored value that never matches the plain PIN the user types again.
    user.passwordpin = newPin;
    user.pinChangeOtp = undefined;
    user.pinChangeOtpCreatedAt = undefined;
    user.pinChangeOtpExpiresAt = undefined;
    user.pinChangeOtpVerified = undefined;
    await user.save();

    logger.info('✅ Pin reset successfully after 2FA verification', { userId: user._id });

    res.status(200).json({ message: 'Pin reset successfully.' });

  } catch (err) {
    logger.error('Forgot pin 2FA verification and pin change error', { error: err.message, stack: err.stack });
    res.status(500).json({ message: 'Server error while verifying 2FA and resetting pin.' });
  }
});

module.exports = router;
