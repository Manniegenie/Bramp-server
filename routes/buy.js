// routes/buy.js
const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const router = express.Router();

const logger = require('../utils/logger');
const ChatbotTx = require('../models/ChatbotTransaction');
const User = require('../models/user');
const Transaction = require('../models/transaction');
const NairaMarkup = require('../models/onramp');
const { getPricesWithCache } = require('../services/portfolio');
const { initializeCollection } = require('../services/collectionService');

const BUY_TTL_MS = 30 * 60 * 1000; // 30 minutes for payment
const FALLBACK_ONRAMP_RATE_NGN_PER_USD = 1620.00; // slightly higher than offramp for buy
const SUPPORTED_TOKENS = new Set(['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX']);
const MIN_BUY_AMOUNT_NGN = 5000; // minimum 5000 NGN

// Cache for user balance optimization
const userCache = new Map();
const CACHE_TTL = 30000; // 30 seconds

/* ===============================
   Helpers
   =============================== */
function cleanStr(v) { return (v ?? '').toString().trim(); }

async function getEffectiveNgnPerUsdBuy(log = logger) {
  const doc = await NairaMarkup.findOne().lean();
  const base = doc?.onrampRate || FALLBACK_ONRAMP_RATE_NGN_PER_USD;
  const appliedMarkupPct = Number(doc?.markup || 2); // Use markup field from schema
  const effective = base * (1 + appliedMarkupPct / 100); // Add markup for buy (opposite of sell)
  log.info?.('Onramp NGN/USD resolved', { baseRate: base, appliedMarkupPct, effectiveRate: effective });
  return { ngnPerUsd: effective, baseNgnPerUsd: base, appliedMarkupPct };
}

/**
 * Buy quote calc:
 *   rate (NGN per token) = usdPerToken * onrampRate
 *   tokenAmount         = buyAmount / rate
 */
async function getBuyQuote({ token, buyAmount }, log = logger) {
  const tokenU = String(token).toUpperCase();
  const numericAmount = Number(buyAmount);
  if (!isFinite(numericAmount) || numericAmount < MIN_BUY_AMOUNT_NGN) {
    const err = new Error(`Invalid amount. Minimum buy amount is ${MIN_BUY_AMOUNT_NGN} NGN`);
    err.status = 400;
    throw err;
  }

  // 1) Onramp NGN/USD (higher rate for buying)
  const { ngnPerUsd, baseNgnPerUsd, appliedMarkupPct } = await getEffectiveNgnPerUsdBuy(log);

  // 2) Token price in USD
  const prices = await getPricesWithCache([tokenU]);
  let usdPerToken = Number(prices[tokenU] || 0);
  if (!usdPerToken || !isFinite(usdPerToken) || usdPerToken <= 0) {
    if (tokenU === 'USDT' || tokenU === 'USDC') {
      usdPerToken = 1;
    } else {
      const err = new Error(`Price unavailable for token ${tokenU}`); err.status = 503; throw err;
    }
  }

  // 3) Calculate token amount user will receive
  const rateNgnPerToken = usdPerToken * ngnPerUsd;  // NGN per 1 token
  const tokenAmount = numericAmount / rateNgnPerToken; // tokens user gets

  // Round to appropriate decimals based on token
  const decimals = ['BTC', 'ETH'].includes(tokenU) ? 8 :
    ['USDT', 'USDC'].includes(tokenU) ? 6 : 6;
  const roundedTokenAmount = Number(tokenAmount.toFixed(decimals));

  log.info?.('Buy quote computed', {
    token: tokenU,
    buyAmount: numericAmount,
    usdPerToken,
    ngnPerUsd,
    rateNgnPerToken,
    tokenAmount: roundedTokenAmount,
  });

  return {
    rate: rateNgnPerToken,      // NGN per token for UI
    tokenAmount: roundedTokenAmount, // tokens user will receive
    breakdown: {
      usdPerToken,
      ngnPerUsdEffective: ngnPerUsd,
      ngnPerUsdBase: baseNgnPerUsd,
      appliedOnrampMarkupPct: appliedMarkupPct,
    },
  };
}

function genPaymentId() {
  return crypto.randomBytes(6).toString('hex');
}

function genWebhookReference(paymentId) {
  return `BUY-${paymentId}-${Date.now()}`;
}

