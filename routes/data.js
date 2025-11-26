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

const DATA_SERVICES = ['mtn', 'glo', 'airtel', '9mobile'];
const AIRTIME_SERVICES = ['mtn', 'glo', 'airtel', '9mobile'];

const SUPPORTED_TOKENS = { BTC: {}, ETH: {}, SOL: {}, USDT: {}, USDC: {}, BNB: {}, MATIC: {}, AVAX: {}, NGNB: {} };
const TOKEN_FIELD_MAPPING = { BTC: 'btc', ETH: 'eth', SOL: 'sol', USDT: 'usdt', USDC: 'usdc', BNB: 'bnb', MATIC: 'matic', AVAX: 'avax', NGNB: 'ngnb' };

// --- Internal Helpers ---
async function reserveUserBalance(userId, currency, amount) {
  const pendingBalanceKey = `${TOKEN_FIELD_MAPPING[currency.toUpperCase()]}PendingBalance`;
  return await User.findByIdAndUpdate(userId, { $inc: { [pendingBalanceKey]: amount }, $set: { lastBalanceUpdate: new Date() } }, { new: true });
}
async function releaseReservedBalance(userId, currency, amount) {
  const pendingBalanceKey = `${TOKEN_FIELD_MAPPING[currency.toUpperCase()]}PendingBalance`;
  return await User.findByIdAndUpdate(userId, { $inc: { [pendingBalanceKey]: -amount }, $set: { lastBalanceUpdate: new Date() } }, { new: true });
}
async function updateUserBalance(userId, currency, amount) {
  const balanceField = `${TOKEN_FIELD_MAPPING[currency.toUpperCase()]}Balance`;
  return await User.findByIdAndUpdate(userId, { $inc: { [balanceField]: amount }, $set: { lastBalanceUpdate: new Date() } }, { new: true });
}
async function updateUserPortfolioBalance(userId) {
  return await User.findByIdAndUpdate(userId, { $set: { portfolioLastUpdated: new Date() } }, { new: true });
}
async function comparePasswordPin(candidate, hashed) { return await bcrypt.compare(candidate, hashed); }
function generateUniqueOrderId(type) { return `${type}_order_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`; }
function generateUniqueRequestId(userId, type) { return `${type}_req_${userId}_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`; }
function validatePhoneNumber(phone) { return /^\d{10,16}$/.test(phone.replace(/\D/g, '')); }

// Fetch data plan
async function getDataPlanPrice(service_id, variation_id) {
  const res = await vtuAuth.makeRequest('GET', `/api/v2/variations/data/${service_id}`, null, { timeout: 15000, baseURL: EBILLS_BASE_URL });
  if (res.code !== 'success') throw new Error('Failed to fetch plan');
  const plan = res.data.find(p => p.variation_id === variation_id);
  if (!plan) throw new Error(`Data plan ${variation_id} not found`);
  return { price: parseFloat(plan.price), name: plan.name, validity: plan.validity, data_allowance: plan.data_allowance };
}

// Validate customer & plan
async function validateCustomerAndGetPlanPrice(phone, service_id, variation_id, type) {
  if (!validatePhoneNumber(phone)) throw new Error('Invalid phone number');
  if (type === 'data') return { planInfo: await getDataPlanPrice(service_id, variation_id), expectedAmount: (await getDataPlanPrice(service_id, variation_id)).price, isValid: true };
  return { planInfo: null, expectedAmount: null, isValid: true };
}

function validateAmountMatchesPlan(userAmount, expectedAmount, type) {
  if (type === 'airtime') return { isValid: true };
  if (!expectedAmount || Math.abs(userAmount - expectedAmount) > 0.01) return { isValid: false, error: 'AMOUNT_PLAN_MISMATCH', message: `Amount mismatch: Expected ₦${expectedAmount}` };
  return { isValid: true };
}

// Validate request
function validateDataAirtimeRequest(body) {
  const errors = []; const sanitized = {};
  if (!body.phone_number || !validatePhoneNumber(body.phone_number)) errors.push('Valid phone number required'); else sanitized.phone_number = body.phone_number.trim();
  if (!body.service_id) errors.push('Service ID required'); else sanitized.service_id = body.service_id.toLowerCase().trim();
  sanitized.service_type = body.service_type?.toLowerCase().trim();
  if (!['data', 'airtime'].includes(sanitized.service_type)) errors.push('Invalid service type');
  if (sanitized.service_type === 'data' && !body.variation_id) errors.push('Variation ID required'); else sanitized.variation_id = body.variation_id?.trim();
  const amt = Number(body.amount);
  if (!amt || amt <= 0 || amt > 50000) errors.push('Invalid amount'); else sanitized.amount = amt;
  sanitized.payment_currency = 'NGNB';
  if (!body.twoFactorCode?.trim()) errors.push('2FA required'); else sanitized.twoFactorCode = body.twoFactorCode.trim();
  if (!/^\d{6}$/.test(body.passwordpin || '')) errors.push('Valid 6-digit PIN required'); else sanitized.passwordpin = body.passwordpin.trim();
  return { isValid: errors.length === 0, errors, sanitized };
}

