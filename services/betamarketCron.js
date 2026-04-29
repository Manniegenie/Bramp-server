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
 * For rounds starting within the next 10 minutes, aggregate the net
 * UP vs DOWN pool per symbol and open a hedging perp on Hyperliquid.
 *
 * Net long (UP > DOWN): users expect price to rise — HL opens a SHORT hedge
 * Net short (DOWN > UP): users expect price to fall — HL opens a LONG hedge
 *
 * This way the platform profits when users lose and is hedged when users win.
 */
async function openPositionsForNearingRounds() {
  const hlService = getHL();
  if (!hlService) return; // HL not configured — pure parimutuel mode

  const now     = new Date();
  const horizon = new Date(now.getTime() + 10 * 60 * 1000); // 10 min from now

  // Find pending bets whose FIRST pick round starts within the next 10 minutes
  // (we use the earliest roundStart as the trigger for parlays)
  const nearingBets = await Prediction.find({
    status:            'pending',
    hlPositionSide:    null,          // not yet hedged
    'picks.roundStart': { $lte: horizon, $gte: now },
  }).lean();

  if (!nearingBets.length) return;

  // Aggregate net notional per symbol across all nearing bets
  // For each bet: if direction=up, add +usdcAmount; if direction=down, add -usdcAmount
  const netBySymbol = {}; // symbol → net USDC (positive = users net UP, negative = users net DOWN)

  for (const bet of nearingBets) {
    const usdcPerPick = (bet.usdcAmount ?? 0) / (bet.picks.length || 1);
    for (const pick of bet.picks) {
      const s = pick.symbol;
      netBySymbol[s] = (netBySymbol[s] ?? 0) + (pick.direction === 'up' ? usdcPerPick : -usdcPerPick);
    }
  }

  for (const [symbol, net] of Object.entries(netBySymbol)) {
    const absNet = Math.abs(net);
    if (absNet < MIN_POSITION_USDC) {
      logger.info(`betamarketCron: net too small for ${symbol} (${absNet} USDC) — skipping HL hedge`);
      continue;
    }

    // Users are net UP → hedge with a SHORT (we profit on net exposure when users lose)
    // Users are net DOWN → hedge with a LONG
    // The house edge ensures we have positive EV on all bets regardless of HL hedge outcome.
    const hlSide = net > 0 ? 'short' : 'long';

    try {
      const { orderId, status } = await hlService.openPosition(symbol, hlSide, absNet);
      logger.info(`betamarketCron: opened HL ${hlSide} hedge for ${symbol}`, {
        netUSDC: absNet, orderId, status,
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
  let allWon      = true;
  let missingData = false;
  const pickUpdates = [];

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

    let winDir;
    if (pick.marketType === 'volatility') {
      const movePct = Math.abs(closePrice - openPrice) / openPrice * 100;
      winDir = movePct >= (pick.threshold ?? 2.0) ? 'high' : 'low';
    } else {
      winDir = closePrice > openPrice ? 'up' : closePrice < openPrice ? 'down' : null;
    }
    const result = winDir !== null && pick.direction === winDir ? 'won' : 'lost';

    if (result !== 'won') allWon = false;

    pickUpdates.push({
      marketId:      pick.marketId,
      result,
      openPriceUSD:  openPrice,
      closePriceUSD: closePrice,
    });
  }

  if (missingData) {
    await Prediction.findByIdAndUpdate(bet._id, { $set: { status: 'pending' } });
    return;
  }

  // Close the HL hedge position for each hedged symbol before finalising payout
  const hlService = getHL();
  if (hlService && bet.hlPositionSide) {
    const symbols = [...new Set(bet.picks.map(p => p.symbol))];
    for (const symbol of symbols) {
      try {
        const { orderId, status } = await hlService.closePosition(symbol);
        logger.info(`betamarketCron: closed HL position for ${symbol}`, { orderId, status });
      } catch (err) {
        // Non-fatal — log and proceed with user settlement regardless
        logger.error(`betamarketCron: failed to close HL position for ${symbol}`, { error: err.message });
      }
    }
  }

  const betStatus = allWon ? 'won' : 'lost';

  const arrayFilters = [];
  const setOps       = { status: betStatus, settledAt: now };

  pickUpdates.forEach((pu, i) => {
    arrayFilters.push({ [`elem${i}.marketId`]: pu.marketId });
    setOps[`picks.$[elem${i}].result`]        = pu.result;
    setOps[`picks.$[elem${i}].openPriceUSD`]  = pu.openPriceUSD;
    setOps[`picks.$[elem${i}].closePriceUSD`] = pu.closePriceUSD;
  });

  await Prediction.findByIdAndUpdate(
    bet._id,
    { $set: setOps },
    { arrayFilters },
  );

  if (betStatus === 'won') {
    await User.findByIdAndUpdate(bet.userId, {
      $inc: { ngnbBalance: bet.potentialPayout },
    });

    logger.info('BetaMarket: payout credited', {
      userId:    bet.userId.toString(),
      betId:     bet._id.toString(),
      payout:    bet.potentialPayout,
      totalOdds: bet.totalOdds,
    });
  }

  logger.info(`BetaMarket: settled bet ${bet._id} → ${betStatus}`, {
    picks: pickUpdates.map(p => `${p.marketId}=${p.result} (${p.openPriceUSD}→${p.closePriceUSD})`).join(', '),
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
