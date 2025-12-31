// routes/sell.js
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const logger = require('../utils/logger');
const ChatbotTx = require('../models/ChatbotTransaction');
const User = require('../models/user');
const NairaMarkdown = require('../models/offramp');
const { getPricesWithCache } = require('../services/portfolio');
const { getSellDepositAddress } = require('../services/getSellDepositAddress');

// NOTE: require path must match actual filename (case-sensitive on Linux)
let sendChatbotSellEmail = null;
try {
  // use lowercase filename as in your project
  const emailSvc = require('../services/EmailService');
  sendChatbotSellEmail = emailSvc && emailSvc.sendChatbotSellEmail;
  if (!sendChatbotSellEmail) {
    logger.warn?.('emailService loaded but sendChatbotSellEmail was not found');
  }
} catch (e) {
  logger.error?.('Failed to load emailService for sell route:', e?.message || e);
}

/* Constants */
const FALLBACK_OFFRAMP_RATE_NGN_PER_USD = 1554.42;
const SUPPORTED_TOKENS = new Set(['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX']);
const TOLERANCE_THRESHOLD_USD = 5; // $5 tolerance threshold
const SELL_INTENT_EXPIRY_MS = 12 * 60 * 60 * 1000; // 12 hours

/* Helpers */
function walletKeyFor(tokenU, networkU) {
  return `${tokenU}_${networkU}`;
}

async function getEffectiveNgnPerUsd(log = logger) {
  const doc = await NairaMarkdown.findOne().lean();
  const base = doc?.offrampRate || FALLBACK_OFFRAMP_RATE_NGN_PER_USD;
  const appliedMarkupPct = Number(doc?.markup || 0);
  const effective = base * (appliedMarkupPct > 0 ? (1 - appliedMarkupPct / 100) : 1);
  log.info?.('Offramp NGN/USD resolved', { baseRate: base, appliedMarkupPct, effectiveRate: effective });
  return { ngnPerUsd: effective, baseNgnPerUsd: base, appliedMarkupPct };
}

/**
 * Get sell quote
 */
async function getSellQuote({ token, amount }, log = logger) {
  const tokenU = String(token).toUpperCase();
  const numericAmount = Number(amount);
  // Allow zero to return rate/breakdown without a hard error (for address-first flow)
  if (!isFinite(numericAmount)) { const err = new Error('Invalid amount'); err.status = 400; throw err; }

  const { ngnPerUsd, baseNgnPerUsd, appliedMarkupPct } = await getEffectiveNgnPerUsd(log);

  const prices = await getPricesWithCache([tokenU]);
  let usdPerToken = Number(prices[tokenU] || 0);
  if (!usdPerToken || !isFinite(usdPerToken) || usdPerToken <= 0) {
    if (tokenU === 'USDT' || tokenU === 'USDC') {
      usdPerToken = 1;
    } else {
      const err = new Error(`Price unavailable for token ${tokenU}`); err.status = 503; throw err;
    }
  }

  const rateNgnPerToken = usdPerToken * ngnPerUsd;  // NGN per 1 token
  // Base compute
  const baseReceiveAmount = Math.round(Math.max(0, numericAmount) * rateNgnPerToken);
  // Display fee and stored adjustment (NGNB)
  const displayFeeNgn = 100;   // shown to user, not stored
  const storedAdjustNgn = 30;  // subtract before saving for webhook processing
  // Amount shown to user (after display fee)
  const receiveAmount = Math.max(0, baseReceiveAmount - displayFeeNgn);

  log.info?.('Quote computed (correct calc)', {
    token: tokenU,
    sellAmount: numericAmount,
    usdPerToken,
    ngnPerUsd,
    rateNgnPerToken,
    receiveAmount,
  });

  return {
    rate: rateNgnPerToken,
    receiveAmount,
    breakdown: {
      usdPerToken,
      ngnPerUsdEffective: ngnPerUsd,
      ngnPerUsdBase: baseNgnPerUsd,
      appliedOfframpMarkupPct: appliedMarkupPct,
      baseReceiveAmount,
      displayFeeNgn,
      storedAdjustNgn,
    },
  };
}

/**
 * Tolerance check
 */
