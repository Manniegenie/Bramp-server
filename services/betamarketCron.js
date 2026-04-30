'use strict';

const cron        = require('node-cron');
const Prediction  = require('../models/Prediction');
const PriceChange = require('../models/pricechange');
const User        = require('../models/user');
const logger      = require('../utils/logger');

// HL integration is optional — if HL_PRIVATE_KEY is not set, position management is skipped
let hl = null;
function getHL() {
  if (hl) return hl;
  if (!process.env.HL_PRIVATE_KEY) return null;
  try { hl = require('./hyperliquid'); } catch (e) { logger.warn('betamarketCron: hyperliquid.js not loadable', { error: e.message }); }
  return hl;
}

// Minimum net USDC exposure worth opening an HL position for (avoids fee waste on tiny nets)
const MIN_POSITION_USDC = parseFloat(process.env.HL_MIN_POSITION_USDC ?? '10');

// ─── Price lookup ─────────────────────────────────────────────────────────────

async function getPriceAtOrBefore(symbol, deadline) {
  const doc = await PriceChange.findOne({
    symbol:    symbol.toUpperCase(),
    timestamp: { $lte: deadline },
  }).sort({ timestamp: -1 }).lean();
  return doc ? doc.price : null;
}

// ─── Position opening (run before rounds start) ───────────────────────────────

/**
 * BetaMarket is a vessel for Hyperliquid perps — we route user positions directly to HL.
 *
 * For each symbol, we aggregate the net leveraged notional across all pending picks
 * and open ONE net position on HL in the same direction as the net user exposure:
 *
 *   Net long  (users mostly UP)   → open LONG  on HL
 *   Net short (users mostly DOWN) → open SHORT on HL
 *
 * When price moves in users' favour, the HL position profits — that profit funds payouts.
 * When price moves against users, the HL position loses — user stakes cover those losses.
 * Platform revenue = ₦100 fee per prediction only.
 */
async function openPositionsForNearingRounds() {
  const hlService = getHL();
  if (!hlService) return;

  const now     = new Date();
  const horizon = new Date(now.getTime() + 10 * 60 * 1000);

  const nearingBets = await Prediction.find({
    status:             'pending',
    hlPositionSide:     null,
    'picks.roundStart': { $lte: horizon, $gte: now },
  }).lean();

  if (!nearingBets.length) return;

  // Net leveraged notional per symbol.
  // Each pick contributes: margin × leverage, signed by direction.
  // This is the full HL notional required to match user P&L exposure.
  const netBySymbol = {};

  for (const bet of nearingBets) {
    const usdcPerPick = (bet.usdcAmount ?? 0) / (bet.picks.length || 1);
    for (const pick of bet.picks) {
      const s        = pick.symbol;
      const notional = usdcPerPick * pick.multiplier;
      netBySymbol[s] = (netBySymbol[s] ?? 0) + (pick.direction === 'up' ? notional : -notional);
    }
  }

  for (const [symbol, net] of Object.entries(netBySymbol)) {
    const absNet = Math.abs(net);
    if (absNet < MIN_POSITION_USDC) {
      logger.info(`betamarketCron: net too small for ${symbol} (${absNet} USDC) — skipping`);
      continue;
    }

    // Open in the SAME direction as net user exposure — we are routing their trade, not fading it
    const hlSide = net > 0 ? 'long' : 'short';

    try {
      const { orderId, status } = await hlService.openPosition(symbol, hlSide, absNet);
      logger.info(`betamarketCron: opened HL ${hlSide} for ${symbol}`, {
        notionalUSDC: absNet, orderId, status,
      });

      // Tag all matching bets with the hedge side so we know to close later
      const betIds = nearingBets
        .filter(b => b.picks.some(p => p.symbol === symbol))
        .map(b => b._id);

      await Prediction.updateMany(
        { _id: { $in: betIds } },
        { $set: { hlPositionSide: hlSide, hlOrderId: orderId ?? undefined } },
      );
    } catch (err) {
      logger.error(`betamarketCron: failed to open HL hedge for ${symbol}`, { error: err.message });
    }
  }
}

// ─── Settlement logic ─────────────────────────────────────────────────────────

async function settleExpiredRounds() {
  const now = new Date();

  while (true) {
    const bet = await Prediction.findOneAndUpdate(
      {
        status:           'pending',
        'picks.roundEnd': { $lte: now },
      },
      { $set: { status: 'settling' } },
      { new: true },
    ).lean();

    if (!bet) break;

    // Skip bets where some picks haven't expired yet (multi-window parlay edge case)
    if (!bet.picks.every(p => new Date(p.roundEnd) <= now)) {
      await Prediction.findByIdAndUpdate(bet._id, { $set: { status: 'pending' } });
      break;
    }

    await processBet(bet, now);
  }
}

