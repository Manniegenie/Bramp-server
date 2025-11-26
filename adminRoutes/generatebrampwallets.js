const express = require('express');
const router = express.Router();
const User = require('../models/user');
const { generateSingleWallet } = require('../utils/generatewallets');
const logger = require('../utils/logger');

// POST: /generate-bramp-wallets - Generate wallet addresses for chibuike user (Bramp hot wallet)
router.post('/generate-bramp-wallets', async (req, res) => {
  try {
    const { force = false } = req.body;

    // Find or create the chibuike user
    let brampUser = await User.findOne({ username: 'chibuike' });

    if (!brampUser) {
      // Create the chibuike user if it doesn't exist
      brampUser = new User({
        username: 'chibuike',
        email: 'chibuike@bramp.com',
        firstname: 'Bramp',
        lastname: 'Hot Wallet',
        phonenumber: '0000000000', // Placeholder
        wallets: {}
      });
      await brampUser.save();
      logger.info('Created chibuike user for Bramp hot wallet');
    }

    // Check if wallets already exist (unless force is true)
    const hasWallets = brampUser.wallets && Object.values(brampUser.wallets).some(wallet =>
      wallet && wallet.address && wallet.address !== null &&
      wallet.address !== "PLACEHOLDER_FOR_NGNB_WALLET_ADDRESS"
    );

    if (!force && hasWallets) {
      return res.status(400).json({
        success: false,
        message: 'Bramp wallets already generated. Use force=true to regenerate.',
        user: {
          id: brampUser._id,
          username: brampUser.username,
          email: brampUser.email
        },
        existingWallets: Object.keys(brampUser.wallets || {})
      });
    }

    logger.info('Starting Bramp wallet generation', {
      userId: brampUser._id,
      username: brampUser.username,
      force: force
    });

    // Define supported tokens (excluding AVAX and MATIC as requested)
    const supportedTokens = [
      { currency: 'BTC', network: 'BTC', schemaKey: 'BTC_BTC' },
      { currency: 'ETH', network: 'ETH', schemaKey: 'ETH_ETH' },
      { currency: 'SOL', network: 'SOL', schemaKey: 'SOL_SOL' },
      { currency: 'USDT', network: 'ETH', schemaKey: 'USDT_ETH' },
      { currency: 'USDT', network: 'TRX', schemaKey: 'USDT_TRX' },
      { currency: 'USDT', network: 'BSC', schemaKey: 'USDT_BSC' },
      { currency: 'USDC', network: 'ETH', schemaKey: 'USDC_ETH' },
      { currency: 'USDC', network: 'BSC', schemaKey: 'USDC_BSC' },
      { currency: 'BNB', network: 'ETH', schemaKey: 'BNB_ETH' },
      { currency: 'BNB', network: 'BSC', schemaKey: 'BNB_BSC' }
    ];

    const results = {
      successful: {},
      failed: {},
      totalRequested: supportedTokens.length,
      successfullyCreated: 0
    };

    // Generate wallets for each supported token
    for (const token of supportedTokens) {
      try {
        logger.info(`Generating wallet for ${token.currency}/${token.network}`, {
          schemaKey: token.schemaKey
        });

        const result = await generateSingleWallet(
          brampUser.email,
          brampUser._id,
          token.currency,
          token.network
        );

        if (result.success) {
          // Update the user's wallet using direct assignment
          if (!brampUser.wallets) {
            brampUser.wallets = {};
          }

          brampUser.wallets[token.schemaKey] = {
            address: result.wallet.address,
            network: result.wallet.network,
            walletReferenceId: result.wallet.referenceId
          };

          results.successful[token.schemaKey] = {
            address: result.wallet.address,
            network: result.wallet.network,
            referenceId: result.wallet.referenceId
          };
          results.successfullyCreated++;
        }
      } catch (error) {
        logger.error(`Failed to generate wallet for ${token.currency}/${token.network}`, {
          error: error.message,
          schemaKey: token.schemaKey
        });
        results.failed[token.schemaKey] = {
          error: error.message,
          currency: token.currency,
          network: token.network
        };
      }
    }

    // Save the updated user
    await brampUser.save();

    const responseData = {
      success: true,
      message: 'Bramp wallet generation completed',
      user: {
        id: brampUser._id,
        username: brampUser.username,
        email: brampUser.email
      },
      results: {
        successful: results.successful,
        failed: results.failed,
        totalRequested: results.totalRequested,
        successfullyCreated: results.successfullyCreated,
        successRate: `${results.successfullyCreated}/${results.totalRequested}`
      },
      force: force
    };

    logger.info('Bramp wallet generation completed', {
      userId: brampUser._id,
      successfullyCreated: results.successfullyCreated,
      totalRequested: results.totalRequested,
      successRate: responseData.results.successRate
    });

    return res.json(responseData);

  } catch (error) {
    logger.error('Bramp wallet generation error', {
      error: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      success: false,
      error: 'Internal server error during Bramp wallet generation',
      message: error.message
    });
  }
});

// GET: /bramp-wallet-status - Check Bramp wallet status
router.get('/bramp-wallet-status', async (req, res) => {
  try {
    const brampUser = await User.findOne({ username: 'chibuike' })
      .select('_id username email wallets');

    if (!brampUser) {
      return res.status(404).json({
        success: false,
        message: 'Bramp user (chibuike) not found'
      });
    }

    // Count how many wallets have been generated
    const walletCount = brampUser.wallets ? Object.keys(brampUser.wallets).filter(key =>
      key !== 'NGNB' && brampUser.wallets[key] && brampUser.wallets[key].address &&
      brampUser.wallets[key].address !== null &&
      brampUser.wallets[key].address !== "PLACEHOLDER_FOR_NGNB_WALLET_ADDRESS"
    ).length : 0;

    // List all supported wallet types (excluding AVAX and MATIC)
    const supportedWallets = [
      'BTC_BTC', 'ETH_ETH', 'SOL_SOL',
      'USDT_ETH', 'USDT_TRX', 'USDT_BSC',
      'USDC_ETH', 'USDC_BSC',
      'BNB_ETH', 'BNB_BSC'
    ];

    // Get wallet details
    const walletDetails = {};
    if (brampUser.wallets) {
      supportedWallets.forEach(key => {
        const wallet = brampUser.wallets[key];
        walletDetails[key] = {
          hasAddress: !!(wallet && wallet.address && wallet.address !== null && wallet.address !== "PLACEHOLDER_FOR_NGNB_WALLET_ADDRESS"),
          network: wallet ? wallet.network : null,
          hasReferenceId: !!(wallet && wallet.walletReferenceId),
          address: wallet ? wallet.address : null
        };
      });
    }

    res.json({
      success: true,
      user: {
        id: brampUser._id,
        username: brampUser.username,
        email: brampUser.email
      },
      walletsGenerated: walletCount,
      totalWallets: supportedWallets.length,
      progress: `${walletCount}/${supportedWallets.length}`,
      supportedWallets,
      walletDetails: walletDetails,
      isComplete: walletCount >= supportedWallets.length
    });

  } catch (error) {
    logger.error('Error checking Bramp wallet status', {
      error: error.message
    });
    res.status(500).json({
      success: false,
      message: 'Server error while checking Bramp wallet status',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

module.exports = router;
