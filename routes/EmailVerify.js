// routes/EmailVerify.js
const express = require("express");
const router = express.Router();
const User = require("../models/user");
const { sendEmailVerificationOTP } = require("../services/EmailService");
const logger = require("../utils/logger");

function generateOTP(length = 6) {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) otp += digits[Math.floor(Math.random() * digits.length)];
  return otp;
}

// POST /email-verify/initiate - Send OTP to email
router.post("/initiate", async (req, res) => {
  try {
    const userId = req.user.id;
    const { email } = req.body;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const targetEmail = email || user.email;
    if (!targetEmail) return res.status(400).json({ message: "Email address is required" });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(targetEmail)) return res.status(400).json({ message: "Invalid email format" });

    if (user.emailVerified && user.email === targetEmail) {
      return res.status(400).json({ message: "Email address is already verified" });
    }

    const otp = generateOTP();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000);

    user.pinChangeOtp = otp;
    user.pinChangeOtpCreatedAt = createdAt;
    user.pinChangeOtpExpiresAt = expiresAt;
    user.pinChangeOtpVerified = false;

    const emailChanged = email && email !== user.email;
    if (emailChanged) {
      user.email = email;
      user.emailVerified = false;
      if (user.kyc?.level2) user.kyc.level2.emailVerified = false;
    }

    await user.save();

    const WEB_BASE = (process.env.APP_WEB_BASE_URL || process.env.FRONTEND_BASE_URL || '').replace(/\/$/, '');
    const DEEP = (process.env.APP_DEEP_LINK || 'bramp://').replace(/\/$/, '');
    const qs = `email=${encodeURIComponent(targetEmail)}`;

    const extras = {
      verifyUrl: `${WEB_BASE}/kyc/verify-email?${qs}`,
      appDeepLink: `${DEEP}/kyc/verify-email?${qs}`,
      ctaText: 'Verify email',
    };

    try {
      const fullName = `${user.firstname || ''} ${user.lastname || ''}`.trim() || 'User';
      await sendEmailVerificationOTP(targetEmail, fullName, otp, 10, extras);

      logger.info("Email verification OTP sent", { userId, emailChanged });

      return res.status(200).json({
        success: true,
        message: "Verification code sent to your email address",
        currentEmail: targetEmail,
        emailChanged,
        verifyUrl: extras.verifyUrl,
        expiresIn: 10
      });
    } catch (emailError) {
      logger.error("Failed to send email verification OTP", { userId, error: emailError.message });
      user.pinChangeOtp = null;
      user.pinChangeOtpCreatedAt = null;
      user.pinChangeOtpExpiresAt = null;
      user.pinChangeOtpVerified = false;
      await user.save();
      return res.status(500).json({ message: "Failed to send verification code. Please try again." });
    }
  } catch (error) {
    logger.error("Email verification initiate error", { userId: req.user?.id, error: error.message });
    return res.status(500).json({ message: "Server error while initiating email verification" });
  }
});

// POST /email-verify/verify - Verify OTP
router.post("/verify", async (req, res) => {
  try {
    const userId = req.user.id;
    const { otp, email } = req.body;

    if (!otp) return res.status(400).json({ message: "Verification code is required" });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    if (!user.pinChangeOtp) {
      return res.status(400).json({ message: "No verification code found. Please request a new one." });
    }

    const now = new Date();
    if (!user.pinChangeOtpExpiresAt || now > user.pinChangeOtpExpiresAt) {
      user.pinChangeOtp = null;
      user.pinChangeOtpCreatedAt = null;
      user.pinChangeOtpExpiresAt = null;
      user.pinChangeOtpVerified = false;
      await user.save();
      return res.status(400).json({ message: "Verification code has expired. Please request a new one." });
    }

    if (user.pinChangeOtp !== otp.toString()) {
      return res.status(400).json({ message: "Invalid verification code" });
    }

    if (email && email !== user.email) {
      return res.status(400).json({ message: "Email mismatch. Use the email associated with this verification code." });
    }

    user.emailVerified = true;
    user.pinChangeOtpVerified = true;
    if (user.kyc?.level2) user.kyc.level2.emailVerified = true;
    user.pinChangeOtp = null;
    user.pinChangeOtpCreatedAt = null;
    user.pinChangeOtpExpiresAt = null;
    await user.save();

    logger.info("Email verification completed", { userId });

    return res.status(200).json({
      success: true,
      message: "Email address verified successfully",
      emailVerified: true,
      verifiedEmail: user.email
    });
  } catch (error) {
    logger.error("Email verification verify error", { userId: req.user?.id, error: error.message });
    return res.status(500).json({ message: "Server error while verifying email." });
  }
});

module.exports = router;
