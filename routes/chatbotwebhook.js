// routes/chatbotwebhook.js
// On deposit: resolve user by wallet address (same validation/find-user pattern as obiexwebhooktrx),
// convert to NGNB at offramp rate, credit NGNB wallet. No sell intent, no auto withdrawal.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const User = require('../models/user');
const Transaction = require('../models/transaction');
const webhookAuth = require('../auth/webhookauth');
const logger = require('../utils/logger');
const { sendChatbotDepositEmail } = require('../services/EmailService');

// Offramp conversion: reuse sell.js getSellQuote (token amount → NGNB)
const { getSellQuote } = require('./sell');

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

// Wallet key mapping (must match user.wallets schema / getSellDepositAddress)
const WALLET_KEY_MAPPING = {
  'BTC_BTC': 'BTC_BTC', 'BTC_BITCOIN': 'BTC_BTC',
  'ETH_ETH': 'ETH_ETH', 'ETH_ETHEREUM': 'ETH_ETH',
  'SOL_SOL': 'SOL_SOL', 'SOL_SOLANA': 'SOL_SOL',
  'USDT_ETH': 'USDT_ETH', 'USDT_ETHEREUM': 'USDT_ETH', 'USDT_ERC20': 'USDT_ETH',
  'USDT_TRX': 'USDT_TRX', 'USDT_TRON': 'USDT_TRX', 'USDT_TRC20': 'USDT_TRX',
  'USDT_BSC': 'USDT_BSC', 'USDT_BEP20': 'USDT_BSC', 'USDT_BINANCE': 'USDT_BSC',
  'USDC_ETH': 'USDC_ETH', 'USDC_ETHEREUM': 'USDC_ETH', 'USDC_ERC20': 'USDC_ETH',
  'USDC_BSC': 'USDC_BSC', 'USDC_BEP20': 'USDC_BSC', 'USDC_BINANCE': 'USDC_BSC',
  'BNB_ETH': 'BNB_ETH', 'BNB_ETHEREUM': 'BNB_ETH', 'BNB_ERC20': 'BNB_ETH',
  'BNB_BSC': 'BNB_BSC', 'BNB_BEP20': 'BNB_BSC', 'BNB_BINANCE': 'BNB_BSC',
  'MATIC_ETH': 'MATIC_ETH', 'MATIC_ETHEREUM': 'MATIC_ETH', 'MATIC_ERC20': 'MATIC_ETH', 'MATIC_POLYGON': 'MATIC_ETH',
  'AVAX_BSC': 'AVAX_BSC', 'AVAX_BEP20': 'AVAX_BSC', 'AVAX_BINANCE': 'AVAX_BSC', 'AVAX_AVALANCHE': 'AVAX_BSC',
  'NGNB_NGNB': 'NGNB', 'NGNB': 'NGNB',
};

function getWalletKey(tokenSymbol, network) {
  const key1 = `${String(tokenSymbol).toUpperCase()}_${String(network || '').toUpperCase()}`;
  const key2 = String(tokenSymbol).toUpperCase();
  return WALLET_KEY_MAPPING[key1] || WALLET_KEY_MAPPING[key2] || null;
}

const NETWORK_ALIASES = {
  'BSC': 'BSC', 'BEP20': 'BSC', 'BNB': 'BSC', 'BNB SMART CHAIN': 'BSC',
  'ETH': 'ETH', 'ERC20': 'ETH', 'TRON': 'TRX', 'TRC20': 'TRX', 'SOL': 'SOL',
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
  const balanceField = `${SUPPORTED_TOKENS[currencyUpper]}Balance`;
  const user = await User.findByIdAndUpdate(
    userId,
    { $inc: { [balanceField]: amount }, $set: { lastBalanceUpdate: new Date() } },
    { new: true, runValidators: true }
  );
  if (!user) throw new Error(`User not found: ${userId}`);
  logger.info(`Updated balance for user ${userId}: ${amount > 0 ? '+' : ''}${amount} ${currencyUpper}`);
  return user;
}

/** Convert observed deposit amount to NGNB using offramp rate (sell.js logic). */
async function depositToNgnbAmount(observedAmount, token, log = logger) {
  const tokenU = String(token).toUpperCase();
  const numericAmount = Number(observedAmount);
  if (!isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Invalid observed amount');
  }
  const quote = await getSellQuote({ token: tokenU, amount: numericAmount }, log);
  return {
    actualReceiveAmount: quote.receiveAmount,
    rate: quote.rate,
    breakdown: quote.breakdown,
  };
}