async function processBet(bet, now) {
  let missingData = false;
  const pickUpdates = [];
  const stakePerPick = bet.stake / bet.picks.length;

  for (const pick of bet.picks) {
    const roundStart = new Date(pick.roundStart);
    const roundEnd   = new Date(pick.roundEnd);
    const grace      = new Date(roundEnd.getTime() + 30 * 60 * 1000);

    const openPrice  = await getPriceAtOrBefore(pick.symbol, roundStart);
    const closePrice = await getPriceAtOrBefore(pick.symbol, grace);

    if (!openPrice || !closePrice) {
      logger.warn(`BetaMarket: deferring ${bet._id} pick ${pick.marketId} — price data missing`, {
        symbol: pick.symbol, openPrice, closePrice,
      });
      missingData = true;
      break;
    }

    // Raw underlying return for the window
    const rawReturn = (closePrice - openPrice) / openPrice;

    // Signed return: positive means the user called direction correctly
    const directedReturn = pick.direction === 'up' ? rawReturn : -rawReturn;

    // Leveraged return: the multiplier IS the leverage
    const leveragedReturn = directedReturn * pick.multiplier;

    // Floor at -1: user can't lose more than their allocated stake (no margin call beyond stake)
    const settledReturn = Math.max(-1, leveragedReturn);

    // What this pick returns — includes original stake + P&L
    const pickPayout = parseFloat((stakePerPick * (1 + settledReturn)).toFixed(2));

    pickUpdates.push({
      marketId:        pick.marketId,
      result:          settledReturn >= 0 ? 'won' : 'lost',
      actualMultiplier: parseFloat((1 + settledReturn).toFixed(4)), // realized return factor
      pickPayout,
      openPriceUSD:    openPrice,
      closePriceUSD:   closePrice,
    });
  }

  if (missingData) {
    await Prediction.findByIdAndUpdate(bet._id, { $set: { status: 'pending' } });
    return;
  }

  // Close HL position now that the window is over
  const hlService = getHL();
  if (hlService && bet.hlPositionSide) {
    const symbols = [...new Set(bet.picks.map(p => p.symbol))];
    for (const symbol of symbols) {
      try {
        const { orderId, status } = await hlService.closePosition(symbol);
        logger.info(`betamarketCron: closed HL position for ${symbol}`, { orderId, status });
      } catch (err) {
        logger.error(`betamarketCron: failed to close HL position for ${symbol}`, { error: err.message });
      }
    }
  }

  // Total returned to user = sum of all pick payouts
  // Stake was already debited at entry — we always return whatever remains (even on full loss it's 0)
  const actualPayout     = parseFloat(pickUpdates.reduce((s, p) => s + p.pickPayout, 0).toFixed(2));
  const actualTotalOdds  = parseFloat((actualPayout / bet.stake).toFixed(4));
  const betStatus        = actualPayout >= bet.stake ? 'won' : 'lost';

  const arrayFilters = [];
  const setOps = {
    status:          betStatus,
    settledAt:       now,
    actualTotalOdds,
    actualPayout,
  };

  pickUpdates.forEach((pu, i) => {
    arrayFilters.push({ [`elem${i}.marketId`]: pu.marketId });
    setOps[`picks.$[elem${i}].result`]           = pu.result;
    setOps[`picks.$[elem${i}].actualMultiplier`] = pu.actualMultiplier;
    setOps[`picks.$[elem${i}].openPriceUSD`]     = pu.openPriceUSD;
    setOps[`picks.$[elem${i}].closePriceUSD`]    = pu.closePriceUSD;
  });

  await Prediction.findByIdAndUpdate(bet._id, { $set: setOps }, { arrayFilters });

  // Always return the remaining capital — stake was already debited at entry
  if (actualPayout > 0) {
    await User.findByIdAndUpdate(bet.userId, { $inc: { ngnbBalance: actualPayout } });
  }

  logger.info(`BetaMarket: settled ${bet._id} → ${betStatus}`, {
    userId:        bet.userId.toString(),
    stake:         bet.stake,
    actualPayout,
    actualTotalOdds,
    picks: pickUpdates.map(p =>
      `${p.marketId} ${p.openPriceUSD}→${p.closePriceUSD} = ${p.result} (${p.pickPayout})`
    ).join(' | '),
  });
}

// ─── Cron registration ────────────────────────────────────────────────────────

function start() {
  // Settlement: every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try {
      await settleExpiredRounds();
    } catch (err) {
      logger.error('BetaMarket settlement cron error', { error: err.message });
    }
  });

  // Position opening: every minute (catches rounds nearing their start within 10 min)
  cron.schedule('* * * * *', async () => {
    try {
      await openPositionsForNearingRounds();
    } catch (err) {
      logger.error('BetaMarket position-open cron error', { error: err.message });
    }
  });

  logger.info('BetaMarket cron started (settlement: 5 min, position-open: 1 min)');
}

module.exports = { start, settleExpiredRounds, openPositionsForNearingRounds };
