// routes/metusela.js — Metusela endpoints
//
// Partner API for Metusela (Naira → USDC on-ramp). Mounted at /metusela in
// server.js behind auth/partnerAuth.js: every request needs
//   X-Partner-Key: <METUSELA_PARTNER_API_KEY>
// Responses use Bramp's { success, message?, data } envelope.
//
//   GET  /metusela/health                    — key check + config sanity
//   GET  /metusela/onramp/networks           — USDC payout networks available now
//   GET  /metusela/onramp/quote?amountNgn=   — rate, fee, USDC for an amount
//   POST /metusela/onramp/orders             — create an order (idempotent on partnerReference)
//   GET  /metusela/onramp/orders/:ref        — order by Bramp reference or partnerReference
//   (Naira on-ramp: paused on Metusela's side for now)
//
// Crypto wallet (services/metuselaWallet.js) — balances held at Bramp:
//   POST /metusela/accounts                          { partnerUserId } — create/get
//   GET  /metusela/accounts/:pid                     — balance + deposit addresses
//   GET  /metusela/deposit-options                   — USDC/USDT × live Obiex networks, fees
//   POST /metusela/accounts/:pid/deposit-address     { currency, network }
//   GET  /metusela/accounts/:pid/history             — signed balance changes
//   GET  /metusela/accounts/:pid/deposits
//   POST /metusela/accounts/:pid/stake               { reference, amountUsdc, marketId } — bet (all-in): user → pool; returns budgetUsdc
//   POST /metusela/accounts/:pid/stake/:ref/refund   — order didn't fill: whole stake back, fee included
//   POST /metusela/accounts/:pid/stake/:ref/settle   { payoutUsdc } — market resolved: close the bet, pay winnings (0 = lost)
//   POST /metusela/accounts/:pid/credit              { reference, amountUsdc, kind } — PAYOUT | REFUND: pool → user
//   GET  /metusela/withdrawal-networks               — USDC networks with minimum + fees, cheapest first
//   GET  /metusela/withdrawal-quote?amountUsdc=&network= — total debited, network fee, what arrives
//   POST /metusela/accounts/:pid/withdrawals         { reference, amountUsdc, network, address }
//   GET  /metusela/pool                              — pool + float status
//   GET  /metusela/pool/float                        — money at Polymarket: idle (on-chain), open bets, caps, sweepDueUsdc
//   POST /metusela/pool/float-topups                 { reference, amountUsdc?, network, address } — capped; no amount = fill to cap
//   POST /metusela/pool/lockout                      { reason } — Polymarket refused/restricted us: pause betting
//
// Status changes are pushed to METUSELA_WEBHOOK_URL, signed
// (services/metuselaNotify.js).
const express = require('express');
const router = express.Router();
const {
  quote, createOrder, findOrder, serializeOrder, payoutNetworks, OnrampError,
} = require('../services/metuselaOnramp');
const wallet = require('../services/metuselaWallet');
const MetuselaDeposit = require('../models/metuselaDeposit');
const MetuselaWithdrawal = require('../models/metuselaWithdrawal');
const float = require('../services/metuselaFloat');
const logger = require('../utils/logger');

function fail(res, err, fallback) {
  if (err instanceof OnrampError || err instanceof wallet.WalletError) {
    return res.status(err.statusCode).json({ success: false, message: err.message });
  }
  logger.error(fallback, { error: err.message, stack: err.stack });
  return res.status(500).json({ success: false, message: 'Internal error.' });
}

router.get('/health', async (req, res) => {
  res.json({
    success: true,
    data: {
      partner: req.partner,
      webhookConfigured: Boolean(process.env.METUSELA_WEBHOOK_URL && process.env.METUSELA_WEBHOOK_SECRET),
      glydeConfigured: Boolean(process.env.GLYDE_API_BASE_URL),
      time: new Date().toISOString(),
    },
  });
});

router.get('/onramp/networks', async (req, res) => {
  try {
    res.json({ success: true, data: { currency: 'USDC', networks: await payoutNetworks() } });
  } catch (err) {
    fail(res, err, 'metusela networks failed');
  }
});

