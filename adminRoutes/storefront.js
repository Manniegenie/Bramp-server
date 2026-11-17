// adminRoutes/storefront.js — Bramp Storefront admin API. Mounted at
// /admin/storefront behind authenticateAdminToken + requireAdmin in
// server.js. Reads need admin; anything that changes money, keys or risk
// settings needs super_admin.
//
//   GET   /merchants                      — every storefront
//   POST  /merchants                      — { email, slug, holdDays?, depositNgn?, perTradeMaxNgn?, dailyMaxNgn? }   (super)
//                                           a hosted store, no key (traders normally link from bramp.shop instead)
//   GET   /merchants/:slug                — one storefront + balances + held orders
//   PATCH /merchants/:slug                — { status?, holdDays?, depositNgn?, perTradeMaxNgn?, dailyMaxNgn? }      (super)
//   POST  /merchants/:slug/rotate-key     — issue the store its own API key (Pro server, bot); any old one stops
//                                           working. Returns the key and webhook secret ONCE                   (super)
//   POST  /stella-customers/:waId/clear-hold — { note } lift a security hold (a disputed number move)      (super)
//   GET   /merchants/:slug/stella-profile — how Stella sounds for this desk
//   PUT   /merchants/:slug/stella-profile — same body as the desk's own PUT /storefront/stella-profile
//   GET   /orders?status=&slug=           — e.g. status=REJECTED for refunds to make, PAYOUT_FAILED to fix
//   POST  /orders/:ref/recall             — { amountNgn, note } a payment was recalled: take it back from the trader (super)
//   GET   /self-rate/applications?status= — Self rate applications (default PENDING) with their automatic checks
//   GET   /merchants/:slug/self-rate      — one desk's full Self rate application and checks
//   POST  /merchants/:slug/self-rate/recheck — run the automatic checks again (e.g. after a Dojah outage)
//   POST  /merchants/:slug/self-rate/approve — { payoutLimitNgn, feeNgn? } monthly payout limit; fee overrides the default (super)
//   POST  /merchants/:slug/self-rate/reject  — { reason } shown to the trader; turns Self rate off (super)
//   GET   /sell-orders?status=&slug=      — offramp sales, e.g. status=NEEDS_REVIEW or AWAITING_FUNDS
const express = require('express');
const router = express.Router();
const User = require('../models/user');
const StorefrontMerchant = require('../models/storefrontMerchant');
const StorefrontOrder = require('../models/storefrontOrder');
const StellaCustomer = require('../models/stellaCustomer');
const { newKey } = require('../auth/storefrontAuth');
const ledger = require('../services/storefrontLedger');
const { serializeOrder } = require('../services/storefrontBuy');
const stellaProfile = require('../AI/stellaProfile');
const logger = require('../utils/logger');

// Traders are business accounts: enhanced KYC before they can take payments.
const MIN_KYC_LEVEL = Number(process.env.STOREFRONT_MIN_KYC_LEVEL || 2);
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const RISK_FIELDS = ['holdDays', 'depositNgn', 'perTradeMaxNgn', 'dailyMaxNgn'];

const superOnly = (req, res, next) => (req.admin?.adminRole === 'super_admin'
  ? next()
  : res.status(403).json({ success: false, error: 'Super admin access required.' }));

const who = (req) => req.admin?.email || String(req.admin?.id || req.admin?._id || '');

const route = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    logger.error('Storefront admin route error', { path: req.path, error: err.message, stack: err.stack });
    res.status(500).json({ success: false, error: 'Internal error.' });
  }
};

function riskUpdate(body) {
  const out = {};
  for (const f of RISK_FIELDS) {
    if (body[f] === undefined) continue;
    const n = Number(body[f]);
    if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error(`${f} must be 0 or more.`), { status: 400 });
    out[f] = n;
  }
  return out;
}

const merchantOf = (m, user) => ({
  id: m._id, slug: m.slug, status: m.status, user: user ? { email: user.email, name: `${user.firstname || ''} ${user.lastname || ''}`.trim() } : undefined,
  mismatchPolicy: m.mismatchPolicy, autoLimitNgn: m.autoLimitNgn, webhookUrl: m.webhookUrl,
  holdDays: m.holdDays, depositNgn: m.depositNgn, perTradeMaxNgn: m.perTradeMaxNgn, dailyMaxNgn: m.dailyMaxNgn,
  owedNgn: m.owedNgn, createdAt: m.createdAt,
});

