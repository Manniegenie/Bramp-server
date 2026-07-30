const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { payBetaAuth } = require('../auth/paybetaAuth');
const { validateUserBalance } = require('../services/balance');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { validateUtilityTransaction } = require('../services/kyccheckservice'); // UPDATED
const logger = require('../utils/logger');
const crypto = require('crypto');

const router = express.Router();

// PayBeta's DISCO slugs are fetched dynamically (GET /providers below) rather than
// hardcoded — eBills' fixed 12-DISCO list doesn't necessarily match PayBeta's slugs,
// and there's no way to verify that mapping without hitting the live API.
const VALID_METER_TYPES = ['prepaid', 'postpaid'];
const TOKEN_FIELD_MAPPING = { BTC: 'btc', ETH: 'eth', SOL: 'sol', USDT: 'usdt', USDC: 'usdc', BNB: 'bnb', MATIC: 'matic', AVAX: 'avax', NGNB: 'ngnb' };

// --- Internal helpers ---
async function reserveUserBalance(userId, currency, amount) {
  const key = `${TOKEN_FIELD_MAPPING[currency.toUpperCase()]}PendingBalance`;
  return await User.findByIdAndUpdate(userId, { $inc: { [key]: amount }, $set: { lastBalanceUpdate: new Date() } }, { new: true });
}
async function releaseReservedBalance(userId, currency, amount) {
  const key = `${TOKEN_FIELD_MAPPING[currency.toUpperCase()]}PendingBalance`;
  return await User.findByIdAndUpdate(userId, { $inc: { [key]: -amount }, $set: { lastBalanceUpdate: new Date() } }, { new: true });
}
async function updateUserBalance(userId, currency, amount) {
  const key = `${TOKEN_FIELD_MAPPING[currency.toUpperCase()]}Balance`;
  return await User.findByIdAndUpdate(userId, { $inc: { [key]: amount }, $set: { lastBalanceUpdate: new Date() } }, { new: true });
}
async function updateUserPortfolioBalance(userId) {
  return await User.findByIdAndUpdate(userId, { $set: { portfolioLastUpdated: new Date() } }, { new: true });
}
async function comparePasswordPin(candidate, hashed) { return await bcrypt.compare(candidate, hashed); }
function generateUniqueOrderId() { return `electricity_order_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }
function generateUniqueRequestId(userId) { return `electricity_req_${userId}_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`; }
async function checkPending(userId, orderId, requestId) {
  return (await BillTransaction.find({ 
    $or: [{ userId, billType: 'electricity', status: { $in: ['initiated-api', 'processing-api'] } }, { orderId }, { requestId }],
    createdAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) }
  })).length > 0;
}

// Request validation
function validateElectricityRequest(body) {
  const errors = [], s = {};
  if (!body.customer_id?.trim()) errors.push('Customer ID is required'); else s.customer_id = body.customer_id.trim();
  if (!body.service_id?.trim()) errors.push('Valid service_id is required'); else s.service_id = body.service_id.toLowerCase().trim();
  if (!body.variation_id?.trim() || !VALID_METER_TYPES.includes(body.variation_id)) errors.push('Meter type must be prepaid or postpaid'); else s.variation_id = body.variation_id.toLowerCase().trim();
  const amt = Number(body.amount); if (!amt || amt < 1000 || amt > 100000) errors.push('Amount must be between ₦1,000 - ₦100,000'); else s.amount = amt;
  if (body.payment_currency?.toUpperCase() !== 'NGNB') errors.push('Payment currency must be NGNB'); else s.payment_currency = 'NGNB';
  if (!body.twoFactorCode?.trim()) errors.push('2FA is required'); else s.twoFactorCode = body.twoFactorCode.trim();
  if (!/^\d{6}$/.test(body.passwordpin || '')) errors.push('Valid 6-digit PIN is required'); else s.passwordpin = body.passwordpin.trim();
  // Optional — captured from the /verifybill/customer step so PayBeta's purchase
  // payload (which requires these, unlike eBills) has real values instead of placeholders.
  s.customerName = body.customerName ? String(body.customerName).trim() : null;
  s.customerAddress = body.customerAddress ? String(body.customerAddress).trim() : null;
  return { isValid: errors.length === 0, errors, sanitized: s };
}

/**
 * GET /providers — DISCOs available on PayBeta (dynamic, not hardcoded).
 */
router.get('/providers', async (req, res) => {
  try {
    const response = await payBetaAuth.makeRequest('GET', '/v2/electricity/providers', {}, { timeout: 15000 });
    if (response.status !== 'successful') throw new Error(response.message || 'Failed to fetch providers');

    const providers = (response.data || []).map(p => ({
      id: p.slug || String(p.name || '').toLowerCase().replace(/\s+/g, '-'),
      name: p.name,
    }));

    return res.status(200).json({ success: true, data: { providers } });
  } catch (error) {
    logger.error('Failed to fetch electricity providers', { error: error.message });
    return res.status(503).json({ success: false, message: 'Electricity providers are temporarily unavailable. Please try again later.' });
  }
});

// PayBeta responds synchronously — see the note in routes/airtime.js.
async function callPayBetaElectricityAPI({ customer_id, service_id, variation_id, amount, customerName, customerAddress, request_id }) {
  const payload = {
    service: service_id,
    meterNumber: customer_id.trim(),
    meterType: variation_id,
    amount: Math.round(amount),
    customerName: customerName || 'Customer',
    customerAddress: customerAddress || 'Address',
    reference: request_id.length > 40 ? request_id.substring(0, 40) : request_id
  };

  const response = await payBetaAuth.makeRequest('POST', '/v2/electricity/purchase', payload, { timeout: 90000 });
  if (response.status !== 'successful') throw new Error(response.message || 'Electricity service error');

  return {
    code: 'success',
    data: {
      status: 'completed-api',
      order_id: response.data.transactionId,
      product_name: response.data.biller || 'Electricity',
      service_name: response.data.biller,
      amount_charged: response.data.chargedAmount,
      token: response.data.token || null,
      unit: response.data.unit || null,
      initial_balance: response.data.previousBalance,
      final_balance: response.data.currentBalance
    }
  };
}

// Main route
router.post('/purchase', async (req, res) => {
  let balanceActionTaken = false, balanceActionType = null, transactionCreated = false, pendingTransaction = null, payBetaResponse = null;
  try {
    const userId = req.user.id;
    const validation = validateElectricityRequest(req.body);
    if (!validation.isValid) return res.status(400).json({ success: false, errors: validation.errors });
    const { customer_id, service_id, variation_id, amount, twoFactorCode, passwordpin, customerName, customerAddress } = validation.sanitized;
    const currency = 'NGNB', ngnbToUsdRate = 1 / 1554.42;

    const orderId = generateUniqueOrderId(), requestId = generateUniqueRequestId(userId);
    if (await checkPending(userId, orderId, requestId)) return res.status(409).json({ success: false, message: 'Pending transaction detected' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!validateTwoFactorAuth(user, twoFactorCode)) return res.status(403).json({ success: false, message: 'Invalid 2FA' });
    if (!await comparePasswordPin(passwordpin, user.passwordpin)) return res.status(401).json({ success: false, message: 'Invalid PIN' });

    const kycValidation = await validateUtilityTransaction(userId, amount);
    if (!kycValidation.allowed) return res.status(403).json({ success: false, message: kycValidation.message, kycDetails: kycValidation.data });

    const balanceValidation = await validateUserBalance(userId, currency, amount);
    if (!balanceValidation.success) return res.status(400).json({ success: false, message: balanceValidation.message });

    const txData = { orderId, status: 'initiated-api', productName: 'Electricity', billType: 'electricity', amount, paymentCurrency: currency, cryptoPrice: ngnbToUsdRate, requestId, userId, metaData: { customer_id, service_id, variation_id } };
    pendingTransaction = await BillTransaction.create(txData); transactionCreated = true;

    payBetaResponse = await callPayBetaElectricityAPI({ customer_id, service_id, variation_id, amount, customerName, customerAddress, request_id: requestId });
    const providerStatus = payBetaResponse.data.status;

    if (providerStatus === 'completed-api') { await updateUserBalance(userId, currency, -amount); await updateUserPortfolioBalance(userId); balanceActionTaken = true; balanceActionType = 'updated'; }
    else if (['initiated-api', 'processing-api'].includes(providerStatus)) { await reserveUserBalance(userId, currency, amount); await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { balanceReserved: true }); balanceActionTaken = true; balanceActionType = 'reserved'; }

    const finalTransaction = await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { $set: { orderId: payBetaResponse.data.order_id, status: providerStatus } }, { new: true });
    return res.status(200).json({ success: true, message: `Electricity purchase ${providerStatus}`, transaction: finalTransaction });

  } catch (error) {
    if (balanceActionTaken && balanceActionType === 'reserved') await releaseReservedBalance(req.user.id, 'NGNB', req.body.amount || 0);
    if (transactionCreated && pendingTransaction) await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { status: 'failed' });
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
