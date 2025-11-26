const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { sendOtpEmail } = require('../services/EmailService');
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

// POST: /initiate
router.post('/initiate', async (req, res) => {
  const userId = req.user.id; // Extract user ID from JWT

  try {
    // Find user in database using JWT user ID
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found for email verification', { 
        userId 
      });
      return res.status(404).json({ message: 'User not found.' });
    }

    // Check if email is already verified
    if (user.emailVerified) {
      logger.info('Email already verified', { 
        userId,
        email: user.email?.slice(0, 3) + '****'
      });
      return res.status(400).json({ message: 'Email is already verified.' });
    }

    // Check if user has a valid email
    if (!user.email || !validator.isEmail(user.email)) {
      logger.warn('Invalid email for verification', { 
        userId,
        email: user.email?.slice(0, 3) + '****'
      });
      return res.status(400).json({ message: 'Invalid email address.' });
    }

    // Generate OTP and expiration
    const otp = generateOTP();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000); // 10 minutes expiration

    // Update user with OTP details for email verification
    user.pinChangeOtp = otp; // Reusing the same OTP fields
    user.pinChangeOtpCreatedAt = createdAt;
    user.pinChangeOtpExpiresAt = expiresAt;
    await user.save();

    // Send OTP via email
    try {
      const fullName = `${user.firstname} ${user.lastname}`;
      const emailResult = await sendOtpEmail(user.email, fullName, otp, 10);
      
      logger.info('Email verification OTP sent successfully', { 
        userId,
        email: user.email?.slice(0, 3) + '****',
        messageId: emailResult.messageId
      });

      res.status(200).json({
        message: 'Email verification code sent to your email.',
        email: user.email
      });

    } catch (emailError) {
      logger.error('Failed to send email verification OTP', {
        userId,
        email: user.email?.slice(0, 3) + '****',
        error: emailError.message,
        stack: emailError.stack
      });
      
      // Clean up the OTP from database since email failed
      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      await user.save();
      
      return res.status(500).json({ message: 'Failed to send verification code. Please try again.' });
    }

  } catch (err) {
    logger.error('Email verification initiation error', {
      userId,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ message: 'Server error while initiating email verification.' });
  }
});

// POST: /verify
router.post('/verify', async (req, res) => {
  let { otp } = req.body;
  const userId = req.user.id; // Extract user ID from JWT

  // Validate presence of required fields
  if (!otp) {
    logger.warn('Missing OTP for email verification completion', { 
      userId 
    });
    return res.status(400).json({ message: 'Please provide OTP.' });
  }

  // Sanitize inputs
  otp = sanitizeInput(otp);

  // Validate OTP format
  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ message: 'Invalid OTP format. OTP should be 6 digits.' });
  }

  try {
    // Find user in database using JWT user ID
    const user = await User.findById(userId);
    if (!user) {
      logger.warn('User not found for email verification completion', { 
        userId 
      });
      return res.status(404).json({ message: 'User not found.' });
    }

    // Check if email is already verified
    if (user.emailVerified) {
      logger.info('Email already verified during verification attempt', { 
        userId,
        email: user.email?.slice(0, 3) + '****'
      });
      return res.status(400).json({ message: 'Email is already verified.' });
    }

    // Check if user has pending email verification OTP
    if (!user.pinChangeOtp) {
      logger.warn('No pending email verification request found', { 
        userId,
        email: user.email?.slice(0, 3) + '****'
      });
      return res.status(400).json({ message: 'No pending email verification request. Please initiate email verification first.' });
    }

    // Check if OTP has expired
    if (new Date() > user.pinChangeOtpExpiresAt) {
      logger.warn('Expired email verification OTP used', { 
        userId,
        email: user.email?.slice(0, 3) + '****'
      });
      
      // Clean up expired OTP
      user.pinChangeOtp = undefined;
      user.pinChangeOtpCreatedAt = undefined;
      user.pinChangeOtpExpiresAt = undefined;
      await user.save();
      
      return res.status(400).json({ message: 'OTP has expired. Please request a new one.' });
    }

    // Verify OTP
    if (user.pinChangeOtp !== otp) {
      logger.warn('Invalid email verification OTP provided', { 
        userId,
        email: user.email?.slice(0, 3) + '****'
      });
      return res.status(400).json({ message: 'Invalid OTP.' });
    }

    // Mark email as verified and clear OTP fields
    user.emailVerified = true;
    user.pinChangeOtp = undefined;
    user.pinChangeOtpCreatedAt = undefined;
    user.pinChangeOtpExpiresAt = undefined;
    await user.save();

    logger.info('Email verified successfully', { 
      userId,
      email: user.email?.slice(0, 3) + '****'
    });

    res.status(200).json({
      message: 'Email verified successfully.',
      emailVerified: true
    });

  } catch (err) {
    logger.error('Email verification completion error', {
      userId,
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({ message: 'Server error while verifying email.' });
  }
});

module.exports = router;