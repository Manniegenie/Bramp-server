// services/storefrontBuy.js
// Customers buying crypto on a trader's storefront (partner API:
// routes/storefront.js). Built on the Metusela on-ramp (services/metuselaOnramp.js):
// a dynamic Glyde account per order, USDT/USDC sent from Bramp's Obiex
// treasury. What's new is that payments from other people's accounts are
// allowed, under the trader's own rules:
//
//   1. quote()        — the trader's rate, checked against Bramp's on-ramp
//                       price plus the storefront fee: the trader can't sell
//                       below what the crypto costs them.
//   2. createOrder()  — locks both rates and issues the one-time account. The
//                       customer gives the name on the account they'll pay from.
//   3. handleGlydeEvent() — the payment lands. The payer's name is checked:
//        match or trusted payer → sent (after a delay if it's large and the
//                                 payer is new to this trader)
//        mismatch / unreadable  → the trader's mismatchPolicy decides
//   4. approve() / reject()   — the trader's decision on a held payment.
//   5. handleObiexWithdrawal() — the payout settles; the trader's margin is
//                       credited to their held balance (services/storefrontLedger.js).
// Every state change is pushed to the trader's storefront-api, signed.
const crypto = require('crypto');
const StorefrontOrder = require('../models/storefrontOrder');
const StorefrontMerchant = require('../models/storefrontMerchant');
const { createVirtualAccount, deactivateVirtualAccount } = require('./collectionService');
const { getOnrampRate } = require('./onramppriceservice');
const { withdrawStablecoin } = require('./ObiexWithdraw');
const { getAvailableNetworks } = require('./networkService');
const { normalizeNetwork, termsFor } = require('./metuselaNetworks');
const { notifyMerchant } = require('./storefrontNotify');
const ledger = require('./storefrontLedger');
const { namesMatch, namesSimilar } = require('../utils/kycHelpers');
const logger = require('../utils/logger');

const ASSETS = ['USDT', 'USDC'];

const cfg = () => ({
  feeBps: Number(process.env.STOREFRONT_FEE_BPS || 50),
  minNgn: Number(process.env.STOREFRONT_MIN_NGN || 1000),
  ttlMinutes: Number(process.env.STOREFRONT_ORDER_TTL_MINUTES || 30),
  // A payment at or above this from a payer name this trader has never been
  // paid by waits delayMinutes before the crypto is sent: most triangle-fraud
  // victims report within that time.
  firstPayerThresholdNgn: Number(process.env.STOREFRONT_FIRST_PAYER_THRESHOLD_NGN || 200000),
  firstPayerDelayMinutes: Number(process.env.STOREFRONT_FIRST_PAYER_DELAY_MINUTES || 45),
});

class StorefrontError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const floor2 = (n) => Math.floor(n * 100) / 100;
const round2 = (n) => Math.round(n * 100) / 100;

// ── Networks ───────────────────────────────────────────────────────────────

let networkCache = {};

/** Networks Obiex currently supports for this asset, with Obiex's terms. Cached 10 minutes. */
async function networks(asset) {
  const cached = networkCache[asset];
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.list;
  let live;
  try {
    live = (await getAvailableNetworks(asset)).map(normalizeNetwork);
  } catch (err) {
    throw new StorefrontError(`${asset} networks are not available right now.`, 503);
  }
  const list = live.map((code) => termsFor(asset, code)).filter(Boolean)
    .map(({ code, name, minWithdrawal, withdrawalFee }) => ({ code, name, minWithdrawal, withdrawalFee }));
  networkCache[asset] = { at: Date.now(), list };
  return list;
}

const ADDRESS = {
  TRX: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  SOL: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
};
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const validAddress = (network, address) => (ADDRESS[network] || EVM_ADDRESS).test(address);

// ── Quote ──────────────────────────────────────────────────────────────────

/**
 * What amountNgn buys at the trader's rate, and what the trader keeps.
 * Refuses a rate below Bramp's on-ramp price plus the storefront fee.
 */
