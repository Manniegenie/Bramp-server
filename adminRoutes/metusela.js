// adminRoutes/metusela.js — Metusela admin API for the admin web page
// (bramp-admin). Mounted at /admin/metusela behind authenticateAdminToken +
// requireAdmin in server.js, so it uses the existing admin login (incl. 2FA).
// Reads need admin; anything that changes money or settings needs
// super_admin and is written to the audit log.
//
// Fees (the simple way to set them)
//   GET    /fees                             — current fees, in % and basis points, with an example
//   PUT    /fees                             — any of: betFeePct | betFeeBps, depositFeePct | depositFeeBps,
//                                              depositFeeFlatUsdc, usdtSwapMarkupPct | usdtSwapMarkupBps,
//                                              withdrawalFeeFlatUsdc                                         (super)
// Settings
//   GET    /settings                         — values + `fields` (labels, types, units) to build the form
//   PATCH  /settings                         — { "depositFeeBps": 50, ... }                     (super)
//   GET    /audit?action=&limit=             — every admin action, newest first
// Obiex network fee table (per coin, per network)
//   GET    /networks                         — effective terms (defaults + overrides)
//   PUT    /networks/:currency/:network      — { minDeposit?, depositFee?, minWithdrawal?, withdrawalFee?, enabled?, name? } (super)
//   DELETE /networks/:currency/:network      — drop the override, back to Obiex's default      (super)
// Money
//   GET    /overview                         — users, pool, fees, things needing attention
//   GET    /accounts?partnerUserId=          — accounts by balance
//   GET    /accounts/:pid                    — one account + its recent deposits/withdrawals
//   GET    /accounts/:pid/history            — its balance changes
//   POST   /accounts/:pid/adjust             — { amountUsdc (+/-), reason }                     (super)
//   GET    /deposits?status=                 — e.g. status=SWAP_FAILED for held deposits
//   POST   /deposits/:obiexTransactionId/resolve — { creditUsdc, note } credit a held deposit  (super)
//   GET    /withdrawals?status=&kind=        — user withdrawals and float top-ups
//   GET    /transfers?type=&limit=           — the ledger
//   POST   /pool/float-topups                — { amountUsdc, network, address }                 (super)
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { MetuselaSettings, MetuselaSettingsAudit } = require('../models/metuselaSettings');
const MetuselaAccount = require('../models/metuselaAccount');
const MetuselaTransfer = require('../models/metuselaTransfer');
const MetuselaDeposit = require('../models/metuselaDeposit');
const MetuselaWithdrawal = require('../models/metuselaWithdrawal');
const wallet = require('../services/metuselaWallet');
const float = require('../services/metuselaFloat');
const { networkTerms, normalizeNetwork, OBIEX_DEFAULTS } = require('../services/metuselaNetworks');
const logger = require('../utils/logger');

const superOnly = (req, res, next) => (req.admin?.adminRole === 'super_admin'
  ? next()
  : res.status(403).json({ success: false, error: 'Super admin access required.' }));

const who = (req) => ({ adminId: String(req.admin?.id || req.admin?._id || ''), adminEmail: req.admin?.email || null });
const audit = (req, entry) => MetuselaSettingsAudit.create({ ...who(req), ...entry })
  .catch((err) => logger.error('Metusela admin audit write failed', { error: err.message, entry }));

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const limitOf = (q, max = 200) => Math.min(Math.max(parseInt(q, 10) || 50, 1), max);

// Async errors → JSON, with WalletError status codes.
const route = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof wallet.WalletError) return res.status(err.statusCode).json({ success: false, error: err.message });
    logger.error('Metusela admin route failed', { path: req.path, error: err.message });
    res.status(500).json({ success: false, error: 'Internal error.' });
  }
};

// ── Fees ───────────────────────────────────────────────────────────────────

