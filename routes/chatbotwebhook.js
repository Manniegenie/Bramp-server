// routes/chatbotwebhooktrx.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const User = require('../models/user');
const Transaction = require('../models/transaction');
const ChatbotTx = require('../models/ChatbotTransaction');
const webhookAuth = require('../auth/webhookauth');
const { debitNaira } = require('../services/nairaWithdrawal');
const { getPricesWithCache } = require('../services/portfolio');
const logger = require('../utils/logger');

// NEW: swap service
const { swapCryptoToNGNX } = require('../services/ObiexSwap');

// NEW: Email service import
const { sendChatbotDepositEmail } = require('../services/EmailService');

// Import rate calculation directly from sell route
const { getSellQuote } = require('./sell');

// NEW: Calculate receive amount using the exact same logic as sell.js
async function calculateActualReceiveAmount(observedAmount, token, log = logger) {
  const tokenU = String(token).toUpperCase();
  const numericAmount = Number(observedAmount);

  if (!isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Invalid observed amount');
  }

  try {
    // Use the exact same getSellQuote function from sell.js
    const quote = await getSellQuote({ token: tokenU, amount: numericAmount }, log);

    log.info?.('Actual receive amount calculated using sell.js logic', {
      token: tokenU,
      observedAmount: numericAmount,
      actualReceiveAmount: quote.receiveAmount,
      rate: quote.rate,
      breakdown: quote.breakdown,
      source: 'getSellQuote from sell.js'
    });

    return {
      actualReceiveAmount: quote.receiveAmount,
      rate: quote.rate,
      breakdown: quote.breakdown
    };
  } catch (error) {
    log.error?.('Failed to calculate actual receive amount using sell.js', {
      error: error.message,
      token: tokenU,
      observedAmount: numericAmount
    });
    throw error;
  }
}

const SUPPORTED_TOKENS = {
  BTC: 'btc',
  ETH: 'eth',
  SOL: 'sol',
  USDT: 'usdt',
  USDC: 'usdc',
  BNB: 'bnb',
  MATIC: 'matic',
  AVAX: 'avax',
  NGNB: 'ngnb',
};

const TOLERANCE_THRESHOLD_USD = 5; // $5 tolerance

const NETWORK_ALIASES = {
  'BSC': 'BSC',
  'BEP20': 'BSC',
  'BNB': 'BSC',
  'BNB SMART CHAIN': 'BSC',
  'ETH': 'ETH',
  'ERC20': 'ETH',
  'TRON': 'TRX',
  'TRC20': 'TRX',
  'SOL': 'SOL',
};
function normalizeNetwork(n) {
  if (!n) return '';
  const key = String(n).trim().toUpperCase();
  return NETWORK_ALIASES[key] || key;
}

async function updateUserBalance(userId, currency, amount) {
  if (!userId || !currency || typeof amount !== 'number') {
    throw new Error('Invalid parameters for balance update');
  }
  const currencyUpper = currency.toUpperCase();
  if (!SUPPORTED_TOKENS[currencyUpper]) {
    throw new Error(`Unsupported currency: ${currencyUpper}`);
  }
  const currencyLower = SUPPORTED_TOKENS[currencyUpper];
  const balanceField = `${currencyLower}Balance`;

  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { [balanceField]: amount }, $set: { lastBalanceUpdate: new Date() } },
    { new: true, runValidators: true }
  );
  if (!user) throw new Error(`User not found: ${userId}`);
  logger.info(`Updated balance for user ${userId}: ${amount > 0 ? '+' : ''}${amount} ${currencyUpper}`);
  return user;
}

