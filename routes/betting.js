const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { payBetaAuth } = require('../auth/paybetaAuth');
const { validateUserBalance } = require('../services/balance');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { validateUtilityTransaction } = require('../services/kyccheckservice'); // <-- UPDATED
const logger = require('../utils/logger');
const crypto = require('crypto');

const router = express.Router();

// PayBeta's betting platform slugs are fetched dynamically (GET /providers below)
// rather than hardcoded — eBills' PascalCase list ('1xBet', 'BetLion', ...) doesn't
// match PayBeta's lowercase slugs 1:1 (e.g. no BetLion on PayBeta; LiveScoreBet is
// just "livescore"), so there's no safe static mapping between the two.

// Supported tokens - aligned with user schema
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

// --- Balance Helpers ---
async function reserveUserBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number' || amount <= 0)
    throw new Error('Invalid parameters for balance reservation');
  const currencyUpper = currency.toUpperCase();
  if (!SUPPORTED_TOKENS[currencyUpper]) throw new Error(`Unsupported currency: ${currencyUpper}`);
  const currencyLower = TOKEN_FIELD_MAPPING[currencyUpper];
  const pendingBalanceKey = `${currencyLower}PendingBalance`;
  const user = await User.findByIdAndUpdate(userId, { $inc: { [pendingBalanceKey]: amount }, $set: { lastBalanceUpdate: new Date() } }, { new: true, runValidators: true });
  if (!user) throw new Error(`User not found: ${userId}`);
  logger.info(`Reserved ${amount} ${currencyUpper} for user ${userId}`);
  return user;
}

async function releaseReservedBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number' || amount <= 0)
    throw new Error('Invalid parameters for balance release');
  const currencyUpper = currency.toUpperCase();
  if (!SUPPORTED_TOKENS[currencyUpper]) throw new Error(`Unsupported currency: ${currencyUpper}`);
  const currencyLower = TOKEN_FIELD_MAPPING[currencyUpper];
  const pendingBalanceKey = `${currencyLower}PendingBalance`;
  const user = await User.findByIdAndUpdate(userId, { $inc: { [pendingBalanceKey]: -amount }, $set: { lastBalanceUpdate: new Date() } }, { new: true, runValidators: true });
  if (!user) throw new Error(`User not found: ${userId}`);
  logger.info(`Released ${amount} ${currencyUpper} for user ${userId}`);
  return user;
}

async function updateUserBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number') throw new Error('Invalid parameters for balance update');
  const currencyUpper = currency.toUpperCase();
  if (!SUPPORTED_TOKENS[currencyUpper]) throw new Error(`Unsupported currency: ${currencyUpper}`);
  const currencyLower = TOKEN_FIELD_MAPPING[currencyUpper];
  const balanceField = `${currencyLower}Balance`;
  const user = await User.findByIdAndUpdate(userId, { $inc: { [balanceField]: amount }, $set: { lastBalanceUpdate: new Date() } }, { new: true, runValidators: true });
  if (!user) throw new Error(`User not found: ${userId}`);
  logger.info(`Updated balance for user ${userId}: ${amount > 0 ? '+' : ''}${amount} ${currencyUpper}`);
  return user;
}

async function updateUserPortfolioBalance(userId) {
  if (!userId) throw new Error('User ID is required');
  const user = await User.findByIdAndUpdate(userId, { $set: { portfolioLastUpdated: new Date() } }, { new: true, runValidators: true });
  if (!user) throw new Error(`User not found: ${userId}`);
  logger.info(`Updated portfolio timestamp for user ${userId}`);
  return user;
}

async function comparePasswordPin(candidatePasswordPin, hashedPasswordPin) {
  if (!candidatePasswordPin || !hashedPasswordPin) return false;
  try { return await bcrypt.compare(candidatePasswordPin, hashedPasswordPin); }
  catch (error) { logger.error('Password pin comparison failed:', error); return false; }
}

// Generate unique IDs
function generateUniqueBettingOrderId() {
  return `betting_order_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}
function generateUniqueBettingRequestId(userId) {
  return `betting_req_${userId}_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
}

async function checkForPendingBettingTransactions(userId, customOrderId, customRequestId) {
  const pendingTransactions = await BillTransaction.find({
    $or: [
      { userId: userId, billType: 'betting', status: { $in: ['initiated-api', 'processing-api', 'pending'] } },
      { orderId: customOrderId },
      { requestId: customRequestId }
    ],
    createdAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) }
  });
  return pendingTransactions.length > 0;
}

