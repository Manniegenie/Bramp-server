// routes/signup.js
const express = require('express');
const router = express.Router();

const PendingUser = require('../models/pendinguser');
const User = require('../models/user');
const { sendVerificationCode } = require('../utils/verifyAT');
const { sendSignupEmail } = require('../services/EmailService');
const logger = require('../utils/logger');
const validator = require('validator');
const facebookConversionsAPI = require('../services/FacebookConversionsAPI');

// --- helpers ---
function generateOTP(length = 6) {
  const digits = '0123456789';
  let otp = '';
  for (let i = 0; i < length; i++) otp += digits[Math.floor(Math.random() * digits.length)];
  return otp;
}
function sanitizeInput(v) {
  return validator.stripLow(validator.escape(String(v ?? '').trim()));
}

// POST: /chatsignup/add-user
router.post('/add-user', async (req, res) => {
  let { email, firstname, lastname, phonenumber, bvn } = req.body || {};

  // ✅ Required core fields only (BVN is optional)
  if (!email || !firstname || !lastname || !phonenumber) {
    logger.warn('Missing required fields', { bodyKeys: Object.keys(req.body || {}) });
    return res.status(400).json({ success: false, message: 'Please fill all required fields.' });
  }

  // sanitize required
  email = sanitizeInput(email.toLowerCase());
  firstname = sanitizeInput(firstname);
  lastname = sanitizeInput(lastname);
  phonenumber = sanitizeInput(phonenumber);

  // sanitize optional
  if (typeof bvn === 'string') bvn = sanitizeInput(bvn);

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

  // format checks
  if (!validator.isEmail(email)) {
    return res.status(400).json({ success: false, message: 'Invalid email address.' });
  }

  // Normalize and validate phone number
  phonenumber = normalizePhone(phonenumber);
  if (!/^\+?\d{10,15}$/.test(phonenumber)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid phone number. Use format like +2348100000000.',
    });
  }

  // ✅ Optional BVN validation (only if provided)
  if (bvn && !/^\d{11}$/.test(bvn)) {
    return res.status(400).json({ success: false, message: 'BVN must be exactly 11 digits.' });
  }

  try {
    // === Duplicate checks ===
    const userOr = [{ email }, { phonenumber }];
    if (bvn) userOr.push({ bvn });
    const existingMainUser = await User.findOne({ $or: userOr });
    if (existingMainUser) {
      logger.info('User exists in main DB', {
        email: email.slice(0, 3) + '****',
        phone: phonenumber.slice(0, 5) + '****',
        bvn: bvn ? bvn.slice(0, 4) + '****' : undefined,
      });
      return res.status(409).json({ success: false, message: 'User already exists.' });
    }

    const pendingOr = [{ email }, { phonenumber }];
    if (bvn) pendingOr.push({ bvn });
    const existingPending = await PendingUser.findOne({ $or: pendingOr });
    if (existingPending) {
      logger.info('User exists in pending DB', {
        email: email.slice(0, 3) + '****',
        phone: phonenumber.slice(0, 5) + '****',
        bvn: bvn ? bvn.slice(0, 4) + '****' : undefined,
      });
      return res
        .status(409)
        .json({ success: false, message: 'Phone or email already exists.' });
    }

    // OTP
    const otp = generateOTP();
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000);

    // send SMS (Africa's Talking expects no leading +)
    const normalizedPhone = phonenumber.startsWith('+') ? phonenumber.slice(1) : phonenumber;
    const sendResult = await sendVerificationCode(normalizedPhone, otp);
    if (!sendResult?.success) {
      logger.error('Failed to send OTP', { phone: normalizedPhone, error: sendResult?.error });
      return res.status(500).json({ success: false, message: 'Failed to send verification code.' });
    }

    // save pending (include BVN only if provided)
    const pendingUser = new PendingUser({
      email,
      firstname,
      lastname,
      phonenumber,
      ...(bvn ? { bvn } : {}),
      verificationCode: otp,
      verificationCodeCreatedAt: createdAt,
      verificationCodeExpiresAt: expiresAt,
    });

    await pendingUser.save();

    // Track Facebook Conversions API CompleteRegistration event (initial signup)
    try {
      const facebookResult = await facebookConversionsAPI.trackCompleteRegistration({
        email: email,
        phone: phonenumber,
        firstname: firstname,
        lastname: lastname
      }, {
        clientIp: req.ip || req.connection.remoteAddress,
        userAgent: req.get('User-Agent')
      });

      if (facebookResult.success) {
        logger.info('Facebook CompleteRegistration event tracked successfully (chatbot signup)', {
          pendingUserId: pendingUser._id,
          eventId: facebookResult.eventId,
          email: email.slice(0, 3) + '****'
        });
      } else {
        logger.warn('Facebook CompleteRegistration event failed (chatbot signup)', {
          pendingUserId: pendingUser._id,
          error: facebookResult.error,
          details: facebookResult.details
        });
      }
    } catch (facebookError) {
      // Don't fail the signup if Facebook tracking fails
      logger.error('Facebook Conversions API error during chatbot signup', {
        pendingUserId: pendingUser._id,
        error: facebookError.message,
        email: email.slice(0, 3) + '****'
      });
    }

    // fire-and-forget welcome email
    (async () => {
      try {
        const fullName = `${firstname} ${lastname}`.trim();
        const emailResult = await sendSignupEmail(email, fullName);
        logger.info('Welcome email sent', {
          email: email.slice(0, 3) + '****',
          messageId: emailResult?.messageId,
        });
      } catch (emailErr) {
        logger.error('Welcome email failed', {
          email: email.slice(0, 3) + '****',
          err: emailErr?.message,
        });
      }
    })();

    return res.status(201).json({
      success: true,
      message: 'Account created. Please verify OTP to complete your signup.',
      otpSent: true,
      userId: pendingUser._id.toString(),
      user: {
        email,
        phonenumber,
        firstname,
        lastname,
        ...(bvn ? { bvn } : {}),
      },
    });
  } catch (err) {
    if (err?.name === 'ValidationError') {
      const firstKey = Object.keys(err.errors || {})[0];
      const msg =
        (firstKey && err.errors[firstKey]?.message) ||
        'Validation failed. Please check your inputs.';
      return res.status(400).json({ success: false, message: msg });
    }
    logger.error('Signup error', {
      error: err?.message,
      stack: err?.stack,
      phone: phonenumber?.slice(0, 5) + '****',
      bvn: bvn ? bvn.slice(0, 4) + '****' : undefined,
    });
    return res.status(500).json({ success: false, message: 'Server error while creating user.' });
  }
});

module.exports = router;