function feesView(s) {
  const pct = (bps) => bps / 100;
  // A worked example the admin page can show next to the inputs.
  const exampleDeposit = 100;
  const depositFee = Math.floor((s.depositFeeFlatUsdc + exampleDeposit * s.depositFeeBps / 10000) * 100) / 100;
  const swapMarkup = Math.floor(exampleDeposit * s.usdtSwapMarkupBps / 10000 * 100) / 100;
  const betFee = Math.floor(10 * s.betFeeBps / 10000 * 100) / 100;
  return {
    betFeePct: pct(s.betFeeBps),
    betFeeBps: s.betFeeBps,
    depositFeePct: pct(s.depositFeeBps),
    depositFeeBps: s.depositFeeBps,
    depositFeeFlatUsdc: s.depositFeeFlatUsdc,
    usdtSwapMarkupPct: pct(s.usdtSwapMarkupBps),
    usdtSwapMarkupBps: s.usdtSwapMarkupBps,
    withdrawalFeeFlatUsdc: s.withdrawalFeeFlatUsdc,
    example: {
      betOf10: { feeUsdc: betFee, orderBudgetUsdc: Math.round((10 - betFee) * 100) / 100, note: 'User is debited exactly $10; the budget includes Polymarket’s own fees.' },
      usdcDepositOf100: { feeUsdc: depositFee, creditedUsdc: Math.round((exampleDeposit - depositFee) * 100) / 100 },
      usdtDepositOf100: { extraMarkupUsdc: swapMarkup, note: 'Taken on top of the deposit fee, after Obiex swaps USDT to USDC.' },
      withdrawal: { yourFeeUsdc: s.withdrawalFeeFlatUsdc, note: 'Charged on top of the amount; Obiex’s network fee is separate.' },
    },
    updatedBy: s.updatedBy,
    updatedAt: s.updatedAt,
  };
}

router.get('/fees', route(async (req, res) => {
  res.json({ success: true, data: feesView(await MetuselaSettings.get()) });
}));

/**
 * PUT /fees — set any subset. Percent or basis points (not both for the
 * same fee): { "depositFeePct": 1 } === { "depositFeeBps": 100 }.
 */
router.put('/fees', superOnly, route(async (req, res) => {
  const b = req.body || {};
  const allowed = ['betFeePct', 'betFeeBps', 'depositFeePct', 'depositFeeBps', 'depositFeeFlatUsdc', 'usdtSwapMarkupPct', 'usdtSwapMarkupBps', 'withdrawalFeeFlatUsdc'];
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) return res.status(400).json({ success: false, error: `Unknown field(s): ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}.` });
  if (!Object.keys(b).length) return res.status(400).json({ success: false, error: 'Send at least one fee.' });

  const patch = {};
  for (const [pctKey, bpsKey] of [['betFeePct', 'betFeeBps'], ['depositFeePct', 'depositFeeBps'], ['usdtSwapMarkupPct', 'usdtSwapMarkupBps']]) {
    if (pctKey in b && bpsKey in b) return res.status(400).json({ success: false, error: `Send ${pctKey} or ${bpsKey}, not both.` });
    if (pctKey in b) {
      const pct = Number(b[pctKey]);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ success: false, error: `${pctKey} must be between 0 and 100.` });
      patch[bpsKey] = Math.round(pct * 100);
    }
    if (bpsKey in b) patch[bpsKey] = b[bpsKey];
  }
  for (const k of ['depositFeeFlatUsdc', 'withdrawalFeeFlatUsdc']) if (k in b) patch[k] = b[k];

  // Same validation and audit as PATCH /settings.
  const { errors, clean } = MetuselaSettings.validatePatch(patch);
  if (errors.length) return res.status(400).json({ success: false, error: 'Invalid fees.', errors });
  const s = await MetuselaSettings.get();
  const changes = [];
  for (const [path, to] of Object.entries(clean)) {
    const from = get(s.toObject(), path);
    if (from === to) continue;
    s.set(path, to);
    changes.push({ path, from, to });
  }
  if (changes.length) {
    s.updatedBy = req.admin.email || String(req.admin.id || '');
    await s.save();
    await audit(req, { action: 'FEES_UPDATE', changes });
    logger.info('Metusela fees updated', { by: s.updatedBy, changes });
  }
  res.json({ success: true, message: changes.length ? 'Fees updated.' : 'No changes.', data: feesView(s), changes });
}));

// ── Settings ───────────────────────────────────────────────────────────────

router.get('/settings', route(async (req, res) => {
  const s = await MetuselaSettings.get();
  res.json({ success: true, data: { settings: s, fields: MetuselaSettings.FIELDS } });
}));

