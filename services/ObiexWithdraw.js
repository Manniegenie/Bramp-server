'use strict';

/**
 * ObiexWithdraw.js
 *
 * Platform-level USDC withdrawal from Obiex to an external address.
 * Used by hlBalanceGuard to auto top-up the Hyperliquid trading account.
 *
 * This is NOT the user-facing withdrawal (no 2FA, PIN, or KYC checks).
 * It is a platform treasury operation — the same as the internal
 * initiateObiexWithdrawal() in routes/withdraw.js, extracted for reuse.
 *
 * Obiex Arbitrum network name: 'ARBITRUM'
 * Minimum withdrawal: $1 USDC
 * Fee: ~$0.40 USDC (deducted by Obiex from the sent amount)
 */

const axios  = require('axios');
const config = require('../routes/config');
const { attachObiexAuth } = require('../utils/obiexAuth');
const logger = require('../utils/logger');

const obiexAxios = axios.create({
  baseURL: (config.obiex.baseURL || '').replace(/\/+$/, ''),
  timeout: 30000,
});
obiexAxios.interceptors.request.use(attachObiexAuth);

const ARBITRUM_NETWORK = process.env.HL_OBIEX_NETWORK ?? 'ARBITRUM';
const MIN_WITHDRAWAL   = 1; // Obiex Arbitrum minimum in USDC

/**
 * Withdraws USDC from the platform's Obiex account to an Arbitrum address.
 *
 * @param {string} toAddress  — destination Arbitrum wallet address
 * @param {number} usdcAmount — amount in USDC (must be >= $1)
 * @param {string} [narration] — optional memo; defaults to 'HL auto top-up'
 * @returns {Promise<{ success: boolean, transactionId?: string, error?: string }>}
 */
async function withdrawUSDCToArbitrum(toAddress, usdcAmount, narration = 'HL auto top-up') {
  if (!toAddress) return { success: false, error: 'MISSING_ADDRESS' };
  if (!Number.isFinite(usdcAmount) || usdcAmount < MIN_WITHDRAWAL) {
    return { success: false, error: `AMOUNT_TOO_LOW: minimum is $${MIN_WITHDRAWAL} USDC` };
  }

  const payload = {
    amount:      usdcAmount,
    currency:    'USDC',
    destination: {
      address: toAddress,
      network: ARBITRUM_NETWORK,
    },
    narration,
  };

  try {
    logger.info('ObiexWithdraw: initiating USDC → Arbitrum withdrawal', {
      toAddress: toAddress.slice(0, 10) + '...',
      usdcAmount,
      network: ARBITRUM_NETWORK,
    });

    const response = await obiexAxios.post('/wallets/ext/debit/crypto', payload);

    if (!response.data?.data?.id) {
      throw new Error('Obiex response missing transaction ID');
    }

    const txId = response.data.data.id;
    logger.info('ObiexWithdraw: withdrawal submitted', { txId, usdcAmount });

    return { success: true, transactionId: txId };

  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    logger.error('ObiexWithdraw: withdrawal failed', {
      usdcAmount,
      network: ARBITRUM_NETWORK,
      error: detail,
      status: err.response?.status,
    });
    return { success: false, error: detail };
  }
}

module.exports = { withdrawUSDCToArbitrum };
