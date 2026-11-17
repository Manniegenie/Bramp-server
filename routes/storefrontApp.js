// routes/storefrontApp.js
// The trader's Storefront page in the Bramp app (spec, 17 Nov 2026), behind
// the app login (authenticateToken): set up the desk (business name, rate
// mode, markdown, agreement), get the Stella link, and see the desk's
// customers and sales. Mounted at /storefront-app.
const express = require('express');
const User = require('../models/user');
const StorefrontMerchant = require('../models/storefrontMerchant');
const StorefrontCustomer = require('../models/storefrontCustomer');
const StorefrontSellOrder = require('../models/storefrontSellOrder');
const sell = require('../services/storefrontSell');
const logger = require('../utils/logger');

const router = express.Router();

const AGREEMENT_VERSION = process.env.STOREFRONT_AGREEMENT_VERSION || '2026-11-17';
const SLUG = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const stellaNumber = () => String(process.env.STELLA_WA_NUMBER || '2347034027590').replace(/\D/g, '');

const fail = (res, status, message) => res.status(status).json({ success: false, message });
const deskFor = (req) => StorefrontMerchant.findOne({ userId: req.user.id });

function linkFor(desk) {
  const url = `https://wa.me/${stellaNumber()}?text=${encodeURIComponent(`@${desk.slug}`)}`;
  return { url, qrText: url }; // the app draws the QR code from qrText
}

function serializeDesk(desk) {
  return {
    username: desk.slug,
    businessName: desk.brandName,
    status: desk.status,
    rateMode: desk.rateMode,
    markdownNgnPerUsd: desk.markdownNgnPerUsd,
    selfRate: { status: desk.selfRate?.status || 'NONE' },
    limits: { perTradeMaxNgn: desk.perTradeMaxNgn, dailyMaxNgn: desk.dailyMaxNgn },
    agreement: { version: desk.agreement?.version || null, acceptedAt: desk.agreement?.acceptedAt || null },
    link: linkFor(desk),
  };
}

/** What a customer gets per coin at this markdown, next to Bramp's rate. */
async function preview(desk) {
  if (desk.rateMode !== 'BRAMP' || desk.status !== 'active') return null;
  const out = {};
  for (const coin of Object.keys(sell.PAIRS)) {
    try {
      const r = await sell.rateFor(desk, coin);
      out[coin] = { customerNgnPerCoin: r.ngnPerCoin, brampNgnPerUsd: r.brampNgnPerUsd, markdownNgnPerUsd: r.markdownNgnPerUsd };
    } catch (err) {
      out[coin] = { error: err.message };
    }
  }
  return out;
}

// ── Desk ───────────────────────────────────────────────────────────────────

router.get('/me', async (req, res) => {
  try {
    const desk = await deskFor(req);
    if (!desk) return res.json({ success: true, data: { desk: null, agreementVersion: AGREEMENT_VERSION } });
    return res.json({ success: true, data: { desk: serializeDesk(desk), rates: await preview(desk), agreementVersion: AGREEMENT_VERSION } });
  } catch (err) {
    logger.error('Storefront app: get desk failed', { userId: req.user?.id, error: err.message });
    return fail(res, 500, 'Internal server error');
  }
});

/**
 * Create or update the desk. body: { businessName, rateMode: 'BRAMP' | 'SELF',
 * markdownNgnPerUsd, acceptAgreement, paused }. The desk's username is the
 * trader's Bramp username. Accepting the agreement is required to create it.
 */
