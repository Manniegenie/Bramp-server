// services/metuselaFloat.js
// How much Metusela customer money is at Polymarket, and the limits on it.
// If Polymarket ever locks the account, everything there is stuck, so:
//
//   Idle float  — read straight from the chain (pUSD balance of Metusela's
//                 Polymarket wallet), never taken from Metusela's word. Top-ups
//                 only refill up to floatCapUsdc; if the balance can't be read,
//                 no top-up goes out.
//   Open bets   — budgets of OPEN bets (models/metuselaBet.js), capped overall
//                 (openBetsCapUsdc) and per market (perMarketCapUsdc).
//   Lockout     — Metusela reports a refused/restricted account → betting
//                 pauses and no more float goes out until an admin turns
//                 betting back on.
//
// Worst-case loss on a lockout = floatCapUsdc + openBetsCapUsdc.
//
// Env: POLYGON_RPC_URL, METUSELA_FLOAT_WALLET (Metusela's Polymarket wallet),
// METUSELA_FLOAT_TOKEN (pUSD contract on Polygon; 6 decimals).
const MetuselaBet = require('../models/metuselaBet');
const MetuselaWithdrawal = require('../models/metuselaWithdrawal');
const { MetuselaSettings, MetuselaSettingsAudit } = require('../models/metuselaSettings');
const { notifyMetusela } = require('./metuselaNotify');
const logger = require('../utils/logger');

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const ERC20_BALANCE_OF = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] }];

let client = null;
async function readOnChain() {
  const { POLYGON_RPC_URL: rpc, METUSELA_FLOAT_WALLET: wallet, METUSELA_FLOAT_TOKEN: token } = process.env;
  if (!rpc || !wallet || !token) throw new Error('Float wallet not configured (POLYGON_RPC_URL, METUSELA_FLOAT_WALLET, METUSELA_FLOAT_TOKEN).');
  if (!client) {
    const { createPublicClient, http } = require('viem');
    const { polygon } = require('viem/chains');
    client = createPublicClient({ chain: polygon, transport: http(rpc) });
  }
  const raw = await client.readContract({ address: token, abi: ERC20_BALANCE_OF, functionName: 'balanceOf', args: [wallet] });
  return Number(raw) / 1e6;
}
let balanceReader = readOnChain;

/** Idle pUSD in the float wallet, or null if it can't be read right now. */
async function idleBalance() {
  try {
    return round6(await balanceReader());
  } catch (err) {
    logger.warn('Metusela float balance read failed', { error: err.message });
    return null;
  }
}

/** Sum of OPEN bet budgets, overall or for one market. */
async function openBetsUsdc(marketId) {
  const [r] = await MetuselaBet.aggregate([
    { $match: { status: 'OPEN', ...(marketId ? { marketId } : {}) } },
    { $group: { _id: null, total: { $sum: '$budgetUsdc' } } },
  ]);
  return round6(r?.total || 0);
}

async function inFlightTopupsUsdc() {
  const inFlight = await MetuselaWithdrawal.find({ kind: 'FLOAT_TOPUP', status: 'SUBMITTED' });
  return round6(inFlight.reduce((sum, w) => sum + w.recipientReceivesUsdc, 0));
}

/** "Money at Polymarket right now" — for the partner API and the admin overview. */
async function status() {
  const s = await MetuselaSettings.get();
  const [idle, openBets, inFlight] = await Promise.all([idleBalance(), openBetsUsdc(), inFlightTopupsUsdc()]);
  return {
    idleUsdc: idle,
    balanceReadable: idle !== null,
    topupsInFlightUsdc: inFlight,
    openBetsUsdc: openBets,
    totalAtRiskUsdc: idle === null ? null : round6(idle + inFlight + openBets),
    floatCapUsdc: s.floatCapUsdc,
    openBetsCapUsdc: s.openBetsCapUsdc,
    perMarketCapUsdc: s.perMarketCapUsdc,
    // Idle money above the cap: Metusela should send it back to the pool.
    sweepDueUsdc: idle === null ? null : round6(Math.max(0, idle - s.floatCapUsdc)),
    // How much a top-up may add right now (0 if unknown or locked out).
    topupRoomUsdc: idle === null || !s.betsEnabled ? 0 : round6(Math.max(0, s.floatCapUsdc - idle - inFlight)),
    betsEnabled: s.betsEnabled,
    betsPausedReason: s.betsPausedReason || null,
  };
}

/**
 * Pause betting because Polymarket refused us or the account looks
 * restricted. Stays paused until an admin turns betting back on.
 */
async function lockout(reason) {
  const why = String(reason || 'Polymarket account problem').slice(0, 300);
  const s = await MetuselaSettings.get();
  const already = !s.betsEnabled;
  s.betsEnabled = false;
  s.betsPausedReason = why;
  s.updatedBy = 'metusela:lockout';
  await s.save();
  if (!already) {
    await MetuselaSettingsAudit.create({ adminEmail: 'metusela', action: 'BETS_LOCKOUT', changes: [{ path: 'betsEnabled', from: true, to: false }], note: why })
      .catch((err) => logger.error('Metusela lockout audit write failed', { error: err.message }));
    logger.error('Metusela betting paused: Polymarket lockout', { reason: why });
    notifyMetusela('pool.bets_paused', { reason: why });
  }
  return status();
}

function setBalanceReaderForTests(fn) {
  balanceReader = fn || readOnChain;
}

module.exports = { idleBalance, openBetsUsdc, inFlightTopupsUsdc, status, lockout, setBalanceReaderForTests };
