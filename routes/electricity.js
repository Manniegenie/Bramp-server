const express = require('express');
const bcrypt = require('bcryptjs');
const User = require('../models/user');
const BillTransaction = require('../models/billstransaction');
const { vtuAuth } = require('../auth/billauth');
const { validateUserBalance } = require('../services/balance');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { validateUtilityTransaction } = require('../services/kyccheckservice'); // UPDATED
const logger = require('../utils/logger');
const crypto = require('crypto');

const router = express.Router();
const EBILLS_BASE_URL = process.env.EBILLS_BASE_URL || 'https://ebills.africa/wp-json';

const ELECTRICITY_SERVICES = [
  'ikeja-electric', 'eko-electric', 'kano-electric', 'portharcourt-electric',
  'jos-electric', 'ibadan-electric', 'kaduna-electric', 'abuja-electric',
  'enugu-electric', 'benin-electric', 'aba-electric', 'yola-electric'
];
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
  if (!body.service_id?.trim() || !ELECTRICITY_SERVICES.includes(body.service_id)) errors.push('Valid service_id is required'); else s.service_id = body.service_id.toLowerCase().trim();
  if (!body.variation_id?.trim() || !VALID_METER_TYPES.includes(body.variation_id)) errors.push('Meter type must be prepaid or postpaid'); else s.variation_id = body.variation_id.toLowerCase().trim();
  const amt = Number(body.amount); if (!amt || amt < 1000 || amt > 100000) errors.push('Amount must be between ₦1,000 - ₦100,000'); else s.amount = amt;
  if (body.payment_currency?.toUpperCase() !== 'NGNB') errors.push('Payment currency must be NGNB'); else s.payment_currency = 'NGNB';
  if (!body.twoFactorCode?.trim()) errors.push('2FA is required'); else s.twoFactorCode = body.twoFactorCode.trim();
  if (!/^\d{6}$/.test(body.passwordpin || '')) errors.push('Valid 6-digit PIN is required'); else s.passwordpin = body.passwordpin.trim();
  return { isValid: errors.length === 0, errors, sanitized: s };
}

// EBills call
async function callEBillsElectricityAPI({ customer_id, service_id, variation_id, amount, request_id }) {
  const payload = { request_id, customer_id: customer_id.trim(), service_id, variation_id, amount: parseInt(amount) };
  const res = await vtuAuth.makeRequest('POST', '/api/v2/electricity', payload, { timeout: 45000, baseURL: EBILLS_BASE_URL });
  if (res.code !== 'success') throw new Error(res.message || 'eBills API error');
  return res;
}

// Main route
router.post('/purchase', async (req, res) => {
  let balanceActionTaken = false, balanceActionType = null, transactionCreated = false, pendingTransaction = null, ebillsResponse = null;
  try {
    const userId = req.user.id;
    const validation = validateElectricityRequest(req.body);
    if (!validation.isValid) return res.status(400).json({ success: false, errors: validation.errors });
    const { customer_id, service_id, variation_id, amount, twoFactorCode, passwordpin } = validation.sanitized;
    const currency = 'NGNB', ngnbToUsdRate = 1 / 1554.42;

    const orderId = generateUniqueOrderId(), requestId = generateUniqueRequestId(userId);
    if (await checkPending(userId, orderId, requestId)) return res.status(409).json({ success: false, message: 'Pending transaction detected' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!validateTwoFactorAuth(user, twoFactorCode)) return res.status(401).json({ success: false, message: 'Invalid 2FA' });
    if (!await comparePasswordPin(passwordpin, user.passwordpin)) return res.status(401).json({ success: false, message: 'Invalid PIN' });

    const kycValidation = await validateUtilityTransaction(userId, amount);
    if (!kycValidation.allowed) return res.status(403).json({ success: false, message: kycValidation.message, kycDetails: kycValidation.data });

    const balanceValidation = await validateUserBalance(userId, currency, amount);
    if (!balanceValidation.success) return res.status(400).json({ success: false, message: balanceValidation.message });

    const txData = { orderId, status: 'initiated-api', productName: 'Electricity', billType: 'electricity', amount, paymentCurrency: currency, cryptoPrice: ngnbToUsdRate, requestId, userId, metaData: { customer_id, service_id, variation_id } };
    pendingTransaction = await BillTransaction.create(txData); transactionCreated = true;

    ebillsResponse = await callEBillsElectricityAPI({ customer_id, service_id, variation_id, amount, request_id: requestId });
    const ebillsStatus = ebillsResponse.data.status;

    if (ebillsStatus === 'completed-api') { await updateUserBalance(userId, currency, -amount); await updateUserPortfolioBalance(userId); balanceActionTaken = true; balanceActionType = 'updated'; }
    else if (['initiated-api', 'processing-api'].includes(ebillsStatus)) { await reserveUserBalance(userId, currency, amount); await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { balanceReserved: true }); balanceActionTaken = true; balanceActionType = 'reserved'; }

    const finalTransaction = await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { $set: { orderId: ebillsResponse.data.order_id, status: ebillsStatus } }, { new: true });
    return res.status(200).json({ success: true, message: `Electricity purchase ${ebillsStatus}`, transaction: finalTransaction });

  } catch (error) {
    if (balanceActionTaken && balanceActionType === 'reserved') await releaseReservedBalance(req.user.id, 'NGNB', req.body.amount || 0);
    if (transactionCreated && pendingTransaction) await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { status: 'failed' });
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