router.get('/merchants', route(async (req, res) => {
  const merchants = await StorefrontMerchant.find().sort({ createdAt: -1 }).populate('userId', 'email firstname lastname');
  res.json({ success: true, data: merchants.map((m) => merchantOf(m, m.userId)) });
}));

router.post('/merchants', superOnly, route(async (req, res) => {
  const { email, slug: slugRaw } = req.body || {};
  const slug = String(slugRaw || '').toLowerCase().trim();
  if (!SLUG.test(slug)) return res.status(400).json({ success: false, error: 'slug must be 3-32 letters, numbers or dashes.' });
  const user = await User.findOne({ email: String(email || '').toLowerCase().trim() }).select('email firstname lastname kycLevel kycStatus');
  if (!user) return res.status(404).json({ success: false, error: 'No Bramp user with that email.' });
  if (user.kycLevel < MIN_KYC_LEVEL) {
    return res.status(400).json({ success: false, error: `The trader needs KYC level ${MIN_KYC_LEVEL} first (they're at ${user.kycLevel}).` });
  }
  let risk;
  try { risk = riskUpdate(req.body); } catch (err) { return res.status(err.status || 400).json({ success: false, error: err.message }); }

  let merchant;
  try {
    merchant = await StorefrontMerchant.create({ userId: user._id, slug, ...risk });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, error: 'That user or slug already has a storefront.' });
    throw err;
  }
  logger.info('Storefront merchant created', { slug, userId: user._id, by: who(req) });
  res.status(201).json({ success: true, data: merchantOf(merchant, user) });
}));

router.get('/merchants/:slug', route(async (req, res) => {
  const m = await StorefrontMerchant.findOne({ slug: req.params.slug }).populate('userId', 'email firstname lastname');
  if (!m) return res.status(404).json({ success: false, error: 'Storefront not found.' });
  const [balances, held] = await Promise.all([
    ledger.balances(m._id),
    StorefrontOrder.find({ merchantId: m._id, status: { $in: ['HELD_REVIEW', 'HELD_DELAY', 'REJECTED', 'PAYOUT_FAILED'] } }).sort({ createdAt: -1 }).limit(50),
  ]);
  res.json({ success: true, data: { ...merchantOf(m, m.userId), balances, needsAttention: held.map(serializeOrder) } });
}));

router.patch('/merchants/:slug', superOnly, route(async (req, res) => {
  const update = {};
  try { Object.assign(update, riskUpdate(req.body || {})); } catch (err) { return res.status(err.status || 400).json({ success: false, error: err.message }); }
  if (req.body?.status !== undefined) {
    if (!['active', 'paused', 'closed'].includes(req.body.status)) return res.status(400).json({ success: false, error: 'status must be active, paused or closed.' });
    update.status = req.body.status;
  }
  const m = await StorefrontMerchant.findOne({ slug: req.params.slug });
  if (!m) return res.status(404).json({ success: false, error: 'Storefront not found.' });
  if (update.status === 'active' && m.owedNgn > 0) {
    return res.status(409).json({ success: false, error: `The trader still owes ₦${m.owedNgn} from a recall.` });
  }
  Object.assign(m, update);
  // A smaller deposit can't leave an AUTO limit above it.
  if (m.mismatchPolicy === 'AUTO' && m.autoLimitNgn > m.depositNgn) m.autoLimitNgn = m.depositNgn;
  await m.save();
  logger.info('Storefront merchant updated', { slug: m.slug, update, by: who(req) });
  res.json({ success: true, data: merchantOf(m) });
}));

router.post('/merchants/:slug/rotate-key', superOnly, route(async (req, res) => {
  const { keyId, keyHash, apiKey } = newKey();
  const m = await StorefrontMerchant.findOneAndUpdate({ slug: req.params.slug }, { keyId, keyHash }, { new: true });
  if (!m) return res.status(404).json({ success: false, error: 'Storefront not found.' });
  logger.warn('Storefront API key issued', { slug: m.slug, by: who(req) });
  // Shown once: only the key's hash is stored.
  res.json({ success: true, data: { slug: m.slug, apiKey, webhookSecret: m.webhookSecret } });
}));