async function quote(merchant, { asset: assetRaw, network: networkRaw, amountNgn: amountRaw, rate: rateRaw }) {
  const { feeBps, minNgn } = cfg();
  const asset = String(assetRaw || '').toUpperCase();
  if (!ASSETS.includes(asset)) throw new StorefrontError(`asset must be one of: ${ASSETS.join(', ')}.`);
  const amountNgn = Number(amountRaw);
  const max = merchant.perTradeMaxNgn;
  if (!Number.isFinite(amountNgn) || amountNgn < minNgn || amountNgn > max) {
    throw new StorefrontError(`amountNgn must be between ${minNgn} and ${max}.`);
  }
  const rate = Number(rateRaw);
  if (!Number.isFinite(rate) || rate <= 0) throw new StorefrontError('rate must be a positive number (₦ per 1 unit).');

  let brampRate;
  try {
    brampRate = (await getOnrampRate()).finalPrice;
  } catch (err) {
    throw new StorefrontError('Rates are not available right now.', 503);
  }
  if (!Number.isFinite(brampRate) || brampRate <= 0) throw new StorefrontError('Rates are not available right now.', 503);

  const minRate = round2(brampRate * (1 + feeBps / 10000));
  if (rate < minRate) {
    throw new StorefrontError(`rate is below Bramp's price: the lowest ${asset} rate today is ₦${minRate}.`, 422);
  }

  const network = normalizeNetwork(networkRaw);
  const net = network ? (await networks(asset)).find((n) => n.code === network) : null;
  if (networkRaw && !net) throw new StorefrontError(`network is not available for ${asset} right now.`);

  const amount = floor2(amountNgn / rate);
  const feeNgn = round2(amountNgn * feeBps / 10000);
  const marginNgn = round2(amountNgn - amount * brampRate - feeNgn);
  return {
    asset, amountNgn, rate, amount,
    network: net ? { code: net.code, name: net.name, fee: net.withdrawalFee, minimum: net.minWithdrawal } : null,
    receives: net ? floor2(amount - net.withdrawalFee) : null,
    brampRate, minRate, feeBps, feeNgn, marginNgn,
  };
}

// ── Orders ─────────────────────────────────────────────────────────────────

function serializeOrder(o) {
  return {
    reference: o.reference,
    storeReference: o.storeReference,
    customerRef: o.customerRef,
    status: o.status,
    asset: o.asset,
    network: o.network,
    address: o.address,
    amountNgn: o.amountNgn,
    rate: o.rate,
    quotedAmount: o.quotedAmount,
    payerName: o.payerName,
    bankTransfer: o.virtualAccount?.accountNumber ? {
      accountNumber: o.virtualAccount.accountNumber,
      accountName: o.virtualAccount.accountName,
      bankName: o.virtualAccount.bankName,
      amountNgn: o.amountNgn,
    } : null,
    expiresAt: o.expiresAt,
    receivedNgn: o.receivedNgn,
    receivedPayerName: o.receivedPayerName,
    nameCheck: o.nameCheck,
    paidAt: o.paidAt,
    releaseAt: o.releaseAt,
    decidedBy: o.decidedBy,
    payoutAmount: o.payoutAmount,
    marginNgn: o.marginNgn,
    payoutTxHash: o.payoutTxHash,
    completedAt: o.completedAt,
    failureReason: o.failureReason,
    createdAt: o.createdAt,
  };
}

async function paidTodayNgn(merchantId) {
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  const [row] = await StorefrontOrder.aggregate([
    { $match: { merchantId, paidAt: { $gte: since } } },
    { $group: { _id: null, total: { $sum: '$receivedNgn' } } },
  ]);
  return row?.total || 0;
}

/**
 * Create an order (idempotent on the merchant's storeReference). Issues a
 * dynamic Glyde account for the exact amount; both rates are locked until
 * expiresAt.
 */
