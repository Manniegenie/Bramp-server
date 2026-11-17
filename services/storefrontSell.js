// services/storefrontSell.js
// Storefront offramp (spec, 17 Nov 2026): a desk's customer sells crypto on
// Stella and is paid naira in their bank account. Phase 1 is Bramp rate mode:
// the customer gets Bramp's sell rate minus the desk's markdown, Bramp sells
// the coin for NGNX on Obiex and pays the customer, and the desk earns the
// markdown in its NGNB balance.
//
// Deposit matching: every customer gets their own address at each desk, per
// coin and network, created only when they ask to sell that coin. A deposit's
// address alone says which desk and customer it is.
const crypto = require('crypto');
const User = require('../models/user');
const StorefrontCustomer = require('../models/storefrontCustomer');
const StorefrontDepositAddress = require('../models/storefrontDepositAddress');
const StorefrontSellOrder = require('../models/storefrontSellOrder');
const StorefrontMerchant = require('../models/storefrontMerchant');
const obiexAddresses = require('./createwalletaddress');
const { swapCryptoToNGNX } = require('./ObiexSwap');
const { debitNaira } = require('./nairaWithdrawal');
const banks = require('./storefrontBanks');
const { notifyTrader } = require('./storefrontTraderNotify');
const logger = require('../utils/logger');

// Coins and networks a customer can sell, by Obiex network code.
const PAIRS = {
  USDT: ['TRX', 'BSC', 'ETH'],
  USDC: ['BSC', 'ETH'],
};
const NETWORK_NAMES = { TRX: 'Tron (TRC20)', BSC: 'BNB Smart Chain (BEP20)', ETH: 'Ethereum (ERC20)' };
const NETWORK_ALIASES = {
  TRX: 'TRX', TRON: 'TRX', TRC20: 'TRX',
  BSC: 'BSC', BEP20: 'BSC', BNB: 'BSC', 'BNB SMART CHAIN': 'BSC', BINANCE: 'BSC',
  ETH: 'ETH', ERC20: 'ETH', ETHEREUM: 'ETH',
};

const cfg = () => ({
  maxMarkdownNgnPerUsd: Number(process.env.STOREFRONT_MAX_MARKDOWN_NGN_PER_USD || 100),
  stuckMinutes: Number(process.env.STOREFRONT_SELL_STUCK_MINUTES || 10),
});

class StorefrontSellError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const floor2 = (n) => Math.floor(n * 100) / 100;
const round2 = (n) => Math.round(n * 100) / 100;
const maskAcct = (n) => `••${String(n || '').slice(-4)}`;

function normalizeCoin(coin) {
  const c = String(coin || '').trim().toUpperCase();
  if (!PAIRS[c]) throw new StorefrontSellError(`${coin || 'That coin'} can't be sold here. Coins: ${Object.keys(PAIRS).join(', ')}.`);
  return c;
}

function normalizeNetwork(coin, network) {
  const n = NETWORK_ALIASES[String(network || '').trim().toUpperCase()];
  if (!n || !PAIRS[coin].includes(n)) {
    throw new StorefrontSellError(`${coin} can be sent on: ${PAIRS[coin].map((x) => NETWORK_NAMES[x]).join(', ')}.`);
  }
  return n;
}

/** Coins and networks on sale, for Stella. */
function sellable() {
  return Object.entries(PAIRS).map(([coin, nets]) => ({ coin, networks: nets.map((code) => ({ code, name: NETWORK_NAMES[code] })) }));
}

// ── Customer records ───────────────────────────────────────────────────────

/** The desk's record for this WhatsApp number, created on first contact; refreshes lastSeenAt. */
async function touchCustomer(merchant, waId, displayName) {
  const set = { lastSeenAt: new Date() };
  if (displayName) set.displayName = String(displayName).slice(0, 100);
  return StorefrontCustomer.findOneAndUpdate(
    { merchantId: merchant._id, waId },
    { $set: set, $setOnInsert: { merchantId: merchant._id, waId, firstSeenAt: new Date() } },
    { upsert: true, new: true }
  );
}

// ── Rates ──────────────────────────────────────────────────────────────────

