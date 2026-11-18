// adminRoutes/storefrontOfframp.js — Storefront offramp admin API (spec,
// 17 Nov 2026), used by bramp-admin's Storefront pages. Mounted at
// /admin/storefront-offramp behind authenticateAdminToken + requireAdmin in
// server.js. Reads need admin; anything that changes money, limits or a
// trader's Self rate needs super_admin.
//
// Overview and reports
//   GET   /summary                         — counts for the Storefront dashboard
//   GET   /overview?days=7|30|90           — volume, trades, fees, desks over time; top desks; by coin, mode, status
//   GET   /exports/sales.csv?from=&to=&status=&slug=   GET /exports/desks.csv
//
// Desks
//   GET   /desks?search=&rateMode=&status=&selfRate=&flag=&page=&limit=
//   GET   /desks/:slug                     — desk, owner, NGNB balance, Self rate, 30-day stats, owed and
//                                             proceeds, notes, flags, open alerts, recent sales
//   PATCH /desks/:slug                     — { status?, reason (with status), businessName?, perTradeMaxNgn?,
//                                             dailyMaxNgn?, markdownNgnPerUsd?, payoutLimitNgn?, feePct?,
//                                             feeMinNgn?, feeMaxNgn? }                                       (super)
//   GET   /desks/:slug/customers?search=&page=   GET /desks/:slug/history?page=
//   POST  /desks/:slug/notes               — { text }            DELETE /desks/:slug/notes/:noteId      (super)
//   PUT   /desks/:slug/flags               — { flags: [WATCH | HIGH_RISK | VIP | KYC_REVIEW | FRAUD_SUSPECTED] }
//   POST  /desks/:slug/message             — { title, body } to the trader by push and email              (super)
//   GET   /self-rate/applications?status=  — default PENDING, with automatic check results
//   POST  /desks/:slug/self-rate/recheck   — run the automatic checks again
//   POST  /desks/:slug/self-rate/approve   — { payoutLimitNgn, feePct?, feeMinNgn?, feeMaxNgn? }       (super)
//   POST  /desks/:slug/self-rate/reject    — { reason } shown to the trader; Self rate off                (super)
//   GET   /sales?status=&slug=&page=&limit=
//   GET   /sales/:ref                      — one sale in full
//   POST  /sales/:ref/resolve              — { outcome: PAID_MANUALLY | REFUNDED_CUSTOMER | NO_ACTION, note }
//                                             close a NEEDS_REVIEW or AWAITING_FUNDS sale by hand              (super)
//
// Customers and compliance
//   GET   /customers/lookup?q=             — a WhatsApp number, 10-digit account number or deposit address,
//                                             across every desk
//   GET   /blocks?kind=&active=&page=      POST /blocks { kind, value, reason }  DELETE /blocks/:id   (super)
//   GET   /alerts?status=&type=&page=      POST /alerts/:id/ack { note }
//
// Platform
//   GET   /settings                        PUT /settings { killSwitch?, disabledPairs?, values? }   (super)
//   GET   /audit?action=&slug=&by=&page=   — every admin change above
const express = require('express');
const router = express.Router();
const User = require('../models/user');
const StorefrontMerchant = require('../models/storefrontMerchant');
const StorefrontCustomer = require('../models/storefrontCustomer');
const StorefrontSellOrder = require('../models/storefrontSellOrder');
const StorefrontDepositAddress = require('../models/storefrontDepositAddress');
const StorefrontLedger = require('../models/storefrontLedger');
const StorefrontBlock = require('../models/storefrontBlock');
const StorefrontAlert = require('../models/storefrontAlert');
const StorefrontAdminLog = require('../models/storefrontAdminLog');
const selfRate = require('../services/storefrontSelfRate');
const settings = require('../services/storefrontSettings');
const { digits } = require('../services/storefrontCompliance');
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
    if (err instanceof selfRate.SelfRateError || err instanceof settings.SettingsError) return res.status(err.statusCode).json({ success: false, error: err.message });
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

/** One line in the Storefront audit log. Never throws. */
async function audit(req, action, { merchant = null, target = null, reason = null, details = null } = {}) {
  try {
    await StorefrontAdminLog.create({
      action, by: who(req), merchantId: merchant?._id || null, slug: merchant?.slug || null,
      target: target === null ? null : String(target), reason: reason ? String(reason).slice(0, 500) : null, details,
    });
  } catch (err) {
    logger.warn('Storefront admin log not saved', { action, error: err.message });
  }
}

const RISK_FLAGS = ['WATCH', 'HIGH_RISK', 'VIP', 'KYC_REVIEW', 'FRAUD_SUSPECTED'];