async function checkTolerance(expectedAmount, observedAmount, token, log = logger) {
  const tokenU = String(token).toUpperCase();
  const prices = await getPricesWithCache([tokenU]);
  const usdPerToken = Number(prices[tokenU] || 0);

  if (!usdPerToken || !isFinite(usdPerToken) || usdPerToken <= 0) {
    const err = new Error(`Price unavailable for tolerance check for token ${tokenU}`);
    err.status = 503;
    throw err;
  }

  const difference = Math.abs(Number(observedAmount) - Number(expectedAmount));
  const differenceInUSD = difference * usdPerToken;
  const withinTolerance = differenceInUSD <= TOLERANCE_THRESHOLD_USD;

  log.info?.('Tolerance check', {
    token: tokenU,
    expectedAmount: Number(expectedAmount),
    observedAmount: Number(observedAmount),
    difference,
    differenceInUSD,
    toleranceThreshold: TOLERANCE_THRESHOLD_USD,
    withinTolerance
  });

  return {
    withinTolerance,
    difference,
    differenceInUSD,
    toleranceThreshold: TOLERANCE_THRESHOLD_USD
  };
}

function genPaymentId() {
  // Increase entropy: 16 bytes -> 32 hex chars (was 12)
  const bytes = parseInt(process.env.SELL_REF_BYTES || '16', 10);
  return crypto.randomBytes(Math.max(12, Math.min(bytes, 32))).toString('hex');
}

