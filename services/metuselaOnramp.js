// services/metuselaOnramp.js
// Naira → USDC on-ramp for Metusela (partner API: routes/metusela.js).
//
//   1. quote()        — Bramp's on-ramp rate (₦ per $1, admin-set, see
//                       services/onramppriceservice.js) minus Metusela's fee.
//   2. createOrder()  — locks the rate and issues a dynamic Glyde virtual
//                       account for the exact Naira amount.
//   3. handleGlydeCollection() — called from the Glyde collection webhook
//                       when money lands on one of these accounts: converts
//                       what was paid and sends USDC from Bramp's Obiex
//                       treasury to the user's own wallet.
//   4. handleObiexWithdrawal() — called from the Obiex transaction webhook
//                       when that USDC payout settles (or fails).
// Every state change is pushed to Metusela's webhook, signed.
const crypto = require('crypto');
const MetuselaOnrampOrder = require('../models/metuselaOnrampOrder');
const { createVirtualAccount, deactivateVirtualAccount } = require('./collectionService');
const { getOnrampRate } = require('./onramppriceservice');
const { withdrawUSDC } = require('./ObiexWithdraw');
const { getAvailableNetworks } = require('./networkService');
const { notifyMetusela } = require('./metuselaNotify');
const { normalizeNetwork } = require('./metuselaNetworks');
const logger = require('../utils/logger');

const cfg = () => ({
  feeBps: Number(process.env.METUSELA_ONRAMP_FEE_BPS || 0),
  minNgn: Number(process.env.METUSELA_ONRAMP_MIN_NGN || 1000),
  maxNgn: Number(process.env.METUSELA_ONRAMP_MAX_NGN || 5000000),
  ttlMinutes: Number(process.env.METUSELA_ORDER_TTL_MINUTES || 30),
  // Networks we're willing to pay out USDC on, in order of preference.
  // Metusela sends its users' Polymarket bridge addresses, which accept
  // USDC on Polygon and Arbitrum (among others) and credit pUSD on Polygon.
  // Polygon first: same chain as Polymarket, lowest fees. Arbitrum is the
  // fallback if Obiex isn't offering USDC on Polygon at the time.
  // Obiex codes (POLYGON is accepted and mapped to Obiex's MATIC).
  networks: (process.env.METUSELA_PAYOUT_NETWORKS || 'MATIC,ARBITRUM').split(',').map(normalizeNetwork).filter(Boolean),
});

class OnrampError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const floor2 = (n) => Math.floor(n * 100) / 100;

// ── Networks ───────────────────────────────────────────────────────────────

let networkCache = { at: 0, list: null };

/**
 * Configured payout networks that Obiex currently supports for USDC.
 * Cached 10 minutes. If Obiex can't be reached we fall back to the
 * configured list — a bad network then fails loudly at payout instead.
 */
async function payoutNetworks() {
  const configured = cfg().networks;
  if (networkCache.list && Date.now() - networkCache.at < 10 * 60 * 1000) return networkCache.list;
  try {
    const live = (await getAvailableNetworks('USDC')).map(normalizeNetwork);
    const list = configured.filter((n) => live.includes(n));
    networkCache = { at: Date.now(), list };
    if (list.length < configured.length) {
      logger.warn('Metusela on-ramp: some configured payout networks are not supported by Obiex for USDC', { configured, live });
    }
    return list;
  } catch (err) {
    logger.warn('Metusela on-ramp: could not fetch Obiex USDC networks, using configured list', { error: err.message });
    return configured;
  }
}

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function validAddress(network, address) {
  return network === 'SOLANA' ? SOLANA_ADDRESS.test(address) : EVM_ADDRESS.test(address);
}

// ── Quote ──────────────────────────────────────────────────────────────────

async function quote(amountNgnRaw) {
  const { feeBps, minNgn, maxNgn } = cfg();
  const amountNgn = Number(amountNgnRaw);
  if (!Number.isFinite(amountNgn) || amountNgn < minNgn || amountNgn > maxNgn) {
    throw new OnrampError(`amountNgn must be between ${minNgn} and ${maxNgn}.`);
  }
  let rate;
  try {
    rate = (await getOnrampRate()).finalPrice;
  } catch (err) {
    throw new OnrampError('On-ramp rate is not available right now.', 503);
  }
  if (!Number.isFinite(rate) || rate <= 0) throw new OnrampError('On-ramp rate is not available right now.', 503);

  const usdc = floor2((amountNgn / rate) * (1 - feeBps / 10000));
  return { amountNgn, ngnPerUsdc: rate, feeBps, usdc, minNgn, maxNgn };
}

// ── Orders ─────────────────────────────────────────────────────────────────

