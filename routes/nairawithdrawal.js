const express = require('express');
const router = express.Router();
const axios = require('axios');
const bcrypt = require('bcryptjs'); // ADD: bcrypt for password pin comparison
const { v4: uuidv4 } = require('uuid');

// Import your services
const { validateUserBalance } = require('../services/balance');
const { 
  reserveUserBalance, 
  releaseReservedBalance
} = require('../services/portfolio');
const { validateTwoFactorAuth } = require('../services/twofactorAuth'); // ADD: 2FA validation
const { validateTransactionLimit } = require('../services/kyccheckservice'); // ADD: KYC service import

// Import models
const User = require('../models/user');
const Transaction = require('../models/transaction');
const logger = require('../utils/logger');

// Nigerian bank codes for validation
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

/**
 * ADD: Compare password pin with user's hashed password pin
 * @param {string} candidatePasswordPin - Plain text password pin to compare
 * @param {string} hashedPasswordPin - Hashed password pin from database
 * @returns {Promise<boolean>} - True if password pin matches
 */
async function comparePasswordPin(candidatePasswordPin, hashedPasswordPin) {
  if (!candidatePasswordPin || !hashedPasswordPin) {
    return false;
  }
  try {
    return await bcrypt.compare(candidatePasswordPin, hashedPasswordPin);
  } catch (error) {
    logger.error('Password pin comparison failed:', error);
    return false;
  }
}

/**
 * Validates Nigerian bank account number format
 */
function isValidAccountNumber(accountNumber) {
  return /^\d{10}$/.test(accountNumber);
}

/**
 * Validates Nigerian bank code
 */
function isValidBankCode(bankCode) {
  return NIGERIAN_BANK_CODES.hasOwnProperty(bankCode);
}

/**
 * UPDATED: Validate withdrawal request with 2FA and Password PIN
 */
function validateWithdrawalRequest(body) {
  const errors = [];
  const sanitized = {};
  
  // Validate amount
  if (!body.amount) {
    errors.push('Amount is required');
  } else {
    const numericAmount = Number(body.amount);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      errors.push('Amount must be a positive number');
    } else if (numericAmount < 1000) {
      errors.push('Minimum withdrawal amount is 1000 NGNB');
    } else if (numericAmount > 10000000) { // 10M NGNB max
      errors.push('Maximum withdrawal amount is 10,000,000 NGNB');
    } else {
      sanitized.amount = numericAmount;
    }
  }
  
  // Validate bank code
  if (!body.bank_code) {
    errors.push('Bank code is required');
  } else {
    sanitized.bank_code = String(body.bank_code).trim();
    if (!isValidBankCode(sanitized.bank_code)) {
      errors.push('Invalid bank code provided');
    }
  }
  
  // Validate account number
  if (!body.account_number) {
    errors.push('Account number is required');
  } else {
    sanitized.account_number = String(body.account_number).trim();
    if (!isValidAccountNumber(sanitized.account_number)) {
      errors.push('Account number must be exactly 10 digits');
    }
  }
  
  // Optional narration
  if (body.narration) {
    sanitized.narration = String(body.narration).trim().substring(0, 100); // Limit to 100 chars
  }
  
  // Validate 2FA code
  if (!body.twoFactorCode?.trim()) {
    errors.push('Two-factor authentication code is required');
  } else {
    sanitized.twoFactorCode = String(body.twoFactorCode).trim();
  }
  
  // ADD: Validate password pin
  if (!body.passwordpin?.trim()) {
    errors.push('Password PIN is required');
  } else {
    sanitized.passwordpin = String(body.passwordpin).trim();
    
    // Password PIN must be exactly 6 numeric digits
    if (!/^\d{6}$/.test(sanitized.passwordpin)) {
      errors.push('Password PIN must be exactly 6 numbers');
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    sanitized
  };
}

/**
 * Calls Glyde API to initiate bank transfer
 */