function validateNGNBLimits(amount, type) {
  const min = type === 'airtime' ? 50 : 100; const max = 50000;
  if (amount < min) return { isValid: false, message: `Minimum ${type} is ${min}` };
  if (amount > max) return { isValid: false, message: `Maximum ${type} is ${max}` };
  return { isValid: true };
}

async function checkForPendingTransactions(userId, orderId, requestId) {
  const pending = await BillTransaction.find({ $or: [{ userId, billType: { $in: ['data', 'airtime'] }, status: { $in: ['initiated-api', 'processing-api'] } }, { orderId }, { requestId }], createdAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) } });
  return pending.length > 0;
}

async function callEBillsDataAirtimeAPI({ phone_number, amount, service_id, variation_id, service_type, request_id }) {
  const endpoint = service_type === 'data' ? '/api/v2/data' : '/api/v2/airtime';
  const payload = { request_id, phone: phone_number, service_id, amount: parseInt(amount) };
  if (service_type === 'data' && variation_id) payload.variation_id = variation_id;
  const res = await vtuAuth.makeRequest('POST', endpoint, payload, { timeout: 45000, baseURL: EBILLS_BASE_URL });
  if (res.code !== 'success') throw new Error(res.message || 'eBills API error');
  return res;
}

// --- Main endpoint ---
router.post('/purchase', async (req, res) => {
  let balanceActionTaken = false, balanceActionType = null, transactionCreated = false, pendingTransaction = null, ebillsResponse = null;
  try {
    const userId = req.user.id;
    const validation = validateDataAirtimeRequest(req.body);
    if (!validation.isValid) return res.status(400).json({ success: false, errors: validation.errors });
    const { phone_number, service_id, service_type, variation_id, amount, twoFactorCode, passwordpin } = validation.sanitized;
    const currency = 'NGNB';
    const uniqueOrderId = generateUniqueOrderId(service_type);
    const uniqueRequestId = generateUniqueRequestId(userId, service_type);
    if (await checkForPendingTransactions(userId, uniqueOrderId, uniqueRequestId)) return res.status(409).json({ success: false, message: 'Pending transaction detected' });

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!validateTwoFactorAuth(user, twoFactorCode)) return res.status(401).json({ success: false, message: 'Invalid 2FA code' });
    if (!await comparePasswordPin(passwordpin, user.passwordpin)) return res.status(401).json({ success: false, message: 'Invalid password PIN' });

    const kycValidation = await validateUtilityTransaction(userId, amount);
    if (!kycValidation.allowed) return res.status(403).json({ success: false, message: kycValidation.message, kycDetails: kycValidation.data });

    const customerValidation = await validateCustomerAndGetPlanPrice(phone_number, service_id, variation_id, service_type);
    if (!customerValidation.isValid) return res.status(400).json({ success: false, message: customerValidation.error });

    if (service_type === 'data') {
      const amountValidation = validateAmountMatchesPlan(amount, customerValidation.expectedAmount, service_type);
      if (!amountValidation.isValid) return res.status(400).json({ success: false, message: amountValidation.message });
    }

    const ngnbAmount = service_type === 'data' ? customerValidation.expectedAmount : amount;
    if (!validateNGNBLimits(ngnbAmount, service_type).isValid) return res.status(400).json({ success: false, message: 'Amount out of allowed range' });

    const balanceValidation = await validateUserBalance(userId, currency, ngnbAmount);
    if (!balanceValidation.success) return res.status(400).json({ success: false, message: balanceValidation.message });

    const txData = { orderId: uniqueOrderId, status: 'initiated-api', productName: service_type, billType: service_type, amount: ngnbAmount, paymentCurrency: currency, requestId: uniqueRequestId, userId, metaData: { phone_number, service_id, variation_id, service_type } };
    pendingTransaction = await BillTransaction.create(txData); transactionCreated = true;

    ebillsResponse = await callEBillsDataAirtimeAPI({ phone_number, amount: ngnbAmount, service_id, variation_id, service_type, request_id: uniqueRequestId });
    const ebillsStatus = ebillsResponse.data.status;

    if (ebillsStatus === 'completed-api') { await updateUserBalance(userId, currency, -ngnbAmount); await updateUserPortfolioBalance(userId); balanceActionTaken = true; balanceActionType = 'updated'; }
    else if (['initiated-api', 'processing-api'].includes(ebillsStatus)) { await reserveUserBalance(userId, currency, ngnbAmount); await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { balanceReserved: true }); balanceActionTaken = true; balanceActionType = 'reserved'; }

    const finalTransaction = await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { $set: { orderId: ebillsResponse.data.order_id, status: ebillsStatus } }, { new: true });
    return res.status(200).json({ success: true, message: `Purchase ${ebillsStatus}`, transaction: finalTransaction });

  } catch (error) {
    if (balanceActionTaken && balanceActionType === 'reserved') await releaseReservedBalance(req.user.id, 'NGNB', req.body.amount || 0);
    if (transactionCreated && pendingTransaction) await BillTransaction.findByIdAndUpdate(pendingTransaction._id, { status: 'failed' });
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
