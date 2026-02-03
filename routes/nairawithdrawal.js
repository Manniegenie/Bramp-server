const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const { validateUserBalance } = require('../services/balance');
const { updateUserBalance } = require('../services/portfolio');
const { debitNaira } = require('../services/nairaWithdrawal');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');

const User = require('../models/user');
const Transaction = require('../models/transaction');
const logger = require('../utils/logger');

// Fee constants (mirror ZeusODX NGNZ withdrawal)
const NGNB_WITHDRAWAL_FEE_OPERATIONAL = 30;
const NGNB_WITHDRAWAL_FEE_RECORDED = 100;

const NIGERIAN_BANK_CODES = {
  '044': 'Access Bank',
  '014': 'Afribank Nigeria Plc',
  '023': 'Citibank Nigeria Limited',
  '050': 'Ecobank Nigeria Plc',
  '040': 'Equitorial Trust Bank',
  '011': 'First Bank of Nigeria',
  '214': 'First City Monument Bank',
  '058': 'Guaranty Trust Bank',
  '030': 'Heritage Bank',
  '301': 'Jaiz Bank',
  '082': 'Keystone Bank',
  '014': 'MainStreet Bank',
  '076': 'Polaris Bank',
  '221': 'Stanbic IBTC Bank',
  '068': 'Standard Chartered Bank',
  '232': 'Sterling Bank',
  '032': 'Union Bank of Nigeria',
  '033': 'United Bank For Africa',
  '215': 'Unity Bank',
  '035': 'Wema Bank',
  '057': 'Zenith Bank'
};

function maskAccountNumber(accountNumber) {
  if (!accountNumber) return '';
  const str = String(accountNumber).replace(/\s+/g, '');
  return str.length <= 4 ? str : `${str.slice(0, 2)}****${str.slice(-2)}`;
}

function isValidAccountNumber(accountNumber) {
  return /^\d{10}$/.test(accountNumber);
}

function isValidBankCode(bankCode) {
  return NIGERIAN_BANK_CODES.hasOwnProperty(bankCode);
}

async function comparePasswordPin(candidate, hashed) {
  if (!candidate || !hashed) return false;
  return await bcrypt.compare(candidate, hashed);
}

function validateWithdrawalRequest(body) {
  const errors = [];
  const sanitized = {};

  if (!body.amount) {
    errors.push('Amount is required');
  } else {
    const numericAmount = Number(body.amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      errors.push('Amount must be a positive number');
    } else if (numericAmount < (NGNB_WITHDRAWAL_FEE_OPERATIONAL + 1)) {
      errors.push(`Minimum withdrawal amount is ₦${NGNB_WITHDRAWAL_FEE_OPERATIONAL + 1} NGNB`);
    } else if (numericAmount > 10000000) {
      errors.push('Maximum withdrawal amount is 10,000,000 NGNB');
    } else {
      sanitized.amount = numericAmount;
    }
  }

  if (!body.bank_code) {
    errors.push('Bank code is required');
  } else {
    sanitized.bank_code = String(body.bank_code).trim();
    if (!isValidBankCode(sanitized.bank_code)) errors.push('Invalid bank code provided');
  }

  if (!body.account_number) {
    errors.push('Account number is required');
  } else {
    sanitized.account_number = String(body.account_number).trim();
    if (!isValidAccountNumber(sanitized.account_number)) errors.push('Account number must be exactly 10 digits');
  }

  // Required for Obiex
  if (!body.account_name || !String(body.account_name).trim()) {
    errors.push('Account name is required');
  } else {
    sanitized.account_name = String(body.account_name).trim().substring(0, 100);
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
    if (!/^\d{6}$/.test(sanitized.passwordpin)) errors.push('Password PIN must be exactly 6 numbers');
  }

  return { isValid: errors.length === 0, errors, sanitized };
}