async function initiateGlydeTransfer(transferData) {
  try {
    const response = await axios.post(
      `${process.env.GLYDE_API_BASE_URL}/v1/transfer/initiate`,
      transferData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.GLYDE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    
    return {
      success: true,
      data: response.data,
      status: response.status
    };
  } catch (error) {
    logger.error('Glyde API call failed:', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    
    return {
      success: false,
      error: error.message,
      status: error.response?.status || 500,
      details: error.response?.data
    };
  }
}

/**
 * UPDATED: @route   POST /withdrawal/ngnb
 * @desc    Withdraw NGNB to Nigerian bank account via Glyde with BVN, 2FA, Password PIN, and KYC
 * @access  Authenticated users
 */
router.post('/withdrawal/ngnb', async (req, res) => {
  const userId = req.user.id;
  
  // Generate unique reference
  const reference = `NGNB_WD_${Date.now()}_${uuidv4().substring(0, 8)}`;
  
  try {
    logger.info(`NGNB withdrawal request from user ${userId}:`, {
      ...req.body,
      passwordpin: '[REDACTED]', // Don't log the actual password pin
      account_number: req.body.account_number ? req.body.account_number.substring(0, 6) + '****' : undefined
    });
    
    // Step 1: Validate request
    const validation = validateWithdrawalRequest(req.body);
    if (!validation.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors
      });
    }
    
    const { amount, bank_code, account_number, narration, twoFactorCode, passwordpin } = validation.sanitized;
    
    // Step 2: Validate user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // ADD: Step 2.1: Check BVN verification before allowing withdrawal
    if (!user.isBvnVerified()) {
      logger.warn('NGNB withdrawal blocked - BVN not verified', { 
        userId,
        reference,
        bvnStatus: user.bvnVerification?.status || 'not_verified'
      });
      
      return res.status(403).json({
        success: false,
        error: 'BVN_NOT_VERIFIED',
        message: 'Verify your BVN',
        details: {
          bvnRequired: true,
          currentStatus: user.bvnVerification?.status || 'not_verified',
          nextSteps: 'Please complete BVN verification before making withdrawals'
        }
      });
    }

    // Step 2.2: Validate 2FA
    if (!user.twoFASecret || !user.is2FAEnabled) {
      return res.status(400).json({
        success: false,
        message: 'Two-factor authentication is not set up or not enabled. Please enable 2FA first.'
      });
    }

    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      logger.warn('Invalid 2FA attempt for NGNB withdrawal', { userId });
      return res.status(401).json({
        success: false,
        message: 'Invalid two-factor authentication code'
      });
    }

    logger.info('2FA validation successful for NGNB withdrawal', { 
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
      userId,
      reference
    });

    // Step 2.3: Validate password pin
    if (!user.passwordpin) {
      return res.status(400).json({
        success: false,
        message: 'Password PIN is not set up for your account. Please set up your password PIN first.'
      });
    }

    const isPasswordPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPasswordPinValid) {
      logger.warn('Invalid password PIN attempt for NGNB withdrawal', { 
        userId,
        reference,
        timestamp: new Date().toISOString().slice(0, 19).replace('T', ' ')
      });
      return res.status(401).json({
        success: false,
        message: 'Invalid password PIN'
      });
    }

    logger.info('Password PIN validation successful for NGNB withdrawal', { 
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
      userId,
      reference
    });

    // ========================================
    // KYC VALIDATION - ENHANCED
    // ========================================
    logger.info('Validating KYC limits for NGNB withdrawal', { userId, amount, currency: 'NGNB' });
    
    // Check basic KYC level requirement
    if (user.kycLevel < 2) {
      return res.status(403).json({
        success: false,
        error: 'KYC_LEVEL_INSUFFICIENT',
        message: 'KYC Level 2 or higher required for withdrawals',
        kycDetails: {
          currentLevel: user.kycLevel,
          requiredLevel: 2,
          upgradeRecommendation: 'Please complete KYC Level 2 verification to enable withdrawals'
        }
      });
    }
    
    try {
      const kycValidation = await validateTransactionLimit(userId, amount, 'NGNB', 'WITHDRAWAL');
      
      if (!kycValidation.allowed) {
        logger.warn('NGNB withdrawal blocked by KYC limits', {
          userId,
          amount,
          currency: 'NGNB',
          bank_code,
          account_number: account_number.substring(0, 6) + '****',
          kycCode: kycValidation.code,
          kycMessage: kycValidation.message,
          kycData: kycValidation.data
        });

        // Return detailed KYC error response
        return res.status(403).json({
          success: false,
          error: 'KYC_LIMIT_EXCEEDED',
          message: kycValidation.message,
          code: kycValidation.code,
          kycDetails: {
            kycLevel: kycValidation.data?.kycLevel,
            limitType: kycValidation.data?.limitType,
            requestedAmount: kycValidation.data?.requestedAmount,
            currentLimit: kycValidation.data?.currentLimit,
            currentSpent: kycValidation.data?.currentSpent,
            availableAmount: kycValidation.data?.availableAmount,
            upgradeRecommendation: kycValidation.data?.upgradeRecommendation,
            amountInNaira: kycValidation.data?.amountInNaira,
            currency: kycValidation.data?.currency,
            transactionType: 'WITHDRAWAL'
          }
        });
      }

      // Log successful KYC validation with details
      logger.info('KYC validation passed for NGNB withdrawal', {
        userId,
        amount,
        currency: 'NGNB',
        bank_code,
        account_number: account_number.substring(0, 6) + '****',
        kycLevel: kycValidation.data?.kycLevel,
        dailyRemaining: kycValidation.data?.dailyRemaining,
        monthlyRemaining: kycValidation.data?.monthlyRemaining,
        amountInNaira: kycValidation.data?.amountInNaira
      });

    } catch (kycError) {
      logger.error('KYC validation failed with error for NGNB withdrawal', {
        userId,
        amount,
        currency: 'NGNB',
        bank_code,
        account_number: account_number.substring(0, 6) + '****',
        error: kycError.message,
        stack: kycError.stack
      });

      return res.status(500).json({
        success: false,
        error: 'KYC_VALIDATION_ERROR',
        message: 'Unable to validate transaction limits. Please try again or contact support.',
        code: 'KYC_VALIDATION_ERROR'
      });
    }
    // ========================================
    // END KYC VALIDATION
    // ========================================
    
    // Step 3: Validate user balance
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
    
    logger.info('NGNB withdrawal initiated with full security validation', {
      userId,
      amount,
      bank_code,
      account_number: account_number.substring(0, 6) + '****',
      reference,
      availableBalance: balanceValidation.availableBalance,
      bvn_verified: true,
      twofa_validated: true,
      passwordpin_validated: true,
      kyc_validated: true
    });
    
    // Step 4: Reserve the NGNB amount
    try {
      await reserveUserBalance(userId, 'NGNB', amount);
      logger.info(`✅ Reserved ${amount} NGNB for withdrawal`, { userId, reference });
    } catch (reserveError) {
      logger.error('❌ Failed to reserve balance:', reserveError);
      return res.status(500).json({
        success: false,
        error: 'BALANCE_RESERVATION_FAILED',
        message: 'Failed to reserve balance for withdrawal'
      });
    }
    
    // Step 5: NGNB is pegged 1:1 with Naira - simple conversion
    const nairaAmount = Math.floor(amount);
    
    // Step 6: Create pending transaction record
    const transaction = new Transaction({
      userId,
      type: 'WITHDRAWAL',
      currency: 'NGNB',
      amount: amount,
      nairaAmount: nairaAmount,
      status: 'PENDING',
      reference,
      metadata: {
        bank_code,
        bank_name: NIGERIAN_BANK_CODES[bank_code],
        account_number,
        narration: narration || `NGNB Withdrawal - ${amount} NGNB`,
        withdrawal_type: 'bank_transfer',
        provider: 'glyde',
        initiated_at: new Date(),
        bvn_verified: true,
        twofa_validated: true,
        passwordpin_validated: true,
        kyc_validated: true,
        kyc_level: user.kycLevel,
        security_validations: {
          bvn: true,
          twofa: true,
          passwordpin: true,
          kyc: true,
          balance_reserved: true
        }
      }
    });
    
    try {
      await transaction.save();
      logger.info('✅ Withdrawal transaction created', { 
        transactionId: transaction._id,
        reference,
        security_status: 'BVN + 2FA + PIN + KYC validated'
      });
    } catch (txError) {
      // Release reserved balance if transaction creation fails
      await releaseReservedBalance(userId, 'NGNB', amount);
      logger.error('❌ Failed to create transaction record:', txError);
      return res.status(500).json({
        success: false,
        error: 'TRANSACTION_CREATION_FAILED',
        message: 'Failed to create transaction record'
      });
    }
    
    // Step 7: Prepare Glyde API request
    const payoutRequest = {
      amount: nairaAmount,
      bank_code,
      account_number,
      reference,
      narration: narration || `NGNB Withdrawal - ${amount} NGNB`
    };
    
    // Step 8: Call Glyde API
    const payoutResult = await initiateGlydeTransfer(payoutRequest);
    
    if (!payoutResult.success) {
      // Update transaction status to failed
      transaction.status = 'FAILED';
      transaction.metadata.failure_reason = `Glyde API error: ${payoutResult.error}`;
      transaction.metadata.failed_at = new Date();
      await transaction.save();
      
      // Release reserved balance
      await releaseReservedBalance(userId, 'NGNB', amount);
      
      logger.error('❌ Glyde transfer failed', {
        reference,
        error: payoutResult.error,
        status: payoutResult.status
      });
      
      return res.status(502).json({
        success: false,
        error: 'GLYDE_API_ERROR',
        message: 'Failed to initiate Glyde bank transfer',
        details: payoutResult.details,
        reference
      });
    }
    
    // Step 9: Update transaction status to processing
    transaction.status = 'PROCESSING';
    transaction.metadata.glyde_api_response = payoutResult.data;
    transaction.metadata.processing_at = new Date();
    await transaction.save();
    
    logger.info('✅ NGNB withdrawal initiated successfully', {
      userId,
      amount,
      nairaAmount,
      reference,
      transactionId: transaction._id,
      security_validations: 'All passed (BVN + 2FA + PIN + KYC)',
      message: 'Withdrawal sent to Glyde - balance will be updated via webhook'
    });
    
    res.status(200).json({
      success: true,
      message: 'NGNB withdrawal initiated successfully',
      data: {
        reference,
        amount: amount,
        nairaAmount: nairaAmount,
        bank_name: NIGERIAN_BANK_CODES[bank_code],
        account_number: account_number.substring(0, 6) + '****',
        status: 'PROCESSING',
        transactionId: transaction._id,
        estimated_completion: '1-2 business days',
        security_info: {
          bvn_verified: true,
          twofa_validated: true,
          passwordpin_validated: true,
          kyc_validated: true,
          kyc_level: user.kycLevel
        }
      }
    });
    
  } catch (error) {
    // Release any reserved balance in case of unexpected error
    try {
      if (validation?.sanitized?.amount) {
        await releaseReservedBalance(userId, 'NGNB', validation.sanitized.amount);
        logger.info('🔄 Released reserved balance due to unexpected error', { 
          userId, 
          amount: validation.sanitized.amount 
        });
      }
    } catch (releaseError) {
      logger.error('❌ Failed to release reserved balance during error handling:', releaseError);
    }
    
    logger.error('❌ NGNB withdrawal endpoint error:', {
      userId,
      reference,
      error: error.message,
      stack: error.stack
    });
    
    res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error during withdrawal processing',
      reference
    });
  }
});