/* Core handlers */
async function initiateSell(userId, payload, log = logger) {
  if (!userId) { const err = new Error('Unauthorized'); err.status = 401; throw err; }

  const { token, network, sellAmount, currency = 'TOKEN' } = payload || {};
  if (!token || !network) { const err = new Error('token and network are required'); err.status = 400; throw err; }

  const tokenU = String(token).trim().toUpperCase();
  const sellAmountNum = sellAmount !== undefined && sellAmount !== null ? +sellAmount : 0;
  let usdAmount;
  let actualTokenAmount;

  // Handle NGN input - convert to USD first, then to token amount
  if (currency === 'NGN' && sellAmountNum > 0) {
    // Get offramp rate to convert NGN to USD
    const { ngnPerUsd } = await getEffectiveNgnPerUsd(log);
    usdAmount = sellAmountNum / ngnPerUsd;

    // Get token price to determine how much token user needs to send
    const prices = await getPricesWithCache([tokenU]);
    let usdPerToken = Number(prices[tokenU] || 0);
    if (!usdPerToken || !isFinite(usdPerToken) || usdPerToken <= 0) {
      if (tokenU === 'USDT' || tokenU === 'USDC') {
        usdPerToken = 1;
      } else {
        const err = new Error(`Price unavailable for token ${tokenU}`); err.status = 503; throw err;
      }
    }

    // Raw token amount from NGN
    const rawTokenAmount = usdAmount / usdPerToken;
    // Round token amount to a cleaner figure for user instructions (avoid long decimals)
    // Using 2dp for clarity across wallets; adjust if token precision requires otherwise
    actualTokenAmount = Number(rawTokenAmount.toFixed(2));
    // Recompute usdAmount using the rounded token amount to keep downstream checks coherent
    usdAmount = actualTokenAmount * usdPerToken;

    log.info('NGN to token conversion', {
      ngnAmount: sellAmountNum,
      ngnPerUsd,
      usdAmount,
      token: tokenU,
      usdPerToken,
      actualTokenAmount
    });
  } else if (currency !== 'NGN' && sellAmountNum > 0) {
    // Handle TOKEN input - direct token amount
    actualTokenAmount = sellAmountNum;

    // Get token price to calculate USD value for daily limit check
    const prices = await getPricesWithCache([tokenU]);
    let usdPerToken = Number(prices[tokenU] || 0);
    if (!usdPerToken || !isFinite(usdPerToken) || usdPerToken <= 0) {
      if (tokenU === 'USDT' || tokenU === 'USDC') {
        usdPerToken = 1;
      } else {
        const err = new Error(`Price unavailable for token ${tokenU}`); err.status = 503; throw err;
      }
    }

    usdAmount = actualTokenAmount * usdPerToken;

    log.info('Token amount provided', {
      tokenAmount: actualTokenAmount,
      token: tokenU,
      usdPerToken,
      usdAmount
    });
  }

  const DAILY_LIMIT_USD = 1000;

  if (usdAmount > DAILY_LIMIT_USD) {
    const err = new Error(`Daily sell limit exceeded. Maximum $${DAILY_LIMIT_USD} per day during test flight. Your amount: $${usdAmount.toFixed(2)} (${currency === 'NGN' ? `₦${sellAmountNum.toFixed(2)}` : `${tokenU} ${sellAmountNum.toFixed(2)}`})`);
    err.status = 400;
    throw err;
  }

  // Check daily sell total for user
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const todaySells = await ChatbotTx.find({
    userId,
    kind: 'SELL',
    createdAt: { $gte: today, $lt: tomorrow },
    status: 'COMPLETED'
  }).lean();

  let totalUsdToday = 0;
  for (const tx of todaySells) {
    const txToken = tx.token;
    const txAmount = tx.sellAmount;

    // Get price for this transaction's token
    const txPrices = await getPricesWithCache([txToken]);
    let txUsdPerToken = Number(txPrices[txToken] || 0);
    if (!txUsdPerToken || !isFinite(txUsdPerToken) || txUsdPerToken <= 0) {
      if (txToken === 'USDT' || txToken === 'USDC') {
        txUsdPerToken = 1;
      } else {
        continue; // Skip if price unavailable
      }
    }

    totalUsdToday += txAmount * txUsdPerToken;
  }

  const newTotalUsd = totalUsdToday + (usdAmount || 0);
  if (newTotalUsd > DAILY_LIMIT_USD) {
    const remaining = Math.max(0, DAILY_LIMIT_USD - totalUsdToday);
    const err = new Error(`Daily sell limit exceeded. You have $${remaining.toFixed(2)} remaining today. Your request: $${usdAmount.toFixed(2)} (${currency === 'NGN' ? `₦${sellAmountNum.toFixed(2)}` : `${tokenU} ${sellAmountNum.toFixed(2)}`})`);
    err.status = 400;
    throw err;
  }

  const networkU = String(network).trim().toUpperCase();
  if (!SUPPORTED_TOKENS.has(tokenU)) {
    const err = new Error(`Unsupported token ${tokenU}`); err.status = 400; throw err;
  }

  // Get per-user deposit address for this token/network
  const sellAddress = await getSellDepositAddress(userId, tokenU, networkU);

  // If no amount provided, compute a zero-amount quote to return rate/breakdown for UI; else full quote
  const { rate, receiveAmount, breakdown } = await getSellQuote(
    { token: tokenU, amount: actualTokenAmount || 0 },
    log
  );

  const paymentId = genPaymentId();
  const now = Date.now();

  const storedReceiveAmount = Math.max(0, (breakdown?.baseReceiveAmount ?? receiveAmount) - (breakdown?.storedAdjustNgn ?? 0));

  // Cancel any existing pending sell intents for this address + token (newer intent replaces older)
  await ChatbotTx.updateMany(
    {
      kind: 'SELL',
      token: tokenU,
      depositAddress: sellAddress.address,
      status: 'PENDING',
    },
    {
      $set: { status: 'CANCELLED' }
    }
  );

  const doc = await ChatbotTx.create({
    paymentId,
    userId,
    kind: 'SELL',
    token: tokenU,
    network: networkU,
    sellAmount: actualTokenAmount, // Store the actual token amount to send
    originalAmount: sellAmountNum, // Store the original input amount
    originalCurrency: currency, // Store the original currency (USD/NGN)
    quoteRate: rate,
    receiveCurrency: 'NGN', // Changed from NGNB to NGN
    receiveAmount: storedReceiveAmount,
    depositAddress: sellAddress.address,
    depositMemo: sellAddress.memo || null,
    status: 'PENDING',
    expiresAt: new Date(now + SELL_INTENT_EXPIRY_MS), // Internal expiry: 12 hours
  });

  log.info?.('SELL initiated (correct calc)', {
    paymentId: doc.paymentId,
    token: tokenU,
    network: networkU,
    originalAmount: sellAmountNum,
    originalCurrency: currency,
    actualTokenAmount: actualTokenAmount,
    usdAmount: usdAmount,
    rate,
    receiveAmount,
  });

  return {
    paymentId: doc.paymentId,
    token: doc.token,
    network: doc.network,
    sellAmount: doc.sellAmount,
    deposit: {
      address: doc.depositAddress,
      memo: doc.depositMemo || null,
      token: doc.token,
      network: doc.network,
      // Optional display-only amount estimate if provided by user
      amount: doc.sellAmount || 0,
      // No amount requirement: user can send any amount
    },
    quote: {
      rate: doc.quoteRate,
      receiveCurrency: doc.receiveCurrency,
      receiveAmount, // present the display amount to the client
      breakdown,
    },
  };
}

