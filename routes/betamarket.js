'use strict';

const express          = require('express');
const router           = express.Router();
const bcrypt           = require('bcryptjs');
const logger           = require('../utils/logger');
const User             = require('../models/user');
const Prediction       = require('../models/Prediction');
const PriceChange      = require('../models/pricechange');
const { swapNGNBtoUSDC }        = require('../services/NGNBSwap');
const { withdrawUSDCToArbitrum } = require('../services/ObiexWithdraw');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { getOnrampRate }         = require('../services/onramppriceservice');

// Arbitrum address that receives USDC after each NGNB→USDC swap.
// This address funds the Hyperliquid trading account used for BetaMarket positions.
const BETAMARKET_USDC_ADDRESS = process.env.BETAMARKET_USDC_ADDRESS;

// ── Hyperliquid perps trading client (optional — only if HL_PRIVATE_KEY set) ──

let _hlPerps = null;
function getHLPerps() {
  if (_hlPerps) return _hlPerps;
  if (!process.env.HL_PRIVATE_KEY) return null;
  try { _hlPerps = require('../services/hyperliquid'); } catch (e) {
    logger.warn('betamarket: hyperliquid.js not loadable', { error: e.message });
  }
  return _hlPerps;
}

// ── Hyperliquid price oracle ───────────────────────────────────────────────────

let _hlInfo = null;

async function getHL() {
  if (!_hlInfo) {
    const { InfoClient, HttpTransport } = await import('@nktkas/hyperliquid');
    _hlInfo = new InfoClient({ transport: new HttpTransport() });
  }
  return _hlInfo;
}

