// adminRoutes/storefrontOfframp.js — Storefront offramp admin API (spec,
// 17 Nov 2026), used by bramp-admin's Storefront pages. Mounted at
// /admin/storefront-offramp behind authenticateAdminToken + requireAdmin in
// server.js. Reads need admin; anything that changes money, limits or a
// trader's Self rate needs super_admin.
//
//   GET   /summary                         — counts for the Storefront dashboard
//   GET   /desks?search=&rateMode=&status=&selfRate=&page=&limit=
//   GET   /desks/:slug                     — desk, owner, NGNB balance, Self rate, 30-day stats, recent sales
//   PATCH /desks/:slug                     — { status?, perTradeMaxNgn?, dailyMaxNgn?, markdownNgnPerUsd?,
//                                             payoutLimitNgn?, feePct?, feeMinNgn?, feeMaxNgn? }          (super)
//   GET   /self-rate/applications?status=  — default PENDING, with automatic check results
//   POST  /desks/:slug/self-rate/recheck   — run the automatic checks again
//   POST  /desks/:slug/self-rate/approve   — { payoutLimitNgn, feePct?, feeMinNgn?, feeMaxNgn? }       (super)
//   POST  /desks/:slug/self-rate/reject    — { reason } shown to the trader; Self rate off                (super)
//   GET   /sales?status=&slug=&page=&limit=
//   GET   /sales/:ref                      — one sale in full
//   POST  /sales/:ref/resolve              — { outcome: PAID_MANUALLY | REFUNDED_CUSTOMER | NO_ACTION, note }
//                                             close a NEEDS_REVIEW or AWAITING_FUNDS sale by hand              (super)
const express = require('express');
const router = express.Router();
const User = require('../models/user');
const StorefrontMerchant = require('../models/storefrontMerchant');
const StorefrontCustomer = require('../models/storefrontCustomer');
const StorefrontSellOrder = require('../models/storefrontSellOrder');
const selfRate = require('../services/storefrontSelfRate');
const { serializeSale } = require('../services/storefrontSell');
const { notifyTrader } = require('../services/storefrontTraderNotify');
const logger = require('../utils/logger');

const superOnly = (req, res, next) => (req.admin?.adminRole === 'super_admin'
  ? next()
  : res.status(403).json({ success: false, error: 'Super admin access required.' }));
const who = (req) => req.admin?.email || String(req.admin?.id || req.admin?._id || '');
const route = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof selfRate.SelfRateError) return res.status(err.statusCode).json({ success: false, error: err.message });
    logger.error('Storefront offramp admin route error', { path: req.path, error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, error: 'Internal error.' });
  }
};
const pageOf = (q) => {
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 25, 1), 100);
  const page = Math.max(parseInt(q.page, 10) || 1, 1);
  return { limit, page, skip: (page - 1) * limit };
};
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const findDesk = (slug) => StorefrontMerchant.findOne({ slug: String(slug || '').toLowerCase() });

function deskRow(m, owner, stats = {}) {
  return {
    slug: m.slug,
    businessName: m.brandName,
    status: m.status,
    rateMode: m.rateMode,
    markdownNgnPerUsd: m.markdownNgnPerUsd,
    perTradeMaxNgn: m.perTradeMaxNgn,
    dailyMaxNgn: m.dailyMaxNgn,
    selfRate: {
      status: m.selfRate?.status || 'NONE',
      rates: Object.fromEntries(Object.keys(require('../services/storefrontSell').PAIRS).map((c) => [c, m.selfRate?.rates?.[c] ?? null])),
      payoutLimitNgn: m.selfRate?.payoutLimitNgn || 0,
      fee: selfRate.feeSchedule(m),
    },
    owner: owner ? { id: owner._id, email: owner.email, username: owner.username, name: [owner.firstname, owner.lastname].filter(Boolean).join(' '), kycLevel: owner.kycLevel, ngnbBalance: owner.ngnbBalance || 0 } : null,
    stats,
    createdAt: m.createdAt,
  };
}

function saleRow(o) {
  return {
    ...serializeSale(o),
    desk: o.merchantId?.slug || null,
    whatsapp: o.waId,
    rateMode: o.rateMode,
    reviewReason: o.reviewReason || null,
    resolution: o.resolution?.outcome ? o.resolution : null,
    settlement: o.settlement,
  };
}