// ===== Tolerance (USD-based, deposit-side only) =====
async function checkTolerance(expectedAmount, observedAmount, token, log = logger) {
  const tokenU = String(token).toUpperCase();
  const prices = await getPricesWithCache([tokenU]);
  const usdPerToken = Number(prices[tokenU] || 0);

  if (!usdPerToken || !isFinite(usdPerToken) || usdPerToken <= 0) {
    log.error(`Price unavailable for tolerance check for token ${tokenU}`);
    return { withinTolerance: false, error: 'Price unavailable' };
  }

  const difference = Math.abs(Number(observedAmount) - Number(expectedAmount));
  const differenceInUSD = difference * usdPerToken;
  const withinTolerance = differenceInUSD <= TOLERANCE_THRESHOLD_USD;

  log.info('Tolerance check', {
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Webhook to process transactions for the single-address SELL flow.
 */
// Simple in-memory rate limiter (IP-based)
const rl = new Map(); // ip -> { count, ts }
function allow(ip, limit = 30, windowMs = 60_000) {
  const now = Date.now();
  const rec = rl.get(ip) || { count: 0, ts: now };
  if (now - rec.ts > windowMs) { rec.count = 0; rec.ts = now; }
  rec.count += 1;
  rl.set(ip, rec);
  return rec.count <= limit;
}

router.post('/transaction', webhookAuth, async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || req.connection?.remoteAddress;
  if (!allow(String(ip))) {
    return res.status(429).json({ error: 'Too many requests' });
  }
  const body = req.body || {};
  logger.info('Webhook Transaction - Received Body', body);

  try {
    // Optional HMAC signature verification (if configured)
    try {
      const secret = process.env.WEBHOOK_HMAC_SECRET;
      const provided = req.headers['x-hub-signature-256'] || req.headers['x-bramp-signature'];
      if (secret && provided) {
        const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        const mac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
        const expected = `sha256=${mac}`;
        if (String(provided).trim() !== expected) {
          logger.warn('Invalid HMAC signature for webhook', { provided: String(provided).slice(0, 16) + '...' });
          return res.status(401).json({ error: 'Invalid signature' });
        }
      }
    } catch (sigErr) {
      logger.error('Webhook signature verification error', { error: sigErr.message });
      return res.status(401).json({ error: 'Signature verification failed' });
    }
    let {
      hash,
      type,
      currency,
      address,
      amount,
      status,
      reference,
      transactionId,
      createdAt,
      network,
      narration,
      source,
    } = body;

    type = String(type || '').toUpperCase();
    status = String(status || '').toUpperCase();
    const normalizedCurrency = String(currency || '').trim().toUpperCase();
    const normalizedNetwork = normalizeNetwork(network);

    if (!type || !normalizedCurrency || !amount || !status || !transactionId) {
      logger.warn('Webhook - Missing required fields', {
        hasType: !!type, hasCurrency: !!normalizedCurrency, hasAmount: !!amount,
        hasStatus: !!status, hasTxnId: !!transactionId, hasRef: !!reference
      });
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!SUPPORTED_TOKENS[normalizedCurrency]) {
      logger.warn(`Unsupported currency: ${normalizedCurrency}`);
      return res.status(400).json({ error: `Unsupported currency: ${normalizedCurrency}` });
    }

    if (type !== 'DEPOSIT') {
      logger.info('Webhook - Ignored (not a deposit for SELL flow)', { type, reference });
      return res.status(200).json({ success: true, ignored: true });
    }

    // Address-based matching only (no reference required)
    let sell = null;
    {
      // Optionally disable address-only fallback in production
      if (String(process.env.DISABLE_ADDRESS_FALLBACK || '').toLowerCase() === 'true') {
        logger.warn('Address-only fallback disabled; ignoring deposit without reference');
        return res.status(202).json({ success: false, message: 'Reference required' });
      }
      if (!address) {
        logger.warn('Webhook deposit has no address and no SELL reference; cannot correlate');
        return res.status(202).json({ success: false, message: 'Uncorrelated deposit (no address / no SELL ref)' });
      }

      // Find the newest pending sell intent for this address + token
      const matchQuery = {
        kind: 'SELL',
        token: normalizedCurrency,
        depositAddress: address,
        status: 'PENDING',
        expiresAt: { $gt: new Date() }, // Only process if not expired (12 hour internal expiry)
      };
      // Require memo/tag match if enabled and a memo was supplied for the sell
      if (String(process.env.REQUIRE_MEMO_MATCH || '').toLowerCase() === 'true') {
        matchQuery.depositMemo = { $ne: null };
      }
      // Get only the newest sell intent (address is unique to user, newer replaces older)
      const newestIntent = await ChatbotTx.findOne(matchQuery).sort({ createdAt: -1 });
      const pendingIntents = newestIntent ? [newestIntent] : [];

      if (pendingIntents.length === 0) {
        logger.warn('No pending SELL intents found for address + token', {
          address,
          token: normalizedCurrency
        });
        return res.status(404).json({ error: 'No pending SELL intents found for this deposit' });
      }

      // Check tolerance for each pending intent
      let matchedIntent = null;
      const observed = parseFloat(amount);

      for (const intent of pendingIntents) {
        logger.info(`Checking tolerance for intent ${intent.paymentId}`, {
          expected: intent.sellAmount,
          observed: observed,
          token: intent.token
        });

        try {
          const toleranceResult = await checkTolerance(intent.sellAmount, observed, intent.token, logger);

          if (toleranceResult.error) {
            logger.warn(`Tolerance check failed for intent ${intent.paymentId}`, {
              error: toleranceResult.error
            });
            continue; // Try next intent
          }

          if (toleranceResult.withinTolerance) {
            logger.info(`Found matching intent ${intent.paymentId} within tolerance`, {
              expected: intent.sellAmount,
              observed: observed,
              differenceUSD: toleranceResult.differenceInUSD,
              toleranceThreshold: toleranceResult.toleranceThreshold
            });
            matchedIntent = intent;
            break; // Found our match!
          } else {
            logger.info(`Intent ${intent.paymentId} outside tolerance`, {
              expected: intent.sellAmount,
              observed: observed,
              differenceUSD: toleranceResult.differenceInUSD,
              toleranceThreshold: toleranceResult.toleranceThreshold
            });
          }
        } catch (err) {
          logger.error(`Error checking tolerance for intent ${intent.paymentId}`, {
            error: err.message
          });
        }
      }

      if (!matchedIntent) {
        logger.warn('No pending SELL intent matched within tolerance', {
          address,
          token: normalizedCurrency,
          observedAmount: observed,
          intentCount: pendingIntents.length,
          toleranceThreshold: TOLERANCE_THRESHOLD_USD
        });
        return res.status(404).json({
          error: 'No pending SELL intent matched within tolerance for this deposit',
          observedAmount: observed,
          toleranceThreshold: TOLERANCE_THRESHOLD_USD
        });
      }

      // Use matchedIntent instead of sell
      sell = matchedIntent;
    }

    if (sell.status !== 'PENDING') {
      logger.info(`SELL ${sell.paymentId} already ${sell.status}, ignoring duplicate`);
      return res.status(200).json({ success: true, message: 'Already processed' });
    }

    // Timeout disabled: do not expire sells based on time

    if (sell.depositAddress && address && sell.depositAddress !== address) {
      logger.warn(`SELL ${sell.paymentId} address mismatch`, { expected: sell.depositAddress, got: address });
    }

    const FINAL_OK = new Set(['CONFIRMED', 'SUCCESS', 'COMPLETED']);
    if (!FINAL_OK.has(status)) {
      logger.info(`SELL ${sell.paymentId} awaiting final confirm (status: ${status})`);
      return res.status(200).json({ success: true, queued: true });
    }

    // Confirmed: verify amount
    const observed = parseFloat(amount);
    if (!(observed > 0)) return res.status(400).json({ error: 'Invalid amount' });

    sell.observedAmount = observed;
    sell.observedTxHash = hash || sell.observedTxHash;
    sell.observedAt = new Date();

    // ===========================
    // CRITICAL FIX: Calculate actual receive amount using exact sell.js logic
    // ===========================
    let actualReceiveAmount;
    let actualRate;
    try {
      const calculation = await calculateActualReceiveAmount(observed, sell.token, logger);
      actualReceiveAmount = calculation.actualReceiveAmount;
      actualRate = calculation.rate;

      // Update the sell record with the actual receive amount
      sell.actualReceiveAmount = actualReceiveAmount;
      sell.actualRate = actualRate;

      logger.info(`Recalculated receive amount for SELL ${sell.paymentId} using sell.js logic`, {
        originalSellAmount: sell.sellAmount,
        originalReceiveAmount: sell.receiveAmount,
        observedAmount: observed,
        actualReceiveAmount: actualReceiveAmount,
        difference: actualReceiveAmount - sell.receiveAmount,
        rate: actualRate,
        breakdown: calculation.breakdown
      });

    } catch (calcError) {
      logger.error(`Failed to calculate actual receive amount for SELL ${sell.paymentId}`, {
        error: calcError.message,
        observedAmount: observed,
        token: sell.token
      });
      return res.status(500).json({
        error: 'Failed to calculate receive amount for observed deposit',
        details: calcError.message
      });
    }

    // Optional deviation alert for reference-based processing (> ±20%)
    try {
      if (sell.sellAmount && isFinite(Number(sell.sellAmount))) {
        const expected = Number(sell.sellAmount);
        const diffPct = Math.abs(observed - expected) / (expected || 1);
        if (diffPct > 0.2) {
          logger.warn('Observed deposit deviates >20% from quoted sell amount', {
            paymentId: sell.paymentId,
            expected,
            observed,
            diffPct: +(diffPct * 100).toFixed(2)
          });
        }
      }
    } catch (e) {
      logger.warn('Deviation check failed', { error: e.message });
    }

    // All good → mark confirmed and credit internal NGNB wallet with ACTUAL amount
    sell.status = 'CONFIRMED';
    await sell.save();

    let creditedUser;
    try {
      // Use actualReceiveAmount instead of sell.receiveAmount
      creditedUser = await updateUserBalance(sell.userId, 'NGNB', actualReceiveAmount);
      logger.info(`SELL ${sell.paymentId} credited ACTUAL NGNB ${actualReceiveAmount} to user ${sell.userId} (was quoted ${sell.receiveAmount})`);
    } catch (e) {
      logger.error('Failed to credit NGNB for SELL', { error: e.message, paymentId: sell.paymentId });
      return res.status(500).json({ error: 'Failed to credit user after sell confirmation' });
    }

    // Persist a Transaction row
    const trxDoc = await Transaction.findOneAndUpdate(
      { obiexTransactionId: transactionId },
      {
        $set: {
          userId: sell.userId,
          type: 'DEPOSIT',
          currency: normalizedCurrency,
          network: normalizedNetwork || sell.network,
          address,
          amount: observed,
          status,
          reference,
          hash,
          narration: narration || `SELL ${sell.paymentId} matched`,
          source,
          updatedAt: new Date(),
          createdAt: createdAt ? new Date(createdAt) : new Date(),
        },
      },
      { upsert: true, new: true }
    );

    // ===========================
    // NEW: Send Chatbot Deposit Email with ACTUAL amounts
    // ===========================
    try {
      if (creditedUser && creditedUser.email) {
        await sendChatbotDepositEmail(
          creditedUser.email,
          creditedUser.username || creditedUser.firstName || 'User',
          observed, // depositAmount (actual amount received)
          sell.token, // token
          actualReceiveAmount, // creditAmount (actual NGN credited)
          sell.receiveCurrency || 'NGNX', // creditCurrency
          sell.paymentId, // paymentId
          hash || sell.observedTxHash, // transactionHash
          'confirmed' // status
        );
        logger.info(`Chatbot deposit email sent successfully for SELL ${sell.paymentId}`, {
          userEmail: creditedUser.email,
          userId: sell.userId,
          actualReceiveAmount
        });
      } else {
        logger.warn(`Cannot send chatbot deposit email for SELL ${sell.paymentId}`, {
          hasUser: !!creditedUser,
          hasEmail: !!creditedUser?.email,
          userId: sell.userId
        });
      }
    } catch (emailError) {
      // Don't fail the transaction if email fails
      logger.error(`Failed to send chatbot deposit email for SELL ${sell.paymentId}`, {
        error: emailError.message,
        userId: sell.userId,
        userEmail: creditedUser?.email
      });
    }

    // ===========================
    // Swap crypto → NGNX
    // Use the EXACT observed token amount
    // ===========================
    try {
      const sourceCode = sell.token;      // e.g., 'USDT', 'BTC', ...
      const swapAmount = Number(observed); // exact deposit amount in token units

      logger.info('Preparing swap crypto → NGNX', {
        paymentId: sell.paymentId,
        sourceCode,
        amountCrypto: swapAmount
      });

      const swapRes = await swapCryptoToNGNX({ sourceCode, amount: swapAmount });

      if (!swapRes.success) {
        logger.error('Swap to NGNX failed', {
          paymentId: sell.paymentId,
          statusCode: swapRes.statusCode,
          providerError: swapRes.error || null
        });
        return res.status(502).json({
          success: false,
          message: 'Swap to NGNX failed',
          swapError: swapRes.error || null
        });
      }

      logger.info('Swap accepted, waiting 5s before fiat payout', {
        paymentId: sell.paymentId
      });
      await sleep(5000);
    } catch (swapErr) {
      logger.error('Swap flow failed with exception', {
        paymentId: sell.paymentId,
        error: swapErr.message
      });
      return res.status(502).json({ success: false, message: 'Swap step failed' });
    }

    // ===========================
    // NGNX Bank Payout (after swap) - Use ACTUAL receive amount
    // ===========================
    if (sell.payout?.accountNumber && sell.payout?.bankCode && sell.payout?.accountName && sell.payout?.bankName) {
      try {
        // Use actualReceiveAmount instead of sell.receiveAmount
        const payoutAmountNgnx = Math.round(Number(actualReceiveAmount) || 0); // NGNX amount (1:1 with NGN)
        if (!(payoutAmountNgnx > 0)) {
          logger.error(`Invalid payout NGNX amount for SELL ${sell.paymentId}`, {
            actualReceiveAmount: actualReceiveAmount,
            originalReceiveAmount: sell.receiveAmount
          });
        } else {
          logger.info(`Initiating payout (NGNX) for SELL ${sell.paymentId}`, {
            amountNGNX: payoutAmountNgnx,
            bankName: sell.payout.bankName,
            accountNumber: sell.payout.accountNumber,
            originalQuoted: sell.receiveAmount,
            actualAmount: actualReceiveAmount
          });

          const payoutResult = await debitNaira(
            {
              destination: {
                accountNumber: sell.payout.accountNumber,
                accountName: sell.payout.accountName,
                bankName: sell.payout.bankName,
                bankCode: sell.payout.bankCode,
              },
              amount: payoutAmountNgnx,   // ACTUAL NGNX amount based on observed deposit
              currency: 'NGNX',           // IMPORTANT: ensure service sends NGNX to Obiex
              narration: `Sell ${sell.paymentId}`,
            },
            { chatbotPaymentId: sell.paymentId, userId: sell.userId.toString() }
          );

          if (payoutResult?.success) {
            logger.info(`Payout (NGNX) initiated successfully for SELL ${sell.paymentId}`, {
              providerId: payoutResult.data?.id,
              reference: payoutResult.data?.reference,
              status: payoutResult.data?.status,
              actualAmount: payoutAmountNgnx
            });
          } else {
            logger.error(`Payout (NGNX) initiation failed for SELL ${sell.paymentId}`, {
              message: payoutResult?.message,
              statusCode: payoutResult?.statusCode
            });
          }
        }
      } catch (payoutErr) {
        logger.error('Payout initiation failed', {
          error: payoutErr.message,
          paymentId: sell.paymentId,
          stack: payoutErr.stack
        });
        // Wallet credited; user can retry payout later.
      }
    } else {
      logger.info(`SELL ${sell.paymentId} confirmed but no payout details available`, {
        hasPayout: !!sell.payout,
        hasAccountNumber: !!sell.payout?.accountNumber,
        hasBankCode: !!sell.payout?.bankCode,
        hasAccountName: !!sell.payout?.accountName,
        hasBankName: !!sell.payout?.bankName
      });
    }

    return res.status(200).json({
      success: true,
      sell: {
        paymentId: sell.paymentId,
        status: sell.status,
        token: sell.token,
        network: sell.network,
        sellAmount: sell.sellAmount,
        receiveAmount: sell.receiveAmount, // original quoted amount
        actualReceiveAmount: actualReceiveAmount, // NEW: actual amount based on deposit
        receiveCurrency: sell.receiveCurrency, // NGNX
        observedAmount: sell.observedAmount,
        observedTxHash: sell.observedTxHash,
        observedAt: sell.observedAt,
        payout: sell.payout || null,
        payoutStatus: sell.payoutStatus,
      },
      transaction: trxDoc,
      user: {
        id: creditedUser.id,
        ngnbBalance: creditedUser.ngnbBalance,
        lastBalanceUpdate: creditedUser.lastBalanceUpdate,
      },
    });

  } catch (error) {
    logger.error('Webhook processing failed', { error: error.message, stack: error.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