/** A WhatsApp number in international digits (0803... becomes 234803...). */
const waDigits = (v) => {
  const d = digits(v);
  return d.length === 11 && d.startsWith('0') ? `234${d.slice(1)}` : d;
};

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // no spreadsheet formulas
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csvRow = (cells) => `${cells.map(csvCell).join(',')}\n`;

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
    riskFlags: m.riskFlags || [],
    pausedBy: m.pausedBy || null,
    closedBy: m.closedBy || null,
    statusNote: m.statusNote?.at ? m.statusNote : null,
    owedNgn: m.owedNgn || 0,
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
  const [desks, activeDesks, pendingApplications, needsReview, awaitingFunds, today, openAlerts, heldPayouts, platform] = await Promise.all([
    StorefrontMerchant.countDocuments({ rateMode: { $ne: null } }),
    StorefrontMerchant.countDocuments({ rateMode: { $ne: null }, status: 'active' }),
    StorefrontMerchant.countDocuments({ 'selfRate.status': 'PENDING' }),
    StorefrontSellOrder.countDocuments({ status: 'NEEDS_REVIEW' }),
    StorefrontSellOrder.countDocuments({ status: 'AWAITING_FUNDS' }),
    StorefrontSellOrder.aggregate([
      { $match: { status: 'PAID', paidAt: { $gte: day } } },
      { $group: { _id: null, sales: { $sum: 1 }, volumeNgn: { $sum: '$settlement.customerNgn' } } },
    ]),
    StorefrontAlert.countDocuments({ status: 'OPEN' }),
    StorefrontSellOrder.countDocuments({ heldAt: { $ne: null }, status: { $in: ['AWAITING_DEPOSIT', 'AWAITING_ACCOUNT', 'AWAITING_FUNDS'] } }),
    settings.get(),
  ]);
  res.json({
    success: true,
    data: {
      desks, activeDesks, pendingApplications, needsReview, awaitingFunds, todaySales: today[0]?.sales || 0, todayVolumeNgn: today[0]?.volumeNgn || 0,
      openAlerts, heldPayouts, killSwitch: platform.killSwitch, disabledPairs: platform.disabledPairs,
    },
  });
}));

// ── Overview and reports ───────────────────────────────────────────────────

const TZ = 'Africa/Lagos';
const byDay = (field) => ({ $dateToString: { format: '%Y-%m-%d', date: field, timezone: TZ } });
const lagosDays = (n) => Array.from({ length: n }, (_, i) => new Date(Date.now() - (n - 1 - i) * 864e5).toLocaleDateString('en-CA', { timeZone: TZ }));
const PAID_SUMS = {
  trades: { $sum: 1 },
  volumeNgn: { $sum: '$settlement.customerNgn' },
  feesNgn: { $sum: { $ifNull: ['$settlement.feeNgn', 0] } },
  earningsNgn: { $sum: { $ifNull: ['$settlement.traderEarningNgn', 0] } },
};
const totalsOf = (row) => ({
  trades: row?.trades || 0, volumeNgn: row?.volumeNgn || 0, feesNgn: row?.feesNgn || 0, earningsNgn: row?.earningsNgn || 0,
  customers: row?.customers?.length || 0, activeDesks: row?.desks?.length || 0,
});

