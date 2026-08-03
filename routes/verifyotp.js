const express = require("express");
const router = express.Router();
const PendingUser = require("../models/pendinguser");
const logger = require("../utils/logger");

// Normalize Nigerian phone - SAME as signup.js so PendingUser is found
function normalizeNigerianPhone(phone) {
  let cleaned = phone.replace(/[^\d+]/g, '');

  if (cleaned.startsWith('+2340')) {
    cleaned = '+234' + cleaned.slice(5);
  }
  if (cleaned.startsWith('2340') && !cleaned.startsWith('+')) {
    cleaned = '234' + cleaned.slice(4);
  }
  if (cleaned.startsWith('0') && cleaned.length === 11) {
    cleaned = '+234' + cleaned.slice(1);
  }
  if (cleaned.startsWith('234') && !cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }

  return cleaned;
}

router.post("/verify-otp", async (req, res) => {
  let { phonenumber, code } = req.body;

  if (!phonenumber || !code) {
    logger.warn("Missing phone number or code in verify-otp request");
    return res.status(400).json({ message: "Phone number and code are required." });
  }

  phonenumber = normalizeNigerianPhone(phonenumber);

  try {
    const pendingUser = await PendingUser.findOne({ phonenumber });

    if (!pendingUser) {
      logger.warn('Pending user not found', {
        phone: phonenumber.slice(0, 5) + '****',
        timestamp: new Date().toISOString()
      });
      return res.status(404).json({ 
        success: false,
        message: "No pending registration found for this number. Please sign up first.",
        error: "PENDING_USER_NOT_FOUND"
      });
    }

    // Validate OTP match
    if (pendingUser.verificationCode !== code) {
      logger.warn('Invalid OTP provided', {
        phone: phonenumber.slice(0, 5) + '****',
        attempts: (pendingUser.otpAttempts || 0) + 1,
        timestamp: new Date().toISOString()
      });

      // Increment failed attempts
      pendingUser.otpAttempts = (pendingUser.otpAttempts || 0) + 1;
      await pendingUser.save();

      return res.status(401).json({ 
        success: false,
        message: "Invalid verification code. Please try again.",
        error: "INVALID_OTP",
        remainingAttempts: Math.max(0, 5 - pendingUser.otpAttempts)
      });
    }

    // Check if OTP is expired
    const now = new Date();
    if (pendingUser.verificationCodeExpiresAt < now) {
      logger.warn('Expired OTP attempt', {
        phone: phonenumber.slice(0, 5) + '****',
        expiredAt: pendingUser.verificationCodeExpiresAt,
        timestamp: now.toISOString()
      });
      return res.status(401).json({ 
        success: false,
        message: "Verification code has expired. Please request a new one.",
        error: "OTP_EXPIRED"
      });
    }

    // Check max attempts
    if (pendingUser.otpAttempts >= 5) {
      logger.warn('Max OTP attempts exceeded', {
        phone: phonenumber.slice(0, 5) + '****',
        attempts: pendingUser.otpAttempts,
        timestamp: now.toISOString()
      });
      return res.status(429).json({
        success: false,
        message: "Too many failed attempts. Please request a new verification code.",
        error: "MAX_ATTEMPTS_EXCEEDED"
      });
    }

    // Mark pending user as OTP verified. verificationCodeExpiresAt also drives
    // the PendingUser TTL delete index (models/pendinguser.js) — left alone,
    // it would still be counting down from the original 10-minute OTP expiry,
    // so a user who takes their time on the PIN screens after verifying could
    // have their PendingUser silently deleted mid-setup. Push it out now that
    // the OTP itself is no longer what's being protected.
    pendingUser.otpVerified = true;
    pendingUser.otpVerifiedAt = now;
    pendingUser.verificationCodeExpiresAt = new Date(now.getTime() + 30 * 60 * 1000);
    await pendingUser.save();

    logger.info(`OTP verified successfully for phone number: ${phonenumber}`);

    res.status(200).json({
      success: true,
      message: "Phone number verified successfully. Please set your password PIN to complete registration.",
      pendingUserId: pendingUser._id,
      email: pendingUser.email,
      firstname: pendingUser.firstname,
      middlename: pendingUser.middlename || '',
      lastname: pendingUser.lastname,
      phonenumber: pendingUser.phonenumber
    });

  } catch (error) {
    const errorMessage = error.message || "Unknown error";
    logger.error("Error during OTP verification", {
      error: errorMessage,
      stack: error.stack,
      phone: phonenumber ? phonenumber.slice(0, 5) + "****" : "N/A",
      timestamp: new Date().toISOString()
    });
    res.status(500).json({ 
      success: false,
      message: "An error occurred while verifying your phone number. Please try again.",
      error: "SERVER_ERROR",
      details: process.env.NODE_ENV === 'development' ? errorMessage : undefined
    });
  }
});

module.exports = router;