async function createOrder(merchant, body) {
  const { storeReference, customerRef, payerName, address: addressRaw } = body;
  if (!storeReference || !customerRef) throw new StorefrontError('storeReference and customerRef are required.');
  const existing = await StorefrontOrder.findOne({ merchantId: merchant._id, storeReference });
  if (existing) return { order: existing, created: false };

  if (merchant.status !== 'active') throw new StorefrontError('This storefront is paused.', 403);
  const name = String(payerName || '').trim();
  if (name.split(/\s+/).length < 2) throw new StorefrontError('payerName must be the full name on the paying account.');
  if (!body.network) throw new StorefrontError('network is required.');

  const q = await quote(merchant, body);
  const address = String(addressRaw || '').trim();
  if (!validAddress(q.network.code, address)) throw new StorefrontError('address is not a valid address for that network.');
  if (q.amount < q.network.minimum) {
    throw new StorefrontError(`That buys ${q.amount} ${q.asset}; the minimum on ${q.network.name} is ${q.network.minimum}.`);
  }
  if (await paidTodayNgn(merchant._id) + q.amountNgn > merchant.dailyMaxNgn) {
    throw new StorefrontError('This storefront has reached its daily limit.', 403);
  }

  const reference = `sf-buy-${crypto.randomBytes(8).toString('hex')}`;
  const [first, ...rest] = name.split(/\s+/);
  const va = await createVirtualAccount({
    type: 'dynamic',
    // Glyde wants an email; the customer's isn't ours to hold.
    customer: { reference, first_name: first, last_name: rest.join(' '), email: `${reference}@storefront.bramp.shop` },
    expectedAmount: q.amountNgn,
  });
  if (!va.success) {
    throw new StorefrontError(`Could not issue a bank account: ${va.message}`, va.statusCode >= 500 ? 502 : 400);
  }
  const d = va.data;
  const ttlExpiry = new Date(Date.now() + cfg().ttlMinutes * 60 * 1000);
  const glydeExpiry = d.expires_at ? new Date(d.expires_at) : null;

  const order = await StorefrontOrder.create({
    reference,
    merchantId: merchant._id,
    storeReference,
    customerRef,
    payerName: name,
    asset: q.asset,
    network: q.network.code,
    address,
    amountNgn: q.amountNgn,
    rate: q.rate,
    brampRate: q.brampRate,
    feeBps: q.feeBps,
    quotedAmount: q.amount,
    virtualAccount: { uid: d.uid, accountNumber: d.account_number, accountName: d.account_name, bankName: d.bank_name || d.bank?.name || null },
    expiresAt: glydeExpiry && glydeExpiry < ttlExpiry ? glydeExpiry : ttlExpiry,
  });
  logger.info('Storefront: buy order created', { merchant: merchant.slug, reference, amountNgn: q.amountNgn, asset: q.asset, network: q.network.code });
  return { order, created: true };
}

async function findOrder(merchant, ref) {
  const order = await StorefrontOrder.findOne({ merchantId: merchant._id, $or: [{ reference: ref }, { storeReference: ref }] });
  if (!order) return null;
  // Lazy expiry: an unpaid order past its window can't be paid any more.
  if (order.status === 'AWAITING_PAYMENT' && !order.glydeReference && order.expiresAt <= new Date()) {
    const expired = await StorefrontOrder.findOneAndUpdate(
      { _id: order._id, status: 'AWAITING_PAYMENT', glydeReference: null }, { status: 'EXPIRED' }, { new: true }
    );
    if (expired) {
      if (expired.virtualAccount?.uid) deactivateVirtualAccount(expired.virtualAccount.uid).catch(() => {});
      notify(merchant, 'buy.expired', expired);
      return expired;
    }
  }
  return order;
}

async function listOrders(merchant, { status, limit = 50 } = {}) {
  const q = { merchantId: merchant._id };
  if (status) q.status = String(status).toUpperCase();
  return StorefrontOrder.find(q).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 50, 200));
}

// ── Webhook to the trader ──────────────────────────────────────────────────

async function notify(merchant, event, order) {
  const { ok, error } = await notifyMerchant(merchant, event, serializeOrder(order));
  await StorefrontOrder.updateOne({ _id: order._id }, { lastNotify: { event, ok, at: new Date(), error } });
}

