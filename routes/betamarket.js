'use strict';

const express          = require('express');
const router           = express.Router();
const logger           = require('../utils/logger');
const User             = require('../models/user');
const Prediction       = require('../models/Prediction');
const PriceChange      = require('../models/pricechange');
const { swapNGNBtoUSDC } = require('../services/NGNBSwap');

// ─── Hyperliquid SDK (read-only price oracle, no account/keys required) ───────
// ESM-only package, loaded lazily via dynamic import.

let _hlInfo = null;

async function getHL() {
  if (!_hlInfo) {
    const { InfoClient, HttpTransport } = await import('@nktkas/hyperliquid');
    _hlInfo = new InfoClient(new HttpTransport());
  }
  return _hlInfo;
}

// If Hyperliquid is unavailable fall back to Binance prices from our own DB.
async function getMidsWithFallback(symbols) {
  try {
    const hl      = await getHL();
    const allMids = await hl.getAllMids();
    // Verify we got at least one of our symbols; if not, treat as failure
    if (symbols.some(s => allMids[s] !== undefined)) return { mids: allMids, source: 'hyperliquid' };
    throw new Error('No matching symbols in HL response');
  } catch (hlErr) {
    logger.warn('BetaMarket: Hyperliquid unavailable, falling back to Binance DB', { error: hlErr.message });
    // Reset singleton so next request retries the HL connection
    _hlInfo = null;

    const prices = {};
    await Promise.all(
      symbols.map(async s => {
        const doc = await PriceChange.findOne({ symbol: s })
          .sort({ timestamp: -1 }).lean();
        if (doc) prices[s] = doc.price;
      })
    );
    return { mids: prices, source: 'binance_fallback' };
  }
}