router.get('/onramp/quote', async (req, res) => {
  try {
    res.json({ success: true, data: await quote(req.query.amountNgn) });
  } catch (err) {
    fail(res, err, 'metusela quote failed');
  }
});

/**
 * POST /metusela/onramp/orders
 * {
 *   partnerReference: "fund_123",          // Metusela's id; repeat calls return the same order
 *   partnerUserId: "u_456",
 *   amountNgn: 15000,
 *   customer: { firstName, lastName, email },   // shown to Glyde for the virtual account
 *   destination: { network: "POLYGON", address: "0x…" }  // the user's own wallet
 * }
 * → 201 (new) / 200 (existing) with the order, incl. bankTransfer details
 *   to show the user and expiresAt.
 */
router.post('/onramp/orders', async (req, res) => {
  try {
    const { order, created } = await createOrder(req.body || {});
    res.status(created ? 201 : 200).json({ success: true, data: serializeOrder(order) });
  } catch (err) {
    if (err.code === 11000) {
      // Two identical requests raced; return the winner.
      const order = await findOrder(req.body.partnerReference);
      if (order) return res.status(200).json({ success: true, data: serializeOrder(order) });
    }
    fail(res, err, 'metusela create order failed');
  }
});

router.get('/onramp/orders/:ref', async (req, res) => {
  try {
    const order = await findOrder(req.params.ref);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
    res.json({ success: true, data: serializeOrder(order) });
  } catch (err) {
    fail(res, err, 'metusela get order failed');
  }
});

// ── Crypto wallet ──────────────────────────────────────────────────────────

const route = (fn, label) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    fail(res, err, `metusela ${label} failed`);
  }
};

const reqRef = (v) => {
  const ref = String(v || '').trim();
  if (!/^[A-Za-z0-9_:.-]{4,100}$/.test(ref)) throw new wallet.WalletError('reference is required (4–100 chars: letters, digits, _ : . -).');
  return ref;
};

router.post('/accounts', route(async (req, res) => {
  const { account, created } = await wallet.ensureAccount(req.body?.partnerUserId);
  res.status(created ? 201 : 200).json({ success: true, data: wallet.serializeAccount(account) });
}, 'create account'));

router.get('/accounts/:pid', route(async (req, res) => {
  res.json({ success: true, data: wallet.serializeAccount(await wallet.getUserAccount(req.params.pid)) });
}, 'get account'));

router.get('/deposit-options', route(async (req, res) => {
  res.json({ success: true, data: await wallet.depositOptions() });
}, 'deposit options'));

router.post('/accounts/:pid/deposit-address', route(async (req, res) => {
  const account = await wallet.getUserAccount(req.params.pid);
  const addr = await wallet.depositAddress(account, req.body?.currency, req.body?.network);
  res.json({ success: true, data: { currency: addr.currency, network: addr.network, address: addr.address, memo: addr.memo, creditedAs: 'USDC' } });
}, 'deposit address'));

router.get('/accounts/:pid/history', route(async (req, res) => {
  const account = await wallet.getUserAccount(req.params.pid);
  res.json({ success: true, data: await wallet.history(account, { limit: Number(req.query.limit) || 50 }) });
}, 'history'));

router.get('/accounts/:pid/deposits', route(async (req, res) => {
  const account = await wallet.getUserAccount(req.params.pid);
  const deps = await MetuselaDeposit.find({ accountId: account._id }).sort({ createdAt: -1 }).limit(50);
  res.json({ success: true, data: deps.map(wallet.serializeDeposit) });
}, 'deposits'));

// All-in stake: debits amountUsdc; returns the order budget (stake − bet fee).
router.post('/accounts/:pid/stake', route(async (req, res) => {
  const b = req.body || {};
  const r = await wallet.stake(req.params.pid, { reference: reqRef(b.reference), amountUsdc: b.amountUsdc, marketId: b.marketId });
  res.json({
    success: true,
    data: { ...wallet.serializeAccount(r.account), stakeUsdc: r.stakeUsdc, betFeeUsdc: r.betFeeUsdc, budgetUsdc: r.budgetUsdc },
  });
}, 'stake'));

