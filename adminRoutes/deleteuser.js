// routes/user.js
const express = require('express');
const router = express.Router();
const User = require('../models/user');
const validator = require('validator');
const logger = require('../utils/logger');

const BVN_REGEX = /^\d{11}$/; // Nigeria BVN = 11 digits

// DELETE user by email, phone number, or BVN
router.delete('/user', async (req, res) => {
  const { email, phonenumber, bvn } = req.body || {};

  // Require at least one identifier
  if (!email && !phonenumber && !bvn) {
    logger.warn('Missing identifier in delete user request');
    return res.status(400).json({
      success: false,
      error: 'Provide a valid email, phone number, or BVN.',
    });
  }

  // Validate identifiers (only for the one that will be used by precedence)
  // 1) Email (highest precedence)
  if (email) {
    if (!validator.isEmail(email)) {
      logger.warn('Invalid email in delete user request', { email });
      return res.status(400).json({ success: false, error: 'Valid email is required.' });
    }
  } else if (bvn) {
    // 2) BVN (next precedence)
    if (!BVN_REGEX.test(String(bvn))) {
      logger.warn('Invalid BVN in delete user request', { bvn });
      return res.status(400).json({ success: false, error: 'Valid BVN is required (11 digits).' });
    }
  } else if (phonenumber) {
    // 3) Phone (last precedence)
    if (!validator.isMobilePhone(String(phonenumber), 'any')) {
      logger.warn('Invalid phone number in delete user request', { phonenumber });
      return res.status(400).json({ success: false, error: 'Valid phone number is required.' });
    }
  }

  // Prefer email > BVN > phone if multiple are provided
  const query = email
    ? { email: email.toLowerCase() }
    : bvn
      ? { bvn: String(bvn) }
      : { phonenumber: String(phonenumber) };

  try {
    const deletedUser = await User.findOneAndDelete(query);

    if (!deletedUser) {
      logger.warn('User not found for deletion', query);
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    logger.info('User deleted', {
      email: deletedUser.email,
      phonenumber: deletedUser.phonenumber,
      bvn: deletedUser.bvn,
    });

    return res.status(200).json({
      success: true,
      message: 'User deleted successfully.',
      deletedUser,
    });
  } catch (error) {
    logger.error('Error deleting user', {
      error: error.message,
      stack: error.stack,
      query,
    });
    return res.status(500).json({ success: false, error: 'Internal server error.' });
  }
});

module.exports = router;
