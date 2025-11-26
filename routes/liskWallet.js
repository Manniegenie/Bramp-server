/**
 * Lisk Wallet Connection Routes
 * Handles Lisk wallet connection endpoints
 */

const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');
const {
  isValidLiskAddress,
  getLiskAccount,
  verifyWalletConnection,
  generateConnectionMessage
} = require('../services/liskWalletService');

/**
 * POST /lisk/connect
 * Initiate wallet connection - returns a message to sign
 */
router.post('/connect', async (req, res) => {
  try {
    const userId = req.user.id;
    const { network = 'mainnet' } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Generate connection message
    const timestamp = new Date().toISOString();
    const message = generateConnectionMessage(userId, timestamp);

    logger.info('Lisk wallet connection initiated', {
      userId,
      network
    });

    res.json({
      success: true,
      message: message,
      timestamp: timestamp,
      network: network,
      instructions: 'Please sign this message with your Lisk wallet to complete the connection.'
    });
  } catch (error) {
    logger.error('Failed to initiate Lisk wallet connection', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      success: false,
      error: 'Failed to initiate wallet connection'
    });
  }
});

/**
 * POST /lisk/verify
 * Verify wallet connection with signature
 */
router.post('/verify', async (req, res) => {
  try {
    const userId = req.user.id;
    const { address, signature, message, network = 'mainnet' } = req.body;

    if (!address || !signature || !message) {
      return res.status(400).json({
        success: false,
        error: 'Address, signature, and message are required'
      });
    }

    // Validate address format
    if (!isValidLiskAddress(address)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Lisk address format'
      });
    }

    // Verify wallet connection
    const verification = await verifyWalletConnection(address, signature, message);
    
    if (!verification.success) {
      return res.status(400).json({
        success: false,
        error: verification.error
      });
    }

    // Get account info from Lisk network
    const accountInfo = await getLiskAccount(address, network);

    // Update user's Lisk wallet info
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Store Lisk wallet info in user model
    // You may need to add a liskWallet field to the user schema
    if (!user.liskWallet) {
      user.liskWallet = {};
    }

    user.liskWallet = {
      address: address,
      network: network,
      publicKey: accountInfo.publicKey || null,
      balance: accountInfo.balance || '0',
      connectedAt: new Date(),
      verified: true
    };

    await user.save();

    logger.info('Lisk wallet connected successfully', {
      userId,
      address,
      network
    });

    res.json({
      success: true,
      message: 'Lisk wallet connected successfully',
      wallet: {
        address: address,
        network: network,
        balance: accountInfo.balance || '0',
        publicKey: accountInfo.publicKey || null
      }
    });
  } catch (error) {
    logger.error('Failed to verify Lisk wallet connection', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      success: false,
      error: 'Failed to verify wallet connection'
    });
  }
});

/**
 * GET /lisk/account
 * Get connected Lisk wallet information
 */
router.get('/account', async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    if (!user.liskWallet || !user.liskWallet.address) {
      return res.status(404).json({
        success: false,
        error: 'No Lisk wallet connected',
        message: 'Please connect your Lisk wallet first'
      });
    }

    // Get latest account info from network
    const accountInfo = await getLiskAccount(user.liskWallet.address, user.liskWallet.network);

    res.json({
      success: true,
      wallet: {
        address: user.liskWallet.address,
        network: user.liskWallet.network,
        balance: accountInfo.balance || user.liskWallet.balance || '0',
        publicKey: user.liskWallet.publicKey || accountInfo.publicKey || null,
        connectedAt: user.liskWallet.connectedAt,
        verified: user.liskWallet.verified
      }
    });
  } catch (error) {
    logger.error('Failed to get Lisk wallet info', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      success: false,
      error: 'Failed to get wallet information'
    });
  }
});

/**
 * POST /lisk/disconnect
 * Disconnect Lisk wallet
 */
router.post('/disconnect', async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    if (!user.liskWallet) {
      return res.status(400).json({
        success: false,
        error: 'No Lisk wallet connected'
      });
    }

    // Clear Lisk wallet info
    user.liskWallet = undefined;
    await user.save();

    logger.info('Lisk wallet disconnected', {
      userId
    });

    res.json({
      success: true,
      message: 'Lisk wallet disconnected successfully'
    });
  } catch (error) {
    logger.error('Failed to disconnect Lisk wallet', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      success: false,
      error: 'Failed to disconnect wallet'
    });
  }
});

module.exports = router;