// Validate betting request
function validateBettingRequest(body) {
  const errors = [];
  const sanitized = {};
  if (!body.customer_id) errors.push('Customer ID (betting account ID) is required');
  else sanitized.customer_id = String(body.customer_id).trim();

  if (!body.service_id) errors.push('Service ID is required');
  else sanitized.service_id = String(body.service_id).toLowerCase().trim();

  if (!body.amount) errors.push('Amount is required');
  else {
    const numericAmount = Number(body.amount);
    if (isNaN(numericAmount) || numericAmount <= 0) errors.push('Amount must be a positive number');
    else if (numericAmount > 100000) errors.push('Amount above maximum. Maximum is ₦100,000');
    else if (numericAmount < 1000) errors.push('Amount below minimum. Minimum is ₦1,000');
    else sanitized.amount = numericAmount;
  }

  sanitized.payment_currency = 'NGNB';
  if (!body.twoFactorCode?.trim()) errors.push('Two-factor authentication code is required');
  else sanitized.twoFactorCode = String(body.twoFactorCode).trim();

  if (!body.passwordpin?.trim()) errors.push('Password PIN is required');
  else {
    sanitized.passwordpin = String(body.passwordpin).trim();
    if (!/^\d{6}$/.test(sanitized.passwordpin)) errors.push('Password PIN must be exactly 6 numbers');
  }

  return { isValid: errors.length === 0, errors, sanitized };
}

// NGNB limits
function validateNGNBLimits(amount) {
  const MIN_NGNB = 1000;
  const MAX_NGNB = 100000;
  if (amount < MIN_NGNB) return { isValid: false, error: 'NGNB_MINIMUM_NOT_MET', message: `Minimum NGNB betting funding amount is ${MIN_NGNB} NGNB.` };
  if (amount > MAX_NGNB) return { isValid: false, error: 'NGNB_MAXIMUM_EXCEEDED', message: `Maximum NGNB betting funding amount is ${MAX_NGNB} NGNB.` };
  return { isValid: true };
}

/**
 * GET /providers — betting platforms available on PayBeta (dynamic, not hardcoded).
 */
router.get('/providers', async (req, res) => {
  try {
    const response = await payBetaAuth.makeRequest('GET', '/v2/gaming/providers');
    if (response.status !== 'successful') throw new Error(response.message || 'Failed to fetch providers');

    const providers = (response.data || []).map(p => ({
      id: p.slug || String(p.name || '').toLowerCase(),
      name: p.name,
    }));

    return res.status(200).json({ success: true, data: { providers } });
  } catch (error) {
    logger.error('Failed to fetch betting providers', { error: error.message });
    return res.status(503).json({ success: false, message: 'Betting providers are temporarily unavailable. Please try again later.' });
  }
});

// PayBeta responds synchronously — see the note in routes/airtime.js.
async function callPayBetaBettingAPI({ customer_id, service_id, amount, request_id, userId, customer_name }) {
  try {
    const reference = request_id.length > 40 ? request_id.substring(0, 40) : request_id;
    const payload = { service: service_id, customerId: customer_id.trim(), amount: Math.round(amount), customerName: customer_name || 'CUSTOMER', reference };
    const response = await payBetaAuth.makeRequest('POST', '/v2/gaming/purchase', payload, { timeout: 45000 });
    if (response.status !== 'successful') throw new Error(`Betting service error: ${response.message || 'Unknown error'}`);

    return {
      code: 'success',
      data: {
        status: 'completed-api',
        order_id: response.data.transactionId,
        product_name: response.data.biller || 'Betting',
        service_name: response.data.biller,
        amount_charged: response.data.chargedAmount
      }
    };
  } catch (error) {
    logger.error('❌ PayBeta betting funding failed:', { request_id, userId, error: error.message, status: error.response?.status, payBetaError: error.response?.data });
    throw new Error(`Betting service error: ${error.message}`);
  }
}

