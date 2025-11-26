const express = require("express");
const router = express.Router();
const PendingUser = require("../models/pendinguser");
const logger = require("../utils/logger");

router.post("/verify-otp", async (req, res) => {
  const { phonenumber, code } = req.body;

  if (!phonenumber || !code) {
    logger.warn("Missing phone number or code in verify-otp request");
    return res.status(400).json({ message: "Phone number and code are required." });
  }

  // Normalize phone number (using same logic as frontend)
  function normalizePhone(input) {
    const d = input.replace(/[^\d+]/g, '');
    
    // Handle Nigerian phone numbers specifically
    if (/^0\d{10}$/.test(d)) return '+234' + d.slice(1); // 08123456789 -> +2348123456789
    if (/^234\d{10}$/.test(d)) return '+' + d; // 2348123456789 -> +2348123456789
    if (/^\+234\d{10}$/.test(d)) return d; // +2348123456789 -> +2348123456789
    
    // Handle 10-digit numbers that could be Nigerian (starting with 7, 8, or 9)
    if (/^[789]\d{9}$/.test(d)) return '+234' + d; // 8123456789 -> +2348123456789
    
    // Handle other international formats
    if (/^\+?\d{10,15}$/.test(d)) return d.startsWith('+') ? d : '+' + d;
    
    return d;
  }

  // Normalize the phone number before searching
  const normalizedPhone = normalizePhone(phonenumber);

  try {
    const pendingUser = await PendingUser.findOne({ phonenumber: normalizedPhone });

    if (!pendingUser) {
      logger.warn('Pending user not found', {
        phone: normalizedPhone.slice(0, 5) + '****',
        rawPhone: phonenumber.slice(0, 5) + '****',
        normalizedPhone: normalizedPhone,
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
        phone: normalizedPhone.slice(0, 5) + '****',
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
        phone: normalizedPhone.slice(0, 5) + '****',
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
        phone: normalizedPhone.slice(0, 5) + '****',
        attempts: pendingUser.otpAttempts,
        timestamp: now.toISOString()
      });
      return res.status(429).json({
        success: false,
        message: "Too many failed attempts. Please request a new verification code.",
        error: "MAX_ATTEMPTS_EXCEEDED"
      });
    }

    // Mark pending user as OTP verified
    pendingUser.otpVerified = true;
    pendingUser.otpVerifiedAt = now;
    await pendingUser.save();

    logger.info(`OTP verified successfully for phone number: ${phonenumber}`);

    res.status(200).json({
      success: true,
      message: "Phone number verified successfully. Please set your password PIN to complete registration.",
      pendingUserId: pendingUser._id,
      email: pendingUser.email,
      firstname: pendingUser.firstname,
      lastname: pendingUser.lastname,
      phonenumber: pendingUser.phonenumber
    });

  } catch (error) {
    const errorMessage = error.message || "Unknown error";
    logger.error("Error during OTP verification", {
      error: errorMessage,
      stack: error.stack,
      phone: normalizedPhone ? normalizedPhone.slice(0, 5) + "****" : "N/A",
      rawPhone: phonenumber ? phonenumber.slice(0, 5) + "****" : "N/A",
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