/** The rate this desk pays now for one coin. */
async function rateFor(merchant, coin) {
  if (merchant.status !== 'active') throw new StorefrontSellError('This desk is not taking trades right now.', 409);
  if (merchant.rateMode === 'SELF') throw new StorefrontSellError('This desk is not taking trades right now.', 409); // Phase 2
  if (merchant.rateMode !== 'BRAMP') throw new StorefrontSellError('This desk has not set its rate yet.', 409);

  // Bramp's own sell rate, the one the app uses (routes/sell.js).
  const { getSellQuote } = require('../routes/sell');
  const q = await getSellQuote({ token: coin, amount: 0 });
  const brampNgnPerUsd = Number(q.breakdown?.ngnPerUsdEffective);
  const usdPerCoin = Number(q.breakdown?.usdPerToken);
  if (!(brampNgnPerUsd > 0) || !(usdPerCoin > 0)) throw new StorefrontSellError('Rates are not available right now.', 503);

  const markdownNgnPerUsd = Math.max(0, Number(merchant.markdownNgnPerUsd) || 0);
  const ngnPerUsd = brampNgnPerUsd - markdownNgnPerUsd;
  if (!(ngnPerUsd > 0)) throw new StorefrontSellError('This desk is not taking trades right now.', 409);
  return {
    rateMode: 'BRAMP',
    brampNgnPerUsd,
    markdownNgnPerUsd,
    ngnPerUsd,
    usdPerCoin,
    ngnPerCoin: floor2(usdPerCoin * ngnPerUsd),
  };
}

// ── Addresses ──────────────────────────────────────────────────────────────

/** This customer's address at this desk for a coin and network, created on first request. */
async function addressFor(merchant, customer, coin, network) {
  const existing = await StorefrontDepositAddress.findOne({ customerId: customer._id, coin, network });
  if (existing) return existing;

  // Obiex purpose: letters, digits and dashes.
  const purpose = `sf-${customer._id}-${coin}-${network}`.toLowerCase();
  let data;
  try {
    data = await obiexAddresses.createDepositAddress({ purpose, currency: coin, network });
  } catch (err) {
    throw new StorefrontSellError(`A ${coin} address is not available right now. Please try again shortly.`, 503);
  }
  const address = data?.value || data?.address;
  if (!address) throw new StorefrontSellError(`A ${coin} address is not available right now. Please try again shortly.`, 503);

  try {
    const doc = await StorefrontDepositAddress.create({
      address, coin, network, memo: data?.memo || null, merchantId: merchant._id, customerId: customer._id, waId: customer.waId,
    });
    await StorefrontCustomer.updateOne(
      { _id: customer._id, addresses: { $not: { $elemMatch: { coin, network } } } },
      { $push: { addresses: { coin, network, address, memo: doc.memo } } }
    );
    return doc;
  } catch (err) {
    if (err.code === 11000) { // another request created it first
      const again = await StorefrontDepositAddress.findOne({ customerId: customer._id, coin, network });
      if (again) return again;
    }
    throw err;
  }
}

// ── Sale ───────────────────────────────────────────────────────────────────