router.get('/overview', route(async (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const since = new Date(Date.now() - days * 864e5);
  const prevSince = new Date(Date.now() - 2 * days * 864e5);
  const inWindow = { $match: { paidAt: { $gte: since } } };
  const [[f = {}], opened, deposited, newDesks, newCustomers] = await Promise.all([
    StorefrontSellOrder.aggregate([
      { $match: { status: 'PAID', paidAt: { $gte: prevSince } } },
      { $facet: {
        current: [inWindow, { $group: { _id: null, ...PAID_SUMS, customers: { $addToSet: '$waId' }, desks: { $addToSet: '$merchantId' } } }],
        previous: [{ $match: { paidAt: { $lt: since } } }, { $group: { _id: null, ...PAID_SUMS, customers: { $addToSet: '$waId' }, desks: { $addToSet: '$merchantId' } } }],
        daily: [inWindow, { $group: { _id: byDay('$paidAt'), ...PAID_SUMS, desks: { $addToSet: '$merchantId' } } }],
        byCoin: [inWindow, { $group: { _id: '$coin', trades: { $sum: 1 }, volumeNgn: { $sum: '$settlement.customerNgn' } } }, { $sort: { volumeNgn: -1 } }],
        byMode: [inWindow, { $group: { _id: '$rateMode', ...PAID_SUMS } }],
        topDesks: [inWindow, { $group: { _id: '$merchantId', ...PAID_SUMS } }, { $sort: { volumeNgn: -1 } }, { $limit: 10 }],
      } },
    ]),
    StorefrontSellOrder.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    StorefrontSellOrder.aggregate([
      { $match: { 'deposit.confirmedAt': { $gte: since } } },
      { $group: { _id: null, deposits: { $sum: 1 }, reviewed: { $sum: { $cond: [{ $or: [{ $eq: ['$status', 'NEEDS_REVIEW'] }, { $eq: ['$status', 'RESOLVED'] }] }, 1, 0] } } } },
    ]),
    StorefrontMerchant.countDocuments({ rateMode: { $ne: null }, createdAt: { $gte: since } }),
    StorefrontCustomer.countDocuments({ firstSeenAt: { $gte: since } }),
  ]);

  const desks = await StorefrontMerchant.find({ _id: { $in: (f.topDesks || []).map((d) => d._id) } }).select('slug brandName rateMode status').lean();
  const deskById = new Map(desks.map((d) => [String(d._id), d]));
  const daily = new Map((f.daily || []).map((d) => [d._id, d]));
  const dep = deposited[0] || { deposits: 0, reviewed: 0 };

  res.json({
    success: true,
    data: {
      days,
      totals: totalsOf(f.current?.[0]),
      previous: totalsOf(f.previous?.[0]),
      series: lagosDays(days).map((day) => {
        const d = daily.get(day);
        return { day, trades: d?.trades || 0, volumeNgn: Math.round(d?.volumeNgn || 0), feesNgn: Math.round(d?.feesNgn || 0), activeDesks: d?.desks?.length || 0 };
      }),
      byCoin: (f.byCoin || []).map((c) => ({ coin: c._id, trades: c.trades, volumeNgn: c.volumeNgn })),
      byMode: (f.byMode || []).map((m) => ({ rateMode: m._id, trades: m.trades, volumeNgn: m.volumeNgn, feesNgn: m.feesNgn, earningsNgn: m.earningsNgn })),
      byStatus: Object.fromEntries(opened.map((o) => [o._id, o.n])),
      topDesks: (f.topDesks || []).map((t) => ({ ...(deskById.get(String(t._id)) || {}), _id: undefined, trades: t.trades, volumeNgn: t.volumeNgn, feesNgn: t.feesNgn, earningsNgn: t.earningsNgn })),
      reviewRate: dep.deposits ? dep.reviewed / dep.deposits : 0,
      deposits: dep.deposits,
      newDesks,
      newCustomers,
    },
  });
}));

const dateParam = (v, endOfDay = false) => {
  if (!v) return null;
  const d = new Date(`${String(v).slice(0, 10)}T${endOfDay ? '23:59:59.999' : '00:00:00'}+01:00`); // Lagos
  return Number.isNaN(d.getTime()) ? null : d;
};
const EXPORT_MAX = 50000;

router.get('/exports/sales.csv', route(async (req, res) => {
  const q = {};
  const from = dateParam(req.query.from);
  const to = dateParam(req.query.to, true);
  if (from || to) q.createdAt = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (req.query.status && StorefrontSellOrder.STATUSES.includes(req.query.status)) q.status = req.query.status;
  if (req.query.slug) {
    const m = await findDesk(req.query.slug);
    if (!m) return res.status(404).json({ success: false, error: 'Desk not found.' });
    q.merchantId = m._id;
  }
  await audit(req, 'export.sales', { details: { from: req.query.from || null, to: req.query.to || null, status: q.status || null, slug: req.query.slug || null } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="storefront-sales-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.write(csvRow(['Reference', 'Created', 'Paid', 'Desk', 'Business name', 'Customer WhatsApp', 'Rate mode', 'Coin', 'Network', 'Amount',
    'Naira per coin', 'Customer paid (NGN)', 'Trader earning (NGN)', 'Bramp fee (NGN)', 'Bank', 'Account', 'Account name', 'Status', 'Review reason', 'Resolution']));
  const cursor = StorefrontSellOrder.find(q).sort({ createdAt: -1 }).limit(EXPORT_MAX).populate('merchantId', 'slug brandName').lean().cursor();
  for await (const o of cursor) {
    res.write(csvRow([
      o.reference, o.createdAt?.toISOString(), o.paidAt?.toISOString() || '', o.merchantId?.slug || '', o.merchantId?.brandName || '', o.waId,
      o.rateMode, o.coin, o.network, o.deposit?.amount ?? '', o.settlement?.ngnPerCoin ?? '', o.settlement?.customerNgn ?? '',
      o.settlement?.traderEarningNgn ?? '', o.settlement?.feeNgn ?? '', o.payoutAccount?.bankName || '', o.payoutAccount?.accountNumber || '',
      o.payoutAccount?.accountName || '', o.status, o.reviewReason || '', o.resolution?.outcome ? `${o.resolution.outcome}: ${o.resolution.note}` : '',
    ]));
  }
  res.end();
}));

