const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { sendVerificationCode } = require('../utils/verifyAT');
const logger = require('../utils/logger');
const validator = require('validator');

// Generate numeric OTP (same as signup / email verification)
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

// POST: /initiate
router.post('/initiate', async (req, res) => {
  const userId = req.user.id; // Extract user ID from JWT

  try {
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found for phone verification', { userId });
      return res.status(404).json({ message: 'User not found.' });
    }

    if (user.phoneVerified) {
      logger.info('Phone already verified', {
        userId,
        phonenumber: user.phonenumber?.slice(0, 5) + '****'
      });
      return res.status(400).json({ message: 'Phone number is already verified.' });
    }

    if (!user.phonenumber) {
      logger.warn('Missing phone number for verification', { userId });
      return res.status(400).json({ message: 'No phone number on file.' });
    }

    // Generate OTP and expiration
    const otp = generateOTP();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000); // 10 minutes expiration

    // Reuse the same OTP fields as email verification / pin changes
    user.pinChangeOtp = otp;
    user.pinChangeOtpCreatedAt = createdAt;
    user.pinChangeOtpExpiresAt = expiresAt;
    await user.save();

    // Send OTP via SMS (Africa's Talking)
    try {
      const smsResult = await sendVerificationCode(user.phonenumber, otp);

      if (!smsResult.success) {
        throw new Error(smsResult.error?.message || smsResult.error || 'SMS send failed');
      }

      logger.info('Phone verification OTP sent successfully', {
        userId,
        phonenumber: user.phonenumber?.slice(0, 5) + '****'
      });

      res.status(200).json({
        message: 'Verification code sent to your phone number.',
        phonenumber: user.phonenumber
      });

    } catch (smsError) {
      logger.error('Failed to send phone verification OTP', {
        userId,
        phonenumber: user.phonenumber?.slice(0, 5) + '****',
        error: smsError.message
      });

      // Clean up the OTP since the SMS failed
      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      await user.save();

      return res.status(500).json({ message: 'Failed to send verification code. Please try again.' });
    }

  } catch (err) {
    logger.error('Phone verification initiation error', {
      userId,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ message: 'Server error while initiating phone verification.' });
  }
});

// POST: /verify
router.post('/verify', async (req, res) => {
  let { otp } = req.body;
  const userId = req.user.id; // Extract user ID from JWT

  if (!otp) {
    logger.warn('Missing OTP for phone verification completion', { userId });
    return res.status(400).json({ message: 'Please provide OTP.' });
  }

  otp = sanitizeInput(otp);

  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ message: 'Invalid OTP format. OTP should be 6 digits.' });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found for phone verification completion', { userId });
      return res.status(404).json({ message: 'User not found.' });
    }

    if (user.phoneVerified) {
      logger.info('Phone already verified during verification attempt', { userId });
      return res.status(400).json({ message: 'Phone number is already verified.' });
    }

    if (!user.pinChangeOtp) {
      logger.warn('No pending phone verification request found', { userId });
      return res.status(400).json({ message: 'No pending phone verification request. Please initiate phone verification first.' });
    }

    if (new Date() > user.pinChangeOtpExpiresAt) {
      logger.warn('Expired phone verification OTP used', { userId });

      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      await user.save();

      return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
    }

    if (user.pinChangeOtp !== otp) {
      logger.warn('Invalid phone verification OTP provided', { userId });
      return res.status(400).json({ message: 'Invalid OTP.' });
    }

    user.phoneVerified = true;
    user.pinChangeOtp = undefined;
    user.pinChangeOtpCreatedAt = undefined;
    user.pinChangeOtpExpiresAt = undefined;
    await user.save();

    logger.info('Phone verified successfully', { userId });

    res.status(200).json({
      message: 'Phone number verified successfully.',
      phoneVerified: true
    });

  } catch (err) {
    logger.error('Phone verification completion error', {
      userId,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ message: 'Server error while verifying phone number.' });
  }
});

module.exports = router;
