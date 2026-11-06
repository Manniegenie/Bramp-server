// services/storefrontLedger.js
// A trader's storefront proceeds (models/storefrontLedger.js): credited HELD
// when an order completes, released to their Bramp NGNB balance holdDays
// later, reversed when a payment is recalled.
const StorefrontLedger = require('../models/storefrontLedger');
const StorefrontMerchant = require('../models/storefrontMerchant');
const { updateUserBalance } = require('./portfolio');
const logger = require('../utils/logger');

const DAY_MS = 24 * 60 * 60 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Credit an order's margin. Idempotent on the order: a retried webhook can't
 * credit twice. Pays down anything the trader owes from earlier recalls first.
 */
async function creditMargin(merchant, order, marginNgn) {
  let amount = round2(marginNgn);
  if (!(amount > 0)) return null;

  if (merchant.owedNgn > 0) {
    const payDown = Math.min(merchant.owedNgn, amount);
    const updated = await StorefrontMerchant.findOneAndUpdate(
      { _id: merchant._id, owedNgn: { $gte: payDown } }, { $inc: { owedNgn: -payDown } }, { new: true }
    );
    if (updated) {
      amount = round2(amount - payDown);
      logger.info('Storefront: margin paid down owed balance', { merchant: merchant.slug, order: order.reference, payDown, stillOwed: updated.owedNgn });
    }
    if (!(amount > 0)) return null;
  }

  try {
    return await StorefrontLedger.create({
      merchantId: merchant._id,
      reference: `margin:${order.reference}`,
      orderReference: order.reference,
      amountNgn: amount,
      availableAt: new Date(Date.now() + merchant.holdDays * DAY_MS),
    });
  } catch (err) {
    if (err.code === 11000) return null; // already credited
    throw err;
  }
}

/**
 * Release every held entry past its availableAt to the trader's NGNB
 * balance. Each entry is claimed before the balance moves, so two job runs
 * can't release it twice.
 */
async function releaseMatured() {
  const due = await StorefrontLedger.find({ status: 'HELD', availableAt: { $lte: new Date() } }).limit(200);
  let released = 0;
  for (const entry of due) {
    const claimed = await StorefrontLedger.findOneAndUpdate(
      { _id: entry._id, status: 'HELD' }, { status: 'RELEASED', releasedAt: new Date() }, { new: true }
    );
    if (!claimed) continue;
    const merchant = await StorefrontMerchant.findById(claimed.merchantId).select('userId slug');
    try {
      await updateUserBalance(merchant.userId, 'NGNB', claimed.amountNgn);
      released += 1;
    } catch (err) {
      // Put it back so the next run retries.
      await StorefrontLedger.updateOne({ _id: claimed._id }, { status: 'HELD', releasedAt: null });
      logger.error('Storefront: could not release held proceeds', { merchant: merchant?.slug, entry: claimed.reference, error: err.message });
    }
  }
  if (released) logger.info('Storefront: released held proceeds', { released });
  return released;
}

/**
 * A payment on this order was recalled. Takes amountNgn back from the
 * trader: first from what's still held (newest entries first), then their
 * security deposit; the rest is added to owedNgn and the storefront is
 * paused until it's paid down.
 */
async function recall(merchant, orderReference, amountNgn) {
  let remaining = round2(amountNgn);
  const held = await StorefrontLedger.find({ merchantId: merchant._id, status: 'HELD' }).sort({ createdAt: -1 });
  for (const entry of held) {
    if (!(remaining > 0)) break;
    const reversed = await StorefrontLedger.findOneAndUpdate(
      { _id: entry._id, status: 'HELD' },
      { status: 'REVERSED', reversedAt: new Date(), note: `recall:${orderReference}` },
      { new: true }
    );
    if (!reversed) continue;
    if (reversed.amountNgn > remaining) {
      // Only part of this entry is needed: hold the rest back again as a new entry.
      await StorefrontLedger.create({
        merchantId: merchant._id,
        reference: `${reversed.reference}:rest:${Date.now()}`,
        orderReference: reversed.orderReference,
        amountNgn: round2(reversed.amountNgn - remaining),
        availableAt: reversed.availableAt,
        note: `remainder after recall:${orderReference}`,
      });
      remaining = 0;
    } else {
      remaining = round2(remaining - reversed.amountNgn);
    }
  }

  // Then the security deposit Bramp holds for exactly this.
  let fromDepositNgn = 0;
  if (remaining > 0) {
    const fresh = await StorefrontMerchant.findById(merchant._id).select('depositNgn');
    fromDepositNgn = round2(Math.min(fresh.depositNgn, remaining));
    if (fromDepositNgn > 0) {
      const taken = await StorefrontMerchant.findOneAndUpdate(
        { _id: merchant._id, depositNgn: { $gte: fromDepositNgn } }, { $inc: { depositNgn: -fromDepositNgn } }, { new: true }
      );
      if (taken) remaining = round2(remaining - fromDepositNgn);
      else fromDepositNgn = 0;
    }
  }

  if (remaining > 0) {
    await StorefrontMerchant.updateOne({ _id: merchant._id }, { $inc: { owedNgn: remaining }, status: 'paused' });
    logger.warn('Storefront: recall exceeded held proceeds and deposit, merchant paused', { merchant: merchant.slug, orderReference, owedNgn: remaining });
  }
  return { coveredNgn: round2(amountNgn - remaining), fromDepositNgn, owedNgn: remaining };
}

async function balances(merchantId) {
  const rows = await StorefrontLedger.aggregate([
    { $match: { merchantId } },
    { $group: { _id: '$status', total: { $sum: '$amountNgn' } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, round2(r.total)]));
  const next = await StorefrontLedger.findOne({ merchantId, status: 'HELD' }).sort({ availableAt: 1 }).select('availableAt amountNgn');
  return {
    heldNgn: by.HELD || 0,
    releasedNgn: by.RELEASED || 0,
    reversedNgn: by.REVERSED || 0,
    nextRelease: next ? { at: next.availableAt, amountNgn: next.amountNgn } : null,
  };
}

module.exports = { creditMargin, releaseMatured, recall, balances };