// Configurable rate limit (default 300/min; set CHATBOT_WEBHOOK_RATE_LIMIT per minute, 0 = disabled)
const RATE_LIMIT_PER_MINUTE = Math.max(0, parseInt(process.env.CHATBOT_WEBHOOK_RATE_LIMIT, 10) || 300);
const rl = new Map();
function allow(ip, limit = RATE_LIMIT_PER_MINUTE, windowMs = 60_000) {
  if (limit <= 0) return true;
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
  logger.info('Webhook Transaction - Received Body:', body);

  try {
    if (process.env.WEBHOOK_HMAC_SECRET) {
      const secret = process.env.WEBHOOK_HMAC_SECRET;
      const provided = req.headers['x-hub-signature-256'] || req.headers['x-bramp-signature'];
      if (provided) {
        const payload = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
        const mac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
        if (String(provided).trim() !== `sha256=${mac}`) {
          logger.warn('Invalid HMAC signature for webhook');
          return res.status(401).json({ error: 'Invalid signature' });
        }
      }
    }

    const {
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

    // Validate required fields (aligned with obiexwebhooktrx: type, currency, amount, transactionId, status; for DEPOSIT: address, network)
    const requiredFields = { type, currency, amount, transactionId, status };
    const missingFields = Object.keys(requiredFields).filter((key) => !requiredFields[key]);
    if (type === 'DEPOSIT' && (!address || !network)) {
      if (!address) missingFields.push('address');
      if (!network) missingFields.push('network');
    }
    if (missingFields.length > 0) {
      logger.warn('Webhook Transaction - Missing Fields:', {
        type: !!type,
        currency: !!currency,
        amount: !!amount,
        transactionId: !!transactionId,
        status: !!status,
        address: !!address,
        network: !!network,
      });
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (parseFloat(amount) <= 0) {
      return res.status(400).json({ error: 'Amount must be positive' });
    }

    const normalizedCurrency = String(currency || '').trim().toUpperCase();
    const normalizedNetwork = normalizeNetwork(network);

    if (!SUPPORTED_TOKENS[normalizedCurrency]) {
      logger.warn(`Unsupported currency: ${normalizedCurrency}`);
      return res.status(400).json({ error: `Unsupported currency: ${normalizedCurrency}` });
    }
    if (type !== 'DEPOSIT') {
      return res.status(200).json({ success: true, ignored: true });
    }

    const walletKey = getWalletKey(normalizedCurrency, normalizedNetwork);
    if (!walletKey) {
      return res.status(400).json({ error: `Invalid token/network: ${normalizedCurrency}/${normalizedNetwork}` });
    }

    // Find user by wallet address (crypto tokens only; NGNB is naira balance, no address)
    logger.info(`Looking for user with address ${address} in wallets.${walletKey}.address`);
    const user = await User.findOne({ [`wallets.${walletKey}.address`]: address })
      .select('_id email username firstname')
      .lean();
    if (!user) {
      logger.warn('No user found for deposit address', { address, token: normalizedCurrency, network: normalizedNetwork });
      return res.status(404).json({ error: 'No user found' });
    }

    // Idempotency: already processed deposit for this transactionId
    const existing = await Transaction.findOne({ obiexTransactionId: transactionId, type: 'DEPOSIT' }).lean();
    if (existing) {
      logger.info('Deposit already processed', { transactionId });
      return res.status(200).json({ success: true, message: 'Already processed' });
    }

    const FINAL_OK = new Set(['CONFIRMED', 'SUCCESS', 'COMPLETED']);
    if (!FINAL_OK.has(status)) {
      return res.status(200).json({ success: true, queued: true });
    }

    const observed = parseFloat(amount);
    if (!(observed > 0)) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    let actualReceiveAmount;
    try {
      const calc = await depositToNgnbAmount(observed, normalizedCurrency, logger);
      actualReceiveAmount = calc.actualReceiveAmount;
      logger.info('Deposit → NGNB conversion', {
        token: normalizedCurrency,
        observedAmount: observed,
        ngnbCredited: actualReceiveAmount,
        rate: calc.rate,
      });
    } catch (err) {
      logger.error('Failed to compute NGNB for deposit', { error: err.message, token: normalizedCurrency });
      return res.status(500).json({ error: 'Failed to compute NGNB amount', details: err.message });
    }

    let creditedUser;
    try {
      creditedUser = await updateUserBalance(user._id, 'NGNB', actualReceiveAmount);
    } catch (e) {
      logger.error('Failed to credit NGNB', { error: e.message, userId: user._id });
      return res.status(500).json({ error: 'Failed to credit user NGNB wallet' });
    }

    // Prepare transaction data (same shape as obiexwebhooktrx)
    const updatePayload = {
      userId: user._id,
      type: 'DEPOSIT',
      currency: normalizedCurrency,
      address,
      amount: observed,
      status,
      reference,
      obiexTransactionId: transactionId,
      updatedAt: new Date(),
    };
    if (hash) updatePayload.hash = hash;
    if (network) updatePayload.network = normalizedNetwork;
    updatePayload.narration = narration || 'Deposit converted to NGNB';
    if (source) updatePayload.source = source;
    if (createdAt) updatePayload.createdAt = new Date(createdAt);

    const trxDoc = await Transaction.findOneAndUpdate(
      { obiexTransactionId: transactionId },
      { $set: updatePayload },
      { upsert: true, new: true }
    );
    logger.info(trxDoc.isNew ? 'New transaction created' : 'Transaction updated');

    try {
      if (creditedUser && creditedUser.email) {
        await sendChatbotDepositEmail(
          creditedUser.email,
          creditedUser.username || creditedUser.firstname || 'User',
          observed,
          normalizedCurrency,
          actualReceiveAmount,
          'NGNB',
          transactionId,
          hash || '',
          'confirmed'
        );
      }
    } catch (emailErr) {
      logger.warn('Chatbot deposit email failed', { error: emailErr.message });
    }

    logger.info('Deposit credited as NGNB', {
      userId: user._id,
      token: normalizedCurrency,
      observedAmount: observed,
      ngnbCredited: actualReceiveAmount,
    });

    return res.status(200).json({
      success: true,
      deposit: {
        token: normalizedCurrency,
        network: normalizedNetwork,
        observedAmount: observed,
        ngnbCredited: actualReceiveAmount,
      },
      transaction: trxDoc,
      user: creditedUser, // same as obiexwebhooktrx: return updated user doc
    });
  } catch (error) {
    logger.error('Webhook processing failed', { error: error.message, stack: error.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