const newReference = () => `SFS-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

function quoteFields(rate, now = new Date()) {
  return {
    ngnPerUsd: rate.ngnPerUsd,
    brampNgnPerUsd: rate.brampNgnPerUsd,
    markdownNgnPerUsd: rate.markdownNgnPerUsd,
    usdPerCoin: rate.usdPerCoin,
    ngnPerCoin: rate.ngnPerCoin,
    quotedAt: now,
  };
}

function savedAccounts(customer) {
  return [...(customer.accounts || [])]
    .sort((a, b) => new Date(b.lastUsedAt) - new Date(a.lastUsedAt))
    .map((a) => ({ accountId: String(a._id), bankName: a.bankName, account: maskAcct(a.accountNumber), accountName: a.accountName }));
}

/**
 * The customer wants to sell a coin: their address, the network and the
 * desk's live rate (a guide: the sale settles at the live rate when the
 * deposit confirms). Reuses an open sale for the same
 * coin and network rather than starting another.
 */
async function startSale(merchant, customer, { coin: coinRaw, network: networkRaw }) {
  const coin = normalizeCoin(coinRaw);
  const network = normalizeNetwork(coin, networkRaw);
  const rate = await rateFor(merchant, coin);
  const addr = await addressFor(merchant, customer, coin, network);
  const quote = quoteFields(rate);

  let order = await StorefrontSellOrder.findOneAndUpdate(
    { customerId: customer._id, coin, network, status: 'AWAITING_DEPOSIT' },
    { $set: { quote } },
    { new: true, sort: { createdAt: -1 } }
  );
  if (!order) {
    order = await StorefrontSellOrder.create({
      reference: newReference(), merchantId: merchant._id, customerId: customer._id, waId: customer.waId,
      coin, network, address: addr.address, rateMode: rate.rateMode, quote,
    });
    await StorefrontCustomer.updateOne({ _id: customer._id }, { $inc: { 'stats.trades': 1 } });
  }

  return {
    reference: order.reference,
    coin,
    network: NETWORK_NAMES[network],
    address: addr.address,
    memo: addr.memo || null,
    ngnPerCoin: rate.ngnPerCoin,
    rateIsLive: true, // paid at the desk's live rate when the deposit confirms
    payoutAccount: order.payoutAccount?.accountNumber
      ? { bankName: order.payoutAccount.bankName, account: maskAcct(order.payoutAccount.accountNumber), accountName: order.payoutAccount.accountName }
      : null,
    savedAccounts: savedAccounts(customer),
  };
}

// ── Payout accounts ────────────────────────────────────────────────────────

/** Look up a bank account's name without saving it, so Stella can read it back for the customer to confirm. */
async function checkAccount({ bank, accountNumber }) {
  const number = String(accountNumber || '').replace(/\D/g, '');
  if (number.length !== 10) throw new StorefrontSellError('A Nigerian account number has 10 digits.');
  const matches = await banks.findBanks(bank);
  if (!matches.length) throw new StorefrontSellError(`I couldn't find a bank called "${String(bank).slice(0, 40)}".`);
  if (matches.length > 1 && !/^\d+$/.test(String(bank))) {
    const exact = matches.filter((m) => m.name.toLowerCase() === String(bank).trim().toLowerCase());
    if (exact.length !== 1) return { needsBankChoice: true, banks: matches.map((m) => ({ bankName: m.name, bankCode: m.code })) };
  }
  const chosen = matches[0];
  const accountName = await banks.resolveAccount(chosen.code, number);
  if (!accountName) throw new StorefrontSellError(`No account ${number} at ${chosen.name}. Please check the number and bank.`);
  return { bankName: chosen.name, bankCode: chosen.code, accountNumber: number, accountName };
}

/**
 * Pay this customer's sales to an account: a saved one (accountId) or a new
 * one (bankCode + accountNumber, name looked up again here - never taken from
 * the chat). Saves it (at most 3 per desk, least recently used dropped) and
 * attaches it to their open sales; a sale already waiting for an account
 * goes ahead.
 */
async function useAccount(merchant, customer, { accountId, bankCode, accountNumber }) {
  const fresh = await StorefrontCustomer.findById(customer._id);
  let account;
  if (accountId) {
    account = fresh.accounts.id(accountId);
    if (!account) throw new StorefrontSellError('That saved account was not found.');
  } else {
    const number = String(accountNumber || '').replace(/\D/g, '');
    const accountName = await banks.resolveAccount(bankCode, number);
    if (!accountName) throw new StorefrontSellError('That account could not be verified.');
    const bank = (await banks.listBanks()).find((b) => b.code === String(bankCode));
    account = fresh.accounts.find((a) => a.accountNumber === number && a.bankCode === String(bankCode));
    if (!account) {
      fresh.accounts.push({ accountNumber: number, bankCode: String(bankCode), bankName: bank?.name || 'Bank', accountName });
      account = fresh.accounts[fresh.accounts.length - 1];
    }
  }
  account.lastUsedAt = new Date();
  const max = StorefrontCustomer.LIMITS.MAX_ACCOUNTS;
  if (fresh.accounts.length > max) {
    fresh.accounts.sort((a, b) => new Date(b.lastUsedAt) - new Date(a.lastUsedAt));
    fresh.accounts.splice(max);
  }
  await fresh.save();

  const payoutAccount = { accountNumber: account.accountNumber, bankCode: account.bankCode, bankName: account.bankName, accountName: account.accountName };
  await StorefrontSellOrder.updateMany(
    { customerId: customer._id, status: { $in: ['AWAITING_DEPOSIT', 'AWAITING_ACCOUNT'] } },
    { $set: { payoutAccount } }
  );
  const waiting = await StorefrontSellOrder.find({ customerId: customer._id, status: 'AWAITING_ACCOUNT' });
  for (const o of waiting) settleInBackground(o._id);

  return { bankName: account.bankName, account: maskAcct(account.accountNumber), accountName: account.accountName, salesGoingAhead: waiting.length };
}