router.get('/exports/desks.csv', route(async (req, res) => {
  const rows = await StorefrontMerchant.find({ rateMode: { $ne: null } }).sort({ createdAt: -1 }).limit(EXPORT_MAX)
    .populate('userId', 'email username firstname lastname kycLevel ngnbBalance').lean();
  const ids = rows.map((m) => m._id);
  const [paid, customers] = await Promise.all([
    StorefrontSellOrder.aggregate([{ $match: { merchantId: { $in: ids }, status: 'PAID' } }, { $group: { _id: '$merchantId', ...PAID_SUMS } }]),
    StorefrontCustomer.aggregate([{ $match: { merchantId: { $in: ids } } }, { $group: { _id: '$merchantId', n: { $sum: 1 } } }]),
  ]);
  const paidBy = new Map(paid.map((p) => [String(p._id), p]));
  const custBy = new Map(customers.map((c) => [String(c._id), c.n]));
  await audit(req, 'export.desks', { details: { rows: rows.length } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="storefront-desks-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.write(csvRow(['Username', 'Business name', 'Status', 'Rate mode', 'Self rate', 'Owner email', 'Owner name', 'KYC level', 'NGNB balance',
    'Markdown (NGN per $1)', 'Per-trade limit', 'Daily limit', 'Owed (NGN)', 'Risk flags', 'Trades', 'Trade volume (NGN)', 'Bramp fees (NGN)',
    'Trader earnings (NGN)', 'Customers', 'Opened']));
  for (const m of rows) {
    const p = paidBy.get(String(m._id)) || {};
    const o = m.userId || {};
    res.write(csvRow([
      m.slug, m.brandName || '', m.status, m.rateMode, m.selfRate?.status || 'NONE', o.email || '', [o.firstname, o.lastname].filter(Boolean).join(' '),
      o.kycLevel ?? '', o.ngnbBalance ?? '', m.markdownNgnPerUsd ?? '', m.perTradeMaxNgn ?? '', m.dailyMaxNgn ?? '', m.owedNgn || 0,
      (m.riskFlags || []).join(' '), p.trades || 0, p.volumeNgn || 0, p.feesNgn || 0, p.earningsNgn || 0, custBy.get(String(m._id)) || 0,
      m.createdAt?.toISOString(),
    ]));
  }
  res.end();
}));

// ── Desks ──────────────────────────────────────────────────────────────────