async function getMidsWithFallback(symbols) {
  try {
    const hl      = await getHL();
    const allMids = await hl.allMids();
    if (symbols.some(s => allMids[s] !== undefined)) return { mids: allMids, source: 'hyperliquid' };
    throw new Error('No matching symbols in HL response');
  } catch (hlErr) {
    logger.warn('BetaMarket: Hyperliquid unavailable, falling back to Binance DB', { error: hlErr.message });
    _hlInfo = null;
    const prices = {};
    await Promise.all(
      symbols.map(async s => {
        const doc = await PriceChange.findOne({ symbol: s }).sort({ timestamp: -1 }).lean();
        if (doc) prices[s] = doc.price;
      })
    );
    return { mids: prices, source: 'binance_fallback' };
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MARKET_TOKENS = ['BTC', 'ETH', 'SOL', 'BNB', 'MATIC', 'AVAX'];

// Platform-defined multiplier options shown on every market card.
// Users pick the one matching their risk appetite — no custom input.
const PLATFORM_MULTIPLIERS = [1.7, 2, 5, 10];

// Illustrative price-move % shown on each market card.
// These are reference points only — they show what a typical move looks like
// at each leverage tier so users can visualise the position.
// Settlement does NOT check whether this price was reached.
// Settlement uses actual HL P&L: (closePrice - openPrice) / openPrice × leverage.
//
// Short windows calibrated to ~1× realized σ. Long windows (3M/6M) calibrated
// to typical crypto directional moves over those horizons.
const ILLUSTRATIVE_PCT = {
  BTC: {
    '1H':  { 1.7: 0.6,  2: 0.8,  5: 1.5,  10: 2.5  },
    '4H':  { 1.7: 1.2,  2: 1.6,  5: 3.0,  10: 5.0  },
    '24H': { 1.7: 3.5,  2: 5.0,  5: 8.0,  10: 15.0 },
    '3M':  { 1.7: 15,   2: 20,   5: 35,   10: 55   },
    '6M':  { 1.7: 25,   2: 35,   5: 55,   10: 80   },
  },
  ETH: {
    '1H':  { 1.7: 0.8,  2: 1.0,  5: 1.8,  10: 3.0  },
    '4H':  { 1.7: 1.5,  2: 2.0,  5: 3.5,  10: 6.0  },
    '24H': { 1.7: 4.0,  2: 6.0,  5: 10.0, 10: 18.0 },
    '3M':  { 1.7: 20,   2: 28,   5: 45,   10: 70   },
    '6M':  { 1.7: 35,   2: 45,   5: 70,   10: 100  },
  },
  SOL: {
    '1H':  { 1.7: 1.0,  2: 1.2,  5: 2.2,  10: 3.5  },
    '4H':  { 1.7: 2.0,  2: 2.5,  5: 4.5,  10: 7.5  },
    '24H': { 1.7: 5.0,  2: 7.0,  5: 12.0, 10: 22.0 },
    '3M':  { 1.7: 25,   2: 35,   5: 55,   10: 85   },
    '6M':  { 1.7: 40,   2: 55,   5: 85,   10: 120  },
  },
  BNB: {
    '1H':  { 1.7: 0.8,  2: 1.0,  5: 1.8,  10: 3.0  },
    '4H':  { 1.7: 1.5,  2: 2.0,  5: 3.5,  10: 6.0  },
    '24H': { 1.7: 4.0,  2: 6.0,  5: 10.0, 10: 18.0 },
    '3M':  { 1.7: 20,   2: 28,   5: 45,   10: 70   },
    '6M':  { 1.7: 35,   2: 45,   5: 70,   10: 100  },
  },
  MATIC: {
    '1H':  { 1.7: 1.0,  2: 1.3,  5: 2.5,  10: 4.0  },
    '4H':  { 1.7: 2.0,  2: 2.8,  5: 5.0,  10: 8.5  },
    '24H': { 1.7: 5.5,  2: 7.5,  5: 13.0, 10: 24.0 },
    '3M':  { 1.7: 28,   2: 38,   5: 60,   10: 90   },
    '6M':  { 1.7: 45,   2: 60,   5: 90,   10: 130  },
  },
  AVAX: {
    '1H':  { 1.7: 1.0,  2: 1.3,  5: 2.5,  10: 4.0  },
    '4H':  { 1.7: 2.0,  2: 2.8,  5: 5.0,  10: 8.5  },
    '24H': { 1.7: 5.5,  2: 7.5,  5: 13.0, 10: 24.0 },
    '3M':  { 1.7: 28,   2: 38,   5: 60,   10: 90   },
    '6M':  { 1.7: 45,   2: 60,   5: 90,   10: 130  },
  },
};

const PLATFORM_FEE  = 100;          // flat ₦100 per prediction — sole platform revenue
const MIN_STAKE_USD = 10;           // $10 USDC minimum — matches HL minimum notional
const MAX_STAKE     = 10_000_000;
const MAX_PAYOUT    = 10_000_000;
const MAX_PICKS     = 6;

const WINDOW_MS = {
  '1H':  3_600_000,
  '4H':  14_400_000,
  '24H': 86_400_000,
  '3M':  90  * 24 * 3_600_000,  // 90 days
  '6M':  180 * 24 * 3_600_000,  // 180 days
};

// ── Price-at-time helper (same logic as settlement cron) ─────────────────────

async function getPriceAtOrBefore(symbol, deadline) {
  const doc = await PriceChange.findOne({
    symbol:    symbol.toUpperCase(),
    timestamp: { $lte: deadline },
  }).sort({ timestamp: -1 }).lean();
  return doc ? doc.price : null;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function validWindow(w) { return WINDOW_MS[w] ? w : '1H'; }

function getRoundBounds(window) {
  const ms    = WINDOW_MS[window];
  const start = Math.floor(Date.now() / ms) * ms;
  return { roundStart: new Date(start), roundEnd: new Date(start + ms) };
}

function makeMarketId(symbol, window, roundStart) {
  return `${symbol}-${window}-${roundStart.getTime()}`;
}

// Build display options for each leverage tier.
// targetPct / targetPriceUp / targetPriceDown are illustrative reference prices —
// they show users what a typical move looks like at this leverage, NOT a win condition.
function buildOptions(symbol, window, currentPrice) {
  return PLATFORM_MULTIPLIERS.map(multiplier => {
    const targetPct = ILLUSTRATIVE_PCT[symbol]?.[window]?.[multiplier] ?? 1.0;
    return {
      multiplier,
      targetPct,
      targetPriceUp:   currentPrice
        ? parseFloat((currentPrice * (1 + targetPct / 100)).toFixed(2))
        : null,
      targetPriceDown: currentPrice
        ? parseFloat((currentPrice * (1 - targetPct / 100)).toFixed(2))
        : null,
    };
  });
}

// Min stake in NGNB = $10 at the admin on-ramp rate
async function getMinStakeNGNB() {
  try {
    const rate = await getOnrampRate();
    return Math.ceil(MIN_STAKE_USD * rate.finalPrice);
  } catch {
    return 16_000; // fallback ~$10 at ₦1,600
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function aggregateParticipants(marketIds) {
  if (!marketIds.length) return {};
  const rows = await Prediction.aggregate([
    { $match: { status: { $in: ['pending', 'settling'] }, 'picks.marketId': { $in: marketIds } } },
    { $unwind: '$picks' },
    { $match: { 'picks.marketId': { $in: marketIds } } },
    { $group: { _id: '$picks.marketId', count: { $sum: 1 } } },
  ]);
  const map = {};
  for (const r of rows) map[r._id] = r.count;
  return map;
}

async function getSparklines(symbols, points = 10) {
  const rows = await PriceChange.aggregate([
    { $match: { symbol: { $in: symbols.map(s => s.toUpperCase()) } } },
    { $sort:  { timestamp: -1 } },
    { $group: { _id: '$symbol', prices: { $push: '$price' } } },
    { $project: { prices: { $slice: ['$prices', points] } } },
  ]);
  const map = {};
  for (const row of rows) map[row._id] = row.prices.slice().reverse();
  return map;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /betamarket/markets?window=1H|4H|24H
 *
 * Each market carries a pre-built options array (one per platform multiplier).
 * Frontend renders them as a row of tappable buttons — no user config required.
 */
router.get('/markets', async (req, res) => {
  const window = validWindow(req.query.window);

  try {
    const [{ mids }, sparklines, minStake] = await Promise.all([
      getMidsWithFallback(MARKET_TOKENS),
      getSparklines(MARKET_TOKENS),
      getMinStakeNGNB(),
    ]);

    const { roundStart, roundEnd } = getRoundBounds(window);
    const marketIds    = MARKET_TOKENS.map(s => makeMarketId(s, window, roundStart));
    const participants = await aggregateParticipants(marketIds);

    const markets = MARKET_TOKENS.map(symbol => {
      const currentPrice = mids[symbol] ? parseFloat(mids[symbol]) : null;
      const mId          = makeMarketId(symbol, window, roundStart);

      return {
        id:           mId,
        symbol,
        window,
        currentPrice,
        options:      buildOptions(symbol, window, currentPrice),
        participants: participants[mId] || 0,
        sparkline:    sparklines[symbol] || [],
        roundStart:   roundStart.toISOString(),
        endTime:      roundEnd.getTime(),
      };
    });

    res.json({
      success: true,
      data: {
        markets,
        window,
        multipliers: PLATFORM_MULTIPLIERS,
        minStake,
        fetchedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    logger.error('BetaMarket /markets error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch markets' });
  }
});

/**
 * POST /betamarket/predict
 *
 * Body: {
 *   picks: [{
 *     symbol:     'BTC' | 'ETH' | ...
 *     direction:  'up' | 'down'
 *     window:     '1H' | '4H' | '24H'
 *     multiplier: 2 | 5 | 10
 *   }],
 *   stake:          number,
 *   idempotencyKey: string,
 *   passwordpin:    string,
 *   twoFactorCode:  string
 * }
 */
router.post('/predict', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const { picks: rawPicks, stake, idempotencyKey, passwordpin, twoFactorCode } = req.body;

  // ── Input validation ──────────────────────────────────────────────────────

  if (!Array.isArray(rawPicks) || rawPicks.length === 0) {
    return res.status(400).json({ success: false, error: 'picks must be a non-empty array' });
  }
  if (rawPicks.length > MAX_PICKS) {
    return res.status(400).json({ success: false, error: `Maximum ${MAX_PICKS} picks per prediction` });
  }

  const stakeNum = parseFloat(stake);
  if (!stakeNum || isNaN(stakeNum) || stakeNum <= 0) {
    return res.status(400).json({ success: false, error: 'Invalid stake amount' });
  }
  if (stakeNum > MAX_STAKE) {
    return res.status(400).json({ success: false, error: `Maximum stake is ₦${MAX_STAKE.toLocaleString()}` });
  }

  const seenMarkets = new Set();
  for (const p of rawPicks) {
    if (!MARKET_TOKENS.includes(p.symbol)) {
      return res.status(400).json({ success: false, error: `Unsupported symbol: ${p.symbol}` });
    }
    if (!WINDOW_MS[p.window]) {
      return res.status(400).json({ success: false, error: 'window must be 1H, 4H, or 24H' });
    }
    if (!['up', 'down'].includes(p.direction)) {
      return res.status(400).json({ success: false, error: 'direction must be up or down' });
    }
    if (!PLATFORM_MULTIPLIERS.includes(Number(p.multiplier))) {
      return res.status(400).json({ success: false, error: `multiplier must be one of: ${PLATFORM_MULTIPLIERS.join(', ')}` });
    }
    const key = `${p.symbol}-${p.window}`;
    if (seenMarkets.has(key)) {
      return res.status(400).json({ success: false, error: `Duplicate pick: ${p.symbol} ${p.window}` });
    }
    seenMarkets.add(key);
  }

  try {
    // ── Min stake check ───────────────────────────────────────────────────────
    const minStake = await getMinStakeNGNB();
    if (stakeNum < minStake) {
      return res.status(400).json({
        success: false,
        error:   'INSUFFICIENT_STAKE',
        message: `Minimum stake is ₦${minStake.toLocaleString()} ($${MIN_STAKE_USD} USDC equivalent)`,
      });
    }

    // ── Idempotency ───────────────────────────────────────────────────────────
    if (idempotencyKey) {
      const existing = await Prediction.findOne({ userId, idempotencyKey }).lean();
      if (existing) return res.status(200).json({ success: true, data: existing, duplicate: true });
    }

    // ── Auth ──────────────────────────────────────────────────────────────────
    const user = await User.findById(userId)
      .select('ngnbBalance ngnbPendingBalance passwordpin twoFactorSecret twoFactorEnabled')
      .lean();
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    if (!user.passwordpin) {
      return res.status(403).json({ success: false, error: 'PIN_NOT_SET_UP', message: 'Set up your Password PIN in Profile first.' });
    }
    if (!passwordpin) {
      return res.status(400).json({ success: false, error: 'PIN_REQUIRED' });
    }
    const pinValid = await bcrypt.compare(String(passwordpin), user.passwordpin);
    if (!pinValid) {
      return res.status(401).json({ success: false, error: 'INVALID_PIN', message: 'Incorrect PIN. Please try again.' });
    }

    if (user.twoFactorEnabled) {
      if (!twoFactorCode) return res.status(400).json({ success: false, error: '2FA_REQUIRED' });
      if (!validateTwoFactorAuth(user, String(twoFactorCode))) {
        return res.status(403).json({ success: false, error: 'INVALID_2FA', message: 'Invalid 2FA code. Please try again.' });
      }
    }

    // ── Balance check ─────────────────────────────────────────────────────────
    const totalRequired = stakeNum + PLATFORM_FEE;
    const available     = Math.max(0, (user.ngnbBalance || 0) - (user.ngnbPendingBalance || 0));
    if (available < totalRequired) {
      return res.status(400).json({
        success: false,
        error:   'INSUFFICIENT_BALANCE',
        message: `Insufficient balance. Available: ₦${available.toFixed(2)}, Required: ₦${totalRequired.toFixed(2)} (stake + ₦${PLATFORM_FEE} fee)`,
      });
    }

    // ── Fetch live prices + resolve picks with locked target prices ───────────
    const symbols = [...new Set(rawPicks.map(p => p.symbol))];
    const { mids } = await getMidsWithFallback(symbols);

    const resolvedPicks = rawPicks.map(p => {
      const { roundStart, roundEnd } = getRoundBounds(p.window);
      const mId          = makeMarketId(p.symbol, p.window, roundStart);
      const currentPrice = mids[p.symbol] ? parseFloat(mids[p.symbol]) : null;
      const multiplier   = Number(p.multiplier);
      // Illustrative reference price — shown in the UI, NOT used for settlement.
      // Settlement uses actual (closePrice - openPrice) / openPrice × multiplier.
      const targetPct   = ILLUSTRATIVE_PCT[p.symbol]?.[p.window]?.[multiplier] ?? 1.0;
      const targetPrice = currentPrice
        ? parseFloat((currentPrice * (1 + (p.direction === 'up' ? 1 : -1) * targetPct / 100)).toFixed(2))
        : null;

      return {
        symbol:        p.symbol,
        direction:     p.direction,
        window:        p.window,
        multiplier,
        marketId:      mId,
        roundStart,
        roundEnd,
        targetPct,
        targetPrice,
        entryPriceUSD: currentPrice,
        odds:          multiplier,
      };
    });

    // potentialPayout: sum of per-pick P&L if each pick's asset moves exactly the illustrative %
    // maxPayout: same but at 3× the illustrative move — gives users a realistic upside range
    // Neither value is guaranteed — actual settlement uses real HL price data.
    const stakePerPick    = stakeNum / resolvedPicks.length;
    const potentialPayout = parseFloat(Math.min(
      resolvedPicks.reduce((sum, p) =>
        sum + stakePerPick * (1 + p.multiplier * (p.targetPct / 100)), 0),
      MAX_PAYOUT
    ).toFixed(2));
    const maxPayout = parseFloat(Math.min(
      resolvedPicks.reduce((sum, p) =>
        sum + stakePerPick * (1 + p.multiplier * (p.targetPct * 3 / 100)), 0),
      MAX_PAYOUT
    ).toFixed(2));
    // Combined leverage display (product of all multipliers) — informational only
    const totalOdds = resolvedPicks.reduce((acc, p) => acc * p.multiplier, 1);

    // ── Atomic balance debit ──────────────────────────────────────────────────
    const debited = await User.findOneAndUpdate(
      { _id: userId, ngnbBalance: { $gte: totalRequired } },
      { $inc: { ngnbBalance: -totalRequired } },
      { new: false },
    );
    if (!debited) {
      logger.warn('BetaMarket: balance debit failed (race condition)', { userId, totalRequired });
      return res.status(400).json({ success: false, error: 'Balance changed — please retry' });
    }

    // ── NGNB → USDC swap (best-effort) ───────────────────────────────────────
    const swapResult = await swapNGNBtoUSDC(stakeNum);
    if (!swapResult.success) {
      logger.warn('BetaMarket: NGNB→USDC swap failed', { userId, stakeNum, error: swapResult.error });
    } else {
      logger.info('BetaMarket: NGNB→USDC swap succeeded', {
        userId, ngnbStake: stakeNum, usdcAmount: swapResult.usdcAmount,
      });

      // Fire-and-forget: withdraw USDC to the platform's Arbitrum address so it
      // reaches the Hyperliquid account that funds BetaMarket positions.
      // Runs after response is sent — a withdrawal failure is logged but never
      // blocks the user's prediction from being recorded.
      if (BETAMARKET_USDC_ADDRESS && swapResult.usdcAmount) {
        setImmediate(() => {
          withdrawUSDCToArbitrum(
            BETAMARKET_USDC_ADDRESS,
            swapResult.usdcAmount,
            'BetaMarket position funding',
          ).then(r => {
            if (r.success) {
              logger.info('BetaMarket: USDC withdrawal to Arbitrum submitted', {
                userId, usdcAmount: swapResult.usdcAmount, txId: r.transactionId,
              });
            } else {
              logger.error('BetaMarket: USDC withdrawal to Arbitrum failed', {
                userId, usdcAmount: swapResult.usdcAmount, error: r.error,
              });
            }
          }).catch(err => {
            logger.error('BetaMarket: USDC withdrawal unexpected error', { userId, error: err.message });
          });
        });
      } else if (!BETAMARKET_USDC_ADDRESS) {
        logger.warn('BetaMarket: BETAMARKET_USDC_ADDRESS not set — USDC withdrawal skipped', { userId });
      }
    }

    // ── Persist ───────────────────────────────────────────────────────────────
    const prediction = await Prediction.create({
      userId,
      picks:           resolvedPicks,
      stake:           stakeNum,
      totalOdds:       parseFloat(totalOdds.toFixed(4)),
      potentialPayout,
      maxPayout,
      status:          'pending',
      usdcAmount:      swapResult.usdcAmount,
      obiexQuoteId:    swapResult.quoteId,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    logger.info('BetaMarket position opened', {
      userId:       userId.toString(),
      predictionId: prediction._id.toString(),
      picks:        resolvedPicks.map(p =>
        `${p.symbol} ${p.direction} ${p.window} ${p.multiplier}x entry=${p.entryPriceUSD}`
      ),
      ngnbStake:    stakeNum,
      usdcMargin:   swapResult.usdcAmount,
    });

    res.status(201).json({ success: true, data: prediction });
  } catch (err) {
    logger.error('BetaMarket /predict error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to place prediction' });
  }
});

/**
 * GET /betamarket/my-bets
 */
router.get('/my-bets', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

  try {
    const bets = await Prediction.find({ userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ success: true, data: bets });
  } catch (err) {
    logger.error('BetaMarket /my-bets error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch bets' });
  }
});

/**
 * GET /betamarket/prices?symbols=BTC,ETH,SOL
 * Lightweight live-price endpoint for cashout P&L polling on the frontend.
 */
router.get('/prices', async (req, res) => {
  const raw     = req.query.symbols;
  const symbols = raw
    ? raw.split(',').map(s => s.trim().toUpperCase()).filter(s => MARKET_TOKENS.includes(s))
    : MARKET_TOKENS;

  try {
    const { mids } = await getMidsWithFallback(symbols);
    const prices   = {};
    for (const s of symbols) {
      if (mids[s] != null) prices[s] = parseFloat(mids[s]);
    }
    res.json({ success: true, data: prices });
  } catch (err) {
    logger.error('BetaMarket /prices error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch prices' });
  }
});

/**
 * POST /betamarket/cashout
 *
 * Early settlement at live price. Available once cumulative P&L has reached
 * 50% of the illustrative P&L target (potentialPayout − stake).
 *
 * Body: { predictionId, passwordpin }
 */
router.post('/cashout', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const { predictionId, passwordpin } = req.body;
  if (!predictionId || !passwordpin) {
    return res.status(400).json({ success: false, error: 'predictionId and passwordpin required' });
  }

  // ── PIN check ──────────────────────────────────────────────────────────────
  const user = await User.findById(userId).select('passwordpin').lean();
  if (!user) return res.status(404).json({ success: false, error: 'User not found' });

  const pinValid = await bcrypt.compare(String(passwordpin), user.passwordpin);
  if (!pinValid) {
    return res.status(401).json({ success: false, error: 'INVALID_PIN', message: 'Incorrect PIN.' });
  }

  const now = new Date();

  // ── Lock prediction atomically ─────────────────────────────────────────────
  const bet = await Prediction.findOneAndUpdate(
    { _id: predictionId, userId, status: 'pending' },
    { $set: { status: 'settling' } },
    { new: true },
  ).lean();

  if (!bet) {
    return res.status(404).json({ success: false, error: 'Position not found or already settled' });
  }

  // ── All rounds must have started ───────────────────────────────────────────
  if (!bet.picks.every(p => new Date(p.roundStart) <= now)) {
    await Prediction.findByIdAndUpdate(bet._id, { $set: { status: 'pending' } });
    return res.status(400).json({ success: false, error: 'ROUND_NOT_STARTED', message: 'Position has not started yet.' });
  }

  // ── Fetch live prices ──────────────────────────────────────────────────────
  const symbols = [...new Set(bet.picks.map(p => p.symbol))];
  let mids;
  try {
    ({ mids } = await getMidsWithFallback(symbols));
  } catch (err) {
    await Prediction.findByIdAndUpdate(bet._id, { $set: { status: 'pending' } });
    return res.status(503).json({ success: false, error: 'PRICE_UNAVAILABLE', message: 'Live price feed unavailable. Try again shortly.' });
  }

  // ── Calculate P&L per pick using round-open price ─────────────────────────
  const stakePerPick = bet.stake / bet.picks.length;
  const pickUpdates  = [];

  for (const pick of bet.picks) {
    const openPrice  = await getPriceAtOrBefore(pick.symbol, new Date(pick.roundStart));
    const closePrice = mids[pick.symbol] ? parseFloat(mids[pick.symbol]) : null;

    if (!openPrice || !closePrice) {
      await Prediction.findByIdAndUpdate(bet._id, { $set: { status: 'pending' } });
      return res.status(400).json({ success: false, error: 'PRICE_DATA_MISSING', message: `Price data missing for ${pick.symbol}.` });
    }

    const rawReturn      = (closePrice - openPrice) / openPrice;
    const directedReturn = pick.direction === 'up' ? rawReturn : -rawReturn;
    const leveragedReturn = directedReturn * pick.multiplier;
    const settledReturn  = Math.max(-1, leveragedReturn);
    const pickPayout     = parseFloat((stakePerPick * (1 + settledReturn)).toFixed(2));

    pickUpdates.push({
      marketId:         pick.marketId,
      result:           settledReturn >= 0 ? 'won' : 'lost',
      actualMultiplier: parseFloat((1 + settledReturn).toFixed(4)),
      pickPayout,
      openPriceUSD:     openPrice,
      closePriceUSD:    closePrice,
    });
  }

  // ── Enforce 50% of illustrative P&L threshold (server-side guard) ─────────
  const totalCurrentPayout = parseFloat(pickUpdates.reduce((s, p) => s + p.pickPayout, 0).toFixed(2));
  const illustrativePnl    = bet.potentialPayout - bet.stake;
  const currentPnl         = totalCurrentPayout - bet.stake;

  if (currentPnl < illustrativePnl * 0.5) {
    await Prediction.findByIdAndUpdate(bet._id, { $set: { status: 'pending' } });
    return res.status(400).json({
      success: false,
      error:   'CASHOUT_THRESHOLD_NOT_MET',
      message: 'Cashout requires at least 50% of the illustrative P&L target.',
    });
  }

  // ── Close HL position ──────────────────────────────────────────────────────
  const hlPerps = getHLPerps();
  if (hlPerps && bet.hlPositionSide) {
    for (const symbol of symbols) {
      try {
        await hlPerps.closePosition(symbol);
        logger.info(`BetaMarket cashout: closed HL position for ${symbol}`);
      } catch (err) {
        logger.error(`BetaMarket cashout: failed to close HL position for ${symbol}`, { error: err.message });
      }
    }
  }

  // ── Persist settlement ─────────────────────────────────────────────────────
  const actualTotalOdds = parseFloat((totalCurrentPayout / bet.stake).toFixed(4));
  const betStatus       = totalCurrentPayout >= bet.stake ? 'won' : 'lost';

  const arrayFilters = [];
  const setOps = {
    status:          betStatus,
    settledAt:       now,
    actualTotalOdds,
    actualPayout:    totalCurrentPayout,
    cashedOut:       true,
    cashedOutAt:     now,
  };

  pickUpdates.forEach((pu, i) => {
    arrayFilters.push({ [`elem${i}.marketId`]: pu.marketId });
    setOps[`picks.$[elem${i}].result`]           = pu.result;
    setOps[`picks.$[elem${i}].actualMultiplier`] = pu.actualMultiplier;
    setOps[`picks.$[elem${i}].openPriceUSD`]     = pu.openPriceUSD;
    setOps[`picks.$[elem${i}].closePriceUSD`]    = pu.closePriceUSD;
  });

  const settled = await Prediction.findByIdAndUpdate(
    bet._id, { $set: setOps }, { arrayFilters, new: true },
  ).lean();

  if (totalCurrentPayout > 0) {
    await User.findByIdAndUpdate(bet.userId, { $inc: { ngnbBalance: totalCurrentPayout } });
  }

  logger.info(`BetaMarket: cashed out ${bet._id} → ${betStatus}`, {
    userId:         bet.userId.toString(),
    stake:          bet.stake,
    actualPayout:   totalCurrentPayout,
    actualTotalOdds,
  });

  res.json({ success: true, data: settled });
});

module.exports = router;
