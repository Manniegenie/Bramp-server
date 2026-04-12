const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const { debitNaira } = require('../services/nairaWithdrawal');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { sendWithdrawalEmail } = require('../services/EmailService');
const { sendWithdrawalNotification } = require('../services/notificationService');

const User = require('../models/user');
const Transaction = require('../models/transaction');
const logger = require('../utils/logger');
const { checkWithdrawalLimit } = require('../utils/withdrawalLimits'); // TEMP: remove when KYC fully set up

// Fee constants
// Total fee charged to user on top of their withdrawal amount.
const NGNB_FEE_TOTAL    = 100;    // ₦100 charged to user (additive — on top of amount)
const NGNB_FEE_OBIEX    = 53.75;  // Obiex's share — added to the payout sent to provider
const NGNB_FEE_PLATFORM = 46.25;  // Platform keeps this (NGNB_FEE_TOTAL - NGNB_FEE_OBIEX)

// In-process lock: prevents double-submit from the same user within a single server instance.
// The atomic MongoDB findOneAndUpdate ($gte balance check) is the true race condition guard
// at the database level — this is belt-and-suspenders for same-process concurrent requests.
const processingUsers = new Set();

// --- HELPERS ---

function maskAccountNumber(accountNumber) {
  if (!accountNumber) return '';
  const str = String(accountNumber).replace(/\s+/g, '');
  return str.length <= 4 ? str : `${str.slice(0, 2)}****${str.slice(-2)}`;
}

function isValidAccountNumber(accountNumber) {
  return /^\d{10}$/.test(accountNumber);
}

async function comparePasswordPin(candidate, hashed) {
  if (!candidate || !hashed) return false;
  return await bcrypt.compare(candidate, hashed);
}