router.get('/desks', route(async (req, res) => {
  const q = { rateMode: { $ne: null } }; // offramp desks (set up from the app)
  if (['BRAMP', 'SELF'].includes(req.query.rateMode)) q.rateMode = req.query.rateMode;
  if (['active', 'paused', 'closed'].includes(req.query.status)) q.status = req.query.status;
  if (['NONE', 'PENDING', 'APPROVED', 'REJECTED'].includes(req.query.selfRate)) q['selfRate.status'] = req.query.selfRate;
  if (RISK_FLAGS.includes(req.query.flag)) q.riskFlags = req.query.flag;
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
  const [stats, customers, recent, proceeds, recalls, alerts, totals] = await Promise.all([
    deskStats([m._id]),
    StorefrontCustomer.countDocuments({ merchantId: m._id }),
    StorefrontSellOrder.find({ merchantId: m._id }).sort({ createdAt: -1 }).limit(20).populate('merchantId', 'slug'),
    StorefrontLedger.aggregate([{ $match: { merchantId: m._id } }, { $group: { _id: '$status', ngn: { $sum: '$amountNgn' }, n: { $sum: 1 } } }]),
    StorefrontLedger.find({ merchantId: m._id, status: 'REVERSED' }).sort({ reversedAt: -1 }).limit(10).lean(),
    StorefrontAlert.find({ merchantId: m._id, status: 'OPEN' }).sort({ createdAt: -1 }).limit(10).lean(),
    StorefrontSellOrder.aggregate([
      { $match: { merchantId: m._id, status: 'PAID' } },
      { $group: { _id: null, trades: { $sum: 1 }, volumeNgn: { $sum: '$settlement.customerNgn' }, feesNgn: { $sum: '$settlement.feeNgn' }, earningsNgn: { $sum: { $ifNull: ['$settlement.traderEarningNgn', 0] } } } },
    ]),
  ]);
  const ledger = Object.fromEntries(proceeds.map((p) => [p._id, { ngn: p.ngn, entries: p.n }]));
  res.json({
    success: true,
    data: {
      ...deskRow(m, m.userId, { ...(stats.get(String(m._id)) || { sales30d: 0, volume30dNgn: 0 }), customers }),
      selfRateApplication: m.selfRate?.application?.submittedAt ? m.selfRate.application : null,
      selfRateDecision: m.selfRate?.decision?.at ? m.selfRate.decision : null,
      agreement: m.agreement,
      allTime: { trades: totals[0]?.trades || 0, volumeNgn: totals[0]?.volumeNgn || 0, feesNgn: totals[0]?.feesNgn || 0, earningsNgn: totals[0]?.earningsNgn || 0 },
      owed: { owedNgn: m.owedNgn || 0, depositNgn: m.depositNgn || 0, holdDays: m.holdDays, ledger, recalls },
      notes: [...(m.adminNotes || [])].reverse(),
      openAlerts: alerts,
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
  const before = m.status;
  const reason = String(b.reason || '').trim();
  if (b.status !== undefined && b.status !== m.status) {
    if (!['active', 'paused', 'closed'].includes(b.status)) return res.status(400).json({ success: false, error: 'status must be active, paused or closed.' });
    if (reason.length < 3) return res.status(400).json({ success: false, error: 'Give a reason for changing the desk\'s status.' });
    if (b.status === 'active' && m.owedNgn > 0) {
      return res.status(409).json({ success: false, error: `The trader still owes ₦${m.owedNgn} from a recall.` });
    }
    m.status = b.status; changes.status = b.status;
    m.closedBy = b.status === 'closed' ? 'ADMIN' : null;
    m.closedAt = b.status === 'closed' ? new Date() : null;
    m.pausedBy = b.status === 'paused' ? 'ADMIN' : b.status === 'active' ? null : m.pausedBy;
    m.statusNote = { reason: reason.slice(0, 500), by: who(req), at: new Date() };
  }
  if (b.businessName !== undefined) {
    const name = String(b.businessName || '').trim();
    if (name.length < 2 || name.length > 60) return res.status(400).json({ success: false, error: 'Business name must be 2 to 60 characters.' });
    m.brandName = name; changes.businessName = name;
  }
  for (const k of ['perTradeMaxNgn', 'dailyMaxNgn']) {
    const v = num(k);
    if (v !== undefined) { m[k] = v; changes[k] = v; }
  }
  const md = num('markdownNgnPerUsd', (await settings.get()).values.maxMarkdownNgnPerUsd);
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
  if (!Object.keys(changes).length) return res.status(400).json({ success: false, error: 'Nothing to change.' });
  await m.save();
  logger.info('Storefront desk updated (admin)', { slug: m.slug, changes, by: who(req) });
  await audit(req, changes.status ? 'desk.status' : 'desk.update', { merchant: m, reason: changes.status ? reason : null, details: { ...changes, ...(changes.status ? { from: before } : {}) } });
  if (changes.status) notifyTrader(m, 'desk_status', null, { status: changes.status, reason }).catch(() => {});
  const owner = await User.findById(m.userId).select('email username firstname lastname kycLevel ngnbBalance');
  res.json({ success: true, data: deskRow(m, owner) });
}));

router.get('/desks/:slug/customers', route(async (req, res) => {
  const m = await findDesk(req.params.slug);
  if (!m) return res.status(404).json({ success: false, error: 'Desk not found.' });
  const q = { merchantId: m._id };
  if (req.query.search) {
    const d = digits(req.query.search);
    const re = new RegExp(escapeRegex(String(req.query.search).trim().slice(0, 60)), 'i');
    q.$or = [{ displayName: re }, ...(d ? [{ waId: { $regex: escapeRegex(d) } }] : [])];
  }
  const { limit, page, skip } = pageOf(req.query);
  const [rows, total] = await Promise.all([
    StorefrontCustomer.find(q).sort({ 'stats.volumeNgn': -1, lastSeenAt: -1 }).skip(skip).limit(limit).lean(),
    StorefrontCustomer.countDocuments(q),
  ]);
  res.json({
    success: true,
    data: {
      customers: rows.map((c) => ({
        waId: c.waId, displayName: c.displayName, firstSeenAt: c.firstSeenAt, lastSeenAt: c.lastSeenAt, lastTradeAt: c.lastTradeAt,
        trades: c.stats?.trades || 0, completed: c.stats?.completed || 0, volumeNgn: c.stats?.volumeNgn || 0, tags: c.tags || [],
      })),
      page, limit, total,
    },
  });
}));

router.get('/desks/:slug/history', route(async (req, res) => {
  const m = await findDesk(req.params.slug);
  if (!m) return res.status(404).json({ success: false, error: 'Desk not found.' });
  const { limit, page, skip } = pageOf(req.query);
  const [rows, total] = await Promise.all([
    StorefrontAdminLog.find({ merchantId: m._id }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    StorefrontAdminLog.countDocuments({ merchantId: m._id }),
  ]);
  res.json({ success: true, data: { entries: rows, page, limit, total } });
}));

router.post('/desks/:slug/notes', route(async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (text.length < 2) return res.status(400).json({ success: false, error: 'Write a note.' });
  const m = await findDesk(req.params.slug);
  if (!m) return res.status(404).json({ success: false, error: 'Desk not found.' });
  m.adminNotes.push({ text: text.slice(0, 1000), by: who(req), at: new Date() });
  await m.save();
  await audit(req, 'desk.note', { merchant: m, details: { text: text.slice(0, 200) } });
  res.json({ success: true, data: [...m.adminNotes].reverse() });
}));

router.delete('/desks/:slug/notes/:noteId', superOnly, route(async (req, res) => {
  const m = await findDesk(req.params.slug);
  if (!m) return res.status(404).json({ success: false, error: 'Desk not found.' });
  const note = m.adminNotes.id(req.params.noteId);
  if (!note) return res.status(404).json({ success: false, error: 'Note not found.' });
  const text = note.text;
  note.deleteOne();
  await m.save();
  await audit(req, 'desk.noteDelete', { merchant: m, details: { text: text.slice(0, 200) } });
  res.json({ success: true, data: [...m.adminNotes].reverse() });
}));

router.put('/desks/:slug/flags', route(async (req, res) => {
  const flags = req.body?.flags;
  if (!Array.isArray(flags) || flags.some((f) => !RISK_FLAGS.includes(f))) {
    return res.status(400).json({ success: false, error: `flags must be a list of: ${RISK_FLAGS.join(', ')}.` });
  }
  const m = await findDesk(req.params.slug);
  if (!m) return res.status(404).json({ success: false, error: 'Desk not found.' });
  const from = [...(m.riskFlags || [])];
  m.riskFlags = [...new Set(flags)];
  await m.save();
  await audit(req, 'desk.flags', { merchant: m, details: { from, to: m.riskFlags } });
  res.json({ success: true, data: m.riskFlags });
}));

router.post('/desks/:slug/message', superOnly, route(async (req, res) => {
  const title = String(req.body?.title || '').trim().slice(0, 80);
  const body = String(req.body?.body || '').trim().slice(0, 1000);
  if (title.length < 2 || body.length < 2) return res.status(400).json({ success: false, error: 'Write a title and a message.' });
  const m = await findDesk(req.params.slug);
  if (!m) return res.status(404).json({ success: false, error: 'Desk not found.' });
  await notifyTrader(m, 'admin_message', null, { title, body });
  await audit(req, 'desk.message', { merchant: m, details: { title, body } });
  res.json({ success: true });
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
  await audit(req, 'selfRate.approve', { merchant: m, details: { payoutLimitNgn: m.selfRate.payoutLimitNgn, fee: selfRate.feeSchedule(m) } });
  notifyTrader(m, 'self_rate_approved', null, { payoutLimitNgn: m.selfRate.payoutLimitNgn }).catch(() => {});
  res.json({ success: true, data: deskRow(m, null) });
}));

router.post('/desks/:slug/self-rate/reject', superOnly, route(async (req, res) => {
  const m = await findDesk(req.params.slug);
  if (!m) return res.status(404).json({ success: false, error: 'Desk not found.' });
  await selfRate.reject(m, req.body || {}, who(req));
  logger.info('Storefront self rate rejected', { slug: m.slug, reason: m.selfRate.decision.reason, by: who(req) });
  await audit(req, 'selfRate.reject', { merchant: m, reason: m.selfRate.decision.reason });
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
  await audit(req, 'sale.resolve', { merchant: await StorefrontMerchant.findById(o.merchantId?._id || o.merchantId), target: o.reference, reason: why, details: { outcome } });
  res.json({ success: true, data: saleRow(o) });
}));

// ── Customers and compliance ───────────────────────────────────────────────

/** Everything Bramp knows about one WhatsApp number, across desks. */
async function profileOf(waId) {
  const [records, sales, block, alerts] = await Promise.all([
    StorefrontCustomer.find({ waId }).populate('merchantId', 'slug brandName status').lean(),
    StorefrontSellOrder.find({ waId }).sort({ createdAt: -1 }).limit(20).populate('merchantId', 'slug'),
    StorefrontBlock.findOne({ kind: 'WHATSAPP', value: waId, active: true }).lean(),
    StorefrontAlert.find({ waId }).sort({ createdAt: -1 }).limit(10).lean(),
  ]);
  return {
    waId,
    blocked: block ? { id: block._id, reason: block.reason, by: block.by, at: block.createdAt } : null,
    totals: {
      desks: records.length,
      trades: records.reduce((n, r) => n + (r.stats?.trades || 0), 0),
      completed: records.reduce((n, r) => n + (r.stats?.completed || 0), 0),
      volumeNgn: records.reduce((n, r) => n + (r.stats?.volumeNgn || 0), 0),
    },
    records: records.map((r) => ({
      desk: r.merchantId?.slug || null, businessName: r.merchantId?.brandName || null, displayName: r.displayName,
      firstSeenAt: r.firstSeenAt, lastTradeAt: r.lastTradeAt, stats: { trades: r.stats?.trades || 0, completed: r.stats?.completed || 0, volumeNgn: r.stats?.volumeNgn || 0 },
      accounts: (r.accounts || []).map((a) => ({ bankName: a.bankName, accountNumber: a.accountNumber, accountName: a.accountName, lastUsedAt: a.lastUsedAt })),
      addresses: r.addresses || [], tags: r.tags || [], note: r.note || null,
    })),
    alerts,
    recentSales: sales.map(saleRow),
  };
}

router.get('/customers/lookup', route(async (req, res) => {
  const raw = String(req.query.q || '').trim().slice(0, 120);
  if (raw.length < 4) return res.status(400).json({ success: false, error: 'Search a WhatsApp number, a 10-digit account number or a deposit address.' });
  const d = digits(raw);
  const waIds = new Set();
  let account = null;
  let address = null;

  // A deposit address (anything that isn't just a phone or account number).
  if (!/^[\d\s+()-]+$/.test(raw)) {
    const a = await StorefrontDepositAddress.findOne({ address: raw }).populate('merchantId', 'slug brandName').lean();
    if (a) {
      address = { address: a.address, coin: a.coin, network: a.network, desk: a.merchantId?.slug || null, waId: a.waId, createdAt: a.createdAt };
      waIds.add(a.waId);
    }
  } else if (d.length === 10) {
    // A bank account: whoever saved it or was paid to it.
    const [holders, paidTo, block] = await Promise.all([
      StorefrontCustomer.find({ 'accounts.accountNumber': d }).select('waId accounts merchantId').populate('merchantId', 'slug').lean(),
      StorefrontSellOrder.distinct('waId', { 'payoutAccount.accountNumber': d }),
      StorefrontBlock.findOne({ kind: 'BANK_ACCOUNT', value: d, active: true }).lean(),
    ]);
    const acct = holders.flatMap((h) => h.accounts).find((a) => a.accountNumber === d);
    account = {
      accountNumber: d, bankName: acct?.bankName || null, accountName: acct?.accountName || null,
      blocked: block ? { id: block._id, reason: block.reason, by: block.by, at: block.createdAt } : null,
      holders: holders.map((h) => ({ waId: h.waId, desk: h.merchantId?.slug || null })),
    };
    holders.forEach((h) => waIds.add(h.waId));
    paidTo.forEach((w) => waIds.add(w));
  }
  if (d.length >= 10 && !account) waIds.add(waDigits(raw));

  const profiles = (await Promise.all([...waIds].slice(0, 10).map(profileOf))).filter((p) => p.records.length || p.recentSales.length || p.blocked);
  res.json({ success: true, data: { query: raw, address, account, profiles } });
}));

const blockRow = (b) => ({ id: b._id, kind: b.kind, value: b.value, reason: b.reason, active: b.active, by: b.by, createdAt: b.createdAt, liftedBy: b.liftedBy, liftedAt: b.liftedAt });

router.get('/blocks', route(async (req, res) => {
  const q = {};
  if (StorefrontBlock.KINDS.includes(req.query.kind)) q.kind = req.query.kind;
  q.active = req.query.active !== 'false';
  if (req.query.search) q.value = { $regex: escapeRegex(digits(req.query.search) || '-') };
  const { limit, page, skip } = pageOf(req.query);
  const [rows, total] = await Promise.all([
    StorefrontBlock.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    StorefrontBlock.countDocuments(q),
  ]);
  res.json({ success: true, data: { blocks: rows.map(blockRow), page, limit, total } });
}));

router.post('/blocks', superOnly, route(async (req, res) => {
  const { kind } = req.body || {};
  if (!StorefrontBlock.KINDS.includes(kind)) return res.status(400).json({ success: false, error: `kind must be ${StorefrontBlock.KINDS.join(' or ')}.` });
  const value = kind === 'WHATSAPP' ? waDigits(req.body.value) : digits(req.body.value);
  if (kind === 'WHATSAPP' && (value.length < 10 || value.length > 15)) return res.status(400).json({ success: false, error: 'Enter a full WhatsApp number, e.g. 2348012345678.' });
  if (kind === 'BANK_ACCOUNT' && value.length !== 10) return res.status(400).json({ success: false, error: 'A Nigerian account number has 10 digits.' });
  const reason = String(req.body.reason || '').trim();
  if (reason.length < 3) return res.status(400).json({ success: false, error: 'Give a reason for the block.' });
  try {
    const b = await StorefrontBlock.create({ kind, value, reason: reason.slice(0, 500), by: who(req) });
    await audit(req, 'block.add', { target: `${kind}:${value}`, reason });
    logger.warn('Storefront block added', { kind, value, by: who(req) });
    res.json({ success: true, data: blockRow(b) });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, error: 'That is already blocked.' });
    throw err;
  }
}));

router.delete('/blocks/:id', superOnly, route(async (req, res) => {
  const b = await StorefrontBlock.findOneAndUpdate(
    { _id: req.params.id, active: true },
    { $set: { active: false, liftedBy: who(req), liftedAt: new Date() } },
    { new: true }
  ).catch(() => null);
  if (!b) return res.status(404).json({ success: false, error: 'Block not found or already lifted.' });
  await audit(req, 'block.lift', { target: `${b.kind}:${b.value}`, reason: req.body?.reason || null });
  res.json({ success: true, data: blockRow(b) });
}));

router.get('/alerts', route(async (req, res) => {
  const q = {};
  q.status = req.query.status === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED' : req.query.status === 'all' ? { $in: ['OPEN', 'ACKNOWLEDGED'] } : 'OPEN';
  if (StorefrontAlert.TYPES.includes(req.query.type)) q.type = req.query.type;
  const { limit, page, skip } = pageOf(req.query);
  const [rows, total] = await Promise.all([
    StorefrontAlert.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).populate('merchantId', 'slug brandName').lean(),
    StorefrontAlert.countDocuments(q),
  ]);
  res.json({ success: true, data: { alerts: rows.map((a) => ({ ...a, id: a._id, desk: a.merchantId?.slug || null, merchantId: undefined })), page, limit, total } });
}));

