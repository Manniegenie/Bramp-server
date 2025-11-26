// routes/changePin.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const bcrypt = require('bcryptjs');

const router = express.Router();

const User = require('../models/user');
const logger = require('../utils/logger');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const EmailVerificationService = require('../services/VerifiedEmail'); // ✅ restored

// --- Helpers ---
const normalizePin = (pin) => String(pin ?? '').replace(/\D/g, '').padStart(6, '0');

// POST: /change-pin
router.post(
  '/change-pin',
  [
    body('otp')
      .trim()
      .isLength({ min: 6, max: 6 })
      .withMessage('OTP must be 6 digits.')
      .isNumeric()
      .withMessage('OTP must contain only digits.'),
    body('newPin')
      .trim()
      .isLength({ min: 4, max: 6 })
      .withMessage('New pin must be 4–6 digits (will be padded to 6).')
      .isNumeric()
      .withMessage('New pin must contain only digits.'),
    body('confirmPin')
      .trim()
      .isLength({ min: 4, max: 6 })
      .withMessage('Confirm pin must be 4–6 digits (will be padded to 6).')
      .isNumeric()
      .withMessage('Confirm pin must contain only digits.'),
    body('twoFactorCode')
      .trim()
      .notEmpty()
      .withMessage('Two-factor authentication code is required.')
  ],
  async (req, res) => {
    const userId = req.user?.id;

    // Validate request
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed.',
        errors: errors.array()
      });
    }

    let { otp, newPin, confirmPin, twoFactorCode } = req.body;

    // Normalize pins to match signin behavior (digits only, left-pad to 6)
    const normalizedNew = normalizePin(newPin);
    const normalizedConfirm = normalizePin(confirmPin);

    if (normalizedNew !== normalizedConfirm) {
      return res.status(400).json({ success: false, message: 'New pin and confirm pin do not match.' });
    }

    try {
      // Load user (as Mongoose doc, not lean)
      const user = await User.findById(userId).lean(false);
      if (!user) {
        logger.warn('User not found for change-pin', { userId });
        return res.status(404).json({ success: false, message: 'User not found.' });
      }

      // ✅ Enforce verified email (keeps parity with /initiate)
      if (!EmailVerificationService.isEmailVerifiedFromObject(user)) {
        logger.info('Unverified user attempted pin change', {
          userId,
          email: user.email?.slice(0, 3) + '****'
        });
        return res.status(403).json({ success: false, message: 'Kindly Verify Your Email Address' });
      }

      // Require 2FA to be set up
      if (!user.twoFASecret || !user.is2FAEnabled) {
        return res.status(400).json({ success: false, message: '2FA Setup Required' });
      }

      // Validate 2FA code
      if (!validateTwoFactorAuth(user, String(twoFactorCode || '').trim())) {
        logger.warn('🚫 2FA validation failed for change-pin', { userId, errorType: 'INVALID_2FA' });
        return res.status(401).json({
          success: false,
          error: 'INVALID_2FA_CODE',
          message: 'Invalid two-factor authentication code'
        });
      }

      // Ensure there is a pending OTP
      if (!user.pinChangeOtp || !user.pinChangeOtpExpiresAt) {
        logger.warn('No pending pin change request found', { userId });
        return res.status(400).json({
          success: false,
          message: 'No pending pin change request. Please initiate pin change first.'
        });
      }

      // Check OTP expiry
      if (new Date() > user.pinChangeOtpExpiresAt) {
        logger.warn('Expired pin change OTP used', { userId });

        // Clean expired OTP
        user.pinChangeOtp = undefined;
        user.pinChangeOtpCreatedAt = undefined;
        user.pinChangeOtpExpiresAt = undefined;
        await user.save();

        return res.status(400).json({ success: false, message: 'OTP has expired. Please request a new one.' });
      }

      // Verify OTP value
      if (String(otp).trim() !== String(user.pinChangeOtp).trim()) {
        logger.warn('Invalid pin change OTP provided', { userId });
        return res.status(400).json({ success: false, message: 'Invalid OTP.' });
      }

      // Optional: block reusing the same PIN
      if (user.passwordpin) {
        try {
          const isSameAsCurrent = await user.comparePasswordPin(normalizedNew);
          if (isSameAsCurrent) {
            return res.status(400).json({
              success: false,
              message: 'New pin cannot be the same as your current pin.'
            });
          }
        } catch (cmpErr) {
          logger.error('Failed to compare current PIN during change', { userId, error: cmpErr.message });
          return res.status(500).json({ success: false, message: 'Server error while validating current pin.' });
        }
      }

      // Hash and save normalized pin
      const saltRounds = 10; // keep in sync with schema SALT_WORK_FACTOR
      const hashedNewPin = await bcrypt.hash(normalizedNew, saltRounds);

      user.passwordpin = hashedNewPin;

      // Clear OTP artifacts
      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;

      await user.save();

      logger.info('Pin changed successfully', {
        userId,
        email: user.email?.slice(0, 3) + '****'
      });

      return res.status(200).json({
        success: true,
        message: 'Pin changed successfully.'
      });
    } catch (err) {
      logger.error('Pin change completion error', {
        userId,
        error: err.message,
        stack: err.stack
      });
      return res.status(500).json({ success: false, message: 'Server error while changing pin.' });
    }
  }
);

module.exports = router;
