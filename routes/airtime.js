const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { payBetaAuth } = require('../auth/paybetaAuth');
const { validateUserBalance } = require('../services/balance');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { validateUtilityTransaction } = require('../services/kyccheckservice'); // <-- UPDATED
const { sendUtilityEmail } = require('../services/EmailService'); // <-- NEW: Import email service
const logger = require('../utils/logger');

const router = express.Router();

// Supported tokens - aligned with user schema (DOGE REMOVED)
const SUPPORTED_TOKENS = {
  BTC: { name: 'Bitcoin' },
  ETH: { name: 'Ethereum' },
  SOL: { name: 'Solana' },
  USDT: { name: 'Tether' },
  USDC: { name: 'USD Coin' },
  BNB: { name: 'Binance Coin' },
  MATIC: { name: 'Polygon' },
  AVAX: { name: 'Avalanche' },
  NGNB: { name: 'NGNB Token' }
};

// Token field mapping for balance operations
const TOKEN_FIELD_MAPPING = {
  BTC: 'btc',
  ETH: 'eth',
  SOL: 'sol',
  USDT: 'usdt',
  USDC: 'usdc',
  BNB: 'bnb',
  MATIC: 'matic',
  AVAX: 'avax',
  NGNB: 'ngnb'
};

async function reserveUserBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number' || amount <= 0) {
    throw new Error('Invalid parameters for balance reservation');
  }
  try {
    const currencyUpper = currency.toUpperCase();
    if (!SUPPORTED_TOKENS[currencyUpper]) throw new Error(`Unsupported currency: ${currencyUpper}`);
    const currencyLower = TOKEN_FIELD_MAPPING[currencyUpper];
    const pendingBalanceKey = `${currencyLower}PendingBalance`;

    const update = {
      $inc: { [pendingBalanceKey]: amount },
      $set: { lastBalanceUpdate: new Date() }
    };

    const user = await User.findByIdAndUpdate(userId, update, { new: true, runValidators: true });
    if (!user) throw new Error(`User not found: ${userId}`);
    logger.info(`Reserved ${amount} ${currencyUpper} for user ${userId}`);
    return user;
  } catch (error) {
    logger.error(`Failed to reserve balance for user ${userId}`, { currency, amount, error: error.message });
    throw error;
  }
}

async function releaseReservedBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number' || amount <= 0) {
    throw new Error('Invalid parameters for balance release');
  }
  try {
    const currencyUpper = currency.toUpperCase();
    if (!SUPPORTED_TOKENS[currencyUpper]) throw new Error(`Unsupported currency: ${currencyUpper}`);
    const currencyLower = TOKEN_FIELD_MAPPING[currencyUpper];
    const pendingBalanceKey = `${currencyLower}PendingBalance`;

    const update = {
      $inc: { [pendingBalanceKey]: -amount },
      $set: { lastBalanceUpdate: new Date() }
    };

    const user = await User.findByIdAndUpdate(userId, update, { new: true, runValidators: true });
    if (!user) throw new Error(`User not found: ${userId}`);
    logger.info(`Released ${amount} ${currencyUpper} for user ${userId}`);
    return user;
  } catch (error) {
    logger.error(`Failed to release reserved balance for user ${userId}`, { currency, amount, error: error.message });
    throw error;
  }
}

async function updateUserBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number') throw new Error('Invalid parameters for balance update');
  try {
    const currencyUpper = currency.toUpperCase();
    if (!SUPPORTED_TOKENS[currencyUpper]) throw new Error(`Unsupported currency: ${currencyUpper}`);
    const currencyLower = TOKEN_FIELD_MAPPING[currencyUpper];
    const balanceField = `${currencyLower}Balance`;

    const updateFields = {
      $inc: { [balanceField]: amount },
      $set: { lastBalanceUpdate: new Date() }
    };

    const user = await User.findByIdAndUpdate(userId, updateFields, { new: true, runValidators: true });
    if (!user) throw new Error(`User not found: ${userId}`);
    logger.info(`Updated balance for user ${userId}: ${amount > 0 ? '+' : ''}${amount} ${currencyUpper}`);
    return user;
  } catch (error) {
    logger.error(`Failed to update balance for user ${userId}`, { currency, amount, error: error.message });
    throw error;
  }
}

async function updateUserPortfolioBalance(userId) {
  if (!userId) throw new Error('User ID is required');
  try {
    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { portfolioLastUpdated: new Date() } },
      { new: true, runValidators: true }
    );
    if (!user) throw new Error(`User not found: ${userId}`);
    logger.info(`Updated portfolio timestamp for user ${userId}`);
    return user;
  } catch (error) {
    logger.error(`Failed to update portfolio for user ${userId}`, { error: error.message });
    throw error;
  }
}