router.post('/alerts/:id/ack', route(async (req, res) => {
  const note = String(req.body?.note || '').trim();
  if (note.length < 3) return res.status(400).json({ success: false, error: 'Say what you checked.' });
  const a = await StorefrontAlert.findOneAndUpdate(
    { _id: req.params.id, status: 'OPEN' },
    { $set: { status: 'ACKNOWLEDGED', ackBy: who(req), ackAt: new Date(), ackNote: note.slice(0, 500) } },
    { new: true }
  ).catch(() => null);
  if (!a) return res.status(404).json({ success: false, error: 'Alert not found or already acknowledged.' });
  await audit(req, 'alert.ack', { merchant: await StorefrontMerchant.findById(a.merchantId), target: a.orderReference, reason: note, details: { type: a.type } });
  res.json({ success: true, data: a });
}));

// ── Platform ───────────────────────────────────────────────────────────────

const allPairs = () => Object.entries(require('../services/storefrontSell').PAIRS).flatMap(([coin, nets]) =>
  nets.map((network) => ({ code: settings.pairCode(coin, network), coin, network, name: require('../services/storefrontSell').networkName(coin, network) })));

router.get('/settings', route(async (req, res) => {
  res.json({ success: true, data: { ...(await settings.get({ fresh: true })), pairs: allPairs() } });
}));

router.put('/settings', superOnly, route(async (req, res) => {
  const { settings: next, changes } = await settings.update(req.body || {}, who(req));
  await audit(req, 'settings.update', { reason: req.body?.reason || null, details: changes });
  if (changes['killSwitch.selling'] !== undefined || changes['killSwitch.payouts'] !== undefined) {
    logger.warn('Storefront kill switch changed', { ...changes, by: who(req) });
  }
  res.json({ success: true, data: { ...next, pairs: allPairs() } });
}));

router.get('/audit', route(async (req, res) => {
  const q = {};
  if (req.query.action) q.action = String(req.query.action).slice(0, 40);
  if (req.query.slug) q.slug = String(req.query.slug).toLowerCase();
  if (req.query.by) q.by = { $regex: escapeRegex(String(req.query.by).slice(0, 80)), $options: 'i' };
  const { limit, page, skip } = pageOf(req.query);
  const [rows, total] = await Promise.all([
    StorefrontAdminLog.find(q).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    StorefrontAdminLog.countDocuments(q),
  ]);
  res.json({ success: true, data: { entries: rows, page, limit, total } });
}));

module.exports = router;