router.put('/me', express.json(), async (req, res) => {
  try {
    const { businessName, rateMode, markdownNgnPerUsd, acceptAgreement, paused } = req.body || {};
    let desk = await deskFor(req);

    if (businessName !== undefined) {
      const name = String(businessName || '').trim();
      if (name.length < 2 || name.length > 60) return fail(res, 400, 'Business name must be 2 to 60 characters.');
    }
    if (rateMode !== undefined && !['BRAMP', 'SELF'].includes(rateMode)) return fail(res, 400, 'rateMode must be BRAMP or SELF.');
    if (rateMode === 'SELF' && desk?.selfRate?.status !== 'APPROVED') {
      return fail(res, 409, 'Self rate needs Bramp approval first.');
    }
    const maxMarkdown = Number(process.env.STOREFRONT_MAX_MARKDOWN_NGN_PER_USD || 100);
    if (markdownNgnPerUsd !== undefined) {
      const m = Number(markdownNgnPerUsd);
      if (!Number.isFinite(m) || m < 0 || m > maxMarkdown) return fail(res, 400, `Markdown must be between ₦0 and ₦${maxMarkdown} per $1.`);
    }

    if (!desk) {
      if (acceptAgreement !== true) return fail(res, 400, 'Accept the storefront agreement and risk acknowledgement to continue.');
      if (!businessName) return fail(res, 400, 'Business name is required.');
      const user = await User.findById(req.user.id).select('username');
      const slug = String(user?.username || '').trim().toLowerCase();
      if (!SLUG.test(slug)) return fail(res, 409, 'Set a Bramp username (letters, numbers and dashes) before opening a storefront.');
      if (await StorefrontMerchant.exists({ slug })) return fail(res, 409, 'That username is already used by another storefront.');
      desk = new StorefrontMerchant({ userId: req.user.id, slug, status: 'active', rateMode: 'BRAMP' });
    }

    if (businessName !== undefined) desk.brandName = String(businessName).trim();
    if (rateMode !== undefined) desk.rateMode = rateMode;
    if (markdownNgnPerUsd !== undefined) desk.markdownNgnPerUsd = Number(markdownNgnPerUsd);
    if (acceptAgreement === true) desk.agreement = { version: AGREEMENT_VERSION, acceptedAt: new Date(), ip: req.ip || null };
    if (paused !== undefined && desk.status !== 'closed') desk.status = paused ? 'paused' : 'active';
    await desk.save();

    return res.json({ success: true, data: { desk: serializeDesk(desk), rates: await preview(desk) } });
  } catch (err) {
    if (err.code === 11000) return fail(res, 409, 'That username is already used by another storefront.');
    logger.error('Storefront app: save desk failed', { userId: req.user?.id, error: err.message });
    return fail(res, 500, 'Internal server error');
  }
});

// ── Customers ──────────────────────────────────────────────────────────────

const SORTS = { lastSeen: 'lastSeenAt', lastTrade: 'lastTradeAt', volume: 'stats.volumeNgn', trades: 'stats.trades', firstSeen: 'firstSeenAt' };

/** Mongo filter for the trader's customer filters (query string). */
function customerFilter(desk, q) {
  const f = { merchantId: desk._id };
  if (q.search) f.waId = { $regex: String(q.search).replace(/\D/g, '').slice(0, 15) || '^$' };
  if (q.tag) f.tags = String(q.tag).slice(0, 30);
  if (q.activeDays) f.lastSeenAt = { $gte: new Date(Date.now() - Math.min(Number(q.activeDays) || 0, 3650) * 86400000) };
  if (q.tradedDays) f.lastTradeAt = { $gte: new Date(Date.now() - Math.min(Number(q.tradedDays) || 0, 3650) * 86400000) };
  const vol = {};
  if (q.minVolume) vol.$gte = Number(q.minVolume) || 0;
  if (q.maxVolume) vol.$lte = Number(q.maxVolume) || 0;
  if (Object.keys(vol).length) f['stats.volumeNgn'] = vol;
  if (q.minTrades) f['stats.completed'] = { $gte: Number(q.minTrades) || 0 };
  if (q.coin && sell.PAIRS[String(q.coin).toUpperCase()]) f[`stats.byCoin.${String(q.coin).toUpperCase()}.trades`] = { $gt: 0 };
  return f;
}

function serializeCustomer(c) {
  const byCoin = {};
  for (const [coin, v] of (c.stats?.byCoin || new Map())) byCoin[coin] = { trades: v.trades, amount: v.amount, volumeNgn: v.volumeNgn };
  return {
    waId: c.waId,
    displayName: c.displayName,
    firstSeenAt: c.firstSeenAt,
    lastSeenAt: c.lastSeenAt,
    lastTradeAt: c.lastTradeAt,
    stats: { trades: c.stats?.trades || 0, completed: c.stats?.completed || 0, volumeNgn: c.stats?.volumeNgn || 0, byCoin },
    accounts: (c.accounts || []).map((a) => ({ bankName: a.bankName, accountNumber: a.accountNumber, accountName: a.accountName, lastUsedAt: a.lastUsedAt })),
    tags: c.tags || [],
    note: c.note || null,
  };
}

router.get('/customers', async (req, res) => {
  try {
    const desk = await deskFor(req);
    if (!desk) return fail(res, 404, 'No storefront yet.');
    const filter = customerFilter(desk, req.query);
    const sortField = SORTS[req.query.sort] || 'lastSeenAt';
    const order = req.query.order === 'asc' ? 1 : -1;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const [rows, total] = await Promise.all([
      StorefrontCustomer.find(filter).sort({ [sortField]: order, _id: order }).skip((page - 1) * limit).limit(limit),
      StorefrontCustomer.countDocuments(filter),
    ]);
    return res.json({ success: true, data: { customers: rows.map(serializeCustomer), page, limit, total } });
  } catch (err) {
    logger.error('Storefront app: list customers failed', { userId: req.user?.id, error: err.message });
    return fail(res, 500, 'Internal server error');
  }
});

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // no spreadsheet formulas
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