/** Sales count and naira paid per desk over the last N days. */
async function deskStats(merchantIds, days = 30) {
  const since = new Date(Date.now() - days * 86400000);
  const rows = await StorefrontSellOrder.aggregate([
    { $match: { merchantId: { $in: merchantIds }, status: 'PAID', paidAt: { $gte: since } } },
    { $group: { _id: '$merchantId', sales: { $sum: 1 }, volumeNgn: { $sum: '$settlement.customerNgn' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { sales30d: r.sales, volume30dNgn: r.volumeNgn }]));
}

// ── Summary ────────────────────────────────────────────────────────────────

router.get('/summary', route(async (req, res) => {
  const day = new Date(); day.setHours(0, 0, 0, 0);
  const [desks, activeDesks, pendingApplications, needsReview, awaitingFunds, today] = await Promise.all([
    StorefrontMerchant.countDocuments({ rateMode: { $ne: null } }),
    StorefrontMerchant.countDocuments({ rateMode: { $ne: null }, status: 'active' }),
    StorefrontMerchant.countDocuments({ 'selfRate.status': 'PENDING' }),
    StorefrontSellOrder.countDocuments({ status: 'NEEDS_REVIEW' }),
    StorefrontSellOrder.countDocuments({ status: 'AWAITING_FUNDS' }),
    StorefrontSellOrder.aggregate([
      { $match: { status: 'PAID', paidAt: { $gte: day } } },
      { $group: { _id: null, sales: { $sum: 1 }, volumeNgn: { $sum: '$settlement.customerNgn' } } },
    ]),
  ]);
  res.json({
    success: true,
    data: { desks, activeDesks, pendingApplications, needsReview, awaitingFunds, todaySales: today[0]?.sales || 0, todayVolumeNgn: today[0]?.volumeNgn || 0 },
  });
}));

// ── Desks ──────────────────────────────────────────────────────────────────

router.get('/desks', route(async (req, res) => {
  const q = { rateMode: { $ne: null } }; // offramp desks (set up from the app)
  if (['BRAMP', 'SELF'].includes(req.query.rateMode)) q.rateMode = req.query.rateMode;
  if (['active', 'paused', 'closed'].includes(req.query.status)) q.status = req.query.status;
  if (['NONE', 'PENDING', 'APPROVED', 'REJECTED'].includes(req.query.selfRate)) q['selfRate.status'] = req.query.selfRate;
  if (req.query.search) {
    const re = new RegExp(escapeRegex(String(req.query.search).trim().slice(0, 60)), 'i');
    q.$or = [{ slug: re }, { brandName: re }];
  }
  const { limit, page, skip } = pageOf(req.query);
  const [rows, total] = await Promise.all([
    StorefrontMerchant.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('userId', 'email username firstname lastname kycLevel ngnbBalance'),
    StorefrontMerchant.countDocuments(q),
  ]);
  const stats = await deskStats(rows.map((m) => m._id));
  res.json({ success: true, data: { desks: rows.map((m) => deskRow(m, m.userId, stats.get(String(m._id)) || { sales30d: 0, volume30dNgn: 0 })), page, limit, total } });
}));

router.get('/desks/:slug', route(async (req, res) => {
  const m = await StorefrontMerchant.findOne({ slug: String(req.params.slug).toLowerCase() }).populate('userId', 'email username firstname lastname kycLevel ngnbBalance');
  if (!m) return res.status(404).json({ success: false, error: 'Desk not found.' });
  const [stats, customers, recent] = await Promise.all([
    deskStats([m._id]),
    StorefrontCustomer.countDocuments({ merchantId: m._id }),
    StorefrontSellOrder.find({ merchantId: m._id }).sort({ createdAt: -1 }).limit(20).populate('merchantId', 'slug'),
  ]);
  res.json({
    success: true,
    data: {
      ...deskRow(m, m.userId, { ...(stats.get(String(m._id)) || { sales30d: 0, volume30dNgn: 0 }), customers }),
      selfRateApplication: m.selfRate?.application?.submittedAt ? m.selfRate.application : null,
      selfRateDecision: m.selfRate?.decision?.at ? m.selfRate.decision : null,
      agreement: m.agreement,
      recentSales: recent.map(saleRow),
    },
  });
}));

router.patch('/desks/:slug', superOnly, route(async (req, res) => {
  const m = await findDesk(req.params.slug);
  if (!m) return res.status(404).json({ success: false, error: 'Desk not found.' });
  const b = req.body || {};
  const num = (k, max = Infinity) => {
    if (b[k] === undefined) return undefined;
    const n = Number(b[k]);
    if (!Number.isFinite(n) || n < 0 || n > max) throw new selfRate.SelfRateError(`${k} must be between 0 and ${max}.`);
    return n;
  };
  const changes = {};
  if (b.status !== undefined) {
    if (!['active', 'paused', 'closed'].includes(b.status)) return res.status(400).json({ success: false, error: 'status must be active, paused or closed.' });
    m.status = b.status; changes.status = b.status;
    m.closedBy = b.status === 'closed' ? 'ADMIN' : null;
    m.closedAt = b.status === 'closed' ? new Date() : null;
  }
  for (const k of ['perTradeMaxNgn', 'dailyMaxNgn']) {
    const v = num(k);
    if (v !== undefined) { m[k] = v; changes[k] = v; }
  }
  const md = num('markdownNgnPerUsd', Number(process.env.STOREFRONT_MAX_MARKDOWN_NGN_PER_USD || 100));
  if (md !== undefined) { m.markdownNgnPerUsd = md; changes.markdownNgnPerUsd = md; }

  const selfRateKeys = ['payoutLimitNgn', 'feePct', 'feeMinNgn', 'feeMaxNgn'];
  if (selfRateKeys.some((k) => b[k] !== undefined)) {
    if (m.selfRate?.status !== 'APPROVED') return res.status(409).json({ success: false, error: 'Self rate limits and fees apply to approved desks only.' });
    const limit = num('payoutLimitNgn');
    if (limit !== undefined) { m.selfRate.payoutLimitNgn = limit; changes.payoutLimitNgn = limit; }
    const pct = num('feePct', 5);
    if (pct !== undefined) { m.selfRate.fee.pct = pct; changes.feePct = pct; }
    const min = num('feeMinNgn');
    if (min !== undefined) { m.selfRate.fee.minNgn = min; changes.feeMinNgn = min; }
    const max = num('feeMaxNgn');
    if (max !== undefined) { m.selfRate.fee.maxNgn = max; changes.feeMaxNgn = max; }
    const f = selfRate.feeSchedule(m);
    if (f.maxNgn > 0 && f.minNgn > f.maxNgn) return res.status(400).json({ success: false, error: 'The fee minimum can\'t be above the maximum.' });
  }
  await m.save();
  logger.info('Storefront desk updated (admin)', { slug: m.slug, changes, by: who(req) });
  const owner = await User.findById(m.userId).select('email username firstname lastname kycLevel ngnbBalance');
  res.json({ success: true, data: deskRow(m, owner) });
}));

// ── Self rate approval ─────────────────────────────────────────────────────

router.get('/self-rate/applications', route(async (req, res) => {
  const status = ['PENDING', 'APPROVED', 'REJECTED'].includes(req.query.status) ? req.query.status : 'PENDING';
  const rows = await StorefrontMerchant.find({ 'selfRate.status': status }).sort({ 'selfRate.application.submittedAt': 1 }).limit(200)
    .populate('userId', 'email username firstname lastname kycLevel ngnbBalance');
  res.json({
    success: true,
    data: rows.map((m) => ({ ...deskRow(m, m.userId), application: m.selfRate?.application || null, decision: m.selfRate?.decision?.at ? m.selfRate.decision : null })),
  });
}));

router.post('/desks/:slug/self-rate/recheck', route(async (req, res) => {
  const m = await findDesk(req.params.slug);
  if (!m) return res.status(404).json({ success: false, error: 'Desk not found.' });
  res.json({ success: true, data: await selfRate.recheck(m) });
}));

router.post('/desks/:slug/self-rate/approve', superOnly, route(async (req, res) => {
  const m = await findDesk(req.params.slug);
  if (!m) return res.status(404).json({ success: false, error: 'Desk not found.' });
  await selfRate.approve(m, req.body || {}, who(req));
  logger.info('Storefront self rate approved', { slug: m.slug, payoutLimitNgn: m.selfRate.payoutLimitNgn, by: who(req) });
  notifyTrader(m, 'self_rate_approved', null, { payoutLimitNgn: m.selfRate.payoutLimitNgn }).catch(() => {});
  res.json({ success: true, data: deskRow(m, null) });
}));

router.post('/desks/:slug/self-rate/reject', superOnly, route(async (req, res) => {
  const m = await findDesk(req.params.slug);
  if (!m) return res.status(404).json({ success: false, error: 'Desk not found.' });
  await selfRate.reject(m, req.body || {}, who(req));
  logger.info('Storefront self rate rejected', { slug: m.slug, reason: m.selfRate.decision.reason, by: who(req) });
  notifyTrader(m, 'self_rate_rejected', null, { reason: m.selfRate.decision.reason }).catch(() => {});
  res.json({ success: true, data: deskRow(m, null) });
}));

// ── Sales ──────────────────────────────────────────────────────────────────

router.get('/sales', route(async (req, res) => {
  const q = {};
  if (req.query.status && StorefrontSellOrder.STATUSES.includes(req.query.status)) q.status = req.query.status;
  if (req.query.slug) {
    const m = await findDesk(req.query.slug);
    if (!m) return res.json({ success: true, data: { sales: [], page: 1, limit: 25, total: 0 } });
    q.merchantId = m._id;
  }
  if (req.query.search) {
    const term = String(req.query.search).trim().slice(0, 40);
    q.$or = [{ reference: term.toUpperCase() }, { waId: { $regex: escapeRegex(term.replace(/\D/g, '') || term) } }];
  }
  const { limit, page, skip } = pageOf(req.query);
  const [rows, total] = await Promise.all([
    StorefrontSellOrder.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('merchantId', 'slug'),
    StorefrontSellOrder.countDocuments(q),
  ]);
  res.json({ success: true, data: { sales: rows.map(saleRow), page, limit, total } });
}));

router.get('/sales/:ref', route(async (req, res) => {
  const o = await StorefrontSellOrder.findOne({ reference: String(req.params.ref).toUpperCase() }).populate('merchantId', 'slug brandName');
  if (!o) return res.status(404).json({ success: false, error: 'Sale not found.' });
  res.json({
    success: true,
    data: {
      ...saleRow(o),
      businessName: o.merchantId?.brandName || null,
      address: o.address,
      payoutAccount: o.payoutAccount,
      deposit: o.deposit,
      quote: o.quote,
      sale: o.sale,
      payout: o.payout,
      selfRateFunds: o.selfRateFunds,
      openedByDeposit: o.openedByDeposit,
      updatedAt: o.updatedAt,
    },
  });
}));

const OUTCOMES = ['PAID_MANUALLY', 'REFUNDED_CUSTOMER', 'NO_ACTION'];

router.post('/sales/:ref/resolve', superOnly, route(async (req, res) => {
  const { outcome, note } = req.body || {};
  if (!OUTCOMES.includes(outcome)) return res.status(400).json({ success: false, error: `outcome must be one of ${OUTCOMES.join(', ')}.` });
  const why = String(note || '').trim();
  if (why.length < 3) return res.status(400).json({ success: false, error: 'Add a note saying what was done.' });
  const o = await StorefrontSellOrder.findOneAndUpdate(
    { reference: String(req.params.ref).toUpperCase(), status: { $in: ['NEEDS_REVIEW', 'AWAITING_FUNDS'] } },
    { $set: { status: 'RESOLVED', resolution: { outcome, note: why.slice(0, 500), by: who(req), at: new Date() } } },
    { new: true }
  ).populate('merchantId', 'slug');
  if (!o) return res.status(409).json({ success: false, error: 'Only a sale under review or waiting for funds can be resolved.' });
  logger.warn('Storefront sale resolved by hand', { reference: o.reference, outcome, note: why, by: who(req) });
  res.json({ success: true, data: saleRow(o) });
}));

module.exports = router;