router.post('/stella-customers/:waId/clear-hold', superOnly, route(async (req, res) => {
  const note = String(req.body?.note || '').trim().slice(0, 300);
  if (!note) return res.status(400).json({ success: false, error: 'note is required: what support checked.' });
  const c = await StellaCustomer.findOneAndUpdate(
    { waId: String(req.params.waId).replace(/\D/g, ''), 'securityHold.active': true },
    { $set: { securityHold: { active: false, reason: null, at: null } } },
    { new: true }
  );
  if (!c) return res.status(404).json({ success: false, error: 'No Stella customer on hold with that number.' });
  logger.warn('Stella: security hold cleared', { waId: c.waId.slice(0, 6), userId: String(c.userId), by: who(req), note });
  res.json({ success: true, data: { waId: c.waId, userId: c.userId } });
}));

router.get('/merchants/:slug/stella-profile', route(async (req, res) => {
  const m = await StorefrontMerchant.findOne({ slug: req.params.slug }).select('slug stellaProfile');
  if (!m) return res.status(404).json({ success: false, error: 'Storefront not found.' });
  res.json({ success: true, data: stellaProfile.serialize(m.stellaProfile) });
}));

router.put('/merchants/:slug/stella-profile', route(async (req, res) => {
  let profile;
  try { profile = stellaProfile.validate(req.body); } catch (err) {
    if (err instanceof stellaProfile.ProfileError) return res.status(400).json({ success: false, error: err.message });
    throw err;
  }
  const m = await StorefrontMerchant.findOneAndUpdate({ slug: req.params.slug }, { stellaProfile: profile }, { new: true });
  if (!m) return res.status(404).json({ success: false, error: 'Storefront not found.' });
  logger.info('Storefront Stella profile set by admin', { slug: m.slug, by: who(req) });
  res.json({ success: true, data: stellaProfile.serialize(m.stellaProfile) });
}));

router.get('/orders', route(async (req, res) => {
  const q = {};
  if (req.query.status) q.status = String(req.query.status).toUpperCase();
  if (req.query.slug) {
    const m = await StorefrontMerchant.findOne({ slug: req.query.slug }).select('_id');
    if (!m) return res.json({ success: true, data: [] });
    q.merchantId = m._id;
  }
  const orders = await StorefrontOrder.find(q).sort({ createdAt: -1 }).limit(Math.min(parseInt(req.query.limit, 10) || 50, 200));
  res.json({ success: true, data: orders.map(serializeOrder) });
}));

router.post('/orders/:ref/recall', superOnly, route(async (req, res) => {
  const amountNgn = Number(req.body?.amountNgn);
  if (!(amountNgn > 0)) return res.status(400).json({ success: false, error: 'amountNgn must be more than 0.' });
  const order = await StorefrontOrder.findOne({ reference: req.params.ref });
  if (!order) return res.status(404).json({ success: false, error: 'Order not found.' });
  const merchant = await StorefrontMerchant.findById(order.merchantId);
  const result = await ledger.recall(merchant, order.reference, amountNgn);
  logger.warn('Storefront recall recorded', { slug: merchant.slug, order: order.reference, amountNgn, ...result, note: req.body?.note, by: who(req) });
  res.json({ success: true, data: result });
}));


// ── Self rate approval (services/storefrontSelfRate.js) ────────────────────

const selfRate = require('../services/storefrontSelfRate');
const { notifyTrader } = require('../services/storefrontTraderNotify');
const StorefrontSellOrder = require('../models/storefrontSellOrder');
const { serializeSale } = require('../services/storefrontSell');

const applicationOf = (m, user) => ({
  slug: m.slug,
  businessName: m.brandName,
  trader: user ? { email: user.email, name: [user.firstname, user.lastname].filter(Boolean).join(' '), kycLevel: user.kycLevel } : undefined,
  status: m.selfRate?.status || 'NONE',
  application: m.selfRate?.application || null,
  payoutLimitNgn: m.selfRate?.payoutLimitNgn || 0,
  feeNgn: selfRate.feeFor(m),
  decision: m.selfRate?.decision || null,
});
const selfRateFail = (res, err) => {
  if (err instanceof selfRate.SelfRateError) return res.status(err.statusCode).json({ success: false, error: err.message });
  throw err;
};