router.get('/customers/export.csv', async (req, res) => {
  try {
    const desk = await deskFor(req);
    if (!desk) return fail(res, 404, 'No storefront yet.');
    const header = ['whatsapp', 'name', 'first_seen', 'last_seen', 'last_trade', 'trades', 'completed', 'volume_ngn', 'usdt_sold', 'usdc_sold', 'tags', 'note'];
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${desk.slug}-customers.csv"`);
    res.write(`${header.join(',')}\n`);
    const cursor = StorefrontCustomer.find(customerFilter(desk, req.query)).sort({ lastSeenAt: -1 }).limit(50000).cursor();
    for await (const c of cursor) {
      const coin = (k) => c.stats?.byCoin?.get?.(k)?.amount || 0;
      res.write(`${[
        `+${c.waId}`, c.displayName, c.firstSeenAt?.toISOString(), c.lastSeenAt?.toISOString(), c.lastTradeAt?.toISOString(),
        c.stats?.trades || 0, c.stats?.completed || 0, c.stats?.volumeNgn || 0, coin('USDT'), coin('USDC'), (c.tags || []).join(' '), c.note,
      ].map(csvCell).join(',')}\n`);
    }
    return res.end();
  } catch (err) {
    logger.error('Storefront app: export customers failed', { userId: req.user?.id, error: err.message });
    if (!res.headersSent) return fail(res, 500, 'Internal server error');
    return res.end();
  }
});

router.get('/customers/:waId', async (req, res) => {
  try {
    const desk = await deskFor(req);
    if (!desk) return fail(res, 404, 'No storefront yet.');
    const c = await StorefrontCustomer.findOne({ merchantId: desk._id, waId: String(req.params.waId).replace(/\D/g, '') });
    if (!c) return fail(res, 404, 'Customer not found.');
    const sales = await StorefrontSellOrder.find({ customerId: c._id }).sort({ createdAt: -1 }).limit(50);
    return res.json({ success: true, data: { customer: serializeCustomer(c), sales: sales.map(sell.serializeSale) } });
  } catch (err) {
    logger.error('Storefront app: get customer failed', { userId: req.user?.id, error: err.message });
    return fail(res, 500, 'Internal server error');
  }
});

/** The trader's own tags and note on a customer. body: { tags?: string[], note?: string } */
router.patch('/customers/:waId', express.json(), async (req, res) => {
  try {
    const desk = await deskFor(req);
    if (!desk) return fail(res, 404, 'No storefront yet.');
    const { MAX_TAGS, MAX_NOTE } = StorefrontCustomer.LIMITS;
    const set = {};
    if (req.body?.tags !== undefined) {
      if (!Array.isArray(req.body.tags)) return fail(res, 400, 'tags must be a list.');
      const tags = [...new Set(req.body.tags.map((t) => String(t).trim().toLowerCase().slice(0, 30)).filter(Boolean))];
      if (tags.length > MAX_TAGS) return fail(res, 400, `At most ${MAX_TAGS} tags.`);
      set.tags = tags;
    }
    if (req.body?.note !== undefined) {
      const note = req.body.note === null ? null : String(req.body.note).trim();
      if (note && note.length > MAX_NOTE) return fail(res, 400, `Note must be at most ${MAX_NOTE} characters.`);
      set.note = note || null;
    }
    const c = await StorefrontCustomer.findOneAndUpdate(
      { merchantId: desk._id, waId: String(req.params.waId).replace(/\D/g, '') },
      { $set: set },
      { new: true }
    );
    if (!c) return fail(res, 404, 'Customer not found.');
    return res.json({ success: true, data: { customer: serializeCustomer(c) } });
  } catch (err) {
    logger.error('Storefront app: update customer failed', { userId: req.user?.id, error: err.message });
    return fail(res, 500, 'Internal server error');
  }
});

// ── Sales ──────────────────────────────────────────────────────────────────

router.get('/sales', async (req, res) => {
  try {
    const desk = await deskFor(req);
    if (!desk) return fail(res, 404, 'No storefront yet.');
    const f = { merchantId: desk._id };
    if (req.query.status && StorefrontSellOrder.STATUSES.includes(req.query.status)) f.status = req.query.status;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const [rows, total] = await Promise.all([
      StorefrontSellOrder.find(f).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      StorefrontSellOrder.countDocuments(f),
    ]);
    return res.json({
      success: true,
      data: {
        sales: rows.map((o) => ({ ...sell.serializeSale(o), whatsapp: o.waId, traderEarningNgn: o.settlement?.traderEarningNgn ?? null })),
        page, limit, total,
      },
    });
  } catch (err) {
    logger.error('Storefront app: list sales failed', { userId: req.user?.id, error: err.message });
    return fail(res, 500, 'Internal server error');
  }
});

module.exports = router;