async function comparePasswordPin(candidatePasswordPin, hashedPasswordPin) {
  if (!candidatePasswordPin || !hashedPasswordPin) return false;
  try {
    return await bcrypt.compare(candidatePasswordPin, hashedPasswordPin);
  } catch (error) {
    logger.error('Password pin comparison failed:', error);
    return false;
  }
}

function validatePhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return false;
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length < 11 || cleanPhone.length > 16) return false;
  if (cleanPhone.startsWith('234')) return cleanPhone.length >= 13 && cleanPhone.length <= 16;
  if (cleanPhone.startsWith('0')) return cleanPhone.length === 11;
  return cleanPhone.length >= 10 && cleanPhone.length <= 13;
}

function validateAirtimeRequest(body) {
  const errors = [];
  const sanitized = {};
  if (!body.phone) errors.push('Phone number is required');
  else {
    sanitized.phone = String(body.phone).trim();
    if (!validatePhoneNumber(sanitized.phone)) errors.push('Invalid phone number format');
  }
  if (!body.service_id) errors.push('Service ID is required');
  else {
    sanitized.service_id = String(body.service_id).toLowerCase().trim();
    if (!['mtn', 'airtel', 'glo', '9mobile'].includes(sanitized.service_id)) {
      errors.push('Invalid service ID. Must be: mtn, airtel, glo, or 9mobile');
    }
  }
  if (body.amount === undefined || body.amount === null || body.amount === '') errors.push('Amount is required');
  else {
    const rawAmount = Number(body.amount);
    if (!Number.isFinite(rawAmount)) errors.push('Amount must be a valid number');
    else {
      sanitized.amount = Math.abs(Math.round(rawAmount * 100) / 100);
      if (rawAmount < 0) errors.push('Amount cannot be negative');
      if (sanitized.amount <= 0) errors.push('Amount must be greater than zero');
      const minAmount = 100;
      const maxAmount = 50000;
      if (sanitized.amount < minAmount) errors.push(`Amount below minimum. Minimum airtime purchase is ${minAmount} NGNB`);
      if (sanitized.amount > maxAmount) errors.push(`Amount above maximum. Maximum airtime purchase is ${maxAmount} NGNB`);
    }
  }
  if (!body.twoFactorCode?.trim()) errors.push('Two-factor authentication code is required');
  else sanitized.twoFactorCode = String(body.twoFactorCode).trim();
  if (!body.passwordpin?.trim()) errors.push('Password PIN is required');
  else {
    sanitized.passwordpin = String(body.passwordpin).trim();
    if (!/^\d{6}$/.test(sanitized.passwordpin)) errors.push('Password PIN must be exactly 6 numbers');
  }
  sanitized.payment_currency = 'NGNB';
  return { isValid: errors.length === 0, errors, sanitized };
}

const AIRTIME_SERVICE_MAP = { mtn: 'mtn_vtu', airtel: 'airtel_vtu', glo: 'glo_vtu', '9mobile': '9mobile_vtu' };

// PayBeta responds synchronously — 'successful' means the airtime has actually been
// delivered, there is no pending/processing intermediate state to reconcile via webhook
// (unlike eBills' completed-api/initiated-api/processing-api three-state model).
async function callPayBetaAPI({ phone, amount, service_id, request_id, userId }) {
  try {
    const payBetaService = AIRTIME_SERVICE_MAP[service_id];
    if (!payBetaService) throw new Error(`Unsupported service: ${service_id}`);

    const reference = request_id.length > 40 ? request_id.substring(0, 40) : request_id;
    const payload = { service: payBetaService, phoneNumber: phone, amount: Math.round(amount), reference };

    logger.info('Making PayBeta airtime purchase request:', { phone, amount, service_id, payBetaService, request_id, endpoint: '/v2/airtime/purchase' });
    const response = await payBetaAuth.makeRequest('POST', '/v2/airtime/purchase', payload, { timeout: 45000 });
    logger.info(`PayBeta API response for ${request_id}:`, { status: response.status, message: response.message, reference: response.data?.reference, transactionId: response.data?.transactionId });

    if (response.status !== 'successful') throw new Error(`Airtime service error: ${response.message || 'Unknown error'}`);

    return {
      code: 'success',
      data: {
        status: 'completed-api',
        order_id: response.data.transactionId,
        phone: response.data.customerId || phone,
        amount: response.data.amount,
        amount_charged: response.data.chargedAmount,
        product_name: response.data.biller || 'Airtime',
        service_name: response.data.biller,
        initial_balance: response.data.previousBalance,
        final_balance: response.data.currentBalance
      }
    };
  } catch (error) {
    logger.error('❌ PayBeta airtime purchase failed:', { request_id, userId, error: error.message, status: error.response?.status, payBetaError: error.response?.data });
    throw new Error(`Airtime service error: ${error.message}`);
  }
}