// Same fallback for getMetaAndAssetCtxs (funding rates / OI).
// Returns an empty ctxMap on failure — markets still work, just without funding nudge.
async function getCtxMapWithFallback() {
  try {
    const hl       = await getHL();
    const metaCtxs = await hl.getMetaAndAssetCtxs();
    return buildCtxMap(metaCtxs);
  } catch {
    _hlInfo = null;
    return {};
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MARKET_TOKENS = ['BTC', 'ETH', 'SOL', 'BNB', 'MATIC', 'AVAX'];
const HOUSE_EDGE    = 0.08;

const MIN_STAKE     = 1_000;     // ₦1,000 NGNB minimum
const MAX_STAKE     = 50_000;    // ₦50,000 NGNB per bet
const MAX_PAYOUT    = 500_000;   // ₦500,000 NGNB per bet (protects the pool)
const MAX_PICKS     = 6;         // max legs in a parlay

const WINDOW_MS     = { '1H': 3_600_000, '4H': 14_400_000, '24H': 86_400_000 };

// Seeded pool sizes (₦) — blended with real stakes so odds look meaningful early on
const BASE_POOLS = {
  BTC:   { '1H': { up: 12000, down: 8000  }, '4H': { up: 28000, down: 22000 }, '24H': { up: 65000, down: 55000 } },
  ETH:   { '1H': { up: 9500,  down: 7500  }, '4H': { up: 22000, down: 18000 }, '24H': { up: 50000, down: 45000 } },
  SOL:   { '1H': { up: 5000,  down: 8000  }, '4H': { up: 12000, down: 18000 }, '24H': { up: 30000, down: 42000 } },
  BNB:   { '1H': { up: 7000,  down: 6500  }, '4H': { up: 16000, down: 15000 }, '24H': { up: 38000, down: 36000 } },
  MATIC: { '1H': { up: 3500,  down: 5500  }, '4H': { up: 8000,  down: 12000 }, '24H': { up: 20000, down: 28000 } },
  AVAX:  { '1H': { up: 4500,  down: 4000  }, '4H': { up: 10000, down: 9000  }, '24H': { up: 24000, down: 22000 } },
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function validWindow(w) { return WINDOW_MS[w] ? w : '1H'; }

function calcOdds(myPool, otherPool) {
  const total = myPool + otherPool;
  return Math.round(((total / myPool) * (1 - HOUSE_EDGE)) * 100) / 100;
}

function buildCtxMap(metaCtxs) {
  const map = {};
  if (metaCtxs?.[0]?.universe && Array.isArray(metaCtxs[1])) {
    metaCtxs[0].universe.forEach((asset, i) => { map[asset.name] = metaCtxs[1][i] || {}; });
  }
  return map;
}

function adjustedPools(base, funding) {
  const abs = Math.min(Math.abs(funding) * 100, 0.25);
  return {
    up:   funding > 0 ? base.up   : Math.round(base.up   * (1 + abs)),
    down: funding < 0 ? base.down : Math.round(base.down * (1 + abs)),
  };
}

function getRoundBounds(window) {
  const ms = WINDOW_MS[window];
  const start = Math.floor(Date.now() / ms) * ms;
  return { roundStart: new Date(start), roundEnd: new Date(start + ms) };
}

function makeMarketId(symbol, window, roundStart) {
  return `${symbol}-${window}-${roundStart.getTime()}`;
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function aggregatePools(marketIds) {
  if (!marketIds.length) return {};
  const rows = await Prediction.aggregate([
    { $match: { status: { $in: ['pending', 'settling'] }, 'picks.marketId': { $in: marketIds } } },
    { $unwind: '$picks' },
    { $match: { 'picks.marketId': { $in: marketIds }, 'picks.result': 'pending' } },
    { $group: {
      _id:   { marketId: '$picks.marketId', direction: '$picks.direction' },
      total: { $sum: '$stake' },
    }},
  ]);

  const map = {};
  for (const r of rows) {
    const { marketId, direction } = r._id;
    if (!map[marketId]) map[marketId] = { up: 0, down: 0 };
    map[marketId][direction] += r.total;
  }
  return map;
}

function marketPools(symbol, window, funding, realUp, realDown) {
  const base   = BASE_POOLS[symbol]?.[window] ?? { up: 5000, down: 5000 };
  const seeded = adjustedPools(base, funding);
  const pools  = { up: seeded.up + realUp, down: seeded.down + realDown };
  return {
    pools,
    upOdds:  calcOdds(pools.up, pools.down),
    downOdds: calcOdds(pools.down, pools.up),
    total:   pools.up + pools.down,
    upPct:   Math.round((pools.up / (pools.up + pools.down)) * 100),
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /betamarket/prices
 */
router.get('/prices', async (req, res) => {
  try {
    const { mids } = await getMidsWithFallback(MARKET_TOKENS);
    const prices = {};
    for (const s of MARKET_TOKENS) {
      if (mids[s] !== undefined) prices[s] = parseFloat(mids[s]);
    }
    res.json({ success: true, data: { prices, fetchedAt: new Date().toISOString() } });
  } catch (err) {
    logger.error('BetaMarket /prices error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to fetch live prices' });
  }
});

/**
 * GET /betamarket/markets?window=1H|4H|24H
 */
router.get('/markets', async (req, res) => {
  const window = validWindow(req.query.window);

  try {
    const [{ mids }, ctxMap] = await Promise.all([
      getMidsWithFallback(MARKET_TOKENS),
      getCtxMapWithFallback(),
    ]);

    const { roundStart, roundEnd } = getRoundBounds(window);
    const marketIds  = MARKET_TOKENS.map(s => makeMarketId(s, window, roundStart));
    const realPools  = await aggregatePools(marketIds);

    const markets = MARKET_TOKENS.map(symbol => {
      const ctx     = ctxMap[symbol] || {};
      const funding = parseFloat(ctx.funding ?? 0);
      const mId     = makeMarketId(symbol, window, roundStart);
      const real    = realPools[mId] || { up: 0, down: 0 };
      const { upOdds, downOdds, total, upPct } =
        marketPools(symbol, window, funding, real.up, real.down);

      return {
        id:           mId,
        symbol,
        window,
        midPrice:     mids[symbol]     ? parseFloat(mids[symbol])     : null,
        markPrice:    ctx.markPx       ? parseFloat(ctx.markPx)       : null,
        oraclePrice:  ctx.oraclePx     ? parseFloat(ctx.oraclePx)     : null,
        openInterest: ctx.openInterest ? parseFloat(ctx.openInterest) : null,
        dayVolume:    ctx.dayNtlVlm    ? parseFloat(ctx.dayNtlVlm)    : null,
        fundingRate:  funding,
        upOdds,
        downOdds,
        poolTotal:    total,
        upPct,
        downPct:      100 - upPct,
        participants: Math.round(total / 350),
        roundStart:   roundStart.toISOString(),
        endTime:      roundEnd.getTime(),
      };
    });

    res.json({
      success: true,
      data: { markets, window, fetchedAt: new Date().toISOString() },
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
 *   picks:          [{ symbol, direction: 'up'|'down', window: '1H'|'4H'|'24H' }],
 *   stake:          number,          // NGNB — debited from ngnbBalance
 *   idempotencyKey: string           // client-generated UUID; prevents duplicate submissions
 * }
 *
 * Security controls applied:
 *   - MAX_PICKS (6) — prevents expensive payload DoS
 *   - MIN_STAKE / MAX_STAKE — business limits
 *   - MAX_PAYOUT — pool protection cap
 *   - Idempotency key — prevents double-submission on network retry
 *   - Atomic $gte debit — prevents race-condition overdraft
 *   - Duplicate market guard — no two picks for same symbol+window
 */
router.post('/predict', async (req, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });

  const { picks: rawPicks, stake, idempotencyKey } = req.body;

  // ── Input validation ────────────────────────────────────────────────────────

  if (!Array.isArray(rawPicks) || rawPicks.length === 0) {
    return res.status(400).json({ success: false, error: 'picks must be a non-empty array' });
  }
  if (rawPicks.length > MAX_PICKS) {
    return res.status(400).json({ success: false, error: `Maximum ${MAX_PICKS} picks per bet` });
  }

  const stakeNum = parseFloat(stake);
  if (!stakeNum || stakeNum < MIN_STAKE) {
    return res.status(400).json({ success: false, error: `Minimum stake is ₦${MIN_STAKE}` });
  }
  if (stakeNum > MAX_STAKE) {
    return res.status(400).json({ success: false, error: `Maximum stake is ₦${MAX_STAKE.toLocaleString()}` });
  }

  const seenMarkets = new Set();
  for (const p of rawPicks) {
    if (!MARKET_TOKENS.includes(p.symbol)) {
      return res.status(400).json({ success: false, error: `Unsupported symbol: ${p.symbol}` });
    }
    if (!['up', 'down'].includes(p.direction)) {
      return res.status(400).json({ success: false, error: `direction must be 'up' or 'down'` });
    }
    if (!WINDOW_MS[p.window]) {
      return res.status(400).json({ success: false, error: `window must be 1H, 4H, or 24H` });
    }
    const key = `${p.symbol}-${p.window}`;
    if (seenMarkets.has(key)) {
      return res.status(400).json({ success: false, error: `Duplicate pick: ${p.symbol} ${p.window}` });
    }
    seenMarkets.add(key);
  }

  try {
    // ── Idempotency check ───────────────────────────────────────────────────
    // Reject if this key was already used by this user (network retry / double-tap guard)
    if (idempotencyKey) {
      const existing = await Prediction.findOne({
        userId,
        'picks.0': { $exists: true }, // has at least one pick
        $where: `this.idempotencyKey === ${JSON.stringify(idempotencyKey)}`,
      }).lean();
      // Use a dedicated indexed field instead of $where for performance
      const existingKeyed = await Prediction.findOne({ userId, idempotencyKey }).lean();
      if (existingKeyed) {
        return res.status(200).json({ success: true, data: existingKeyed, duplicate: true });
      }
    }

    // ── Balance check ───────────────────────────────────────────────────────
    const user = await User.findById(userId).select('ngnbBalance ngnbPendingBalance').lean();
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    const available = Math.max(0, (user.ngnbBalance || 0) - (user.ngnbPendingBalance || 0));
    if (available < stakeNum) {
      return res.status(400).json({
        success: false,
        error: `Insufficient NGNB balance. Available: ₦${available.toFixed(2)}, Required: ₦${stakeNum.toFixed(2)}`,
      });
    }

    // ── Fetch live prices (with Binance fallback) ───────────────────────────
    const symbols = [...new Set(rawPicks.map(p => p.symbol))];
    const [{ mids }, ctxMap] = await Promise.all([
      getMidsWithFallback(symbols),
      getCtxMapWithFallback(),
    ]);

    // ── Resolve picks with live odds ────────────────────────────────────────
    const marketIds = rawPicks.map(p => {
      const { roundStart } = getRoundBounds(p.window);
      return makeMarketId(p.symbol, p.window, roundStart);
    });
    const realPools = await aggregatePools(marketIds);

    const resolvedPicks = rawPicks.map(p => {
      const { roundStart, roundEnd } = getRoundBounds(p.window);
      const mId     = makeMarketId(p.symbol, p.window, roundStart);
      const ctx     = ctxMap[p.symbol] || {};
      const funding = parseFloat(ctx.funding ?? 0);
      const real    = realPools[mId] || { up: 0, down: 0 };
      const { upOdds, downOdds } = marketPools(p.symbol, p.window, funding, real.up, real.down);

      return {
        symbol:        p.symbol,
        direction:     p.direction,
        window:        p.window,
        marketId:      mId,
        roundStart,
        roundEnd,
        odds:          p.direction === 'up' ? upOdds : downOdds,
        entryPriceUSD: mids[p.symbol] ? parseFloat(mids[p.symbol]) : null,
      };
    });

    const totalOdds      = resolvedPicks.reduce((acc, p) => acc * p.odds, 1);
    const rawPayout      = stakeNum * totalOdds;
    // Cap payout to protect the pool from catastrophic multi-leg parlays
    const potentialPayout = parseFloat(Math.min(rawPayout, MAX_PAYOUT).toFixed(2));

    // ── Atomic balance debit (race-condition safe) ──────────────────────────
    const debited = await User.findOneAndUpdate(
      { _id: userId, ngnbBalance: { $gte: stakeNum } },
      { $inc: { ngnbBalance: -stakeNum } },
      { new: false },
    );
    if (!debited) {
      logger.warn('BetaMarket: balance debit failed (race condition or insufficient funds)', { userId, stakeNum });
      return res.status(400).json({ success: false, error: 'Balance changed — please retry' });
    }

    // ── Convert NGNB stake → USDC via Obiex (platform-level) ───────────────
    // This moves the equivalent Naira value into the platform's Obiex USDC pool,
    // which will later back a Hyperliquid perp position for the round.
    const swapResult = await swapNGNBtoUSDC(stakeNum);

    if (!swapResult.success) {
      // Swap failed — refund the NGNB before returning an error.
      // The user's balance is restored; nothing is recorded in the DB.
      await User.findByIdAndUpdate(userId, { $inc: { ngnbBalance: stakeNum } });
      logger.error('BetaMarket: NGNB→USDC swap failed — NGNB refunded', {
        userId, stakeNum, error: swapResult.error,
      });
      return res.status(503).json({
        success: false,
        error: 'Market temporarily unavailable. Your balance has been restored.',
      });
    }

    logger.info('BetaMarket: NGNB→USDC swap succeeded', {
      userId,
      ngnbStake:  stakeNum,
      usdcAmount: swapResult.usdcAmount,
      quoteId:    swapResult.quoteId,
    });

    // ── Persist prediction ──────────────────────────────────────────────────
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
      userId:         userId.toString(),
      predictionId:   prediction._id.toString(),
      picks:          resolvedPicks.map(p => `${p.symbol} ${p.direction} ${p.window} @${p.odds}`),
      ngnbStake:      stakeNum,
      usdcAmount:     swapResult.usdcAmount,
      obiexQuoteId:   swapResult.quoteId,
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
