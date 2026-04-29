'use strict';

const express          = require('express');
const router           = express.Router();
const bcrypt           = require('bcryptjs');
const logger           = require('../utils/logger');
const User             = require('../models/user');
const Prediction       = require('../models/Prediction');
const PriceChange      = require('../models/pricechange');
const { swapNGNBtoUSDC }        = require('../services/NGNBSwap');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');
const { getOnrampRate }         = require('../services/onramppriceservice');

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

// Target % move required to win per asset × window × multiplier.
// Calibrated to approximate win rates:
//   2x  → ~30% win rate   (moderate, often in reach on active days)
//   5x  → ~15% win rate   (requires conviction + momentum)
//   10x → ~8%  win rate   (outlier moves, high-reward believers)
// Target % move required to win per asset × window × multiplier.
// Calibrated approximate win rates:
//   1.7x → ~55% win rate  (small move, accessible — most will win)
//   2x   → ~35% win rate  (moderate conviction required)
//   5x   → ~15% win rate  (strong move, high reward)
//   10x  → ~8%  win rate  (outlier moves only)
const TARGET_PCT = {
  BTC: {
    '1H':  { 1.7: 0.6,  2: 1.5,  5: 3.5,  10: 7.0  },
    '4H':  { 1.7: 1.2,  2: 3.0,  5: 7.0,  10: 14.0 },
    '24H': { 1.7: 2.0,  2: 5.0,  5: 12.0, 10: 22.0 },
  },
  ETH: {
    '1H':  { 1.7: 0.8,  2: 2.0,  5: 4.5,  10: 9.0  },
    '4H':  { 1.7: 1.6,  2: 4.0,  5: 9.0,  10: 18.0 },
    '24H': { 1.7: 3.0,  2: 7.0,  5: 15.0, 10: 28.0 },
  },
  SOL: {
    '1H':  { 1.7: 1.2,  2: 3.0,  5: 7.0,  10: 14.0 },
    '4H':  { 1.7: 2.5,  2: 6.0,  5: 14.0, 10: 28.0 },
    '24H': { 1.7: 4.0,  2: 10.0, 5: 22.0, 10: 40.0 },
  },
  BNB: {
    '1H':  { 1.7: 0.8,  2: 2.0,  5: 4.5,  10: 9.0  },
    '4H':  { 1.7: 1.6,  2: 4.0,  5: 9.0,  10: 18.0 },
    '24H': { 1.7: 3.0,  2: 7.0,  5: 15.0, 10: 28.0 },
  },
  MATIC: {
    '1H':  { 1.7: 1.0,  2: 2.5,  5: 6.0,  10: 12.0 },
    '4H':  { 1.7: 2.0,  2: 5.0,  5: 12.0, 10: 24.0 },
    '24H': { 1.7: 3.5,  2: 9.0,  5: 20.0, 10: 38.0 },
  },
  AVAX: {
    '1H':  { 1.7: 1.0,  2: 2.5,  5: 6.0,  10: 12.0 },
    '4H':  { 1.7: 2.0,  2: 5.0,  5: 12.0, 10: 24.0 },
    '24H': { 1.7: 3.5,  2: 9.0,  5: 20.0, 10: 38.0 },
  },
};

const PLATFORM_FEE  = 100;          // flat ₦100 per prediction — sole platform revenue
const MIN_STAKE_USD = 10;           // $10 USDC minimum — matches HL minimum notional
const MAX_STAKE     = 10_000_000;
const MAX_PAYOUT    = 10_000_000;
const MAX_PICKS     = 6;

const WINDOW_MS = { '1H': 3_600_000, '4H': 14_400_000, '24H': 86_400_000 };

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

// Build all platform multiplier options for a single market.
// Returns array — one entry per multiplier, each with UP + DOWN target prices.
function buildOptions(symbol, window, currentPrice) {
  return PLATFORM_MULTIPLIERS.map(multiplier => {
    const targetPct = TARGET_PCT[symbol]?.[window]?.[multiplier] ?? 3.0;
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
        return res.status(401).json({ success: false, error: 'INVALID_2FA', message: 'Invalid 2FA code. Please try again.' });
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
      const targetPct    = TARGET_PCT[p.symbol]?.[p.window]?.[multiplier] ?? 3.0;
      const targetPrice  = currentPrice
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
        odds:          multiplier,   // multiplier IS the odds — payout = stake × odds
      };
    });

    // Parlay: total odds = product of all individual multipliers
    const totalOdds       = resolvedPicks.reduce((acc, p) => acc * p.multiplier, 1);
    const rawPayout       = stakeNum * totalOdds;
    const potentialPayout = parseFloat(Math.min(rawPayout, MAX_PAYOUT).toFixed(2));

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
    }

    // ── Persist ───────────────────────────────────────────────────────────────
    const prediction = await Prediction.create({
      userId,
      picks:           resolvedPicks,
      stake:           stakeNum,
      totalOdds:       parseFloat(totalOdds.toFixed(4)),
      potentialPayout,
      status:          'pending',
      usdcAmount:      swapResult.usdcAmount,
      obiexQuoteId:    swapResult.quoteId,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });

    logger.info('BetaMarket prediction placed', {
      userId:       userId.toString(),
      predictionId: prediction._id.toString(),
      picks:        resolvedPicks.map(p =>
        `${p.symbol} ${p.direction} ${p.window} ${p.multiplier}x target=${p.targetPrice}`
      ),
      ngnbStake:    stakeNum,
      totalOdds,
      potentialPayout,
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

module.exports = router;
