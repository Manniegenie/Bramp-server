// routes/storefront.js — Bramp Storefront endpoints
//
// Called by bramp.shop's backend for hosted stores, or by a trader's own
// server or bot, never by customers directly. Mounted at /storefront in
// server.js behind auth/storefrontAuth.js: every request needs either
//   X-Bramp-Shop-Key + X-Storefront-Slug    (bramp.shop, hosted stores)
//   X-Storefront-Key: sfk_<keyId>_<secret>   (a store's own key)
// and acts on that one storefront only. Responses use Bramp's
// { success, message?, data } envelope.
//
//   GET   /storefront/health                  — key check + config sanity
//   GET   /storefront/networks?asset=         — payout networks for USDT/USDC now, with Obiex's minimum and fee
//   GET   /storefront/buy/quote?asset=&network=&amountNgn=&rate= — what the amount buys, the trader's margin
//   POST  /storefront/buy/orders              — { storeReference, customerRef, payerName, asset, network, address, amountNgn, rate }
//                                               create an order (idempotent on storeReference)
//   GET   /storefront/buy/orders?status=      — newest first
//   GET   /storefront/buy/orders/:ref         — by Bramp reference or storeReference
//   POST  /storefront/buy/orders/:ref/approve — send the crypto for a held payment
//   POST  /storefront/buy/orders/:ref/reject  — { reason } refuse a held payment (refunded to the payer)
//   GET   /storefront/balance                 — held proceeds, released, next release
//   GET   /storefront/settings                — mismatch policy, limits, hold
//   PATCH /storefront/settings                — { mismatchPolicy?, autoLimitNgn?, webhookUrl? }
//
// Status changes are pushed to the trader's webhookUrl, signed
// (services/storefrontNotify.js): buy.held_review, buy.held_delay,
// buy.payout_submitted, buy.completed, buy.rejected, buy.expired, buy.failed.
const express = require('express');
const router = express.Router();
const buy = require('../services/storefrontBuy');
const ledger = require('../services/storefrontLedger');
const logger = require('../utils/logger');

const route = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    if (err instanceof buy.StorefrontError) return res.status(err.statusCode).json({ success: false, message: err.message });
    logger.error('Storefront route error', { path: req.path, merchant: req.merchant?.slug, error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, message: 'Internal error.' });
  }
};

const settingsOf = (m, req) => ({
  slug: m.slug,
  status: m.status,
  mismatchPolicy: m.mismatchPolicy,
  autoLimitNgn: m.autoLimitNgn,
  webhookUrl: m.webhookUrl,
  // Only bramp.shop's own backend sees it, to verify the webhooks we send it.
  // A store with its own key gets it when the key is issued.
  ...(req.viaPlatform ? { webhookSecret: m.webhookSecret } : {}),
  holdDays: m.holdDays,
  depositNgn: m.depositNgn,
  perTradeMaxNgn: m.perTradeMaxNgn,
  dailyMaxNgn: m.dailyMaxNgn,
  owedNgn: m.owedNgn,
});

router.get('/health', (req, res) => {
  res.json({ success: true, data: { storefront: req.merchant.slug, status: req.merchant.status, webhookConfigured: Boolean(req.merchant.webhookUrl) } });
});

router.get('/networks', route(async (req, res) => {
  const asset = String(req.query.asset || '').toUpperCase();
  if (!buy.ASSETS.includes(asset)) return res.status(400).json({ success: false, message: `asset must be one of: ${buy.ASSETS.join(', ')}.` });
  res.json({ success: true, data: { asset, networks: await buy.networks(asset) } });
}));

router.get('/buy/quote', route(async (req, res) => {
  res.json({ success: true, data: await buy.quote(req.merchant, req.query) });
}));

router.post('/buy/orders', route(async (req, res) => {
  const { order, created } = await buy.createOrder(req.merchant, req.body || {});
  res.status(created ? 201 : 200).json({ success: true, data: buy.serializeOrder(order) });
}));

router.get('/buy/orders', route(async (req, res) => {
  const orders = await buy.listOrders(req.merchant, req.query);
  res.json({ success: true, data: orders.map(buy.serializeOrder) });
}));

router.get('/buy/orders/:ref', route(async (req, res) => {
  const order = await buy.findOrder(req.merchant, req.params.ref);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found.' });
  res.json({ success: true, data: buy.serializeOrder(order) });
}));

router.post('/buy/orders/:ref/approve', route(async (req, res) => {
  res.json({ success: true, data: buy.serializeOrder(await buy.approve(req.merchant, req.params.ref)) });
}));

router.post('/buy/orders/:ref/reject', route(async (req, res) => {
  res.json({ success: true, data: buy.serializeOrder(await buy.reject(req.merchant, req.params.ref, req.body?.reason)) });
}));

router.get('/balance', route(async (req, res) => {
  res.json({ success: true, data: { ...(await ledger.balances(req.merchant._id)), owedNgn: req.merchant.owedNgn, holdDays: req.merchant.holdDays } });
}));

router.get('/settings', (req, res) => res.json({ success: true, data: settingsOf(req.merchant, req) }));

router.patch('/settings', route(async (req, res) => {
  const m = req.merchant;
  const { mismatchPolicy, autoLimitNgn, webhookUrl } = req.body || {};
  if (mismatchPolicy !== undefined) {
    if (!['STRICT', 'REVIEW', 'AUTO'].includes(mismatchPolicy)) {
      return res.status(400).json({ success: false, message: 'mismatchPolicy must be STRICT, REVIEW or AUTO.' });
    }
    m.mismatchPolicy = mismatchPolicy;
  }
  if (autoLimitNgn !== undefined) {
    const n = Number(autoLimitNgn);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ success: false, message: 'autoLimitNgn must be 0 or more.' });
    m.autoLimitNgn = n;
  }
  // The deposit is what covers a recalled payment Bramp already paid out for.
  if (m.mismatchPolicy === 'AUTO' && m.autoLimitNgn > m.depositNgn) {
    return res.status(400).json({ success: false, message: `autoLimitNgn can't be more than your security deposit (₦${m.depositNgn}).` });
  }
  if (webhookUrl !== undefined) {
    if (webhookUrl !== null && !/^https:\/\/\S+$/.test(webhookUrl)) {
      return res.status(400).json({ success: false, message: 'webhookUrl must be an https URL.' });
    }
    m.webhookUrl = webhookUrl;
  }
  await m.save();
  logger.info('Storefront settings changed', { merchant: m.slug, mismatchPolicy: m.mismatchPolicy, autoLimitNgn: m.autoLimitNgn });
  res.json({ success: true, data: settingsOf(m, req) });
}));

module.exports = router;