async function saveSellPayout(userId, details) {
  if (!userId) { const err = new Error('Unauthorized'); err.status = 401; throw err; }

  const { paymentId, bankName, bankCode, accountNumber, accountName } = details || {};
  if (!paymentId || !bankName || !bankCode || !accountNumber || !accountName) {
    const err = new Error('paymentId, bankName, bankCode, accountNumber, accountName are required'); err.status = 400; throw err;
  }

  const tx = await ChatbotTx.findOne({ paymentId, userId });
  if (!tx) { const err = new Error('Sell intent not found'); err.status = 404; throw err; }

  if (tx.status !== 'PENDING') {
    const err = new Error(`Sell intent is ${tx.status} and cannot accept payout details`); err.status = 400; throw err;
  }

  // Timeout disabled; no expiry check

  tx.payout = {
    bankName: String(bankName).trim(),
    bankCode: String(bankCode).trim(),
    accountNumber: String(accountNumber).trim(),
    accountName: String(accountName).trim(),
    capturedAt: new Date(),
  };

  await tx.save();

  // Email on payout saved disabled by request

  logger.info?.('Payout saved', {
    paymentId: tx.paymentId,
    sellAmount: tx.sellAmount,
  });

  return {
    paymentId: tx.paymentId,
    status: tx.status,
    token: tx.token,
    network: tx.network,
    sellAmount: tx.sellAmount,
    quote: {
      rate: tx.quoteRate,
      receiveCurrency: tx.receiveCurrency,
      receiveAmount: tx.receiveAmount,
    },
    deposit: {
      address: tx.depositAddress,
      memo: tx.depositMemo || null,
    },
    payout: tx.payout,
  };
}

/* Payout payload normalizer */
function extractPayoutPayload(body) {
  let src = body;
  if (typeof src === 'string') {
    try { src = JSON.parse(src); } catch { /* leave as string */ }
  }
  if (src && typeof src === 'object') {
    if (typeof src.json === 'string') {
      try { src = JSON.parse(src.json); } catch { }
    } else if (typeof src.payout === 'string') {
      try { src = JSON.parse(src.payout); } catch { }
    } else if (src.payout && typeof src.payout === 'object') {
      src = src.payout;
    }
  }
  if (!src || typeof src !== 'object') return null;

  const paymentId = src.paymentId?.toString()?.trim();
  const bankName = src.bankName?.toString()?.trim();
  const bankCode = src.bankCode?.toString()?.trim();
  const accountNumber = src.accountNumber?.toString()?.trim();
  const accountName = src.accountName?.toString()?.trim();

  return { paymentId, bankName, bankCode, accountNumber, accountName };
}

/* Routes */

// Initiate sell - expects authenticateToken in server mounting to set req.user
router.post('/initiate', express.json(), async (req, res) => {
  try {
    const userId = req.user?.id;
    const result = await initiateSell(userId, req.body, logger);
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    const status = err.status || 500;
    logger.error('SELL initiate failed', { status, error: err.message });
    return res.status(status).json({ success: false, message: err.message });
  }
});

// Save payout details
router.post('/payout', express.json(), async (req, res) => {
  try {
    const userId = req.user?.id;

    const extracted = extractPayoutPayload(req.body);
    if (!extracted) {
      return res.status(400).json({
        success: false,
        message: 'Invalid JSON: expected payout parameters in body (object, payout field, or json string).',
      });
    }

    const { paymentId, bankName, bankCode, accountNumber, accountName } = extracted;

    if (!paymentId) return res.status(400).json({ success: false, message: 'paymentId is required' });
    if (!bankName || !bankCode) return res.status(400).json({ success: false, message: 'bankName and bankCode are required' });
    if (!accountNumber || !accountName) return res.status(400).json({ success: false, message: 'accountNumber and accountName are required' });

    const result = await saveSellPayout(userId, { paymentId, bankName, bankCode, accountNumber, accountName });
    return res.status(200).json({ success: true, ...result });
  } catch (err) {
    const status = err.status || 500;
    logger.error('SELL payout failed', { status, error: err.message });
    return res.status(status).json({ success: false, message: err.message });
  }
});

// Validate tolerance: compare observed vs expected token units
router.post('/validate-tolerance', express.json(), async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { paymentId, observedAmount } = req.body;
    if (!paymentId || observedAmount === undefined || isNaN(+observedAmount)) {
      return res.status(400).json({
        success: false,
        message: 'paymentId and observedAmount are required'
      });
    }

    const tx = await ChatbotTx.findOne({ paymentId, userId });
    if (!tx) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    const toleranceCheck = await checkTolerance(
      tx.sellAmount,
      observedAmount,
      tx.token,
      logger
    );

    return res.status(200).json({
      success: true,
      paymentId: tx.paymentId,
      expectedAmount: tx.sellAmount,
      observedAmount: Number(observedAmount),
      tolerance: toleranceCheck
    });

  } catch (err) {
    const status = err.status || 500;
    logger.error('Tolerance validation failed', { status, error: err.message });
    return res.status(status).json({ success: false, message: err.message });
  }
});

// Export just the router (Fixed: was exporting object before)
module.exports = router;

// Export getSellQuote for use in webhook
module.exports.getSellQuote = getSellQuote;