router.patch('/settings', superOnly, route(async (req, res) => {
  const { errors, clean } = MetuselaSettings.validatePatch(req.body);
  if (errors.length) return res.status(400).json({ success: false, error: 'Invalid settings.', errors });

  const s = await MetuselaSettings.get();
  const changes = [];
  for (const [path, to] of Object.entries(clean)) {
    const from = get(s.toObject(), path);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    s.set(path, to);
    if (path === 'networkOverrides') s.markModified('networkOverrides');
    changes.push({ path, from, to });
    // Turning betting back on ends a lockout.
    if (path === 'betsEnabled' && to === true && s.betsPausedReason) {
      changes.push({ path: 'betsPausedReason', from: s.betsPausedReason, to: null });
      s.betsPausedReason = null;
    }
  }
  if (!changes.length) return res.json({ success: true, message: 'No changes.', data: s });
  s.updatedBy = req.admin.email || String(req.admin.id || '');
  await s.save();
  await audit(req, { action: 'SETTINGS_UPDATE', changes });
  logger.info('Metusela settings updated', { by: s.updatedBy, paths: changes.map((c) => c.path) });
  res.json({ success: true, message: 'Settings updated.', data: s, changes });
}));

router.get('/audit', route(async (req, res) => {
  const filter = req.query.action ? { action: String(req.query.action).toUpperCase() } : {};
  res.json({ success: true, data: await MetuselaSettingsAudit.find(filter).sort({ createdAt: -1 }).limit(limitOf(req.query.limit)) });
}));
// Kept for anything already calling the old path.
router.get('/settings/audit', route(async (req, res) => {
  res.json({ success: true, data: await MetuselaSettingsAudit.find().sort({ createdAt: -1 }).limit(100) });
}));

// ── Network fee table ──────────────────────────────────────────────────────

router.get('/networks', route(async (req, res) => {
  const s = await MetuselaSettings.get();
  const rows = (cur) => networkTerms(cur, s.networkOverrides).map((t) => ({
    ...t,
    overridden: Boolean(s.networkOverrides?.[cur]?.[t.code]),
    default: OBIEX_DEFAULTS[cur]?.[t.code] || null,
  }));
  res.json({ success: true, data: { USDC: rows('USDC'), USDT: rows('USDT') } });
}));

const TERM_FIELDS = ['minDeposit', 'depositFee', 'minWithdrawal', 'withdrawalFee'];

router.put('/networks/:currency/:network', superOnly, route(async (req, res) => {
  const cur = String(req.params.currency).toUpperCase();
  const net = normalizeNetwork(req.params.network);
  if (!['USDC', 'USDT'].includes(cur)) return res.status(400).json({ success: false, error: 'currency must be USDC or USDT.' });
  if (!/^[A-Z0-9_-]{2,20}$/.test(net)) return res.status(400).json({ success: false, error: 'Invalid network code.' });

  const patch = {};
  for (const [k, v] of Object.entries(req.body || {})) {
    if (TERM_FIELDS.includes(k)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return res.status(400).json({ success: false, error: `${k} must be a number ≥ 0.` });
      patch[k] = n;
    } else if (k === 'enabled') {
      if (typeof v !== 'boolean') return res.status(400).json({ success: false, error: 'enabled must be true or false.' });
      patch.enabled = v;
    } else if (k === 'name') {
      if (typeof v !== 'string' || !v.trim() || v.length > 40) return res.status(400).json({ success: false, error: 'name must be 1–40 characters.' });
      patch.name = v.trim();
    } else {
      return res.status(400).json({ success: false, error: `Unknown field: ${k}` });
    }
  }
  const isNew = !OBIEX_DEFAULTS[cur]?.[net];
  if (isNew && !TERM_FIELDS.every((f) => f in patch)) {
    return res.status(400).json({ success: false, error: `A network not in Obiex's table needs all of: ${TERM_FIELDS.join(', ')}.` });
  }
  if (!Object.keys(patch).length) return res.status(400).json({ success: false, error: 'Nothing to change.' });

  const s = await MetuselaSettings.get();
  const overrides = JSON.parse(JSON.stringify(s.networkOverrides || {}));
  const before = overrides[cur]?.[net] || null;
  overrides[cur] = { ...(overrides[cur] || {}), [net]: { ...(before || {}), ...patch } };
  s.networkOverrides = overrides;
  s.markModified('networkOverrides');
  s.updatedBy = req.admin.email || String(req.admin.id || '');
  await s.save();
  await audit(req, { action: 'NETWORK_TERMS_UPDATE', target: `${cur}/${net}`, changes: [{ path: `networkOverrides.${cur}.${net}`, from: before, to: overrides[cur][net] }] });
  res.json({ success: true, data: networkTerms(cur, s.networkOverrides).find((t) => t.code === net) });
}));