// ── Deposits (Obiex webhook) ───────────────────────────────────────────────

/**
 * Called from both Obiex webhooks for a deposit to an address that isn't a
 * Bramp user's. Returns true if the address is a storefront one (handled, or
 * nothing to do yet), false otherwise. Acts only on CONFIRMED, once per
 * Obiex transaction id; the sale and payout then run in the background.
 */
async function handleObiexDeposit({ address, currency, amount, status, transactionId, hash }) {
  const addr = await StorefrontDepositAddress.findOne({ address });
  if (!addr) return false;
  if (String(status).toUpperCase() !== 'CONFIRMED') return true;

  const amt = Number(amount);
  if (!transactionId || !(amt > 0)) {
    logger.warn('Storefront sell: deposit without id or amount', { address, transactionId, amount });
    return true;
  }
  if (await StorefrontSellOrder.exists({ 'deposit.transactionId': String(transactionId) })) return true; // retry

  const coin = String(currency || addr.coin).toUpperCase();
  if (coin !== addr.coin) logger.warn('Storefront sell: deposit currency differs from address', { address, coin, expected: addr.coin });
  const deposit = { transactionId: String(transactionId), hash: hash || null, amount: amt, confirmedAt: new Date() };

  // The customer's open sale for this address, else a new one at today's rate.
  let order = await StorefrontSellOrder.findOneAndUpdate(
    { customerId: addr.customerId, coin: addr.coin, network: addr.network, status: 'AWAITING_DEPOSIT', 'deposit.transactionId': null },
    { $set: { deposit } },
    { new: true, sort: { createdAt: 1 } }
  ).catch((err) => { if (err.code === 11000) return 'DUPLICATE'; throw err; });
  if (order === 'DUPLICATE') return true;

  const merchant = await StorefrontMerchant.findById(addr.merchantId);
  if (!order) {
    const customer = await StorefrontCustomer.findById(addr.customerId);
    const last = customer?.accounts?.length ? [...customer.accounts].sort((a, b) => new Date(b.lastUsedAt) - new Date(a.lastUsedAt))[0] : null;
    let quote;
    try {
      quote = quoteFields(await rateFor(merchant, addr.coin));
    } catch (err) {
      quote = { ngnPerCoin: 0, quotedAt: new Date() }; // desk paused/unpriced: ops decides
    }
    try {
      order = await StorefrontSellOrder.create({
        reference: newReference(), merchantId: addr.merchantId, customerId: addr.customerId, waId: addr.waId,
        coin: addr.coin, network: addr.network, address: addr.address, rateMode: merchant?.rateMode || 'BRAMP', quote, deposit, openedByDeposit: true,
        // A repeat sale to a saved address goes to the account they used last.
        payoutAccount: last ? { accountNumber: last.accountNumber, bankCode: last.bankCode, bankName: last.bankName, accountName: last.accountName } : undefined,
      });
    } catch (err) {
      if (err.code === 11000) return true;
      throw err;
    }
    await StorefrontCustomer.updateOne({ _id: addr.customerId }, { $inc: { 'stats.trades': 1 } });
  }

  logger.info('Storefront sell: deposit confirmed', { reference: order.reference, coin: order.coin, amount: amt });
  if (merchant) notifyTrader(merchant, 'deposit_confirmed', order).catch(() => {});

  if (!order.payoutAccount?.accountNumber) {
    await StorefrontSellOrder.updateOne({ _id: order._id }, { $set: { status: 'AWAITING_ACCOUNT' } });
    tellCustomer(order.waId, `I've received your *${amt} ${order.coin}* ✅ Where should I pay you? Send your bank and 10-digit account number.`);
    return true;
  }
  settleInBackground(order._id);
  return true;
}

// ── Settlement ─────────────────────────────────────────────────────────────

function tellCustomer(waId, text) {
  require('../AI/stellaSender').sendText(waId, text).catch((err) =>
    logger.warn('Storefront sell: customer message failed', { error: err.message }));
}

function settleInBackground(orderId) {
  setImmediate(() => settle(orderId).catch((err) =>
    logger.error('Storefront sell: settle failed', { orderId: String(orderId), error: err.message, stack: err.stack })));
}

