'use strict';

const express          = require('express');
const router           = express.Router();
const bcrypt           = require('bcryptjs');
const logger           = require('../utils/logger');
const User             = require('../models/user');
const Prediction       = require('../models/Prediction');
const PriceChange      = require('../models/pricechange');
const { swapNGNBtoUSDC }       = require('../services/NGNBSwap');
const { validateTwoFactorAuth } = require('../services/twofactorAuth');

// ─── Hyperliquid SDK (read-only price oracle, no account/keys required) ───────
// ESM-only package, loaded lazily via dynamic import.

let _hlInfo = null;

async function getHL() {
  if (!_hlInfo) {
    const { InfoClient, HttpTransport } = await import('@nktkas/hyperliquid');
    _hlInfo = new InfoClient({ transport: new HttpTransport() });
  }
  return _hlInfo;
}

// If Hyperliquid is unavailable fall back to Binance prices from our own DB.
async function getMidsWithFallback(symbols) {
  try {
    const hl      = await getHL();
    const allMids = await hl.allMids();
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
    const metaCtxs = await hl.metaAndAssetCtxs();
    return buildCtxMap(metaCtxs);
  } catch {
    _hlInfo = null;
    return {};
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MARKET_TOKENS  = ['BTC', 'ETH', 'SOL', 'BNB', 'MATIC', 'AVAX'];
const LEVERAGE       = 2.0;    // HL perp leverage — sets the base fair odds ceiling
const HOUSE_EDGE     = 0.06;   // 6% — platform keeps this fraction of every losing stake in expectation
const PLATFORM_FEE   = 100;    // flat ₦100 NGNB fee per prediction (platform revenue, on top of house edge)
const MIN_STAKE      = 100;    // ₦100 minimum (plus fee on top)
const MAX_STAKE      = 10_000_000;
const MAX_PAYOUT     = 10_000_000;
const MAX_PICKS      = 6;

const WINDOW_MS = { '1H': 3_600_000, '4H': 14_400_000, '24H': 86_400_000 };

// % price move required to win a volatility 'high' pick
const VOLATILITY_THRESHOLDS = {
  BTC:   { '1H': 1.5, '4H': 3.0, '24H': 5.5 },
  ETH:   { '1H': 2.0, '4H': 3.8, '24H': 6.5 },
  SOL:   { '1H': 2.5, '4H': 4.8, '24H': 8.0 },
  BNB:   { '1H': 1.8, '4H': 3.4, '24H': 6.0 },
  MATIC: { '1H': 2.2, '4H': 4.2, '24H': 7.0 },
  AVAX:  { '1H': 2.0, '4H': 3.8, '24H': 6.5 },
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function validWindow(w) { return WINDOW_MS[w] ? w : '1H'; }

function buildCtxMap(metaCtxs) {
  const map = {};
  if (metaCtxs?.[0]?.universe && Array.isArray(metaCtxs[1])) {
    metaCtxs[0].universe.forEach((asset, i) => { map[asset.name] = metaCtxs[1][i] || {}; });
  }
  return map;
}

/**
 * Directional odds — house model with HL funding rate as a probability signal.
 *
 * Base fair odds = LEVERAGE (2.0x). House edge is applied first, then a bias
 * derived from the HL funding rate nudges one side ±10% max.
 *
 * Positive funding (longs crowded/paying shorts) → UP slightly less likely →
 *   UP odds nudge down, DOWN odds nudge up.
 *
 * With LEVERAGE=2 and HOUSE_EDGE=0.06, symmetric base odds are 1.88x.
 * Expected platform margin per ₦100 staked (50/50 outcome): ₦6.
 */
function calcDirectionalOdds(funding) {
  const base = LEVERAGE * (1 - HOUSE_EDGE);              // e.g. 2.0 × 0.94 = 1.88
  const bias = Math.tanh((funding ?? 0) * 2000) * 0.10;  // ±10% max tilt from funding signal
  const upOdds   = Math.max(1.05, parseFloat((base * (1 - bias)).toFixed(2)));
  const downOdds = Math.max(1.05, parseFloat((base * (1 + bias)).toFixed(2)));
  return { upOdds, downOdds };
}

/**
 * Volatility odds — house model with HL mark/oracle spread as a signal.
 *
 * Wider spread = market implies a bigger move = BIG odds nudge down,
 * QUIET odds nudge up. House edge applied at base.
 */
function calcVolatilityOdds(markPx, oraclePx, threshold) {
  const base   = LEVERAGE * (1 - HOUSE_EDGE);
  const spread = (markPx && oraclePx && oraclePx > 0)
    ? Math.abs(markPx - oraclePx) / oraclePx * 100
    : 0;
  const factor   = Math.min(spread / Math.max(threshold, 0.1), 0.20);
  const highOdds = Math.max(1.05, parseFloat((base * (1 - factor)).toFixed(2)));
  const lowOdds  = Math.max(1.05, parseFloat((base * (1 + factor)).toFixed(2)));
  return { highOdds, lowOdds };
}

function getRoundBounds(window) {
  const ms = WINDOW_MS[window];
  const start = Math.floor(Date.now() / ms) * ms; // current window — timer shows time remaining
  return { roundStart: new Date(start), roundEnd: new Date(start + ms) };
}

function makeMarketId(symbol, window, roundStart) {
  return `${symbol}-${window}-${roundStart.getTime()}`;
}

function makeVolMarketId(symbol, window, roundStart) {
  return `VOL-${symbol}-${window}-${roundStart.getTime()}`;
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

  // Return participant count per marketId (direction-agnostic)
  const map = {};
  for (const r of rows) {
    const { marketId } = r._id;
    map[marketId] = (map[marketId] || 0) + 1;
  }
  return map;
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
    const allMarketIds = [
      ...MARKET_TOKENS.map(s => makeMarketId(s,    window, roundStart)),
      ...MARKET_TOKENS.map(s => makeVolMarketId(s, window, roundStart)),
    ];
    const participantCounts = await aggregatePools(allMarketIds);

    const markets = MARKET_TOKENS.map(symbol => {
      const ctx       = ctxMap[symbol] || {};
      const funding   = parseFloat(ctx.funding  ?? 0);
      const markPx    = ctx.markPx    ? parseFloat(ctx.markPx)    : null;
      const oraclePx  = ctx.oraclePx  ? parseFloat(ctx.oraclePx)  : null;
      const mId       = makeMarketId(symbol, window, roundStart);
      const { upOdds, downOdds } = calcDirectionalOdds(funding);

      return {
        id:           mId,
        symbol,
        window,
        marketType:   'directional',
        midPrice:     mids[symbol] ? parseFloat(mids[symbol]) : null,
        markPrice:    markPx,
        oraclePrice:  oraclePx,
        openInterest: ctx.openInterest ? parseFloat(ctx.openInterest) : null,
        dayVolume:    ctx.dayNtlVlm    ? parseFloat(ctx.dayNtlVlm)    : null,
        fundingRate:  funding,
        upOdds,
        downOdds,
        participants: participantCounts[mId] || 0,
        roundStart:   roundStart.toISOString(),
        endTime:      roundEnd.getTime(),
      };
    });

    const volatilityMarkets = MARKET_TOKENS.map(symbol => {
      const ctx       = ctxMap[symbol] || {};
      const markPx    = ctx.markPx   ? parseFloat(ctx.markPx)   : null;
      const oraclePx  = ctx.oraclePx ? parseFloat(ctx.oraclePx) : null;
      const threshold = VOLATILITY_THRESHOLDS[symbol]?.[window] ?? 2.0;
      const vId       = makeVolMarketId(symbol, window, roundStart);
      const { highOdds, lowOdds } = calcVolatilityOdds(markPx, oraclePx, threshold);

      return {
        id:           vId,
        symbol,
        window,
        marketType:   'volatility',
        threshold,
        midPrice:     mids[symbol] ? parseFloat(mids[symbol]) : null,
        fundingRate:  ctx.funding  ? parseFloat(ctx.funding)  : 0,
        highOdds,
        lowOdds,
        participants: participantCounts[vId] || 0,
        roundStart:   roundStart.toISOString(),
        endTime:      roundEnd.getTime(),
      };
    });

    res.json({
      success: true,
      data: { markets, volatilityMarkets, window, fetchedAt: new Date().toISOString() },
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

  const { picks: rawPicks, stake, idempotencyKey, passwordpin, twoFactorCode } = req.body;

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
    if (!WINDOW_MS[p.window]) {
      return res.status(400).json({ success: false, error: `window must be 1H, 4H, or 24H` });
    }
    const mType = p.marketType || 'directional';
    if (mType === 'volatility') {
      if (!['high', 'low'].includes(p.direction)) {
        return res.status(400).json({ success: false, error: `volatility direction must be 'high' or 'low'` });
      }
    } else {
      if (!['up', 'down'].includes(p.direction)) {
        return res.status(400).json({ success: false, error: `direction must be 'up' or 'down'` });
      }
    }
    const key = `${mType}-${p.symbol}-${p.window}`;
    if (seenMarkets.has(key)) {
      return res.status(400).json({ success: false, error: `Duplicate pick: ${p.symbol} ${p.window}` });
    }
    seenMarkets.add(key);
  }

  try {
    // ── Idempotency check ───────────────────────────────────────────────────
    // Reject if this key was already used by this user (network retry / double-tap guard)
    if (idempotencyKey) {
      const existingKeyed = await Prediction.findOne({ userId, idempotencyKey }).lean();
      if (existingKeyed) {
        return res.status(200).json({ success: true, data: existingKeyed, duplicate: true });
      }
    }

    // ── Auth checks (PIN + 2FA) ─────────────────────────────────────────────
    const user = await User.findById(userId)
      .select('ngnbBalance ngnbPendingBalance passwordpin twoFactorSecret twoFactorEnabled')
      .lean();
    if (!user) return res.status(404).json({ success: false, error: 'User not found' });

    if (!user.passwordpin) {
      return res.status(403).json({ success: false, error: 'PIN_NOT_SET_UP', message: 'Please set up your Password PIN in Profile before placing predictions.' });
    }
    if (!passwordpin) {
      return res.status(400).json({ success: false, error: 'PIN_REQUIRED', message: 'Password PIN is required.' });
    }
    const pinValid = await bcrypt.compare(String(passwordpin), user.passwordpin);
    if (!pinValid) {
      return res.status(401).json({ success: false, error: 'INVALID_PIN', message: 'Incorrect PIN. Please try again.' });
    }

    if (user.twoFactorEnabled) {
      if (!twoFactorCode) {
        return res.status(400).json({ success: false, error: '2FA_REQUIRED', message: '2FA code is required.' });
      }
      if (!validateTwoFactorAuth(user, String(twoFactorCode))) {
        return res.status(401).json({ success: false, error: 'INVALID_2FA', message: 'Invalid 2FA code. Please try again.' });
      }
    }

    // ── Balance check ───────────────────────────────────────────────────────
    const totalRequired = stakeNum + PLATFORM_FEE;
    const available = Math.max(0, (user.ngnbBalance || 0) - (user.ngnbPendingBalance || 0));
    if (available < totalRequired) {
      return res.status(400).json({
        success: false,
        error: 'INSUFFICIENT_BALANCE',
        message: `Insufficient balance. Available: ₦${available.toFixed(2)}, Required: ₦${totalRequired.toFixed(2)} (stake + ₦${PLATFORM_FEE} fee)`,
      });
    }

    // ── Fetch live prices (with Binance fallback) ───────────────────────────
    const symbols = [...new Set(rawPicks.map(p => p.symbol))];
    const [{ mids }, ctxMap] = await Promise.all([
      getMidsWithFallback(symbols),
      getCtxMapWithFallback(),
    ]);

    // ── Resolve picks with live odds ────────────────────────────────────────
    const resolvedPicks = rawPicks.map(p => {
      const mType             = p.marketType || 'directional';
      const { roundStart, roundEnd } = getRoundBounds(p.window);
      const isVol             = mType === 'volatility';
      const mId               = isVol
        ? makeVolMarketId(p.symbol, p.window, roundStart)
        : makeMarketId(p.symbol,    p.window, roundStart);

      let odds;
      let threshold = null;
      if (isVol) {
        threshold             = VOLATILITY_THRESHOLDS[p.symbol]?.[p.window] ?? 2.0;
        const ctx             = ctxMap[p.symbol] || {};
        const markPx          = ctx.markPx   ? parseFloat(ctx.markPx)   : null;
        const oraclePx        = ctx.oraclePx ? parseFloat(ctx.oraclePx) : null;
        const { highOdds, lowOdds } = calcVolatilityOdds(markPx, oraclePx, threshold);
        odds = p.direction === 'high' ? highOdds : lowOdds;
      } else {
        const ctx     = ctxMap[p.symbol] || {};
        const funding = parseFloat(ctx.funding ?? 0);
        const { upOdds, downOdds } = calcDirectionalOdds(funding);
        odds = p.direction === 'up' ? upOdds : downOdds;
      }

      return {
        symbol:        p.symbol,
        marketType:    mType,
        direction:     p.direction,
        ...(threshold !== null && { threshold }),
        window:        p.window,
        marketId:      mId,
        roundStart,
        roundEnd,
        odds,
        entryPriceUSD: mids[p.symbol] ? parseFloat(mids[p.symbol]) : null,
      };
    });

    const totalOdds      = resolvedPicks.reduce((acc, p) => acc * p.odds, 1);
    const rawPayout      = stakeNum * totalOdds;
    // Cap payout to protect the pool from catastrophic multi-leg parlays
    const potentialPayout = parseFloat(Math.min(rawPayout, MAX_PAYOUT).toFixed(2));

    // ── Atomic balance debit (race-condition safe) ──────────────────────────
    // Deducts stake (goes to HL position) + PLATFORM_FEE (platform revenue)
    const debited = await User.findOneAndUpdate(
      { _id: userId, ngnbBalance: { $gte: totalRequired } },
      { $inc: { ngnbBalance: -totalRequired } },
      { new: false },
    );
    if (!debited) {
      logger.warn('BetaMarket: balance debit failed (race condition or insufficient funds)', { userId, totalRequired });
      return res.status(400).json({ success: false, error: 'Balance changed — please retry' });
    }

    // ── Convert NGNB stake → USDC via Obiex (best-effort, non-blocking) ────
    // Only the stake portion is swapped — PLATFORM_FEE stays as NGNB revenue.
    // If the swap fails (e.g. trade pair unavailable), the prediction is still
    // recorded. The HL cron will hedge at pool level using its own liquidity.
    const swapResult = await swapNGNBtoUSDC(stakeNum);
    if (!swapResult.success) {
      logger.warn('BetaMarket: NGNB→USDC swap failed — proceeding without HL swap', {
        userId, stakeNum, error: swapResult.error,
      });
    } else {
      logger.info('BetaMarket: NGNB→USDC swap succeeded', {
        userId, ngnbStake: stakeNum, usdcAmount: swapResult.usdcAmount, quoteId: swapResult.quoteId,
      });
    }

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
