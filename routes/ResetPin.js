// routes/ResetPin.js
const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { sendEmailVerificationOTP } = require('../services/EmailService');
const EmailVerificationService = require('../services/VerifiedEmail');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const logger = require('../utils/logger');
const validator = require('validator');

function generateOTP(length = 6) {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) otp += digits[Math.floor(Math.random() * digits.length)];
  return otp;
}

function sanitizeInput(input) {
  return validator.stripLow(validator.escape(input.trim()));
}

// POST /reset-pin/initiate - Send OTP via email
router.post('/initiate', async (req, res) => {
  const userId = req.user.id;

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    if (!user.twoFASecret || !user.is2FAEnabled) {
      return res.status(400).json({ success: false, message: '2FA Setup Required' });
    }

    if (!EmailVerificationService.isEmailVerifiedFromObject(user)) {
      return res.status(403).json({ message: 'Kindly Verify Your Email Address' });
    }

    const otp = generateOTP();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000);

    user.pinChangeOtp = otp;
    user.pinChangeOtpCreatedAt = createdAt;
    user.pinChangeOtpExpiresAt = expiresAt;
    user.pinChangeOtpVerified = false;
    await user.save();

    try {
      const fullName = `${user.firstname} ${user.lastname}`;
      await sendEmailVerificationOTP(user.email, fullName, otp, 10);

      logger.info('Reset pin OTP sent successfully', { userId });

      res.status(200).json({ message: 'Pin reset verification code sent to your email.' });
    } catch (emailError) {
      logger.error('Failed to send reset pin OTP email', { userId, error: emailError.message });

      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      user.pinChangeOtpVerified = undefined;
      await user.save();

      return res.status(500).json({ message: 'Failed to send verification code. Please try again.' });
    }
  } catch (err) {
    logger.error('Reset pin initiation error', { userId, error: err.message });
    res.status(500).json({ message: 'Server error while initiating pin reset.' });
  }
});

// POST /reset-pin/verify-otp - Verify OTP only
router.post('/verify-otp', async (req, res) => {
  let { otp } = req.body;
  const userId = req.user.id;

  if (!otp) return res.status(400).json({ message: 'Please provide OTP.' });

  otp = sanitizeInput(otp);

  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ message: 'Invalid OTP format. OTP should be 6 digits.' });
  }

  try {
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    if (!user.pinChangeOtp) {
      return res.status(400).json({ message: 'No pending pin reset request. Please initiate pin reset first.' });
    }

    if (new Date() > user.pinChangeOtpExpiresAt) {
      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      user.pinChangeOtpVerified = undefined;
      await user.save();
      return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
    }

    if (user.pinChangeOtp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP.' });
    }

    user.pinChangeOtpVerified = true;
    await user.save();

    logger.info('Reset pin OTP verified successfully', { userId });

    res.status(200).json({ message: 'OTP verified successfully. Please proceed with two-factor authentication.' });
  } catch (err) {
    logger.error('Reset pin OTP verification error', { userId, error: err.message });
    res.status(500).json({ message: 'Server error while verifying OTP.' });
  }
});

// POST /reset-pin/change-pin - Verify 2FA and change pin
router.post('/change-pin', async (req, res) => {
  let { newPin, confirmPin, twoFactorCode } = req.body;
  const userId = req.user.id;

  if (!newPin || !confirmPin || !twoFactorCode) {
    return res.status(400).json({ message: 'Please provide all required fields.' });
  }

  if (!twoFactorCode?.trim()) {
    return res.status(400).json({ message: 'Two-factor authentication code is required.' });
  }

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
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    if (!user.twoFASecret || !user.is2FAEnabled) {
      return res.status(400).json({ success: false, message: '2FA Setup Required' });
    }

    if (!user.pinChangeOtpVerified) {
      return res.status(400).json({ message: 'Please verify OTP first before proceeding with pin change.' });
    }

    if (new Date() > user.pinChangeOtpExpiresAt) {
      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      user.pinChangeOtpVerified = undefined;
      await user.save();
      return res.status(400).json({ message: 'Session has expired. Please start the pin reset process again.' });
    }

    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      logger.warn('2FA validation failed for reset pin', { userId });
      return res.status(401).json({ success: false, error: 'INVALID_2FA_CODE', message: 'Invalid two-factor authentication code' });
    }

    user.passwordpin = newPin;
    user.pinChangeOtp = undefined;
    user.pinChangeOtpCreatedAt = undefined;
    user.pinChangeOtpExpiresAt = undefined;
    user.pinChangeOtpVerified = undefined;
    await user.save();

    logger.info('Pin reset successfully after 2FA verification', { userId });

    res.status(200).json({ message: 'Pin reset successfully.' });
  } catch (err) {
    logger.error('Reset pin change error', { userId, error: err.message });
    res.status(500).json({ message: 'Server error while verifying 2FA and resetting pin.' });
  }
});

module.exports = router;