/**
 * @route   GET /withdrawal/ngnb/status/:reference
 * @desc    Check NGNB withdrawal status via Glyde
 * @access  Authenticated users
 */
router.get('/withdrawal/ngnb/status/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    const userId = req.user.id;
    
    if (!reference) {
      return res.status(400).json({
        success: false,
        error: 'Reference is required'
      });
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
    
    res.status(200).json({
      success: true,
      data: {
        reference: transaction.reference,
        status: transaction.status,
        amount: transaction.amount,
        nairaAmount: transaction.nairaAmount,
        bank_name: transaction.metadata.bank_name,
        account_number: transaction.metadata.account_number?.substring(0, 6) + '****',
        created_at: transaction.createdAt,
        updated_at: transaction.updatedAt,
        security_info: {
          bvn_verified: transaction.metadata.bvn_verified,
          twofa_validated: transaction.metadata.twofa_validated,
          passwordpin_validated: transaction.metadata.passwordpin_validated,
          kyc_validated: transaction.metadata.kyc_validated,
          kyc_level: transaction.metadata.kyc_level
        },
        metadata: {
          initiated_at: transaction.metadata.initiated_at,
          processing_at: transaction.metadata.processing_at,
          confirmed_at: transaction.metadata.confirmed_at,
          failed_at: transaction.metadata.failed_at,
          failure_reason: transaction.metadata.failure_reason
        }
      }
    });
    
  } catch (error) {
    logger.error('Error checking withdrawal status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve withdrawal status'
    });
  }
});

/**
 * @route   GET /withdrawal/ngnb/banks
 * @desc    Get list of supported Nigerian banks
 * @access  Authenticated users
 */
router.get('/withdrawal/ngnb/banks', async (req, res) => {
  try {
    const banks = Object.entries(NIGERIAN_BANK_CODES).map(([code, name]) => ({
      code,
      name
    }));
    
    res.status(200).json({
      success: true,
      data: {
        banks,
        total: banks.length
      }
    });
    
  } catch (error) {
    logger.error('Error fetching bank list:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to retrieve bank list'
    });
  }
});

module.exports = router;