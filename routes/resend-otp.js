// routes/resend-otp.js
const express = require('express');
const router = express.Router();
const PendingUser = require('../models/pendinguser');
const { sendVerificationCode } = require('../utils/verifyAT');
const logger = require('../utils/logger');

function generateOTP(length = 6) {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) otp += digits[Math.floor(Math.random() * digits.length)];
  return otp;
}

// POST: /resend-otp/resend-otp
router.post('/resend-otp', async (req, res) => {
  const { phonenumber } = req.body;

  if (!phonenumber) {
    logger.warn('Missing phone number for OTP resend');
    return res.status(400).json({ success: false, message: 'Phone number is required.' });
  }

  try {
    // Normalize phone number format (ensure it starts with +)
    const normalizedPhone = phonenumber.startsWith('+') ? phonenumber : `+${phonenumber}`;
    
    // Find pending user
    const pendingUser = await PendingUser.findOne({ phonenumber: normalizedPhone });
    if (!pendingUser) {
      logger.warn('Pending user not found for phone number', { phone: normalizedPhone });
      return res.status(404).json({ success: false, message: 'No pending registration found for this number.' });
    }

    // Generate new OTP
    const otp = generateOTP();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000); // 10 minutes

    // Send SMS (Africa's Talking expects no leading +)
    const smsPhone = normalizedPhone.startsWith('+') ? normalizedPhone.slice(1) : normalizedPhone;
    const sendResult = await sendVerificationCode(smsPhone, otp);
    
    if (!sendResult?.success) {
      logger.error('Failed to send OTP', { phone: smsPhone, error: sendResult?.error });
      return res.status(500).json({ success: false, message: 'Failed to send verification code.' });
    }

    // Update pending user with new OTP
    pendingUser.verificationCode = otp;
    pendingUser.verificationCodeCreatedAt = createdAt;
    pendingUser.verificationCodeExpiresAt = expiresAt;
    await pendingUser.save();

    logger.info('OTP resent successfully', { phone: normalizedPhone });
    return res.status(200).json({
      success: true,
      message: 'Verification code resent successfully.',
    });

  } catch (err) {
    logger.error('Error in resend OTP', {
      error: err?.message,
      stack: err?.stack,
      phone: phonenumber,
    });
    return res.status(500).json({ success: false, message: 'Server error while resending OTP.' });
  }
});

module.exports = router;
