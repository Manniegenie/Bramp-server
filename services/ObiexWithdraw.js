'use strict';

/**
 * ObiexWithdraw.js
 *
 * Platform-level USDC withdrawal from Obiex to an external address, on any
 * network Obiex supports for USDC. Used by Metusela (services/metuselaWallet.js,
 * services/metuselaOnramp.js).
 *
 * This is NOT the user-facing withdrawal (no 2FA, PIN, or KYC checks).
 * It is a platform treasury operation — the same as the internal
 * initiateObiexWithdrawal() in routes/withdraw.js, extracted for reuse.
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

const MIN_WITHDRAWAL = 1; // USDC

/**
 * Withdraws a stablecoin (USDC or USDT) from the platform's Obiex account to
 * an address on any network Obiex supports for it (e.g. 'POLYGON', 'TRX').
 * Storefront payouts use it directly (services/storefrontBuy.js).
 *
 * @returns {Promise<{ success: boolean, transactionId?: string, error?: string }>}
 */
async function withdrawStablecoin(currency, toAddress, amount, network, narration) {
  if (!toAddress) return { success: false, error: 'MISSING_ADDRESS' };
  if (!network) return { success: false, error: 'MISSING_NETWORK' };
  if (!Number.isFinite(amount) || amount < MIN_WITHDRAWAL) {
    return { success: false, error: `AMOUNT_TOO_LOW: minimum is ${MIN_WITHDRAWAL} ${currency}` };
  }

  try {
    const response = await obiexAxios.post('/wallets/ext/debit/crypto', {
      amount,
      currency,
      destination: { address: toAddress, network },
      // Obiex rejects long narrations (see the 40-char cap commit).
      narration: String(narration).slice(0, 40),
    });
    const txId = response.data?.data?.id;
    if (!txId) throw new Error('Obiex response missing transaction ID');
    logger.info(`ObiexWithdraw: ${currency} withdrawal submitted`, { txId, amount, network });
    return { success: true, transactionId: txId };
  } catch (err) {
    const detail = err.response?.data?.message || err.message;
    // Obiex's message alone ("Invalid request") rarely says why; keep the
    // whole reply (field errors, codes) in the log.
    logger.error(`ObiexWithdraw: ${currency} withdrawal failed`, {
      amount, network, error: detail, status: err.response?.status,
      obiexResponse: JSON.stringify(err.response?.data ?? null).slice(0, 800),
    });
    return { success: false, error: detail };
  }
}

/**
 * Withdraws USDC from the platform's Obiex account to an address on any
 * network Obiex supports for USDC (e.g. 'POLYGON', 'ARBITRUM').
 */
function withdrawUSDC(toAddress, usdcAmount, network, narration = 'Metusela on-ramp') {
  return withdrawStablecoin('USDC', toAddress, usdcAmount, network, narration);
}

module.exports = { withdrawUSDC, withdrawStablecoin };
