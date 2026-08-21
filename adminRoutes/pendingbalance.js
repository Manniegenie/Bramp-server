// routes/userRoutes.js

const express = require('express');
const router = express.Router();
const User = require('../models/user');  // Adjust path if needed

// POST /wipe-pending-balance
router.post('/wipe', async (req, res) => {
  try {
    const { email, currency } = req.body;

    if (!email || !currency) {
      return res.status(400).json({ error: 'Email and currency are required' });
    }

    const normalizedCurrency = currency.trim().toUpperCase();

    // Find user by email
    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Map currency to pending balance field
    const currencyKey = normalizedCurrency.toLowerCase();

    let pendingBalanceField;

    if (currencyKey.startsWith('usdt')) {
      pendingBalanceField = 'usdtPendingBalance';
    } else if (currencyKey.startsWith('usdc')) {
      pendingBalanceField = 'usdcPendingBalance';
    } else if (currencyKey.startsWith('btc')) {
      pendingBalanceField = 'btcPendingBalance';
    } else if (currencyKey.startsWith('sol')) {
      pendingBalanceField = 'solPendingBalance';
    } else if (currencyKey.startsWith('eth')) {
      pendingBalanceField = 'ethPendingBalance';
    } else {
      return res.status(400).json({ error: 'Unsupported currency for pending balance reset' });
    }

    // Set the pending balance to zero
    user[pendingBalanceField] = 0;

    await user.save();

    return res.status(200).json({
      success: true,
      message: `Pending balance for ${normalizedCurrency} wiped for user ${email}`,
      [pendingBalanceField]: user[pendingBalanceField],
    });
  } catch (error) {
    console.error('Error wiping pending balance:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /deduct - Deduct from user's balance
router.post('/deduct', async (req, res) => {
  try {
    const { email, currency, amount } = req.body;

    if (!email || !currency || amount === undefined || amount === null) {
      return res.status(400).json({ error: 'Email, currency, and amount are required' });
    }

    const deductAmount = parseFloat(amount);
    if (isNaN(deductAmount) || deductAmount <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive number' });
    }

    const normalizedCurrency = currency.trim().toUpperCase();

    const user = await User.findOne({ email: email.trim().toLowerCase() });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Map currency to balance field — matches Bramp's actual supported tokens
    // (models/user.js), not ZeusODX-server's set (no TRX/TON here, has AVAX/NGNB).
    const currencyKey = normalizedCurrency.toLowerCase();

    let balanceField;

    if (currencyKey.startsWith('usdt')) {
      balanceField = 'usdtBalance';
    } else if (currencyKey.startsWith('usdc')) {
      balanceField = 'usdcBalance';
    } else if (currencyKey.startsWith('btc')) {
      balanceField = 'btcBalance';
    } else if (currencyKey.startsWith('sol')) {
      balanceField = 'solBalance';
    } else if (currencyKey.startsWith('eth')) {
      balanceField = 'ethBalance';
    } else if (currencyKey.startsWith('bnb')) {
      balanceField = 'bnbBalance';
    } else if (currencyKey.startsWith('matic')) {
      balanceField = 'maticBalance';
    } else if (currencyKey.startsWith('avax')) {
      balanceField = 'avaxBalance';
    } else if (currencyKey.startsWith('ngnb')) {
      balanceField = 'ngnbBalance';
    } else {
      return res.status(400).json({ error: 'Unsupported currency for balance deduction' });
    }

    const currentBalance = user[balanceField] || 0;

    // Atomic deduction with balance guard — prevents double-deduct from concurrent requests
    const updated = await User.findOneAndUpdate(
      { email: email.trim().toLowerCase(), [balanceField]: { $gte: deductAmount } },
      { $inc: { [balanceField]: -deductAmount } },
      { new: true }
    );

    if (!updated) {
      return res.status(400).json({
        error: 'Insufficient balance',
        currentBalance,
        requestedDeduction: deductAmount
      });
    }

    return res.status(200).json({
      success: true,
      message: `Successfully deducted ${deductAmount} ${normalizedCurrency} from user ${email}`,
      previousBalance: currentBalance,
      deductedAmount: deductAmount,
      newBalance: updated[balanceField],
      currency: normalizedCurrency
    });
  } catch (error) {
    console.error('Error deducting balance:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