router.delete('/networks/:currency/:network', superOnly, route(async (req, res) => {
  const cur = String(req.params.currency).toUpperCase();
  const net = normalizeNetwork(req.params.network);
  const s = await MetuselaSettings.get();
  const overrides = JSON.parse(JSON.stringify(s.networkOverrides || {}));
  const before = overrides[cur]?.[net];
  if (!before) return res.status(404).json({ success: false, error: 'No override for that network.' });
  delete overrides[cur][net];
  s.networkOverrides = overrides;
  s.markModified('networkOverrides');
  await s.save();
  await audit(req, { action: 'NETWORK_TERMS_RESET', target: `${cur}/${net}`, changes: [{ path: `networkOverrides.${cur}.${net}`, from: before, to: null }] });
  res.json({ success: true, data: networkTerms(cur, s.networkOverrides).find((t) => t.code === net) || null });
}));

// ── Money ──────────────────────────────────────────────────────────────────

router.get('/overview', route(async (req, res) => {
  const [pool, fees] = await Promise.all([wallet.systemAccount('POOL'), wallet.systemAccount('FEES')]);
  const [users] = await MetuselaAccount.aggregate([
    { $match: { kind: 'USER' } },
    { $group: { _id: null, count: { $sum: 1 }, totalUsdc: { $sum: '$usdcBalance' } } },
  ]);
  const [stuckTransfers, heldDeposits, failedWithdrawals, floatInFlight, pendingWithdrawals] = await Promise.all([
    MetuselaTransfer.countDocuments({ $or: [{ debitState: 'APPLYING' }, { creditState: 'APPLYING' }] }),
    MetuselaDeposit.countDocuments({ status: { $in: ['SWAP_FAILED', 'BELOW_FEE', 'IGNORED'] } }),
    MetuselaWithdrawal.countDocuments({ status: 'FAILED' }),
    MetuselaWithdrawal.countDocuments({ kind: 'FLOAT_TOPUP', status: 'SUBMITTED' }),
    MetuselaWithdrawal.countDocuments({ kind: 'USER', status: 'SUBMITTED' }),
  ]);
  res.json({
    success: true,
    data: {
      users: { count: users?.count || 0, totalUsdc: users?.totalUsdc || 0 },
      pool: { usdcBalance: pool.usdcBalance },
      fees: { usdcBalance: fees.usdcBalance },
      needsAttention: { stuckTransfers, heldDeposits, failedWithdrawals },
      inFlight: { userWithdrawals: pendingWithdrawals, floatTopups: floatInFlight },
      // "Money at Polymarket right now": idle + in flight + live bets, against the caps.
      atPolymarket: await float.status(),
    },
  });
}));

router.get('/accounts', route(async (req, res) => {
  const filter = { kind: 'USER' };
  if (req.query.partnerUserId) filter.partnerUserId = String(req.query.partnerUserId);
  const items = await MetuselaAccount.find(filter).sort({ usdcBalance: -1 }).limit(limitOf(req.query.limit));
  res.json({ success: true, data: items.map(wallet.serializeAccount) });
}));

router.get('/accounts/:pid', route(async (req, res) => {
  const account = await wallet.getUserAccount(req.params.pid);
  const [deposits, withdrawals] = await Promise.all([
    MetuselaDeposit.find({ accountId: account._id }).sort({ createdAt: -1 }).limit(20),
    MetuselaWithdrawal.find({ accountId: account._id }).sort({ createdAt: -1 }).limit(20),
  ]);
  res.json({
    success: true,
    data: {
      account: wallet.serializeAccount(account),
      deposits: deposits.map(wallet.serializeDeposit),
      withdrawals: withdrawals.map(wallet.serializeWithdrawal),
    },
  });
}));

router.get('/accounts/:pid/history', route(async (req, res) => {
  const account = await wallet.getUserAccount(req.params.pid);
  res.json({ success: true, data: await wallet.history(account, { limit: 200 }) });
}));