function serializeOrder(o) {
  return {
    reference: o.reference,
    partnerReference: o.partnerReference,
    partnerUserId: o.partnerUserId,
    status: o.status,
    amountNgn: o.amountNgn,
    ngnPerUsdc: o.ngnPerUsdc,
    feeBps: o.feeBps,
    quotedUsdc: o.quotedUsdc,
    destination: o.destination,
    bankTransfer: o.virtualAccount?.accountNumber ? {
      accountNumber: o.virtualAccount.accountNumber,
      accountName: o.virtualAccount.accountName,
      bankName: o.virtualAccount.bankName,
      amountNgn: o.amountNgn,
    } : null,
    expiresAt: o.expiresAt,
    receivedNgn: o.receivedNgn,
    paidAt: o.paidAt,
    payoutUsdc: o.payoutUsdc,
    payoutTxHash: o.payoutTxHash,
    completedAt: o.completedAt,
    failureReason: o.failureReason,
    createdAt: o.createdAt,
  };
}

/**
 * Create an order (idempotent on partnerReference: the same reference
 * returns the existing order). Issues a dynamic Glyde virtual account for
 * the exact amount; the rate is locked until expiresAt.
 */
async function createOrder({ partnerReference, partnerUserId, amountNgn, customer, destination }) {
  if (!partnerReference || !partnerUserId) throw new OnrampError('partnerReference and partnerUserId are required.');
  const existing = await MetuselaOnrampOrder.findOne({ partnerReference });
  if (existing) return { order: existing, created: false };

  if (!customer?.firstName || !customer?.lastName || !customer?.email) {
    throw new OnrampError('customer.firstName, customer.lastName and customer.email are required.');
  }
  const network = normalizeNetwork(destination?.network);
  const address = String(destination?.address || '').trim();
  const networks = await payoutNetworks();
  if (!networks.includes(network)) throw new OnrampError(`destination.network must be one of: ${networks.join(', ') || 'none available'}.`);
  if (!validAddress(network, address)) throw new OnrampError('destination.address is not a valid address for that network.');

  const q = await quote(amountNgn);
  if (q.usdc < 1) throw new OnrampError('That amount converts to less than 1 USDC.');

  const reference = `mts-onramp-${crypto.randomBytes(8).toString('hex')}`;
  const va = await createVirtualAccount({
    type: 'dynamic',
    customer: { reference, first_name: customer.firstName, last_name: customer.lastName, email: customer.email },
    expectedAmount: q.amountNgn,
  });
  if (!va.success) {
    throw new OnrampError(`Could not issue a bank account: ${va.message}`, va.statusCode >= 500 ? 502 : 400);
  }
  const d = va.data;
  const ttlExpiry = new Date(Date.now() + cfg().ttlMinutes * 60 * 1000);
  const glydeExpiry = d.expires_at ? new Date(d.expires_at) : null;

  const order = await MetuselaOnrampOrder.create({
    reference,
    partnerReference,
    partnerUserId,
    customer: { firstName: customer.firstName, lastName: customer.lastName, email: customer.email },
    amountNgn: q.amountNgn,
    ngnPerUsdc: q.ngnPerUsdc,
    feeBps: q.feeBps,
    quotedUsdc: q.usdc,
    destination: { network, address },
    virtualAccount: { uid: d.uid, accountNumber: d.account_number, accountName: d.account_name, bankName: d.bank_name || d.bank?.name || null },
    // Whichever comes first: our rate-lock window or Glyde's own expiry.
    expiresAt: glydeExpiry && glydeExpiry < ttlExpiry ? glydeExpiry : ttlExpiry,
  });
  logger.info('Metusela on-ramp order created', { reference, partnerReference, amountNgn: q.amountNgn, network });
  return { order, created: true };
}

async function findOrder(ref) {
  const order = await MetuselaOnrampOrder.findOne({ $or: [{ reference: ref }, { partnerReference: ref }] });
  if (!order) return null;
  // Lazy expiry: an unpaid order past its window can't be paid any more.
  if (order.status === 'AWAITING_PAYMENT' && order.expiresAt <= new Date()) {
    const expired = await MetuselaOnrampOrder.findOneAndUpdate(
      { _id: order._id, status: 'AWAITING_PAYMENT' }, { status: 'EXPIRED' }, { new: true }
    );
    if (expired) {
      if (expired.virtualAccount?.uid) deactivateVirtualAccount(expired.virtualAccount.uid).catch(() => {});
      notify('onramp.expired', expired);
      return expired;
    }
  }
  return order;
}

// ── Webhook to Metusela ────────────────────────────────────────────────────

// Push a status change to Metusela (signed; see services/metuselaNotify.js)
// and remember how the delivery went, for debugging.
async function notify(event, order) {
  const { ok, error } = await notifyMetusela(event, serializeOrder(order));
  await MetuselaOnrampOrder.updateOne({ _id: order._id }, { lastNotify: { event, ok, at: new Date(), error } });
}