// --- Main Endpoint ---
// Frontend calls POST /betting/fund (bettingService.js) — the previous /purchase
// naming mismatch in this session's earlier utility port meant this was 404ing.
router.post('/fund', async (req, res) => {
  const startTime = Date.now();
  let balanceActionTaken = false;
  let balanceActionType = null;
  let transactionCreated = false;
  let pendingTransaction = null;
  let payBetaResponse = null;

  try {
    const requestBody = req.body;
    const userId = req.user.id;
    logger.info(`🎰 Betting funding request from user ${userId}:`, { ...requestBody, passwordpin: '[REDACTED]' });

    // Step 1: Validate request
    const validation = validateBettingRequest(requestBody);
    if (!validation.isValid) return res.status(400).json({ success: false, message: 'Validation failed', errors: validation.errors });

    const { customer_id, service_id, amount, twoFactorCode, passwordpin } = validation.sanitized;
    const currency = 'NGNB';

    // Step 2: Generate IDs
    const uniqueOrderId = generateUniqueBettingOrderId();
    const uniqueRequestId = generateUniqueBettingRequestId(userId);

    // Step 3: Check pending transactions
    const hasPending = await checkForPendingBettingTransactions(userId, uniqueOrderId, uniqueRequestId);
    if (hasPending) return res.status(409).json({ success: false, error: 'DUPLICATE_OR_PENDING_TRANSACTION', message: 'You have a pending betting transaction. Please wait.' });

    // Step 4: Validate user + 2FA
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.twoFASecret || !user.is2FAEnabled) return res.status(400).json({ success: false, message: '2FA is not enabled. Please enable 2FA.' });
    if (!validateTwoFactorAuth(user, twoFactorCode)) return res.status(403).json({ success: false, error: 'INVALID_2FA_CODE', message: 'Invalid 2FA code' });

    // Step 5: Validate PIN
    if (!user.passwordpin) return res.status(400).json({ success: false, message: 'Password PIN not set. Please set it first.' });
    const isPinValid = await comparePasswordPin(passwordpin, user.passwordpin);
    if (!isPinValid) return res.status(401).json({ success: false, error: 'INVALID_PASSWORDPIN', message: 'Invalid password PIN' });

    // Step 6: KYC validation (UPDATED)
    const kycValidation = await validateUtilityTransaction(userId, amount);
    if (!kycValidation.allowed) {
      return res.status(403).json({
        success: false,
        error: 'KYC_LIMIT_EXCEEDED',
        message: kycValidation.message,
        kycDetails: kycValidation.data
      });
    }

    // Step 7: Validate NGNB limits
    const ngnbLimitValidation = validateNGNBLimits(amount);
    if (!ngnbLimitValidation.isValid) {
      return res.status(400).json({ success: false, error: ngnbLimitValidation.error, message: ngnbLimitValidation.message });
    }

    // Step 8: Validate balance
    const balanceValidation = await validateUserBalance(userId, currency, amount, { includeBalanceDetails: true, logValidation: true });
    if (!balanceValidation.success) return res.status(400).json({ success: false, error: 'INSUFFICIENT_BALANCE', message: balanceValidation.message });

    // Step 9: Create transaction record
    const initialTransactionData = {
      orderId: uniqueOrderId,
      status: 'initiated-api',
      productName: 'Betting',
      billType: 'betting',
      quantity: 1,
      amount: amount,
      amountNaira: amount,
      paymentCurrency: currency,
      requestId: uniqueRequestId,
      metaData: { customer_id, service_id, betting_provider: service_id, user_id: userId, payment_currency: currency, twofa_validated: true, passwordpin_validated: true, kyc_validated: true },
      network: service_id,
      customerPhone: customer_id,
      userId: userId,
      timestamp: new Date(),
      balanceReserved: false,
      twoFactorValidated: true,
      passwordPinValidated: true,
      kycValidated: true
    };
    pendingTransaction = await BillTransaction.create(initialTransactionData);
    transactionCreated = true;

    // Step 10: Call eBills API
    try {
      payBetaResponse = await callPayBetaBettingAPI({ customer_id, service_id, amount, request_id: uniqueRequestId, userId });
    } catch (apiError) {
      await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { status: 'failed', processingErrors: [{ error: apiError.message, timestamp: new Date(), phase: 'ebills_betting_api_call' }] });
      return res.status(500).json({ success: false, error: 'PAYBETA_BETTING_API_ERROR', message: apiError.message });
    }

    // Step 11: Handle balance reservation or direct update
    const providerStatus = payBetaResponse.data.status;
    if (providerStatus === 'completed-api') {
      await updateUserBalance(userId, currency, -amount);
      await updateUserPortfolioBalance(userId);
      balanceActionTaken = true;
      balanceActionType = 'updated';
    } else if (['initiated-api', 'processing-api'].includes(providerStatus)) {
      await reserveUserBalance(userId, currency, amount);
      await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { balanceReserved: true });
      balanceActionTaken = true;
      balanceActionType = 'reserved';
    }

    // Step 12: Update transaction with eBills data
    const updatedTransactionData = {
      orderId: payBetaResponse.data.order_id.toString(),
      status: payBetaResponse.data.status,
      productName: payBetaResponse.data.product_name,
      metaData: { ...initialTransactionData.metaData, service_name: payBetaResponse.data.service_name, amount_charged: payBetaResponse.data.amount_charged }
    };
    if (balanceActionType === 'reserved') updatedTransactionData.balanceReserved = true;
    else if (balanceActionType === 'updated') { updatedTransactionData.balanceReserved = false; updatedTransactionData.balanceCompleted = true; }
    const finalTransaction = await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { $set: updatedTransactionData }, { new: true });

    // Step 13: Respond to client
    return res.status(200).json({
      success: true,
      message: `Betting funding status: ${payBetaResponse.data.status}`,
      data: { order_id: payBetaResponse.data.order_id, status: payBetaResponse.data.status, amount },
      transaction: finalTransaction
    });

  } catch (error) {
    logger.error('Betting funding unexpected error:', { userId: req.user?.id, error: error.message });
    if (balanceActionTaken && balanceActionType === 'reserved') await releaseReservedBalance(req.user.id, 'NGNB', validation?.sanitized?.amount || 0);
    if (transactionCreated && pendingTransaction) await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { status: 'failed' });
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR', message: 'An error occurred while processing your betting funding' });
  }
});

module.exports = router;