function generateWithdrawalReference() {
  return `NGNB_WD_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

function validateWithdrawalRequest(body) {
  const errors = [];
  const sanitized = {};

  const numericAmount = Number(body.amount);
  if (!body.amount || isNaN(numericAmount) || numericAmount <= 0) {
    errors.push('Amount must be a positive number');
  } else if (numericAmount < 100) {
    errors.push('Minimum withdrawal amount is ₦100');
  } else if (numericAmount > 10_000_000) {
    errors.push('Maximum withdrawal amount is ₦10,000,000');
  } else {
    sanitized.amount = numericAmount;
  }

  if (!body.bank_code) {
    errors.push('Bank code is required');
  } else {
    sanitized.bank_code = String(body.bank_code).trim();
  }

  if (!body.account_number) {
    errors.push('Account number is required');
  } else {
    sanitized.account_number = String(body.account_number).trim();
    if (!isValidAccountNumber(sanitized.account_number)) {
      errors.push('Account number must be exactly 10 digits');
    }
  }

  if (!body.account_name || !String(body.account_name).trim()) {
    errors.push('Account name is required');
  } else {
    sanitized.account_name = String(body.account_name).trim().substring(0, 100);
  }

  if (!body.bank_name || !String(body.bank_name).trim()) {
    errors.push('Bank name is required');
  } else {
    sanitized.bank_name = String(body.bank_name).trim().substring(0, 100);
  }

  if (body.narration) sanitized.narration = String(body.narration).trim().substring(0, 100);

  if (!body.twoFactorCode?.trim()) {
    errors.push('Two-factor authentication code is required');
  } else {
    sanitized.twoFactorCode = String(body.twoFactorCode).trim();
  }

  if (!body.passwordpin?.trim()) {
    errors.push('Password PIN is required');
  } else {
    sanitized.passwordpin = String(body.passwordpin).trim();
    if (!/^\d{6}$/.test(sanitized.passwordpin)) errors.push('Password PIN must be exactly 6 digits');
  }

  return { isValid: errors.length === 0, errors, sanitized };
}

// --- STAGE 1: Atomic balance deduction + transaction record (MongoDB session) ---

async function executeNGNBWithdrawal(userId, withdrawalData, reference) {
  const { amount, bank_code, bank_name, account_number, account_name, narration } = withdrawalData;

  // Fee is additive: user pays amount + NGNB_FEE_TOTAL
  // Provider receives amount + NGNB_FEE_OBIEX (Obiex's share of the fee)
  // Platform keeps NGNB_FEE_PLATFORM (= NGNB_FEE_TOTAL - NGNB_FEE_OBIEX)
  const totalDeducted  = amount + NGNB_FEE_TOTAL;   // deducted from user's wallet
  const amountToProvider = amount + NGNB_FEE_OBIEX; // sent to Obiex

  // Atomic balance deduction: only succeeds if balance >= totalDeducted
  const updatedUser = await User.findOneAndUpdate(
    { _id: userId, ngnbBalance: { $gte: totalDeducted } },
    { $inc: { ngnbBalance: -totalDeducted }, $set: { lastBalanceUpdate: new Date() } },
    { new: true, runValidators: true }
  );

  if (!updatedUser) throw new Error('INSUFFICIENT_BALANCE');

  const tx = new Transaction({
    userId,
    type: 'WITHDRAWAL',
    currency: 'NGNB',
    amount: -amount,            // withdrawal amount (excluding fee)
    status: 'PENDING',
    source: 'BANK',
    reference,
    obiexTransactionId: reference,
    narration: narration || `NGNB withdrawal to ${bank_name || account_name}`,
    fee: NGNB_FEE_TOTAL,
    metadata: {
      bank_code,
      bank_name,
      account_number,
      account_name,
      amountSentToBank:  amountToProvider,
      withdrawalFee:     NGNB_FEE_TOTAL,
      platformFee:       NGNB_FEE_PLATFORM,
      obiexFee:          NGNB_FEE_OBIEX,
      requestedAmount:   amount,
      totalDeducted,
      initiated_at: new Date()
    }
  });

  await tx.save();

  return { user: updatedUser, transaction: tx, amountToProvider, totalDeducted };
}

// --- STAGE 2: Provider payout (non-atomic, status driven by webhook) ---

async function processProviderWithdrawal(userId, withdrawalData, amountToProvider, totalDeducted, reference, transactionId) {
  try {
    const { bank_code, bank_name, account_number, account_name, narration } = withdrawalData;

    const payload = {
      destination: {
        accountNumber: account_number,
        accountName:   account_name,
        bankName:      bank_name,
        bankCode:      bank_code,
      },
      amount:   amountToProvider,
      currency: 'NGNX',
      narration: narration || `NGNB withdrawal - ${reference}`
    };

    const result = await debitNaira(payload, { userId: userId.toString(), idempotencyKey: `ngnb-wd-${reference}` });

    if (result.success) {
      // Stay PENDING — final status comes via Obiex naira webhook
      await Transaction.findByIdAndUpdate(transactionId, {
        $set: {
          status: 'PENDING',
          'metadata.providerId':        result.data?.id || null,
          'metadata.providerReference': result.data?.reference || null,
        }
      });
      return { success: true, data: result.data };
    } else {
      // Provider rejected synchronously — mark failed and refund
      await Transaction.findByIdAndUpdate(transactionId, {
        $set: {
          status: 'FAILED',
          failedAt: new Date(),
          'metadata.failureReason': 'Provider rejected withdrawal',
        }
      });
      // Refund the full amount deducted (withdrawal + fee)
      await User.findByIdAndUpdate(userId, {
        $inc: { ngnbBalance: totalDeducted },
        $set: { lastBalanceUpdate: new Date() }
      }, { runValidators: true });

      logger.info('NGNB withdrawal refunded after provider rejection', { userId, reference, totalDeducted });
      return { success: false, error: 'Withdrawal was rejected. Your balance has been refunded.' };
    }
  } catch (err) {
    logger.error('Provider withdrawal call failed', { userId, reference, error: err.message });
    return { success: false, error: 'Withdrawal processing failed. Please contact support.' };
  }
}

// --- ROUTES ---

/**
 * POST /withdrawal/ngnb
 * Withdraw NGNB balance to a Nigerian bank account.
 */
router.post('/withdrawal/ngnb', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ success: false, message: 'Authentication required' });

  // In-process concurrency guard
  if (processingUsers.has(userId)) {
    return res.status(409).json({ success: false, message: 'A withdrawal is already being processed. Please wait.' });
  }

  try {
    logger.info('NGNB withdrawal request', {
      userId,
      account_number: req.body.account_number ? maskAccountNumber(req.body.account_number) : undefined,
    });

    // 1. Validate input
    const validation = validateWithdrawalRequest(req.body);
    if (!validation.isValid) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: validation.errors });
    }

    const { amount, bank_code, bank_name, account_number, account_name, narration, twoFactorCode, passwordpin } = validation.sanitized;

    // 2. Load user
    const user = await User.findById(userId).select(
      '_id twoFASecret is2FAEnabled passwordpin email username firstname ngnbBalance'
    );
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // 3. 2FA check
    if (!user.twoFASecret || !user.is2FAEnabled) {
      return res.status(400).json({ success: false, message: 'Please enable two-factor authentication before making withdrawals.' });
    }
    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      logger.warn('NGNB withdrawal blocked: invalid 2FA', { userId });
      return res.status(401).json({ success: false, message: 'Invalid two-factor authentication code.' });
    }

    // 4. PIN check
    if (!user.passwordpin) {
      return res.status(400).json({ success: false, message: 'Please set up your PIN before making withdrawals.' });
    }
    const isPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPinValid) {
      logger.warn('NGNB withdrawal blocked: invalid PIN', { userId });
      return res.status(401).json({ success: false, message: 'Invalid PIN.' });
    }

    // 5. Pre-check balance (fast fail before acquiring lock) — must cover amount + fee
    if ((user.ngnbBalance ?? 0) < amount + NGNB_FEE_TOTAL) {
      return res.status(400).json({ success: false, message: 'Insufficient NGNB balance.' });
    }

    // 5b. Rolling 7-day withdrawal limit — TEMP: remove when KYC fully set up
    const limitCheck = await checkWithdrawalLimit(userId, amount);
    if (!limitCheck.allowed) {
      logger.warn('NGNB withdrawal blocked: 7-day limit reached', { userId, used: limitCheck.used, requested: amount });
      return res.status(400).json({
        success: false,
        message: `You have reached your 7-day withdrawal limit of ₦${limitCheck.limit.toLocaleString()}. Available: ₦${limitCheck.remaining.toLocaleString()}.`,
      });
    }

    // 6. Acquire in-process lock
    processingUsers.add(userId);

    let withdrawalResult;
    try {
      const reference = generateWithdrawalReference();
      withdrawalResult = await executeNGNBWithdrawal(
        userId,
        { amount, bank_code, bank_name, account_number, account_name, narration },
        reference
      );
    } catch (err) {
      processingUsers.delete(userId);
      if (err.message === 'INSUFFICIENT_BALANCE') {
        return res.status(400).json({ success: false, message: 'Insufficient NGNB balance.' });
      }
      throw err;
    } finally {
      processingUsers.delete(userId);
    }

    // 7. Provider payout
    const providerResult = await processProviderWithdrawal(
      userId,
      { amount, bank_code, bank_name, account_number, account_name, narration },
      withdrawalResult.amountToProvider,
      withdrawalResult.totalDeducted,
      withdrawalResult.transaction.reference,
      withdrawalResult.transaction._id
    );

    if (providerResult.success) {
      logger.info('NGNB withdrawal submitted to provider', {
        userId,
        reference: withdrawalResult.transaction.reference,
        amount,
        amountToProvider: withdrawalResult.amountToProvider,
      });

      // Notifications (non-blocking)
      const displayName = user.username || user.firstname || 'User';
      sendWithdrawalNotification(userId, amount, 'NGNB', 'pending', {
        reference: withdrawalResult.transaction.reference,
        bankName: bank_name,
        accountNumber: maskAccountNumber(account_number),
        fee: NGNB_FEE_TOTAL,
        totalAmount: withdrawalResult.totalDeducted,
      }).catch(e => logger.warn('Push notification failed', { error: e.message }));

      sendWithdrawalEmail(user.email, displayName, amount, 'NGNB', withdrawalResult.transaction.reference)
        .catch(e => logger.warn('Withdrawal email failed', { error: e.message }));

      return res.status(200).json({
        success: true,
        message: 'Withdrawal submitted and is being processed.',
        data: {
          withdrawalId:     withdrawalResult.transaction.reference,
          amount,
          fee:              NGNB_FEE_TOTAL,
          totalDeducted:    withdrawalResult.totalDeducted,
          amountSentToBank: withdrawalResult.amountToProvider,
          balanceAfter:     withdrawalResult.user.ngnbBalance,
          bankName:         bank_name,
          accountNumber:    maskAccountNumber(account_number),
          status:           'PENDING',
        }
      });
    } else {
      return res.status(502).json({
        success: false,
        message: providerResult.error,
        reference: withdrawalResult.transaction.reference,
      });
    }
  } catch (err) {
    processingUsers.delete(userId);
    logger.error('NGNB withdrawal error', { userId, error: err.message });
    return res.status(500).json({ success: false, message: 'An error occurred. Please try again.' });
  }
});

/**
 * GET /withdrawal/ngnb/status/:reference
 */
router.get('/withdrawal/ngnb/status/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    const userId = req.user.id;

    const tx = await Transaction.findOne({ reference, userId, type: 'WITHDRAWAL', currency: 'NGNB' });
    if (!tx) return res.status(404).json({ success: false, error: 'Withdrawal not found' });

    return res.status(200).json({
      success: true,
      data: {
        reference:     tx.reference,
        status:        tx.status,
        amount:        Math.abs(tx.amount),
        fee:           tx.fee,
        createdAt:     tx.createdAt,
        updatedAt:     tx.updatedAt,
        completedAt:   tx.completedAt,
        failedAt:      tx.failedAt,
        failureReason: tx.failureReason,
      }
    });
  } catch (err) {
    logger.error('Error checking withdrawal status', { error: err.message });
    return res.status(500).json({ success: false, error: 'Failed to retrieve withdrawal status' });
  }
});

/**
 * GET /withdrawal/ngnb/fees
 */
router.get('/withdrawal/ngnb/fees', (req, res) => {
  return res.json({
    success: true,
    data: {
      withdrawalFee:     NGNB_WITHDRAWAL_FEE_RECORDED,
      minimumWithdrawal: NGNB_WITHDRAWAL_FEE_OPERATIONAL + 1,
    }
  });
});

module.exports = router;