// ── Payment in (Glyde) → USDC out (Obiex) ──────────────────────────────────

/**
 * From routes/nairawebhook.js /glyde/collection, for payments whose
 * merchant_reference isn't a Bramp user's virtual account. Returns true if
 * it was a Metusela order (handled or already processed), false otherwise.
 */
async function handleGlydeCollection({ event, merchantReference, glydeReference, amount }) {
  const order = await MetuselaOnrampOrder.findOne({ reference: merchantReference });
  if (!order) return false;

  if (event === 'collection.failed') {
    logger.info('Metusela on-ramp: Glyde reported a failed payment', { reference: order.reference, glydeReference });
    return true;
  }

  const receivedNgn = Number(amount);
  // Claim the payment once (Glyde retries webhooks). Late payments on an
  // expired order are still honoured — at today's rate, not the locked one.
  const late = order.status === 'EXPIRED';
  const claimed = await MetuselaOnrampOrder.findOneAndUpdate(
    { _id: order._id, status: { $in: ['AWAITING_PAYMENT', 'EXPIRED'] }, glydeReference: null },
    { status: 'PAYMENT_RECEIVED', receivedNgn, glydeReference, paidAt: new Date() },
    { new: true }
  );
  if (!claimed) {
    logger.info('Metusela on-ramp: payment already processed', { reference: order.reference, glydeReference });
    return true;
  }
  notify('onramp.payment_received', claimed);
  if (claimed.virtualAccount?.uid) deactivateVirtualAccount(claimed.virtualAccount.uid).catch(() => {});

  // Convert what was actually paid (over/under-payments included).
  let rate = claimed.ngnPerUsdc;
  if (late) {
    try { rate = (await getOnrampRate()).finalPrice; } catch { /* keep the locked rate */ }
  }
  const payoutUsdc = floor2((receivedNgn / rate) * (1 - claimed.feeBps / 10000));

  if (payoutUsdc < 1) {
    const failed = await MetuselaOnrampOrder.findOneAndUpdate(
      { _id: claimed._id }, { status: 'PAYOUT_FAILED', payoutUsdc, failureReason: 'AMOUNT_TOO_LOW: needs manual refund' }, { new: true }
    );
    notify('onramp.failed', failed);
    return true;
  }

  const result = await withdrawUSDC(claimed.destination.address, payoutUsdc, claimed.destination.network, `Metusela ${claimed.reference.slice(-8)}`);
  const updated = await MetuselaOnrampOrder.findOneAndUpdate(
    { _id: claimed._id },
    result.success
      ? { status: 'PAYOUT_SUBMITTED', payoutUsdc, ngnPerUsdc: rate, obiexWithdrawalId: result.transactionId, payoutSubmittedAt: new Date() }
      : { status: 'PAYOUT_FAILED', payoutUsdc, failureReason: `PAYOUT_ERROR: ${result.error}` },
    { new: true }
  );
  logger[result.success ? 'info' : 'error']('Metusela on-ramp: USDC payout', {
    reference: updated.reference, payoutUsdc, network: updated.destination.network, ok: result.success, error: result.error,
  });
  notify(result.success ? 'onramp.payout_submitted' : 'onramp.failed', updated);
  return true;
}

/**
 * From routes/obiexwebhooktrx.js for WITHDRAWAL events that don't match a
 * Bramp user's transaction. Returns true if it was a Metusela payout.
 */
async function handleObiexWithdrawal({ transactionId, status, hash }) {
  const order = await MetuselaOnrampOrder.findOne({ obiexWithdrawalId: transactionId });
  if (!order) return false;

  const s = String(status || '').toUpperCase();
  if (s === 'SUCCESSFUL' || s === 'CONFIRMED' || s === 'COMPLETED') {
    const done = await MetuselaOnrampOrder.findOneAndUpdate(
      { _id: order._id, status: 'PAYOUT_SUBMITTED' },
      { status: 'COMPLETED', payoutTxHash: hash || null, completedAt: new Date() },
      { new: true }
    );
    if (done) notify('onramp.completed', done);
  } else if (s === 'FAILED' || s === 'REJECTED' || s === 'CANCELLED') {
    const failed = await MetuselaOnrampOrder.findOneAndUpdate(
      { _id: order._id, status: 'PAYOUT_SUBMITTED' },
      { status: 'PAYOUT_FAILED', failureReason: `OBIEX_${s}: needs manual review` },
      { new: true }
    );
    if (failed) notify('onramp.failed', failed);
  }
  return true;
}

module.exports = {
  quote, createOrder, findOrder, serializeOrder, payoutNetworks,
  handleGlydeCollection, handleObiexWithdrawal, OnrampError,
};