router.get('/self-rate/applications', route(async (req, res) => {
  const status = ['PENDING', 'APPROVED', 'REJECTED'].includes(req.query.status) ? req.query.status : 'PENDING';
  const rows = await StorefrontMerchant.find({ 'selfRate.status': status }).sort({ 'selfRate.application.submittedAt': 1 }).limit(200)
    .populate('userId', 'email firstname lastname kycLevel');
  res.json({ success: true, data: rows.map((m) => applicationOf(m, m.userId)) });
}));

router.get('/merchants/:slug/self-rate', route(async (req, res) => {
  const m = await StorefrontMerchant.findOne({ slug: req.params.slug }).populate('userId', 'email firstname lastname kycLevel');
  if (!m) return res.status(404).json({ success: false, error: 'Storefront not found.' });
  res.json({ success: true, data: applicationOf(m, m.userId) });
}));

router.post('/merchants/:slug/self-rate/recheck', route(async (req, res) => {
  const m = await StorefrontMerchant.findOne({ slug: req.params.slug });
  if (!m) return res.status(404).json({ success: false, error: 'Storefront not found.' });
  try {
    const checks = await selfRate.recheck(m);
    res.json({ success: true, data: checks });
  } catch (err) { selfRateFail(res, err); }
}));

router.post('/merchants/:slug/self-rate/approve', superOnly, route(async (req, res) => {
  const m = await StorefrontMerchant.findOne({ slug: req.params.slug });
  if (!m) return res.status(404).json({ success: false, error: 'Storefront not found.' });
  try {
    await selfRate.approve(m, req.body || {}, who(req));
  } catch (err) { return selfRateFail(res, err); }
  logger.info('Storefront self rate approved', { slug: m.slug, payoutLimitNgn: m.selfRate.payoutLimitNgn, by: who(req) });
  notifyTrader(m, 'self_rate_approved', null, { payoutLimitNgn: m.selfRate.payoutLimitNgn }).catch(() => {});
  res.json({ success: true, data: applicationOf(m) });
}));

router.post('/merchants/:slug/self-rate/reject', superOnly, route(async (req, res) => {
  const m = await StorefrontMerchant.findOne({ slug: req.params.slug });
  if (!m) return res.status(404).json({ success: false, error: 'Storefront not found.' });
  try {
    await selfRate.reject(m, req.body || {}, who(req));
  } catch (err) { return selfRateFail(res, err); }
  logger.info('Storefront self rate rejected', { slug: m.slug, reason: m.selfRate.decision.reason, by: who(req) });
  notifyTrader(m, 'self_rate_rejected', null, { reason: m.selfRate.decision.reason }).catch(() => {});
  res.json({ success: true, data: applicationOf(m) });
}));

// ── Offramp sales (services/storefrontSell.js) ─────────────────────────────

router.get('/sell-orders', route(async (req, res) => {
  const q = {};
  if (req.query.status && StorefrontSellOrder.STATUSES.includes(req.query.status)) q.status = req.query.status;
  if (req.query.slug) {
    const m = await StorefrontMerchant.findOne({ slug: String(req.query.slug) }).select('_id');
    if (!m) return res.json({ success: true, data: [] });
    q.merchantId = m._id;
  }
  const rows = await StorefrontSellOrder.find(q).sort({ createdAt: -1 }).limit(200).populate('merchantId', 'slug');
  res.json({
    success: true,
    data: rows.map((o) => ({
      ...serializeSale(o), desk: o.merchantId?.slug || null, whatsapp: o.waId, rateMode: o.rateMode,
      depositTransactionId: o.deposit?.transactionId || null, reviewReason: o.reviewReason || null,
      sale: o.sale, payout: { error: o.payout?.error || null, providerId: o.payout?.providerId || null },
      selfRateFunds: o.selfRateFunds, settlement: o.settlement,
    })),
  });
}));

module.exports = router;