// Manual correction. Positive credits the user; negative debits them.
router.post('/accounts/:pid/adjust', superOnly, route(async (req, res) => {
  const amount = Number(req.body?.amountUsdc);
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ success: false, error: 'amountUsdc must be a non-zero number.' });
  if (reason.length < 5) return res.status(400).json({ success: false, error: 'A reason is required.' });
  const account = await wallet.getUserAccount(req.params.pid);
  const reference = `adjust:${crypto.randomBytes(8).toString('hex')}`;
  const meta = { reason, by: req.admin.email || String(req.admin.id || '') };
  await wallet.transfer(amount > 0
    ? { reference, type: 'ADJUSTMENT', toId: account._id, amount, meta }
    : { reference, type: 'ADJUSTMENT', fromId: account._id, amount: -amount, meta });
  await audit(req, { action: 'BALANCE_ADJUST', target: account.partnerUserId, changes: [{ path: 'usdcBalance', delta: amount }], note: reason });
  logger.warn('Metusela balance adjusted by admin', { partnerUserId: account.partnerUserId, amount, ...meta });
  res.json({ success: true, data: wallet.serializeAccount(await MetuselaAccount.findById(account._id)) });
}));

router.get('/deposits', route(async (req, res) => {
  const filter = req.query.status ? { status: String(req.query.status).toUpperCase() } : {};
  const items = await MetuselaDeposit.find(filter).sort({ createdAt: -1 }).limit(limitOf(req.query.limit));
  res.json({ success: true, data: items });
}));

// Credit a held deposit (swap failed, below fee, unsupported coin) after
// reviewing it on Obiex. The admin states the USDC to credit.
router.post('/deposits/:id/resolve', superOnly, route(async (req, res) => {
  const credit = Number(req.body?.creditUsdc);
  const note = String(req.body?.note || '').trim();
  if (!(credit >= 0)) return res.status(400).json({ success: false, error: 'creditUsdc must be ≥ 0 (0 = close without crediting).' });
  if (note.length < 5) return res.status(400).json({ success: false, error: 'A note is required.' });
  const dep = await MetuselaDeposit.findOneAndUpdate(
    { obiexTransactionId: req.params.id, status: { $in: ['SWAP_FAILED', 'BELOW_FEE', 'IGNORED'] } },
    { status: 'CREDITED', creditedUsdc: credit, feeUsdc: 0, grossUsdc: credit, creditedAt: new Date(), failureReason: `Resolved by admin: ${note}` },
    { new: true }
  );
  if (!dep) return res.status(404).json({ success: false, error: 'No held deposit with that id.' });
  if (credit > 0) {
    await wallet.transfer({ reference: `dep:${dep.obiexTransactionId}:resolved`, type: 'DEPOSIT', toId: dep.accountId, amount: credit, meta: { note, by: who(req).adminEmail } });
  }
  await audit(req, { action: 'DEPOSIT_RESOLVE', target: dep.obiexTransactionId, changes: [{ path: 'creditedUsdc', to: credit }], note });
  res.json({ success: true, data: wallet.serializeDeposit(dep) });
}));

router.get('/withdrawals', route(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = String(req.query.status).toUpperCase();
  if (req.query.kind) filter.kind = String(req.query.kind).toUpperCase();
  const items = await MetuselaWithdrawal.find(filter).sort({ createdAt: -1 }).limit(limitOf(req.query.limit));
  res.json({ success: true, data: items.map(wallet.serializeWithdrawal) });
}));

router.get('/transfers', route(async (req, res) => {
  const filter = req.query.type ? { type: String(req.query.type).toUpperCase() } : {};
  const items = await MetuselaTransfer.find(filter).sort({ createdAt: -1 }).limit(limitOf(req.query.limit));
  res.json({ success: true, data: items });
}));

router.post('/pool/float-topups', superOnly, route(async (req, res) => {
  const b = req.body || {};
  const reference = `admin-${crypto.randomBytes(6).toString('hex')}`;
  const w = await wallet.floatTopup({ reference, amountUsdc: b.amountUsdc, network: b.network, address: b.address });
  await audit(req, { action: 'FLOAT_TOPUP', target: w.reference, changes: [{ path: 'pool', delta: -w.amountUsdc }], note: `${w.network} → ${w.address}` });
  res.status(201).json({ success: true, data: wallet.serializeWithdrawal(w) });
}));

module.exports = router;
