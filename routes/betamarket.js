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

module.exports = router;