async function review(order, reason, merchant) {
  await StorefrontSellOrder.updateOne({ _id: order._id }, { $set: { status: 'NEEDS_REVIEW', reviewReason: String(reason).slice(0, 300) } });
  logger.error('Storefront sell: needs review', { reference: order.reference, reason });
  const fresh = await StorefrontSellOrder.findById(order._id);
  if (merchant) notifyTrader(merchant, 'needs_review', fresh).catch(() => {});
  tellCustomer(order.waId, `Your sale *${order.reference}* needs a quick check by our team. Your money is safe, and we'll message you once it's done.`);
}

/** Work out the naira at the rate that applies, then sell the coin and pay the customer. */
async function settle(orderId) {
  // Claim: only one settle per order, and only once it has a deposit and an account.
  const order = await StorefrontSellOrder.findOneAndUpdate(
    { _id: orderId, status: { $in: ['AWAITING_DEPOSIT', 'AWAITING_ACCOUNT'] }, 'deposit.transactionId': { $type: 'string' }, 'payoutAccount.accountNumber': { $type: 'string' } },
    { $set: { status: 'SELLING' } },
    { new: true }
  );
  if (!order) return;
  const merchant = await StorefrontMerchant.findById(order.merchantId);
  if (!merchant) return review(order, 'Desk not found', null);

  // Always the live rate, at settlement (never a quote from earlier).
  let live;
  try {
    live = await rateFor(merchant, order.coin);
  } catch (err) {
    return review(order, `No rate at settlement: ${err.message}`, merchant);
  }
  const { ngnPerCoin, usdPerCoin, markdownNgnPerUsd: markdown } = live;
  const rateAt = new Date();
  const amount = order.deposit.amount;
  const customerNgn = floor2(amount * ngnPerCoin);
  const traderEarningNgn = round2(amount * usdPerCoin * markdown);
  await StorefrontSellOrder.updateOne({ _id: order._id }, { $set: { settlement: { ngnPerCoin, rateAt, customerNgn, traderEarningNgn, feeNgn: 0 } } });

  // Desk limits are a risk check: over them, a person decides.
  if (merchant.perTradeMaxNgn > 0 && customerNgn > merchant.perTradeMaxNgn) {
    return review(order, `Over the desk's per-trade limit (${customerNgn} > ${merchant.perTradeMaxNgn})`, merchant);
  }
  if (merchant.dailyMaxNgn > 0) {
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const [{ total = 0 } = {}] = await StorefrontSellOrder.aggregate([
      { $match: { merchantId: merchant._id, status: 'PAID', paidAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: '$settlement.customerNgn' } } },
    ]);
    if (total + customerNgn > merchant.dailyMaxNgn) return review(order, `Over the desk's daily limit (${total + customerNgn} > ${merchant.dailyMaxNgn})`, merchant);
  }

  // 1. Sell the coin for NGNX on Obiex.
  let sale;
  try {
    sale = await swapCryptoToNGNX({ sourceCode: order.coin, amount });
  } catch (err) {
    sale = { success: false, error: err.message };
  }
  if (!sale || sale.success === false) {
    await StorefrontSellOrder.updateOne({ _id: order._id }, { $set: { sale: { ok: false, error: String(sale?.error || sale?.message || 'swap failed').slice(0, 300), at: new Date() } } });
    return review(order, 'Sale on Obiex failed', merchant);
  }
  const idempotencyKey = `sf-sell-${order.reference}`;
  const toPaying = await StorefrontSellOrder.updateOne(
    { _id: order._id, status: 'SELLING' }, // not if it was flagged for review meanwhile
    { $set: { status: 'PAYING', sale: { ok: true, at: new Date() }, 'payout.idempotencyKey': idempotencyKey, 'payout.requestedAt': new Date() } }
  );
  if (!toPaying.modifiedCount) {
    await StorefrontSellOrder.updateOne({ _id: order._id }, { $set: { sale: { ok: true, at: new Date() } } });
    logger.error('Storefront sell: sold but flagged before payout - pay manually', { reference: order.reference });
    return;
  }

  // 2. Pay the customer from NGNX.
  let payout;
  try {
    payout = await debitNaira({
      destination: order.payoutAccount,
      amount: customerNgn,
      currency: 'NGNX',
      narration: `Bramp ${merchant.brandName || merchant.slug}`.slice(0, 40),
    }, { idempotencyKey, userId: String(merchant.userId) });
  } catch (err) {
    payout = { success: false, message: err.message };
  }
  if (!payout?.success) {
    await StorefrontSellOrder.updateOne({ _id: order._id }, { $set: { 'payout.error': String(payout?.message || 'payout failed').slice(0, 300) } });
    return review(order, 'Payout to the customer failed', merchant);
  }

  // 3. Paid: the desk's earning, the customer's totals, everyone told.
  const paidAt = new Date();
  // The money has gone, so PAID is the truth even if the stuck check flagged it meanwhile.
  await StorefrontSellOrder.updateOne({ _id: order._id, status: { $in: ['PAYING', 'NEEDS_REVIEW'] } }, {
    $set: { status: 'PAID', paidAt, reviewReason: null, 'payout.providerId': payout.data?.id || payout.data?.data?.id || null },
  });
  if (traderEarningNgn > 0) {
    await User.updateOne({ _id: merchant.userId }, { $inc: { ngnbBalance: traderEarningNgn }, $set: { lastBalanceUpdate: paidAt } });
  }
  await StorefrontCustomer.updateOne({ _id: order.customerId }, {
    $inc: {
      'stats.completed': 1,
      'stats.volumeNgn': customerNgn,
      [`stats.byCoin.${order.coin}.trades`]: 1,
      [`stats.byCoin.${order.coin}.amount`]: amount,
      [`stats.byCoin.${order.coin}.volumeNgn`]: customerNgn,
    },
    $set: { lastTradeAt: paidAt },
  });

  const paid = await StorefrontSellOrder.findById(order._id);
  logger.info('Storefront sell: paid', { reference: order.reference, customerNgn, traderEarningNgn, ngnPerCoin });
  notifyTrader(merchant, 'paid', paid).catch(() => {});
  const naira = `₦${customerNgn.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const rateText = `₦${ngnPerCoin.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} per ${order.coin}`;
  tellCustomer(order.waId, `Received *${amount} ${order.coin}* ✅ *${naira}* (${rateText}) is on its way to ${order.payoutAccount.bankName} ${maskAcct(order.payoutAccount.accountNumber)}. Ref ${order.reference}.`);
}

/** Every minute: a sale stuck mid-way (e.g. the server restarted) goes to people, never retried blind. */
async function flagStuck() {
  const before = new Date(Date.now() - cfg().stuckMinutes * 60 * 1000);
  const stuck = await StorefrontSellOrder.find({ status: { $in: ['SELLING', 'PAYING'] }, updatedAt: { $lt: before } }).limit(50);
  for (const o of stuck) {
    const merchant = await StorefrontMerchant.findById(o.merchantId);
    await review(o, `Stuck in ${o.status} - check Obiex before retrying`, merchant);
  }
}

// ── Reads ──────────────────────────────────────────────────────────────────

function serializeSale(o) {
  return {
    reference: o.reference,
    coin: o.coin,
    network: NETWORK_NAMES[o.network] || o.network,
    status: o.status,
    amount: o.deposit?.amount ?? null,
    ngnPerCoin: o.settlement?.ngnPerCoin ?? o.quote?.ngnPerCoin ?? null,
    naira: o.settlement?.customerNgn ?? null,
    payTo: o.payoutAccount?.accountNumber ? `${o.payoutAccount.bankName} ${maskAcct(o.payoutAccount.accountNumber)}` : null,
    createdAt: o.createdAt?.toISOString?.() || null,
    paidAt: o.paidAt ? o.paidAt.toISOString() : null,
  };
}

async function customerSales(customer, { reference } = {}) {
  const q = { customerId: customer._id };
  if (reference) q.reference = String(reference).trim().toUpperCase().slice(0, 32);
  const rows = await StorefrontSellOrder.find(q).sort({ createdAt: -1 }).limit(reference ? 1 : 5);
  return rows.map(serializeSale);
}

module.exports = {
  PAIRS, NETWORK_NAMES, sellable, normalizeCoin, normalizeNetwork,
  touchCustomer, rateFor, addressFor, startSale, checkAccount, useAccount,
  handleObiexDeposit, settle, flagStuck, customerSales, serializeSale,
  StorefrontSellError,
};