function generateWithdrawalReference() {
  return `NGNB_WD_${Date.now()}_${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * Stage 1: Deduct balance and create transaction (no MongoDB session - works on standalone)
 */
async function executeNGNBWithdrawal(userId, withdrawalData, reference) {
  const { amount, bank_code, account_number, account_name, narration } = withdrawalData;
  const totalDeducted = amount;
  const amountToObiex = amount - NGNB_WITHDRAWAL_FEE_OPERATIONAL;
  const feeAmountRecorded = NGNB_WITHDRAWAL_FEE_RECORDED;
  const bankName = NIGERIAN_BANK_CODES[bank_code] || 'Unknown';

  const updatedUser = await User.findOneAndUpdate(
    { _id: userId, ngnbBalance: { $gte: totalDeducted } },
    { $inc: { ngnbBalance: -totalDeducted }, $set: { lastBalanceUpdate: new Date() } },
    { new: true, runValidators: true }
  );

  if (!updatedUser) throw new Error('Insufficient NGNB balance');

  const withdrawalTransaction = new Transaction({
    userId,
    type: 'WITHDRAWAL',
    currency: 'NGNB',
    amount: -totalDeducted,
    status: 'PENDING',
    source: 'BANK',
    reference,
    obiexTransactionId: reference,
    narration: narration || `NGNB withdrawal to ${bankName}`,
    fee: feeAmountRecorded,
    metadata: {
      provider: 'OBIEX',
      bank_code,
      bank_name,
      account_number,
      account_name,
      amountSentToBank: amountToObiex,
      withdrawalFee: feeAmountRecorded,
      requestedAmount: totalDeducted,
      initiated_at: new Date()
    }
  });

  try {
    await withdrawalTransaction.save();
  } catch (txErr) {
    await updateUserBalance(userId, 'NGNB', totalDeducted);
    logger.error('Failed to create withdrawal transaction record, refunded user', { userId, reference, error: txErr.message });
    throw txErr;
  }

  return {
    user: updatedUser,
    transaction: withdrawalTransaction,
    reference,
    amountToObiex,
    feeAmountRecorded,
    bankName
  };
}

/**
 * Stage 2: Call Obiex (mirror ZeusODX)
 */
async function processObiexWithdrawal(userId, withdrawalData, amountToObiex, reference, transactionId) {
  try {
    const { bank_code, account_number, account_name, narration } = withdrawalData;
    const bankName = NIGERIAN_BANK_CODES[bank_code] || 'Unknown';

    const obiexPayload = {
      destination: {
        accountNumber: account_number,
        accountName: account_name,
        bankName,
        bankCode: bank_code
      },
      amount: amountToObiex,
      currency: 'NGNX',
      narration: narration || `NGNB withdrawal - ${reference}`
    };

    const obiexResult = await debitNaira(obiexPayload, {
      userId: userId.toString(),
      idempotencyKey: `ngnb-wd-${reference}`
    });

    if (obiexResult.success) {
      await Transaction.findByIdAndUpdate(transactionId, {
        $set: {
          status: 'SUCCESSFUL',
          completedAt: new Date(),
          'metadata.obiexId': obiexResult.data?.id,
          'metadata.obiexReference': obiexResult.data?.reference
        }
      });
      return { success: true, data: obiexResult.data };
    } else {
      await Transaction.findByIdAndUpdate(transactionId, {
        $set: {
          status: 'FAILED',
          failedAt: new Date(),
          failureReason: obiexResult.message,
          'metadata.failureReason': obiexResult.message
        }
      });
      return { success: false, error: obiexResult.message };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * @route   POST /withdrawal/ngnb
 * @desc    Withdraw NGNB to Nigerian bank via Obiex (mirror ZeusODX NGNZ flow)
 * @access  Authenticated
 */
router.post('/withdrawal/ngnb', async (req, res) => {
  const userId = req.user.id;

  try {
    logger.info('NGNB withdrawal request', {
      userId,
      account_number: req.body.account_number ? req.body.account_number.substring(0, 4) + '****' : undefined,
      passwordpin: '[REDACTED]'
    });

    const validation = validateWithdrawalRequest(req.body);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }

    const { amount, bank_code, account_number, account_name, narration, twoFactorCode, passwordpin } = validation.sanitized;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (!user.twoFASecret || !user.is2FAEnabled) {
      return res.status(400).json({
        success: false,
        message: 'Two-factor authentication is not set up or not enabled. Please enable 2FA first.'
      });
    }

    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      logger.warn('Invalid 2FA for NGNB withdrawal', { userId });
      return res.status(401).json({
        success: false,
        message: 'Invalid two-factor authentication code'
      });
    }

    if (!user.passwordpin) {
      return res.status(400).json({
        success: false,
        message: 'Password PIN is not set up. Please set up your password PIN first.'
      });
    }

    const isPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPinValid) {
      logger.warn('Invalid password PIN for NGNB withdrawal', { userId });
      return res.status(401).json({
        success: false,
        message: 'Invalid password PIN'
      });
    }

    const balanceValidation = await validateUserBalance(userId, 'NGNB', amount, {
      includeBalanceDetails: true,
      logValidation: true
    });
    if (!balanceValidation.success) {
      return res.status(400).json({
        success: false,
        error: 'INSUFFICIENT_BALANCE',
        message: balanceValidation.message,
        details: {
          availableBalance: balanceValidation.availableBalance,
          requiredAmount: amount,
          currency: 'NGNB',
          shortfall: balanceValidation.shortfall
        }
      });
    }

    const reference = generateWithdrawalReference();

    const withdrawalResult = await executeNGNBWithdrawal(
      userId,
      { amount, bank_code, account_number, account_name, narration },
      reference
    );

    const obiexResult = await processObiexWithdrawal(
      userId,
      { bank_code, account_number, account_name, narration },
      withdrawalResult.amountToObiex,
      reference,
      withdrawalResult.transaction._id
    );

    if (obiexResult.success) {
      logger.info('NGNB withdrawal completed via Obiex', {
        userId,
        reference,
        amount: amount,
        amountSentToBank: withdrawalResult.amountToObiex
      });
      return res.status(200).json({
        success: true,
        message: 'Withdrawal processed successfully',
        data: {
          withdrawalId: reference,
          totalAmount: amount,
          amountSentToBank: withdrawalResult.amountToObiex,
          fee: withdrawalResult.feeAmountRecorded,
          balanceAfter: withdrawalResult.user.ngnbBalance,
          bankName: withdrawalResult.bankName,
          accountNumber: maskAccountNumber(account_number),
          status: 'SUCCESSFUL'
        }
      });
    } else {
      await updateUserBalance(userId, 'NGNB', amount);
      logger.error('NGNB withdrawal failed at Obiex', {
        reference,
        error: obiexResult.error,
        userId
      });
      return res.status(502).json({
        success: false,
        message: 'Withdrawal failed at provider',
        error: obiexResult.error,
        reference
      });
    }
  } catch (err) {
    logger.error('NGNB withdrawal error', { userId: req.user?.id, error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Internal server error during withdrawal',
      error: err.message
    });
  }
});

/**
 * @route   GET /withdrawal/ngnb/status/:reference
 * @desc    Check NGNB withdrawal status
 * @access  Authenticated
 */
router.get('/withdrawal/ngnb/status/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    const userId = req.user.id;

    if (!reference) {
      return res.status(400).json({ success: false, error: 'Reference is required' });
    }

    const transaction = await Transaction.findOne({
      reference,
      userId,
      type: 'WITHDRAWAL',
      currency: 'NGNB'
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        error: 'Withdrawal transaction not found'
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        reference: transaction.reference,
        status: transaction.status,
        amount: Math.abs(transaction.amount),
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
        completedAt: transaction.completedAt,
        failedAt: transaction.failedAt,
        failureReason: transaction.failureReason,
        metadata: transaction.metadata
      }
    });
  } catch (error) {
    logger.error('Error checking withdrawal status:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve withdrawal status'
    });
  }
});

/**
 * @route   GET /withdrawal/ngnb/banks
 * @desc    Get list of supported Nigerian banks
 * @access  Authenticated
 */
router.get('/withdrawal/ngnb/banks', async (req, res) => {
  try {
    const banks = Object.entries(NIGERIAN_BANK_CODES).map(([code, name]) => ({ code, name }));

    return res.status(200).json({
      success: true,
      data: { banks, total: banks.length }
    });
  } catch (error) {
    logger.error('Error fetching bank list:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve bank list'
    });
  }
});

/**
 * @route   GET /withdrawal/ngnb/fees
 * @desc    Get withdrawal fee info (mirror ZeusODX)
 */
router.get('/withdrawal/ngnb/fees', (req, res) => {
  return res.json({
    success: true,
    data: {
      withdrawalFee: NGNB_WITHDRAWAL_FEE_RECORDED,
      minimumWithdrawal: NGNB_WITHDRAWAL_FEE_OPERATIONAL + 1
    }
  });
});

module.exports = router;