// ── Payment in (Glyde) ─────────────────────────────────────────────────────

// Same rule as services/glydeDepositCrediting.js: some banks send a
// narration ("Transfer 2000.00 To ...") where the payer's name should be,
// and a narration says nothing about who paid.
function looksLikeNarration(text) {
  if (!text) return false;
  if (/\d/.test(text)) return true;
  return /\b(transfer|payment|nip|pos|ussd|via|txn|trx)\b/i.test(text);
}

/** MATCH, TRUSTED (this customer has paid this trader from that name before), MISMATCH or UNVERIFIABLE. */
async function checkPayerName(order, payerName) {
  if (!payerName || looksLikeNarration(payerName)) return 'UNVERIFIABLE';
  if (namesMatch(payerName, order.payerName) || namesSimilar(payerName, order.payerName)) return 'MATCH';
  const before = await StorefrontOrder.find({
    merchantId: order.merchantId, customerRef: order.customerRef, status: 'COMPLETED', _id: { $ne: order._id },
  }).select('receivedPayerName').sort({ completedAt: -1 }).limit(20);
  if (before.some((o) => o.receivedPayerName && namesSimilar(payerName, o.receivedPayerName))) return 'TRUSTED';
  return 'MISMATCH';
}

/** Has this trader been paid by this payer name before (any customer)? */
async function knownPayer(order, payerName) {
  const before = await StorefrontOrder.find({
    merchantId: order.merchantId, status: 'COMPLETED', _id: { $ne: order._id },
  }).select('receivedPayerName').sort({ completedAt: -1 }).limit(500);
  return before.some((o) => o.receivedPayerName && namesSimilar(payerName, o.receivedPayerName));
}

/**
 * Entry point from routes/nairawebhook.js /glyde/collection, after Metusela's
 * handler. Same payload handling as services/metuselaOnramp.js. Returns true
 * if it was a storefront order.
 */
async function handleGlydeEvent(event, data) {
  const funded = event === 'virtual_account.funded' || event === 'collection.success';
  if (!data || !funded) return false;
  const ref = data.payee?.reference || data.merchant_reference || data.customer?.reference || null;
  const uid = data.uid || data.virtual_account_uid || null;
  const accountNumber = data.account_number || data.payee?.account_number || null;
  const or = [];
  if (ref) or.push({ reference: ref });
  if (uid) or.push({ 'virtualAccount.uid': uid });
  if (accountNumber) or.push({ 'virtualAccount.accountNumber': accountNumber });
  if (!or.length) return false;
  const order = await StorefrontOrder.findOne({ $or: or }).sort({ createdAt: -1 });
  if (!order) return false;

  const glydeReference = data.transaction_reference || data.reference || data.id
    || `fp-${crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16)}`;
  const receivedNgn = Number(data.amount ?? data.total_collected);
  const receivedPayerName = data.payer?.account_name || null;
  if (!(receivedNgn > 0)) {
    logger.error('Storefront: Glyde payment without an amount — check manually', { reference: order.reference, glydeReference });
    return true;
  }

  // Claim the payment once (Glyde retries webhooks). A payment after expiry
  // is held for the trader: the locked rate no longer applies.
  const late = order.status === 'EXPIRED';
  const claimed = await StorefrontOrder.findOneAndUpdate(
    { _id: order._id, status: { $in: ['AWAITING_PAYMENT', 'EXPIRED'] }, glydeReference: null },
    { receivedNgn, receivedPayerName, glydeReference, paidAt: new Date() },
    { new: true }
  );
  if (!claimed) {
    if (order.glydeReference !== glydeReference) {
      // A second, different payment into the same one-time account.
      logger.error('Storefront: extra payment on an order already paid — refund manually', {
        reference: order.reference, glydeReference, receivedNgn, receivedPayerName,
      });
    } else {
      logger.info('Storefront: payment already processed', { reference: order.reference, glydeReference });
    }
    return true;
  }
  if (claimed.virtualAccount?.uid) deactivateVirtualAccount(claimed.virtualAccount.uid).catch(() => {});

  const merchant = await StorefrontMerchant.findById(claimed.merchantId);
  const nameCheck = await checkPayerName(claimed, receivedPayerName);
  logger.info('Storefront: payment received', {
    merchant: merchant.slug, reference: claimed.reference, receivedNgn, nameCheck, late,
  });

  const nameOk = nameCheck === 'MATCH' || nameCheck === 'TRUSTED';
  const autoOk = merchant.mismatchPolicy === 'AUTO' && receivedNgn <= merchant.autoLimitNgn;
  if (late || merchant.status !== 'active' || (!nameOk && !autoOk)) {
    const held = await StorefrontOrder.findOneAndUpdate(
      { _id: claimed._id }, { status: 'HELD_REVIEW', nameCheck }, { new: true }
    );
    notify(merchant, 'buy.held_review', held);
    return true;
  }

  const { firstPayerThresholdNgn, firstPayerDelayMinutes } = cfg();
  if (receivedNgn >= firstPayerThresholdNgn && nameCheck !== 'TRUSTED' && !(await knownPayer(claimed, receivedPayerName))) {
    const delayed = await StorefrontOrder.findOneAndUpdate(
      { _id: claimed._id },
      { status: 'HELD_DELAY', nameCheck, decidedBy: 'AUTO', releaseAt: new Date(Date.now() + firstPayerDelayMinutes * 60 * 1000) },
      { new: true }
    );
    notify(merchant, 'buy.held_delay', delayed);
    return true;
  }

  await StorefrontOrder.updateOne({ _id: claimed._id }, { nameCheck, decidedBy: 'AUTO' });
  return payout(merchant, claimed._id);
}