// NEW: Helper function to send airtime purchase email
async function sendAirtimePurchaseEmail(user, transactionDetails) {
  try {
    if (!user.email) {
      logger.warn('Cannot send airtime email: User email not found', { userId: user._id });
      return;
    }

    const userName = user.firstName || user.name || user.username || 'User';
    const utilityType = `${transactionDetails.network} Airtime`;
    const reference = transactionDetails.order_id || transactionDetails.request_id;

    await sendUtilityEmail(
      user.email,
      userName,
      utilityType,
      `${transactionDetails.amount} NGNB`,
      reference
    );

    logger.info('✅ Airtime purchase email sent successfully', {
      userId: user._id,
      email: user.email,
      reference: reference
    });
  } catch (emailError) {
    logger.error('❌ Failed to send airtime purchase email:', {
      userId: user._id,
      error: emailError.message,
      email: user.email
    });
    // Don't throw the error - email failure shouldn't break the transaction
  }
}

router.post('/purchase', async (req, res) => {
  const startTime = Date.now();
  let balanceActionTaken = false;
  let balanceActionType = null;
  let transactionCreated = false;
  let pendingTransaction = null;
  let payBetaResponse = null;

  try {
    const requestBody = req.body;
    const userId = req.user.id;
    logger.info(`📱 Airtime purchase request from user ${userId}:`, { ...requestBody, passwordpin: '[REDACTED]' });

    const validation = validateAirtimeRequest(requestBody);
    if (!validation.isValid) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: validation.errors });
    }

    const { phone, service_id, amount, twoFactorCode, passwordpin } = validation.sanitized;
    const currency = 'NGNB';

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.twoFASecret || !user.is2FAEnabled) return res.status(400).json({ success: false, message: 'Two-factor authentication is not set up or not enabled. Please enable 2FA first.' });

    if (!validateTwoFactorAuth(user, twoFactorCode)) {
      logger.warn('🚫 2FA validation failed for airtime purchase', { userId, errorType: 'INVALID_2FA' });
      return res.status(403).json({ success: false, error: 'INVALID_2FA_CODE', message: 'Invalid two-factor authentication code' });
    }

    logger.info('✅ 2FA validation successful for airtime purchase', { userId });

    if (!user.passwordpin) return res.status(400).json({ success: false, message: 'Password PIN is not set up for your account. Please set up your password PIN first.' });

    const isPasswordPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPasswordPinValid) {
      logger.warn('🚫 Password PIN validation failed for airtime purchase', { userId, errorType: 'INVALID_PASSWORDPIN' });
      return res.status(401).json({ success: false, error: 'INVALID_PASSWORDPIN', message: 'Invalid password PIN' });
    }

    logger.info('✅ Password PIN validation successful for airtime purchase', { userId });

    // KYC Validation using Utility function
    const kycValidation = await validateUtilityTransaction(userId, amount);
    if (!kycValidation.allowed) {
      return res.status(403).json({
        success: false,
        error: 'KYC_LIMIT_EXCEEDED',
        message: kycValidation.message,
        kycDetails: {
          kycLevel: kycValidation.data?.kycLevel,
          limitType: kycValidation.data?.limitType,
          requestedAmount: kycValidation.data?.requestedAmount,
          availableAmount: kycValidation.data?.availableAmount
        }
      });
    }

    const existingPending = await BillTransaction.getUserPendingTransactions(userId, 'airtime', 5);
    if (existingPending.length > 0) {
      return res.status(409).json({ success: false, error: 'PENDING_TRANSACTION_EXISTS', message: 'You already have a pending airtime purchase. Please wait for it to complete.' });
    }

    const timestamp = Date.now();
    const randomSuffix = Math.random().toString(36).substring(2, 8);
    const finalRequestId = `${userId}_${timestamp}_${randomSuffix}`;
    const uniqueOrderId = `pending_${userId}_${timestamp}`;

    const balanceValidation = await validateUserBalance(userId, currency, amount, { includeBalanceDetails: true, logValidation: true });
    if (!balanceValidation.success) {
      return res.status(400).json({
        success: false,
        error: 'INSUFFICIENT_BALANCE',
        message: balanceValidation.message,
        details: {
          availableBalance: balanceValidation.availableBalance,
          requiredAmount: amount,
          currency: currency
        }
      });
    }

    const initialTransactionData = {
      orderId: uniqueOrderId,
      status: 'initiated-api',
      productName: 'Airtime',
      billType: 'airtime',
      quantity: 1,
      amount: amount,
      amountNaira: amount,
      paymentCurrency: currency,
      requestId: finalRequestId,
      metaData: {
        phone,
        network: service_id.toUpperCase(),
        service_id,
        user_id: userId,
        payment_currency: currency,
        ngnb_amount: amount,
        exchange_rate: 1,
        twofa_validated: true,
        passwordpin_validated: true,
        kyc_validated: true
      },
      network: service_id.toUpperCase(),
      customerPhone: phone,
      userId: userId,
      timestamp: new Date(),
      balanceReserved: false,
      twoFactorValidated: true,
      passwordPinValidated: true,
      kycValidated: true
    };

    pendingTransaction = await BillTransaction.create(initialTransactionData);
    transactionCreated = true;

    logger.info(`📋 Bill transaction ${uniqueOrderId}: initiated-api | airtime | ${amount} NGNB | ✅ 2FA | ✅ PIN | ✅ KYC | ⚠️ Balance Pending`);

    try {
      payBetaResponse = await callPayBetaAPI({ phone, amount, service_id, request_id: finalRequestId, userId });
    } catch (apiError) {
      await BillTransaction.findByIdAndUpdate(pendingTransaction._id, {
        status: 'failed',
        processingErrors: [{
          error: apiError.message,
          timestamp: new Date(),
          phase: 'api_call'
        }]
      });

      return res.status(500).json({ success: false, error: 'PAYBETA_API_ERROR', message: apiError.message });
    }

    const providerStatus = payBetaResponse.data.status;

    if (providerStatus === 'completed-api') {
      logger.info(`✅ Transaction completed immediately, updating balance directly for ${finalRequestId}`);
      try {
        await updateUserBalance(userId, currency, -amount);
        await updateUserPortfolioBalance(userId);
        balanceActionTaken = true;
        balanceActionType = 'updated';
        logger.info(`✅ Balance updated directly: -${amount} ${currency} for user ${userId}`);
      } catch (balanceError) {
        logger.error('CRITICAL: Balance update failed for completed transaction:', {
          request_id: finalRequestId,
          userId,
          currency,
          amount,
          error: balanceError.message,
          paybeta_order_id: payBetaResponse.data?.order_id
        });

        await BillTransaction.findByIdAndUpdate(pendingTransaction._id, {
          status: 'failed',
          processingErrors: [{
            error: `Balance update failed for completed transaction: ${balanceError.message}`,
            timestamp: new Date(),
            phase: 'balance_update',
            paybeta_order_id: payBetaResponse.data?.order_id
          }]
        });

        return res.status(500).json({
          success: false,
          error: 'BALANCE_UPDATE_FAILED',
          message: 'PayBeta transaction succeeded but balance update failed. Please contact support immediately.',
          details: {
            paybeta_order_id: payBetaResponse.data?.order_id,
            paybeta_status: payBetaResponse.data?.status,
            amount: amount,
            phone: phone
          }
        });
      }
    } else if (['initiated-api', 'processing-api'].includes(providerStatus)) {
      logger.info(`⏳ Transaction pending (${providerStatus}), reserving balance for ${finalRequestId}`);
      try {
        await reserveUserBalance(userId, currency, amount);
        await pendingTransaction.markBalanceReserved();
        balanceActionTaken = true;
        balanceActionType = 'reserved';
        logger.info(`✅ Balance reserved: ${amount} ${currency} for user ${userId}`);
      } catch (balanceError) {
        logger.error('CRITICAL: Balance reservation failed after successful PayBeta API call:', {
          request_id: finalRequestId,
          userId,
          currency,
          amount,
          error: balanceError.message,
          paybeta_order_id: payBetaResponse.data?.order_id
        });

        await BillTransaction.findByIdAndUpdate(pendingTransaction._id, {
          status: 'failed',
          processingErrors: [{
            error: `Balance reservation failed after PayBeta success: ${balanceError.message}`,
            timestamp: new Date(),
            phase: 'balance_reservation',
            paybeta_order_id: payBetaResponse.data?.order_id
          }]
        });

        return res.status(500).json({
          success: false,
          error: 'BALANCE_RESERVATION_FAILED',
          message: 'PayBeta transaction succeeded but balance reservation failed. Please contact support immediately.',
          details: {
            paybeta_order_id: payBetaResponse.data?.order_id,
            paybeta_status: payBetaResponse.data?.status,
            amount: amount,
            phone: phone
          }
        });
      }
    } else {
      logger.warn(`Unexpected PayBeta status: ${providerStatus} for ${finalRequestId}`);
    }

    const updateData = {
      orderId: payBetaResponse.data.order_id.toString(),
      status: payBetaResponse.data.status,
      productName: payBetaResponse.data.product_name,
      metaData: {
        ...initialTransactionData.metaData,
        service_name: payBetaResponse.data.service_name,
        amount_charged: payBetaResponse.data.amount_charged,
        balance_action_taken: balanceActionTaken,
        balance_action_type: balanceActionType,
        balance_action_at: new Date(),
        paybeta_initial_balance: payBetaResponse.data.initial_balance,
        paybeta_final_balance: payBetaResponse.data.final_balance
      }
    };

    if (balanceActionType === 'reserved') updateData.balanceReserved = true;
    else if (balanceActionType === 'updated') {
      updateData.balanceReserved = false;
      updateData.balanceCompleted = true;
    }

    const finalTransaction = await BillTransaction.findByIdAndUpdate(pendingTransaction._id, updateData, { new: true });
    logger.info(`📋 Transaction updated: ${payBetaResponse.data.order_id} | ${payBetaResponse.data.status} | Balance: ${balanceActionType || 'none'}`);

    // NEW: Send email notification for completed transactions
    if (payBetaResponse.data.status === 'completed-api') {
      // Send email notification asynchronously
      const emailTransactionDetails = {
        amount: payBetaResponse.data.amount,
        phone: payBetaResponse.data.phone,
        network: service_id.toUpperCase(),
        order_id: payBetaResponse.data.order_id,
        request_id: finalRequestId
      };
      
      // Don't await this to prevent email failures from affecting the response
      sendAirtimePurchaseEmail(user, emailTransactionDetails).catch(err => {
        logger.error('Email sending failed but transaction completed:', err);
      });

      return res.status(200).json({
        success: true,
        message: 'Airtime purchase completed successfully',
        data: {
          order_id: payBetaResponse.data.order_id,
          status: payBetaResponse.data.status,
          phone: payBetaResponse.data.phone,
          amount: payBetaResponse.data.amount,
          service_name: payBetaResponse.data.service_name,
          request_id: finalRequestId,
          balance_action: 'updated_directly'
        }
      });
    } else if (['initiated-api', 'processing-api'].includes(payBetaResponse.data.status)) {
      return res.status(202).json({
        success: true,
        message: 'Airtime purchase is being processed',
        data: {
          order_id: payBetaResponse.data.order_id,
          status: payBetaResponse.data.status,
          phone: payBetaResponse.data.phone,
          amount: payBetaResponse.data.amount,
          service_name: payBetaResponse.data.service_name,
          request_id: finalRequestId,
          balance_action: 'reserved'
        },
        note: 'You will receive a notification when the transaction is completed'
      });
    } else {
      return res.status(200).json({
        success: true,
        message: `Airtime purchase status: ${payBetaResponse.data.status}`,
        data: { ...payBetaResponse.data, request_id: finalRequestId, balance_action: balanceActionType || 'none' }
      });
    }
  } catch (error) {
    logger.error('Airtime purchase unexpected error:', { userId: req.user?.id, error: error.message, processingTime: Date.now() - startTime });
    if (balanceActionTaken && balanceActionType === 'reserved') {
      try {
        await releaseReservedBalance(req.user.id, 'NGNB', validation?.sanitized?.amount || 0);
        logger.info('🔄 Released reserved NGNB balance due to error');
      } catch (releaseError) {
        logger.error('❌ Failed to release reserved NGNB balance after error:', releaseError.message);
      }
    } else if (balanceActionTaken && balanceActionType === 'updated') {
      logger.error('❌ CRITICAL: Direct balance update completed but transaction failed. Manual intervention required.');
    }

    if (transactionCreated && pendingTransaction) {
      try {
        await BillTransaction.findByIdAndUpdate(pendingTransaction._id, {
          status: 'failed',
          processingErrors: [{
            error: error.message,
            timestamp: new Date(),
            phase: 'unexpected_error'
          }]
        });
      } catch (updateError) {
        logger.error('Failed to update transaction status:', updateError);
      }
    }

    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred while processing your airtime purchase' });
  }
});

module.exports = router;