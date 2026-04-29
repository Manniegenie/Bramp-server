'use strict';

/**
 * hlBalanceGuard.js
 *
 * Runs every hour. Checks the platform's Hyperliquid USDC balance.
 * If below the critical threshold, automatically triggers an Obiex → Arbitrum
 * withdrawal to top up the HL trading account.
 *
 * Env vars:
 *   HL_PRIVATE_KEY          — platform wallet key (required)
 *   HL_MIN_USDC_BUFFER      — critical floor; triggers auto top-up (default: 500)
 *   HL_WARN_USDC_BUFFER     — soft warning level (default: 1000)
 *   HL_TOPUP_TARGET_USDC    — balance to restore to on auto top-up (default: 2000)
 *   HL_OBIEX_NETWORK        — Obiex network name for Arbitrum (default: ARBITRUM)
 */

const cron   = require('node-cron');
const logger = require('../utils/logger');
const { getUSDCBalance, getPlatformAddress } = require('./hyperliquid');
const { withdrawUSDCToArbitrum }             = require('./ObiexWithdraw');

const MIN_BUFFER    = parseFloat(process.env.HL_MIN_USDC_BUFFER   ?? '500');
const WARN_BUFFER   = parseFloat(process.env.HL_WARN_USDC_BUFFER  ?? '1000');
const TOPUP_TARGET  = parseFloat(process.env.HL_TOPUP_TARGET_USDC ?? '2000');

// Prevent overlapping top-up calls if the hourly cron fires while a top-up is in flight
let _topupInProgress = false;

async function checkBalance() {
  let balance;
  try {
    balance = await getUSDCBalance();
  } catch (err) {
    logger.error('hlBalanceGuard: failed to fetch HL balance', { error: err.message });
    return;
  }

  logger.info('hlBalanceGuard: HL USDC balance check', { balance, MIN_BUFFER, WARN_BUFFER });

  if (balance >= WARN_BUFFER) return; // all good

  if (balance < MIN_BUFFER) {
    logger.error('hlBalanceGuard: CRITICAL — HL balance below minimum, triggering auto top-up', {
      balance, MIN_BUFFER, TOPUP_TARGET,
    });
    await triggerTopUp(balance);
    return;
  }

  // Between MIN and WARN — soft warning only
  logger.warn('hlBalanceGuard: HL balance below soft threshold', { balance, WARN_BUFFER });
}

async function triggerTopUp(currentBalance) {
  if (_topupInProgress) {
    logger.warn('hlBalanceGuard: top-up already in progress, skipping');
    return;
  }

  _topupInProgress = true;
  try {
    const needed = TOPUP_TARGET - currentBalance;

    // Obiex minimum withdrawal is $1; fee (~$0.40) is deducted by Obiex from the amount
    if (needed < 1) {
      logger.info('hlBalanceGuard: top-up amount too small to withdraw', { needed });
      return;
    }

    let hlAddress;
    try {
      hlAddress = getPlatformAddress();
    } catch (err) {
      logger.error('hlBalanceGuard: cannot derive HL address for top-up', { error: err.message });
      return;
    }

    const result = await withdrawUSDCToArbitrum(hlAddress, parseFloat(needed.toFixed(2)));

    if (result.success) {
      logger.info('hlBalanceGuard: top-up withdrawal submitted to Obiex', {
        amount:        needed,
        transactionId: result.transactionId,
        note:          'Funds will arrive on HL after Arbitrum bridge confirmation (~2 min)',
      });
    } else {
      logger.error('hlBalanceGuard: auto top-up failed', { error: result.error, needed });
    }

  } finally {
    _topupInProgress = false;
  }
}

function start() {
  if (!process.env.HL_PRIVATE_KEY) {
    logger.warn('hlBalanceGuard: HL_PRIVATE_KEY not set — balance guard will not start');
    return;
  }

  // Run once at startup, then every hour
  checkBalance();
  cron.schedule('0 * * * *', async () => {
    try {
      await checkBalance();
    } catch (err) {
      logger.error('hlBalanceGuard: unexpected error', { error: err.message });
    }
  });

  logger.info('hlBalanceGuard: started (every hour)');
}

module.exports = { start, checkBalance };