// The order for that stake didn't fill: full refund, bet fee included.
router.post('/accounts/:pid/stake/:reference/refund', route(async (req, res) => {
  const r = await wallet.refundStake(req.params.pid, { reference: reqRef(req.params.reference) });
  res.json({ success: true, data: { ...wallet.serializeAccount(r.account), refundedUsdc: r.refundedUsdc } });
}, 'refund stake'));

// The market resolved: close the bet; payoutUsdc 0 for a losing bet.
router.post('/accounts/:pid/stake/:reference/settle', route(async (req, res) => {
  const r = await wallet.settleStake(req.params.pid, { reference: reqRef(req.params.reference), payoutUsdc: req.body?.payoutUsdc });
  res.json({ success: true, data: { ...wallet.serializeAccount(r.account), payoutUsdc: r.payoutUsdc } });
}, 'settle stake'));

router.post('/accounts/:pid/credit', route(async (req, res) => {
  const account = await wallet.credit(req.params.pid, { reference: reqRef(req.body?.reference), amountUsdc: req.body?.amountUsdc, kind: req.body?.kind });
  res.json({ success: true, data: wallet.serializeAccount(account) });
}, 'credit'));

router.get('/withdrawal-networks', route(async (req, res) => {
  res.json({ success: true, data: await wallet.withdrawalNetworks() });
}, 'withdrawal networks'));

// What a withdrawal costs and delivers: ?amountUsdc=&network=
router.get('/withdrawal-quote', route(async (req, res) => {
  res.json({ success: true, data: await wallet.quoteWithdrawal({ amountUsdc: req.query.amountUsdc, network: req.query.network }) });
}, 'withdrawal quote'));

router.post('/accounts/:pid/withdrawals', route(async (req, res) => {
  const b = req.body || {};
  const w = await wallet.withdraw(req.params.pid, { reference: reqRef(b.reference), amountUsdc: b.amountUsdc, network: b.network, address: b.address });
  res.status(201).json({ success: true, data: wallet.serializeWithdrawal(w) });
}, 'withdraw'));

router.get('/pool', route(async (req, res) => {
  const pool = await wallet.systemAccount('POOL');
  const inFlight = await MetuselaWithdrawal.find({ kind: 'FLOAT_TOPUP', status: 'SUBMITTED' });
  res.json({
    success: true,
    data: {
      usdcBalance: pool.usdcBalance,
      depositAddresses: wallet.serializeAccount(pool).depositAddresses,
      floatTopupsInFlight: inFlight.map(wallet.serializeWithdrawal),
      float: await float.status(),
    },
  });
}, 'pool'));

router.get('/pool/float', route(async (req, res) => {
  res.json({ success: true, data: await float.status() });
}, 'float status'));

// Polymarket refused an order for account reasons, or the account looks
// restricted: stop betting and float top-ups until an admin re-enables.
router.post('/pool/lockout', route(async (req, res) => {
  res.json({ success: true, data: await float.lockout(req.body?.reason) });
}, 'lockout'));

// The pool's own deposit address — where Metusela sends float back.
router.post('/pool/deposit-address', route(async (req, res) => {
  const pool = await wallet.systemAccount('POOL');
  const addr = await wallet.depositAddress(pool, req.body?.currency || 'USDC', req.body?.network);
  res.json({ success: true, data: { currency: addr.currency, network: addr.network, address: addr.address, memo: addr.memo } });
}, 'pool deposit address'));

router.post('/pool/float-topups', route(async (req, res) => {
  const b = req.body || {};
  const w = await wallet.floatTopup({ reference: reqRef(b.reference), amountUsdc: b.amountUsdc, network: b.network, address: b.address });
  res.status(201).json({ success: true, data: wallet.serializeWithdrawal(w) });
}, 'float topup'));

module.exports = router;
