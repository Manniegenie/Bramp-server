const express = require('express');
const router = express.Router();
const User = require('../models/user');
const logger = require('../utils/logger');

const BALANCE_SYMBOLS = ['SOL', 'BTC', 'USDT', 'USDC', 'ETH', 'BNB', 'MATIC', 'AVAX', 'NGNB'];

/**
 * GET /admin/users/wallets?email=user@example.com&tokens=BTC_BTC,NGNB_NGNB
 *
 * Balances are flat per-symbol fields on the user document, so they're always
 * returned in full regardless of the tokens filter — cheap, and avoids the
 * caller having to know the exact deposit-wallet key format just to read a
 * balance. `tokens` only filters which deposit-wallet (address) entries come
 * back; unrecognized keys are silently skipped rather than erroring, since
 * some callers (e.g. the funding form) pass a synthesized "SYMBOL_SYMBOL" key
 * that doesn't necessarily match a real multi-network wallet key.
 */
router.get('/wallets', async (req, res) => {
  try {
    const { email, tokens } = req.query;
    if (!email) {
      return res.status(400).json({ success: false, message: 'email is required' });
    }

    const user = await User.findOne({ email: String(email).toLowerCase().trim() });
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const balances = {};
    for (const symbol of BALANCE_SYMBOLS) {
      const key = `${symbol.toLowerCase()}Balance`;
      balances[key] = user[key] ?? 0;
    }

    const requestedTokens = String(tokens || '')
      .split(',')
      .map(t => t.trim())
      .filter(Boolean);

    const userWallets = user.wallets || {};
    const wallets = {};
    for (const tokenKey of requestedTokens) {
      const entry = userWallets[tokenKey];
      if (entry) {
        wallets[tokenKey] = {
          address: entry.address || null,
          network: entry.network || null,
          walletReferenceId: entry.walletReferenceId || null,
        };
      }
    }

    return res.status(200).json({
      success: true,
      email: user.email,
      wallets,
      balances,
    });
  } catch (err) {
    logger.error('Failed to fetch user wallets (admin)', { error: err.message, email: req.query?.email });
    return res.status(500).json({ success: false, message: 'Failed to fetch user wallets' });
  }
});

module.exports = router;