function validateWalletAddress(address, network) {
  if (!address || typeof address !== 'string') return false;

  const networkU = String(network).toUpperCase();
  const addr = address.trim();

  // Basic validation - you can enhance this with proper address validation libraries
  switch (networkU) {
    case 'BTC':
      return /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$|^bc1[a-z0-9]{39,59}$/.test(addr);
    case 'ETH':
    case 'BSC':
      return /^0x[a-fA-F0-9]{40}$/.test(addr);
    case 'SOL':
      return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
    case 'TRX':
      return /^T[A-Za-z1-9]{33}$/.test(addr);
    default:
      return addr.length >= 20 && addr.length <= 100; // fallback basic check
  }
}

/**
 * Execute NGNZ debit and crypto purchase with atomic balance updates
 */
async function executeNGNZCryptoPurchase(userId, purchaseData, correlationId, systemContext) {
  const session = await mongoose.startSession();
  session.startTransaction();
  const startTime = new Date();

  try {
    const { token, network, walletAddress, buyAmount, tokenAmount, rate } = purchaseData;

    // Generate purchase reference
    const purchaseReference = `NGNZ_BUY_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Get current NGNZ balance for audit trail
    const userBefore = await User.findById(userId).select('ngnzBalance').lean();

    // 1. Deduct NGNZ balance atomically
    const updatedUser = await User.findOneAndUpdate(
      {
        _id: userId,
        ngnzBalance: { $gte: buyAmount } // Ensure sufficient balance
      },
      {
        $inc: { ngnzBalance: -buyAmount },
        $set: { lastBalanceUpdate: new Date() }
      },
      {
        new: true,
        runValidators: true,
        session
      }
    );

    if (!updatedUser) {
      throw new Error('Balance update failed - insufficient NGNZ balance or user not found');
    }

    // Clear user cache
    userCache.delete(`user_${userId}`);

    // 2. Create purchase transaction record
    const purchaseTransaction = new Transaction({
      userId,
      type: 'WITHDRAWAL', // NGNZ going out
      currency: 'NGNZ',
      amount: -buyAmount, // Negative for outgoing
      status: 'SUCCESSFUL',
      source: 'CRYPTO_PURCHASE',
      reference: purchaseReference,
      obiexTransactionId: purchaseReference,
      narration: `NGNZ crypto purchase: ${tokenAmount} ${token} on ${network}`,
      completedAt: new Date(),
      metadata: {
        purchaseType: 'NGNZ_TO_CRYPTO',
        targetToken: token,
        targetNetwork: network,
        targetAmount: tokenAmount,
        walletAddress: walletAddress,
        exchangeRate: rate,
        correlationId,
        is_ngnz_purchase: true,
        delivery_pending: true
      }
    });

    await purchaseTransaction.save({ session });

    // 3. Commit balance update and transaction creation
    await session.commitTransaction();
    session.endSession();

    const endTime = new Date();

    logger.info('NGNZ crypto purchase completed successfully', {
      userId,
      purchaseReference,
      correlationId,
      buyAmount,
      token,
      network,
      tokenAmount,
      walletAddress,
      balanceBefore: userBefore.ngnzBalance,
      balanceAfter: updatedUser.ngnzBalance,
      transactionId: purchaseTransaction._id
    });

    return {
      user: updatedUser,
      transaction: purchaseTransaction,
      purchaseReference
    };

  } catch (err) {
    await session.abortTransaction();
    session.endSession();

    const endTime = new Date();

    logger.error('NGNZ crypto purchase failed', {
      error: err.message,
      stack: err.stack,
      userId,
      correlationId,
      purchaseData
    });

    throw err;
  }
}

/**
 * Validate user has sufficient NGNZ balance
 */
async function validateUserNGNZBalance(userId, amount) {
  const user = await User.findById(userId).select('ngnzBalance').lean();
  if (!user) {
    return { success: false, message: 'User not found' };
  }

  const availableBalance = user.ngnzBalance || 0;
  if (availableBalance < amount) {
    return {
      success: false,
      message: `Insufficient NGNZ balance. Available: ₦${availableBalance.toLocaleString()}, Required: ₦${amount.toLocaleString()}`,
      availableBalance,
      requiredAmount: amount
    };
  }

  return { success: true, availableBalance };
}

async function initiateBuy(userId, payload, log = logger) {
  if (!userId) { const err = new Error('Unauthorized'); err.status = 401; throw err; }

  const { token, network, walletAddress, buyAmount } = payload || {};
  if (!token || !network || !walletAddress || !buyAmount || isNaN(+buyAmount) || +buyAmount <= 0) {
    const err = new Error('token, network, walletAddress, and buyAmount are required');
    err.status = 400;
    throw err;
  }

  const tokenU = String(token).trim().toUpperCase();
  const networkU = String(network).trim().toUpperCase();
  const cleanWalletAddress = cleanStr(walletAddress);

  if (!SUPPORTED_TOKENS.has(tokenU)) {
    const err = new Error(`Unsupported token ${tokenU}`); err.status = 400; throw err;
  }

  if (!validateWalletAddress(cleanWalletAddress, networkU)) {
    const err = new Error(`Invalid wallet address for ${networkU} network`); err.status = 400; throw err;
  }

  // Get user details for collection
  const user = await User.findById(userId).lean();
  if (!user) { const err = new Error('User not found'); err.status = 404; throw err; }

  const amount = +buyAmount;

  // Get buy quote
  const { rate, tokenAmount, breakdown } = await getBuyQuote(
    { token: tokenU, buyAmount: amount },
    log
  );

  const paymentId = genPaymentId();
  const webhookRef = genWebhookReference(paymentId);
  const now = Date.now();
  const expiresAt = new Date(now + BUY_TTL_MS);

  // Prepare customer info for collection service
  const customerName = [user.firstname, user.lastname].filter(Boolean).join(' ') ||
    user.username ||
    'Customer';
  const customerEmail = user.email;
  const customerPhone = user.phonenumber || null;

  // Create collection payload
  const collectionPayload = {
    amount: amount * 100, // Convert to kobo/cents
    currency: 'NGN',
    customer: {
      name: customerName,
      email: customerEmail,
      phone: customerPhone
    },
    channels: ['card_payment', 'bank_transfer'],
    reference: webhookRef,
    meta: {
      type: 'crypto_buy',
      token: tokenU,
      network: networkU,
      tokenAmount,
      walletAddress: cleanWalletAddress,
      userId: userId.toString(),
      paymentId
    }
  };

  // Initialize collection
  const collectionResult = await initializeCollection(collectionPayload, {
    userId,
    chatbotPaymentId: paymentId
  });

  if (!collectionResult.success) {
    const err = new Error(`Collection initialization failed: ${collectionResult.message}`);
    err.status = collectionResult.statusCode || 500;
    throw err;
  }

  // Create transaction record
  const doc = await ChatbotTx.create({
    paymentId,
    userId,
    kind: 'BUY',
    token: tokenU,
    network: networkU,
    buyAmount: amount,
    tokenAmount,

    // quote fields
    quoteRate: rate,
    receiveCurrency: tokenU,        // user receives tokens
    receiveAmount: tokenAmount,     // amount of tokens

    // webhook correlation
    webhookRef,
    status: 'PENDING',
    expiresAt,

    // collection details - using new field name
    collectionDetails: {
      customerName,
      customerEmail,
      customerPhone,
      channels: ['card_payment', 'bank_transfer'],
      defaultChannel: 'card_payment',
      meta: collectionPayload.meta,
      walletAddress: cleanWalletAddress,
      walletNetwork: networkU,
      capturedAt: new Date()
    },

    // collection tracking
    collectionCurrency: 'NGN',
    collectionAmount: amount,
    collectionReference: webhookRef,
    collectionStatus: 'REQUESTED',
    collectionResult: {
      provider: 'COLLECTION_API',
      collectionId: collectionResult.data.id,
      collectionReference: collectionResult.data.reference,
      collectionStatus: collectionResult.data.status,
      paymentUrl: collectionResult.data.paymentUrl,
      idempotencyKey: collectionResult.idempotencyKey
    }
  });

  log.info?.('BUY initiated', {
    paymentId: doc.paymentId,
    token: tokenU,
    network: networkU,
    buyAmount: amount,
    tokenAmount,
    rate,
    paymentUrl: collectionResult.data.paymentUrl
  });

  return {
    paymentId: doc.paymentId,
    reference: doc.webhookRef,
    token: doc.token,
    network: doc.network,
    buyAmount: doc.buyAmount,
    delivery: {
      walletAddress: cleanWalletAddress,
      network: doc.network,
      token: doc.token,
      amount: doc.tokenAmount,
    },
    quote: {
      rate: doc.quoteRate,
      receiveCurrency: doc.receiveCurrency,
      receiveAmount: doc.receiveAmount,
      tokenAmount: doc.tokenAmount,
      expiresAt: doc.expiresAt,
      breakdown,
    },
    payment: {
      url: collectionResult.data.paymentUrl,
      amount: doc.buyAmount,
      currency: 'NGN',
      reference: doc.collectionReference,
      status: collectionResult.data.status
    }
  };
}

async function getBuyStatus(userId, paymentId, log = logger) {
  if (!userId) { const err = new Error('Unauthorized'); err.status = 401; throw err; }
  if (!paymentId) { const err = new Error('paymentId is required'); err.status = 400; throw err; }

  const tx = await ChatbotTx.findOne({ paymentId, userId, kind: 'BUY' });
  if (!tx) { const err = new Error('Buy transaction not found'); err.status = 404; throw err; }

  return {
    paymentId: tx.paymentId,
    reference: tx.webhookRef,
    status: tx.status,
    collectionStatus: tx.collectionStatus,
    token: tx.token,
    network: tx.network,
    buyAmount: tx.buyAmount,
    tokenAmount: tx.tokenAmount,
    delivery: {
      walletAddress: tx.collectionDetails?.walletAddress,
      network: tx.network,
      token: tx.token,
      amount: tx.tokenAmount,
    },
    payment: {
      url: tx.collectionResult?.paymentUrl,
      amount: tx.buyAmount,
      currency: 'NGN',
      reference: tx.collectionReference,
      status: tx.collectionResult?.collectionStatus
    },
    expiresAt: tx.expiresAt,
    createdAt: tx.createdAt,
    updatedAt: tx.updatedAt
  };
}

/* ===============================
   Routes
   =============================== */
router.post('/initiate', express.json(), async (req, res) => {
  try {
    const userId = req.user?.id;
    const result = await initiateBuy(userId, req.body, logger);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    const status = err.status || 500;
    logger.error('BUY initiate failed', { status, error: err.message, body: req.body });
    return res.status(status).json({ success: false, message: err.message });
  }
});

router.get('/status/:paymentId', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { paymentId } = req.params;
    const result = await getBuyStatus(userId, paymentId, logger);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    const status = err.status || 500;
    logger.error('BUY status check failed', { status, error: err.message, paymentId: req.params.paymentId });
    return res.status(status).json({ success: false, message: err.message });
  }
});

router.post('/resend-payment-link', express.json(), async (req, res) => {
  try {
    const userId = req.user?.id;
    const { paymentId } = req.body;

    if (!paymentId) {
      return res.status(400).json({ success: false, message: 'paymentId is required' });
    }

    const tx = await ChatbotTx.findOne({ paymentId, userId, kind: 'BUY' });
    if (!tx) {
      return res.status(404).json({ success: false, message: 'Buy transaction not found' });
    }

    if (tx.status !== 'PENDING') {
      return res.status(400).json({
        success: false,
        message: `Transaction is ${tx.status} and payment link is no longer valid`
      });
    }

    // Check if transaction has expired (10 minutes) but keep it in database
    if (new Date(tx.expiresAt).getTime() <= Date.now()) {
      tx.status = 'EXPIRED';
      await tx.save();
      return res.status(410).json({ success: false, message: 'Transaction has expired' });
    }

    return res.status(200).json({
      success: true,
      paymentId: tx.paymentId,
      paymentUrl: tx.collectionResult?.paymentUrl,
      expiresAt: tx.expiresAt
    });

  } catch (err) {
    const status = err.status || 500;
    logger.error('Resend payment link failed', { status, error: err.message });
    return res.status(status).json({ success: false, message: err.message });
  }
});

// Get user's buy history
router.get('/history', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { page = 1, limit = 20 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const transactions = await ChatbotTx.find({
      userId,
      kind: 'BUY'
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();

    const total = await ChatbotTx.countDocuments({ userId, kind: 'BUY' });

    const formattedTxs = transactions.map(tx => ({
      paymentId: tx.paymentId,
      reference: tx.webhookRef,
      status: tx.status,
      collectionStatus: tx.collectionStatus,
      token: tx.token,
      network: tx.network,
      buyAmount: tx.buyAmount,
      tokenAmount: tx.tokenAmount,
      paymentUrl: tx.collectionResult?.paymentUrl,
      createdAt: tx.createdAt,
      expiresAt: tx.expiresAt
    }));

    return res.status(200).json({
      success: true,
      transactions: formattedTxs,
      pagination: {
        page: Number(page),
        limit: Number(limit),
        total,
        pages: Math.ceil(total / Number(limit))
      }
    });

  } catch (err) {
    logger.error('Get buy history failed', { error: err.message, userId: req.user?.id });
    return res.status(500).json({ success: false, message: 'Failed to fetch buy history' });
  }
});

// Clean up user cache periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of userCache.entries()) {
    if (now - entry.timestamp > CACHE_TTL) {
      userCache.delete(key);
    }
  }
}, 60000); // Clean every minute

module.exports = router;