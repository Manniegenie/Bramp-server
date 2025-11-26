const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { vtuAuth } = require('../auth/billauth');
const { validateUserBalance } = require('../services/balance');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { validateUtilityTransaction } = require('../services/kyccheckservice'); // <-- UPDATED
const logger = require('../utils/logger');
const crypto = require('crypto');

const router = express.Router();
const EBILLS_BASE_URL = process.env.EBILLS_BASE_URL || 'https://ebills.africa/wp-json';

// Cable TV services
const CABLE_TV_SERVICES = ['dstv', 'gotv', 'startimes', 'showmax'];
const VALID_SUBSCRIPTION_TYPES = ['change', 'renew'];

// Tokens
const SUPPORTED_TOKENS = { BTC: {}, ETH: {}, SOL: {}, USDT: {}, USDC: {}, BNB: {}, MATIC: {}, AVAX: {}, NGNB: {} };
const TOKEN_FIELD_MAPPING = { BTC: 'btc', ETH: 'eth', SOL: 'sol', USDT: 'usdt', USDC: 'usdc', BNB: 'bnb', MATIC: 'matic', AVAX: 'avax', NGNB: 'ngnb' };

// --- Helper Functions ---
async function reserveUserBalance(userId, currency, amount) {
  const currencyUpper = currency.toUpperCase();
  const pendingBalanceKey = `${TOKEN_FIELD_MAPPING[currencyUpper]}PendingBalance`;
  const user = await User.findByIdAndUpdate(userId, { $inc: { [pendingBalanceKey]: amount }, $set: { lastBalanceUpdate: new Date() } }, { new: true, runValidators: true });
  if (!user) throw new Error(`User not found: ${userId}`);
  return user;
}
async function releaseReservedBalance(userId, currency, amount) {
  const currencyUpper = currency.toUpperCase();
  const pendingBalanceKey = `${TOKEN_FIELD_MAPPING[currencyUpper]}PendingBalance`;
  return await User.findByIdAndUpdate(userId, { $inc: { [pendingBalanceKey]: -amount }, $set: { lastBalanceUpdate: new Date() } }, { new: true, runValidators: true });
}
async function updateUserBalance(userId, currency, amount) {
  const currencyUpper = currency.toUpperCase();
  const balanceField = `${TOKEN_FIELD_MAPPING[currencyUpper]}Balance`;
  return await User.findByIdAndUpdate(userId, { $inc: { [balanceField]: amount }, $set: { lastBalanceUpdate: new Date() } }, { new: true, runValidators: true });
}
async function updateUserPortfolioBalance(userId) {
  return await User.findByIdAndUpdate(userId, { $set: { portfolioLastUpdated: new Date() } }, { new: true, runValidators: true });
}
async function comparePasswordPin(candidatePasswordPin, hashedPasswordPin) { return await bcrypt.compare(candidatePasswordPin, hashedPasswordPin); }
function generateUniqueOrderId() { return `cabletv_order_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }
function generateUniqueRequestId(userId) { return `cabletv_req_${userId}_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`; }
async function checkForPendingTransactions(userId, customOrderId, customRequestId) {
  const pendingTransactions = await BillTransaction.find({
    $or: [
      { userId: userId, billType: 'cable_tv', status: { $in: ['initiated-api', 'processing-api', 'pending'] } },
      { orderId: customOrderId },
      { requestId: customRequestId }
    ],
    createdAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) }
  });
  return pendingTransactions.length > 0;
}

// Get package price
async function getPackagePrice(service_id, variation_id) {
  const variationsResponse = await vtuAuth.makeRequest('GET', `/api/v2/variations/tv/${service_id}`, null, { timeout: 15000, baseURL: EBILLS_BASE_URL });
  if (variationsResponse.code !== 'success') throw new Error('Failed to fetch package variations');
  const selectedPackage = variationsResponse.data.find(pkg => pkg.variation_id === variation_id);
  if (!selectedPackage) throw new Error(`Package with variation_id ${variation_id} not found`);
  return { price: parseFloat(selectedPackage.price), name: selectedPackage.name };
}

// Verify customer
async function validateCustomerAndGetAmount(customer_id, service_id, variation_id, subscription_type) {
  const payload = { customer_id: customer_id.trim(), service_id };
  if (variation_id) payload.variation_id = variation_id;
  const verificationResponse = await vtuAuth.makeRequest('POST', '/api/v2/verify-customer', payload, { timeout: 15000, baseURL: EBILLS_BASE_URL });
  if (verificationResponse.code !== 'success') throw new Error(`Customer verification failed: ${verificationResponse.message}`);
  let expectedAmount = null; const customerInfo = verificationResponse.data;
  if (subscription_type === 'renew' && customerInfo.renewal_amount) expectedAmount = parseFloat(customerInfo.renewal_amount);
  else { const pkg = await getPackagePrice(service_id, variation_id); expectedAmount = pkg.price; customerInfo.package_info = pkg; }
  return { customerInfo, expectedAmount, isValid: true };
}

// Validate request
function validateCableTVRequest(body) {
  const errors = []; const sanitized = {};
  if (!body.customer_id) errors.push('Customer ID is required'); else sanitized.customer_id = String(body.customer_id).trim();
  if (!body.service_id) errors.push('Service ID is required'); else sanitized.service_id = String(body.service_id).toLowerCase().trim();
  if (!body.variation_id) errors.push('Variation ID is required'); else sanitized.variation_id = String(body.variation_id).trim();
  sanitized.subscription_type = body.subscription_type ? String(body.subscription_type).toLowerCase().trim() : 'change';
  if (!VALID_SUBSCRIPTION_TYPES.includes(sanitized.subscription_type)) errors.push('Subscription type must be "change" or "renew"');
  if (!body.amount) errors.push('Amount is required'); else sanitized.amount = Number(body.amount);
  sanitized.payment_currency = 'NGNB';
  if (!body.twoFactorCode?.trim()) errors.push('2FA code required'); else sanitized.twoFactorCode = String(body.twoFactorCode).trim();
  if (!body.passwordpin?.trim()) errors.push('Password PIN required'); else sanitized.passwordpin = String(body.passwordpin).trim();
  return { isValid: errors.length === 0, errors, sanitized };
}

// Validate amount
function validateAmountMatchesPackage(userAmount, expectedAmount) {
  if (!expectedAmount) return { isValid: false, error: 'PACKAGE_PRICE_NOT_FOUND', message: 'Package price not found' };
  if (Math.abs(userAmount - expectedAmount) > 0.01) return { isValid: false, error: 'AMOUNT_PACKAGE_MISMATCH', message: `Amount mismatch. Provided ₦${userAmount}, expected ₦${expectedAmount}` };
  return { isValid: true };
}
function validateNGNBLimits(amount) { if (amount < 500) return { isValid: false, error: 'NGNB_MINIMUM_NOT_MET', message: 'Minimum NGNB is 500' }; if (amount > 50000) return { isValid: false, error: 'NGNB_MAXIMUM_EXCEEDED', message: 'Maximum NGNB is 50,000' }; return { isValid: true }; }

// Call eBills API
async function callEBillsCableTVAPI({ customer_id, service_id, variation_id, subscription_type, amount, request_id }) {
  const payload = { request_id, customer_id: customer_id.trim(), service_id, variation_id, subscription_type, amount: parseInt(amount) };
  const response = await vtuAuth.makeRequest('POST', '/api/v2/tv', payload, { timeout: 45000, baseURL: EBILLS_BASE_URL });
  if (response.code !== 'success') throw new Error(`eBills Cable TV API error: ${response.message || 'Unknown error'}`);
  return response;
}

// --- Main Endpoint ---
router.post('/purchase', async (req, res) => {
  const startTime = Date.now();
  let balanceActionTaken = false, balanceActionType = null, transactionCreated = false, pendingTransaction = null, ebillsResponse = null;
  try {
    const userId = req.user.id;
    const validation = validateCableTVRequest(req.body);
    if (!validation.isValid) return res.status(400).json({ success: false, message: 'Validation failed', errors: validation.errors });
    const { customer_id, service_id, variation_id, subscription_type, amount, twoFactorCode, passwordpin } = validation.sanitized;
    const currency = 'NGNB';

    const uniqueOrderId = generateUniqueOrderId();
    const uniqueRequestId = generateUniqueRequestId(userId);
    if (await checkForPendingTransactions(userId, uniqueOrderId, uniqueRequestId)) return res.status(409).json({ success: false, error: 'DUPLICATE_OR_PENDING_TRANSACTION', message: 'Pending transaction exists' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!validateTwoFactorAuth(user, twoFactorCode)) return res.status(401).json({ success: false, error: 'INVALID_2FA_CODE', message: 'Invalid 2FA code' });
    if (!await comparePasswordPin(passwordpin, user.passwordpin)) return res.status(401).json({ success: false, error: 'INVALID_PASSWORDPIN', message: 'Invalid password PIN' });

    // KYC Validation (UPDATED)
    const kycValidation = await validateUtilityTransaction(userId, amount);
    if (!kycValidation.allowed) return res.status(403).json({ success: false, error: 'KYC_LIMIT_EXCEEDED', message: kycValidation.message, kycDetails: kycValidation.data });

    const customerValidation = await validateCustomerAndGetAmount(customer_id, service_id, variation_id, subscription_type);
    if (!customerValidation.isValid) return res.status(400).json({ success: false, error: 'CUSTOMER_VALIDATION_FAILED', message: customerValidation.error });

    const amountValidation = validateAmountMatchesPackage(amount, customerValidation.expectedAmount);
    if (!amountValidation.isValid) return res.status(400).json({ success: false, error: amountValidation.error, message: amountValidation.message });

    const ngnbAmount = customerValidation.expectedAmount;
    if (!validateNGNBLimits(ngnbAmount).isValid) return res.status(400).json({ success: false, message: 'Amount out of bounds' });

    const balanceValidation = await validateUserBalance(userId, currency, ngnbAmount);
    if (!balanceValidation.success) return res.status(400).json({ success: false, error: 'INSUFFICIENT_BALANCE', message: balanceValidation.message });

    // Create transaction
    const transactionData = { orderId: uniqueOrderId, status: 'initiated-api', productName: 'Cable TV', billType: 'cable_tv', amount: ngnbAmount, paymentCurrency: currency, requestId: uniqueRequestId, userId, metaData: { customer_id, service_id, variation_id, subscription_type } };
    pendingTransaction = await BillTransaction.create(transactionData); transactionCreated = true;

    // Call eBills
    ebillsResponse = await callEBillsCableTVAPI({ customer_id, service_id, variation_id, subscription_type, amount: ngnbAmount, request_id: uniqueRequestId });
    const ebillsStatus = ebillsResponse.data.status;

    if (ebillsStatus === 'completed-api') { await updateUserBalance(userId, currency, -ngnbAmount); await updateUserPortfolioBalance(userId); balanceActionTaken = true; balanceActionType = 'updated'; }
    else if (['initiated-api', 'processing-api'].includes(ebillsStatus)) { await reserveUserBalance(userId, currency, ngnbAmount); await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { balanceReserved: true }); balanceActionTaken = true; balanceActionType = 'reserved'; }

    const finalTransaction = await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { $set: { orderId: ebillsResponse.data.order_id.toString(), status: ebillsStatus } }, { new: true });
    return res.status(200).json({ success: true, message: `Cable TV purchase status: ${ebillsStatus}`, transaction: finalTransaction });

  } catch (error) {
    if (balanceActionTaken && balanceActionType === 'reserved') await releaseReservedBalance(req.user.id, 'NGNB', validation?.sanitized?.amount || 0);
    if (transactionCreated && pendingTransaction) await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { status: 'failed' });
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR', message: error.message });
  }
});

module.exports = router;
