// adminRoutes/metusela.js — Metusela admin (mounted at /admin/metusela behind
// authenticateAdminToken + requireAdmin in server.js). Changing settings or
// adjusting balances needs super_admin; every settings change is audited.
//
//   GET   /admin/metusela/settings               — current fees/limits/switches + editable paths
//   PATCH /admin/metusela/settings               — { "depositFeeBps": 50, ... } (super_admin)
//   GET   /admin/metusela/settings/audit         — who changed what, when
//   GET   /admin/metusela/overview               — pool, fees, user totals, things needing attention
//   GET   /admin/metusela/accounts?partnerUserId=
//   GET   /admin/metusela/accounts/:pid/history
//   GET   /admin/metusela/deposits?status=
//   POST  /admin/metusela/accounts/:pid/adjust   — { amountUsdc (+/-), reason } (super_admin)
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { MetuselaSettings, MetuselaSettingsAudit } = require('../models/metuselaSettings');
const MetuselaAccount = require('../models/metuselaAccount');
const MetuselaTransfer = require('../models/metuselaTransfer');
const MetuselaDeposit = require('../models/metuselaDeposit');
const MetuselaWithdrawal = require('../models/metuselaWithdrawal');
const wallet = require('../services/metuselaWallet');
const logger = require('../utils/logger');

const superOnly = (req, res, next) => (req.admin?.adminRole === 'super_admin'
  ? next()
  : res.status(403).json({ success: false, error: 'Super admin access required.' }));

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

router.get('/settings', async (req, res) => {
  const s = await MetuselaSettings.get();
  res.json({ success: true, data: { settings: s, editable: MetuselaSettings.PATCHABLE } });
});

router.patch('/settings', superOnly, async (req, res) => {
  const { errors, clean } = MetuselaSettings.validatePatch(req.body);
  if (errors.length) return res.status(400).json({ success: false, error: 'Invalid settings.', errors });

  const s = await MetuselaSettings.get();
  const changes = [];
  for (const [path, to] of Object.entries(clean)) {
    const from = get(s.toObject(), path);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    s.set(path, to);
    changes.push({ path, from, to });
  }
  if (!changes.length) return res.json({ success: true, message: 'No changes.', data: s });
  s.updatedBy = req.admin.email || String(req.admin.id || '');
  await s.save();
  await MetuselaSettingsAudit.create({ adminId: String(req.admin.id || req.admin._id || ''), adminEmail: req.admin.email || null, changes });
  logger.info('Metusela settings updated', { by: s.updatedBy, paths: changes.map((c) => c.path) });
  res.json({ success: true, message: 'Settings updated.', data: s, changes });
});

router.get('/settings/audit', async (req, res) => {
  const items = await MetuselaSettingsAudit.find().sort({ createdAt: -1 }).limit(100);
  res.json({ success: true, data: items });
});

router.get('/overview', async (req, res) => {
  const [pool, fees] = await Promise.all([wallet.systemAccount('POOL'), wallet.systemAccount('FEES')]);
  const [users] = await MetuselaAccount.aggregate([
    { $match: { kind: 'USER' } },
    { $group: { _id: null, count: { $sum: 1 }, totalUsdc: { $sum: '$usdcBalance' } } },
  ]);
  const [stuckTransfers, heldDeposits, failedWithdrawals, floatInFlight] = await Promise.all([
    MetuselaTransfer.countDocuments({ $or: [{ debitState: 'APPLYING' }, { creditState: 'APPLYING' }] }),
    MetuselaDeposit.countDocuments({ status: { $in: ['SWAP_FAILED', 'BELOW_FEE', 'IGNORED'] } }),
    MetuselaWithdrawal.countDocuments({ status: 'FAILED' }),
    MetuselaWithdrawal.countDocuments({ kind: 'FLOAT_TOPUP', status: 'SUBMITTED' }),
  ]);
  res.json({
    success: true,
    data: {
      users: { count: users?.count || 0, totalUsdc: users?.totalUsdc || 0 },
      pool: { usdcBalance: pool.usdcBalance },
      fees: { usdcBalance: fees.usdcBalance },
      needsAttention: { stuckTransfers, heldDeposits, failedWithdrawals },
      floatTopupsInFlight: floatInFlight,
    },
  });
});

router.get('/accounts', async (req, res) => {
  const filter = { kind: 'USER' };
  if (req.query.partnerUserId) filter.partnerUserId = String(req.query.partnerUserId);
  const items = await MetuselaAccount.find(filter).sort({ usdcBalance: -1 }).limit(100);
  res.json({ success: true, data: items.map(wallet.serializeAccount) });
});

router.get('/accounts/:pid/history', async (req, res) => {
  try {
    const account = await wallet.getUserAccount(req.params.pid);
    res.json({ success: true, data: await wallet.history(account, { limit: 200 }) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

router.get('/deposits', async (req, res) => {
  const filter = req.query.status ? { status: String(req.query.status).toUpperCase() } : {};
  const items = await MetuselaDeposit.find(filter).sort({ createdAt: -1 }).limit(100);
  res.json({ success: true, data: items });
});

// Manual correction, e.g. crediting a held deposit after review. Positive
// credits the user; negative debits them. Always with a reason.
router.post('/accounts/:pid/adjust', superOnly, async (req, res) => {
  try {
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
    logger.warn('Metusela balance adjusted by admin', { partnerUserId: account.partnerUserId, amount, ...meta });
    res.json({ success: true, data: wallet.serializeAccount(await MetuselaAccount.findById(account._id)) });
  } catch (err) {
    res.status(err.statusCode || 500).json({ success: false, error: err.message });
  }
});

module.exports = router;