// ── Crypto out (Obiex) ─────────────────────────────────────────────────────

/**
 * Send the crypto for what was actually paid, at the locked rate. Claims the
 * order first (from whatever held/paid state it's in) so it can't be paid
 * out twice.
 */
async function payout(merchant, orderId) {
  const order = await StorefrontOrder.findOneAndUpdate(
    { _id: orderId, status: { $in: ['AWAITING_PAYMENT', 'EXPIRED', 'HELD_REVIEW', 'HELD_DELAY'] }, obiexWithdrawalId: null, receivedNgn: { $gt: 0 } },
    { status: 'PAYOUT_SUBMITTED' },
    { new: true }
  );
  if (!order) return true;

  const amount = floor2(order.receivedNgn / order.rate);
  const marginNgn = round2(order.receivedNgn - amount * order.brampRate - order.receivedNgn * order.feeBps / 10000);
  const net = termsFor(order.asset, order.network);
  if (!net || amount < net.minWithdrawal) {
    const failed = await StorefrontOrder.findOneAndUpdate(
      { _id: order._id }, { status: 'PAYOUT_FAILED', payoutAmount: amount, failureReason: 'AMOUNT_TOO_LOW: needs manual refund' }, { new: true }
    );
    notify(merchant, 'buy.failed', failed);
    return true;
  }

  const result = await withdrawStablecoin(order.asset, order.address, amount, order.network, `Storefront ${order.reference.slice(-8)}`);
  const updated = await StorefrontOrder.findOneAndUpdate(
    { _id: order._id },
    result.success
      ? { payoutAmount: amount, marginNgn, obiexWithdrawalId: result.transactionId }
      : { status: 'PAYOUT_FAILED', payoutAmount: amount, failureReason: `PAYOUT_ERROR: ${result.error}` },
    { new: true }
  );
  logger[result.success ? 'info' : 'error']('Storefront: payout', {
    merchant: merchant.slug, reference: updated.reference, asset: updated.asset, amount, network: updated.network, ok: result.success, error: result.error,
  });
  notify(merchant, result.success ? 'buy.payout_submitted' : 'buy.failed', updated);
  return true;
}

