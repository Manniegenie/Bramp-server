// routes/NIN.js
const express = require('express');
const router = express.Router();
const User = require('../models/user');
const SmileIDNINService = require('../services/SmileIDService');
const EmailVerificationService = require('../services/VerifiedEmail');
const logger = require('../utils/logger');

const smileService = new SmileIDNINService();

// Retired: submitted NIN to Smile ID without a selfie match. NIN now goes
// through Dojah via /kyc/biometric-verification. The Smile ID callback below
// stays so any in-flight jobs can still complete.
router.post('/verify-nin', (req, res) => res.status(410).json({
    success: false,
    message: 'This verification endpoint has been retired. Please update the app and verify through /kyc/biometric-verification.'
  }));

// POST /nin/smile-callback - Webhook from Smile ID
router.post('/smile-callback', async (req, res) => {
  try {
    logger.info('Received Smile ID webhook callback', { smileJobId: req.body.SmileJobID, resultCode: req.body.ResultCode });

    const result = await smileService.handleVerificationCallback(req.body);

    res.status(200).json({ success: true, message: 'Callback processed successfully' });

    if (result.verification_status === 'verified') {
      logger.info('User successfully verified via NIN', { userId: result.userId });
    } else if (result.verification_status === 'failed') {
      logger.warn('User NIN verification failed', { userId: result.userId, resultText: result.result_text });
    }
  } catch (error) {
    logger.error('Failed to process Smile ID callback', { error: error.message });
    res.status(200).json({ success: false, message: 'Callback processing failed' });
  }
});

module.exports = router;