/** The trader approves a held payment: the crypto is sent now. */
async function approve(merchant, ref) {
  const order = await findOrder(merchant, ref);
  if (!order) throw new StorefrontError('Order not found.', 404);
  if (order.status !== 'HELD_REVIEW' && order.status !== 'HELD_DELAY') {
    throw new StorefrontError(`Only held orders can be approved; this one is ${order.status}.`, 409);
  }
  await StorefrontOrder.updateOne({ _id: order._id }, { decidedBy: 'TRADER' });
  await payout(merchant, order._id);
  return StorefrontOrder.findById(order._id);
}

/**
 * The trader rejects a held payment. The money goes back to the account it
 * came from — never anywhere else. Refunds are manual for now (ops), so this
 * only marks the order.
 */
async function reject(merchant, ref, reason) {
  const order = await findOrder(merchant, ref);
  if (!order) throw new StorefrontError('Order not found.', 404);
  const rejected = await StorefrontOrder.findOneAndUpdate(
    { _id: order._id, status: { $in: ['HELD_REVIEW', 'HELD_DELAY'] } },
    { status: 'REJECTED', decidedBy: 'TRADER', failureReason: `REJECTED_BY_TRADER: ${String(reason || 'no reason given').slice(0, 200)} — refund to payer` },
    { new: true }
  );
  if (!rejected) throw new StorefrontError(`Only held orders can be rejected; this one is ${order.status}.`, 409);
  logger.warn('Storefront: payment rejected by trader, needs refund', {
    merchant: merchant.slug, reference: rejected.reference, receivedNgn: rejected.receivedNgn, payer: rejected.receivedPayerName,
  });
  notify(merchant, 'buy.rejected', rejected);
  return rejected;
}

/** Job: send delayed payouts whose releaseAt has passed. */
async function releaseDelayed() {
  const due = await StorefrontOrder.find({ status: 'HELD_DELAY', releaseAt: { $lte: new Date() } }).limit(100);
  for (const order of due) {
    const merchant = await StorefrontMerchant.findById(order.merchantId);
    // A trader paused in the meantime (a recall, say) keeps it held for review.
    if (merchant.status !== 'active') {
      const held = await StorefrontOrder.findOneAndUpdate({ _id: order._id, status: 'HELD_DELAY' }, { status: 'HELD_REVIEW' }, { new: true });
      if (held) notify(merchant, 'buy.held_review', held);
      continue;
    }
    await payout(merchant, order._id);
  }
  return due.length;
}

/**
 * From routes/obiexwebhooktrx.js for WITHDRAWAL events that don't match a
 * Bramp user's transaction. Returns true if it was a storefront payout.
 */
async function handleObiexWithdrawal({ transactionId, status, hash }) {
  const order = await StorefrontOrder.findOne({ obiexWithdrawalId: transactionId });
  if (!order) return false;
  const merchant = await StorefrontMerchant.findById(order.merchantId);

  const s = String(status || '').toUpperCase();
  if (s === 'SUCCESSFUL' || s === 'CONFIRMED' || s === 'COMPLETED') {
    const done = await StorefrontOrder.findOneAndUpdate(
      { _id: order._id, status: 'PAYOUT_SUBMITTED' },
      { status: 'COMPLETED', payoutTxHash: hash || null, completedAt: new Date() },
      { new: true }
    );
    if (done) {
      await ledger.creditMargin(merchant, done, done.marginNgn);
      notify(merchant, 'buy.completed', done);
    }
  } else if (s === 'FAILED' || s === 'REJECTED' || s === 'CANCELLED') {
    const failed = await StorefrontOrder.findOneAndUpdate(
      { _id: order._id, status: 'PAYOUT_SUBMITTED' },
      { status: 'PAYOUT_FAILED', failureReason: `OBIEX_${s}: needs manual review` },
      { new: true }
    );
    if (failed) notify(merchant, 'buy.failed', failed);
  }
  return true;
}

module.exports = {
  ASSETS, networks, quote, createOrder, findOrder, listOrders, serializeOrder,
  handleGlydeEvent, approve, reject, releaseDelayed, handleObiexWithdrawal, StorefrontError,
};
