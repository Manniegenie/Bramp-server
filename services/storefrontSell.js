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
const StellaConversation = require('../models/stellaConversation');
const obiexAddresses = require('./createwalletaddress');
const { swapCryptoToNGNX } = require('./ObiexSwap');
const { debitNaira } = require('./nairaWithdrawal');
const banks = require('./storefrontBanks');
const { notifyTrader } = require('./storefrontTraderNotify');
const logger = require('../utils/logger');
const settings = require('./storefrontSettings');
const compliance = require('./storefrontCompliance');

// Coins and networks a customer can sell, by Obiex network code.
// The same coin/network pairs Bramp users have wallets for (utils/generatewallets.js).
const PAIRS = {
  USDT: ['TRX', 'BSC', 'ETH'],
  USDC: ['BSC', 'ETH'],
  BTC: ['BTC'],
  ETH: ['ETH'],
  SOL: ['SOL'],
  BNB: ['BSC'],
};
const NATIVE = { BTC: 'BTC', ETH: 'ETH', SOL: 'SOL', BNB: 'BSC' }; // a coin on its own chain
const NETWORK_NAMES = { TRX: 'Tron (TRC20)', BSC: 'BNB Smart Chain (BEP20)', ETH: 'Ethereum (ERC20)', BTC: 'Bitcoin', SOL: 'Solana' };
const NATIVE_NAMES = { BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', BSC: 'BNB Smart Chain' };
const networkName = (coin, network) => (NATIVE[coin] === network ? NATIVE_NAMES[network] : NETWORK_NAMES[network]) || network;
const NETWORK_ALIASES = {
  TRX: 'TRX', TRON: 'TRX', TRC20: 'TRX',
  BSC: 'BSC', BEP20: 'BSC', BNB: 'BSC', 'BNB SMART CHAIN': 'BSC', BINANCE: 'BSC',
  ETH: 'ETH', ERC20: 'ETH', ETHEREUM: 'ETH',
  BTC: 'BTC', BITCOIN: 'BTC',
  SOL: 'SOL', SOLANA: 'SOL',
};

const cfg = () => ({
  maxMarkdownNgnPerUsd: settings.peek().values.maxMarkdownNgnPerUsd,
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
  // A coin with one network needs no choice (BTC is always Bitcoin).
  if (!String(network || '').trim() && PAIRS[coin].length === 1) return PAIRS[coin][0];
  const n = NETWORK_ALIASES[String(network || '').trim().toUpperCase()];
  if (!n || !PAIRS[coin].includes(n)) {
    throw new StorefrontSellError(`${coin} can be sent on: ${PAIRS[coin].map((x) => networkName(coin, x)).join(', ')}.`);
  }
  return n;
}

/** Coins and networks on sale, for Stella (without any Bramp has switched off). */
function sellable() {
  const off = settings.peek().disabledPairs;
  return Object.entries(PAIRS)
    .map(([coin, nets]) => ({ coin, networks: nets.filter((n) => !off.includes(settings.pairCode(coin, n))).map((code) => ({ code, name: networkName(coin, code) })) }))
    .filter((c) => c.networks.length);
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

/**
 * The rate this desk pays now for one coin. Bramp rate: Bramp's sell rate
 * minus the markdown. Self rate: the trader's own rate, quoted only while
 * their NGNB balance can cover a payout (forSettlement skips that check: an
 * arrived deposit waits for a top-up instead).
 */
/** Bramp's own sell rate for a coin, the one the app uses (routes/sell.js). */
async function brampRate(coin) {
  const { getSellQuote } = require('../routes/sell');
  const q = await getSellQuote({ token: coin, amount: 0 });
  const brampNgnPerUsd = Number(q.breakdown?.ngnPerUsdEffective);
  const usdPerCoin = Number(q.breakdown?.usdPerToken);
  if (!(brampNgnPerUsd > 0) || !(usdPerCoin > 0)) throw new StorefrontSellError('Rates are not available right now.', 503);
  return { brampNgnPerUsd, usdPerCoin, brampNgnPerCoin: floor2(usdPerCoin * brampNgnPerUsd) };
}

// mode / markdownNgnPerUsd / selfNgnPerCoin override the desk's current settings
// (settlementRate: the desk's settings at quote time, honoured).
async function rateFor(merchant, coin, { forSettlement = false, mode = null, markdownNgnPerUsd: markdownOverride = null, selfNgnPerCoin = null } = {}) {
  const rateMode = mode || merchant.rateMode;
  if (merchant.status !== 'active') throw new StorefrontSellError('This desk is not taking trades right now.', 409);
  if (!forSettlement) {
    const paused = await settings.sellingPaused(); // Bramp's kill switch
    if (paused) throw new StorefrontSellError(paused, 503);
  }

  if (rateMode === 'SELF') {
    const selfRate = require('./storefrontSelfRate');
    if (merchant.selfRate?.status !== 'APPROVED') throw new StorefrontSellError('This desk is not taking trades right now.', 409);
    const ngnPerCoin = Number(selfNgnPerCoin ?? merchant.selfRate?.rates?.[coin]);
    if (!(ngnPerCoin > 0)) throw new StorefrontSellError(`This trader hasn't priced ${coin} yet.`, 409);
    if (!forSettlement) {
      const trader = await User.findById(merchant.userId).select('ngnbBalance');
      if ((trader?.ngnbBalance || 0) < selfRate.cfg().minCoverNgn) throw new StorefrontSellError('This desk is not taking trades right now.', 409);
    }
    return { rateMode: 'SELF', ngnPerCoin: floor2(ngnPerCoin), usdPerCoin: null, markdownNgnPerUsd: 0, brampNgnPerUsd: null, ngnPerUsd: null };
  }
  if (rateMode !== 'BRAMP') throw new StorefrontSellError('This desk has not set its rate yet.', 409);

  const { brampNgnPerUsd, usdPerCoin } = await brampRate(coin);

  const markdownNgnPerUsd = Math.max(0, Number(markdownOverride ?? merchant.markdownNgnPerUsd) || 0);
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
  if (await compliance.numberBlocked(customer.waId)) throw new StorefrontSellError('We can\'t take trades from this number.', 403);
  if (await settings.pairDisabled(coin, network)) {
    const others = PAIRS[coin].filter((n) => n !== network && !settings.peek().disabledPairs.includes(settings.pairCode(coin, n)));
    throw new StorefrontSellError(`${coin} on ${networkName(coin, network)} is paused right now.${others.length ? ` You can send it on ${others.map((n) => networkName(coin, n)).join(' or ')}.` : ''}`, 409);
  }
  const rate = await rateFor(merchant, coin);
  const addr = await addressFor(merchant, customer, coin, network);
  const quote = quoteFields(rate);

  let order = await StorefrontSellOrder.findOneAndUpdate(
    // Not one whose deposit is already on its way (seen, not yet confirmed): that one settles as it is.
    { customerId: customer._id, coin, network, status: 'AWAITING_DEPOSIT', 'deposit.transactionId': null },
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
    network: networkName(coin, network),
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
  if (await compliance.accountBlocked(number)) throw new StorefrontSellError('That account can\'t receive payouts from Bramp. Please use a different account.', 403);
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
    if (await compliance.accountBlocked(number)) throw new StorefrontSellError('That account can\'t receive payouts from Bramp. Please use a different account.', 403);
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
  const s = String(status || '').toUpperCase();
  const confirmed = CONFIRMED_STATUSES.includes(s);
  const failed = FAILED_STATUSES.includes(s);
  const amt = Number(amount);
  if (!transactionId || (!failed && !(amt > 0))) {
    logger.warn('Storefront sell: deposit without id or amount', { address, transactionId, amount, status: s });
    return true;
  }

  // Seen before while pending (now confirmed or failed), or a retry.
  const seen = await StorefrontSellOrder.findOne({ 'deposit.transactionId': String(transactionId) });
  if (seen) {
    if (failed) return depositFailed(seen);
    if (!confirmed || seen.deposit.confirmedAt) return true;
    const now = await StorefrontSellOrder.findOneAndUpdate(
      { _id: seen._id, 'deposit.confirmedAt': null },
      { $set: { 'deposit.confirmedAt': new Date(), 'deposit.amount': amt, ...(hash ? { 'deposit.hash': hash } : {}) } },
      { new: true }
    );
    if (!now || ['NEEDS_REVIEW', 'RESOLVED'].includes(now.status)) return true;
    const merchant = await StorefrontMerchant.findById(now.merchantId);
    if (now.sale?.early && now.sale?.ok && Number(now.sale.amount) !== amt) {
      await review(now, `Confirmed ${amt} ${now.coin}, but ${now.sale.amount} ${now.coin} was sold when it was first seen`, merchant);
      return true;
    }
    return depositConfirmed(now, merchant, amt);
  }
  if (failed) return true; // never seen while pending: nothing to undo

  const coin = String(currency || addr.coin).toUpperCase();
  // Pending: recorded and (Bramp rate, stablecoins) sold at once; paid only once confirmed.
  const deposit = { transactionId: String(transactionId), hash: hash || null, amount: amt, detectedAt: new Date(), confirmedAt: confirmed ? new Date() : null };

  // Another coin sent to this address (e.g. TRX to a USDT-on-Tron address) is
  // never priced as the address's coin: a person checks it.
  if (coin !== addr.coin) {
    logger.warn('Storefront sell: deposit currency differs from address', { address, coin, expected: addr.coin });
    let odd;
    try {
      odd = await StorefrontSellOrder.create({
        reference: newReference(), merchantId: addr.merchantId, customerId: addr.customerId, waId: addr.waId,
        coin: addr.coin, network: addr.network, address: addr.address, rateMode: 'BRAMP',
        quote: { ngnPerCoin: 0, quotedAt: new Date() }, deposit, openedByDeposit: true,
      });
    } catch (err) {
      if (err.code === 11000) return true;
      throw err;
    }
    await review(odd, `Deposit of ${amt} ${coin} to a ${addr.coin} address`, await StorefrontMerchant.findById(addr.merchantId));
    return true;
  }

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

  if (!confirmed) {
    logger.info('Storefront sell: deposit seen, waiting for confirmation', { reference: order.reference, coin: order.coin, amount: amt });
    await lockRate(order, merchant);
    earlySellInBackground(order._id);
    return true;
  }
  return depositConfirmed(order, merchant, amt);
}

/** A deposit has confirmed: tell the trader and the customer, then pay (or ask where to). */
async function depositConfirmed(order, merchant, amt) {
  logger.info('Storefront sell: deposit confirmed', { reference: order.reference, coin: order.coin, amount: amt });
  if (merchant) notifyTrader(merchant, 'deposit_confirmed', order).catch(() => {});

  const desk = deskLabel(merchant);
  if (!order.payoutAccount?.accountNumber) {
    await StorefrontSellOrder.updateOne({ _id: order._id }, { $set: { status: 'AWAITING_ACCOUNT' } });
    tellCustomer(order.waId, `I've received your *${amt} ${order.coin}* ✅ Where should I pay you? Send your bank and 10-digit account number.`,
      { env: 'STELLA_TEMPLATE_DEPOSIT_NEEDS_ACCOUNT', params: [amt, order.coin, desk, order.reference] });
    return true;
  }
  // Deposit received - sent (and accepted by WhatsApp) before the payout
  // starts, so it always arrives before the "sent" message.
  await tellCustomer(order.waId, ...((await settings.payoutsHeld())
    ? [`✅ I've received your *${amt} ${order.coin}*. Payouts are delayed for a short while; you'll be paid at the live rate as soon as they resume, and I'll message you when it's sent. Ref ${order.reference}.`]
    : [`✅ I've received your *${amt} ${order.coin}*. I'm paying you now at the live rate and will message you as soon as it's sent. Ref ${order.reference}.`,
      { env: 'STELLA_TEMPLATE_DEPOSIT_RECEIVED', params: [amt, order.coin, desk, order.reference] }]));
  settleInBackground(order._id);
  return true;
}

// ── Selling at detection (Bramp rate) ──────────────────────────────────────

// Obiex reports a deposit while it's still pending, then again once confirmed.
const CONFIRMED_STATUSES = ['CONFIRMED', 'SUCCESSFUL', 'COMPLETED'];
const FAILED_STATUSES = ['FAILED', 'REJECTED', 'CANCELLED', 'REVERSED'];
// Sold as soon as the deposit is seen: stablecoins only, where a pending
// transfer that never confirms is very unlikely. Everything else (and Self
// rate, which has no sale) waits for confirmation. Paid only once confirmed.
const EARLY_SELL_COINS = ['USDT', 'USDC'];

/**
 * Lock the desk's own settings as the deposit is first seen: its markdown
 * (Bramp rate) or its rate for this coin (Self rate). settlementRate pays at
 * least that at today's market, however long confirmation takes.
 */
async function lockRate(order, merchant) {
  if (!merchant || order.rateLock?.at) return;
  const self = merchant.rateMode === 'SELF';
  const ngnPerCoin = self ? Number(merchant.selfRate?.rates?.[order.coin]) : null;
  if (self && !(ngnPerCoin > 0)) return; // unpriced: nothing to lock (it goes to review)
  await StorefrontSellOrder.updateOne({ _id: order._id, 'rateLock.at': null }, {
    $set: {
      rateLock: {
        rateMode: self ? 'SELF' : 'BRAMP',
        markdownNgnPerUsd: self ? null : Math.max(0, Number(merchant.markdownNgnPerUsd) || 0),
        ngnPerCoin: self ? ngnPerCoin : null,
        at: new Date(),
      },
    },
  });
}

function earlySellInBackground(orderId) {
  setImmediate(() => earlySell(orderId).catch((err) =>
    logger.error('Storefront sell: early sale failed', { orderId: String(orderId), error: err.message })));
}

/**
 * A Bramp rate deposit just seen (not yet confirmed): sell the coin on Obiex
 * now, so the rate is the one when the customer sent, and lock the figures.
 * Skipped (it sells on confirmation instead) above the cap or when the sale
 * would only go to review: below the minimum payout, a blocked number or
 * account, or over the desk's limits.
 */
async function earlySell(orderId) {
  const order = await StorefrontSellOrder.findById(orderId);
  if (!order || order.deposit?.confirmedAt || order.sale?.at || order.status !== 'AWAITING_DEPOSIT') return;
  if (!EARLY_SELL_COINS.includes(order.coin)) return;
  const merchant = await StorefrontMerchant.findById(order.merchantId);
  if (!merchant || merchant.rateMode !== 'BRAMP') return;
  const { values } = await settings.get();
  if (!(values.earlySellMaxNgn > 0)) return;

  let rate;
  try {
    rate = await settlementRate(order, merchant);
  } catch (err) {
    return; // no rate now: it's priced on confirmation (or goes to review then)
  }
  if (rate.rateMode !== 'BRAMP') return;
  const amount = order.deposit.amount;
  const customerNgn = floor2(amount * rate.ngnPerCoin);
  if (customerNgn > values.earlySellMaxNgn) return;
  if (values.minPayoutNgn > 0 && customerNgn < values.minPayoutNgn) return;
  if (await compliance.payoutBlock(order)) return;
  if (await overLimits(order, merchant, customerNgn)) return;

  // Claim the early sale: once, and only while still unconfirmed and unsold.
  const claimed = await StorefrontSellOrder.findOneAndUpdate(
    { _id: order._id, status: 'AWAITING_DEPOSIT', 'deposit.confirmedAt': null, 'sale.at': null },
    { $set: { 'sale.at': new Date(), 'sale.early': true } }
  );
  if (!claimed) return;

  let sold;
  try {
    sold = await swapCryptoToNGNX({ sourceCode: order.coin, amount });
  } catch (err) {
    sold = { success: false, error: err.message };
  }
  if (!sold || sold.success === false) {
    // Not sold: back to selling on confirmation.
    await StorefrontSellOrder.updateOne({ _id: order._id }, { $set: { 'sale.at': null, 'sale.early': false, 'sale.error': String(sold?.error || sold?.message || 'swap failed').slice(0, 300) } });
    logger.warn('Storefront sell: early sale failed, will sell on confirmation', { reference: order.reference });
  } else {
    const traderEarningNgn = round2(amount * rate.usdPerCoin * rate.markdownNgnPerUsd);
    await StorefrontSellOrder.updateOne({ _id: order._id }, {
      $set: {
        rateMode: 'BRAMP', 'sale.ok': true, 'sale.amount': amount, 'sale.error': null,
        settlement: { ngnPerCoin: rate.ngnPerCoin, rateAt: new Date(), customerNgn, traderEarningNgn, feeNgn: 0, basis: rate.basis || 'LIVE' },
      },
    });
    logger.info('Storefront sell: sold at detection', { reference: order.reference, coin: order.coin, amount, ngnPerCoin: rate.ngnPerCoin });
  }
  // Confirmed while selling: settle now (settle waits for an early sale in flight).
  const fresh = await StorefrontSellOrder.findById(order._id).select('deposit.confirmedAt payoutAccount status');
  if (fresh?.deposit?.confirmedAt) settleInBackground(order._id);
}

/** A pending deposit Obiex then reported failed. If it was sold early, Bramp sold coins it won't get. */
async function depositFailed(order) {
  if (order.deposit?.confirmedAt || ['NEEDS_REVIEW', 'RESOLVED', 'PAID'].includes(order.status)) return true;
  const merchant = await StorefrontMerchant.findById(order.merchantId);
  if (order.sale?.early && order.sale?.ok) {
    await require('../models/storefrontAlert').create({
      type: 'LATE_PAYOUT', merchantId: order.merchantId, waId: order.waId, orderReference: order.reference, amountNgn: order.settlement?.customerNgn || null,
      detail: `Deposit failed after ${order.sale.amount} ${order.coin} was sold at detection: Bramp sold coins it won't receive (nothing was paid out)`,
    }).catch(() => {});
    await review(order, `Deposit failed on chain after the coin was sold early (nothing paid out)`, merchant);
  } else {
    await review(order, 'Deposit failed on chain before confirming (nothing sold or paid)', merchant);
  }
  return true;
}

// ── Settlement ─────────────────────────────────────────────────────────────

// WhatsApp delivers a free-form message only within 24 hours of the customer's
// last message; after that it must be an approved template (YCloud). A little
// short of 24h, so a message sent at the edge isn't refused.
const SERVICE_WINDOW_MS = 23.5 * 60 * 60 * 1000;
const deskLabel = (merchant) => merchant?.brandName || (merchant?.slug ? `@${merchant.slug}` : 'your desk');

/**
 * A message to the customer in their Stella chat. Never throws; await it when
 * order matters. With template ({ env, params }): outside the 24-hour window,
 * the approved template named by that env variable is sent instead, with
 * params as its body variables (same order as the template's {{1}}, {{2}}...).
 */
async function tellCustomer(waId, text, template = null) {
  const sender = require('../AI/stellaSender');
  try {
    const name = template && process.env[template.env];
    if (name) {
      const convo = await StellaConversation.findOne({ waId }).select('lastInboundAt').lean();
      const open = convo?.lastInboundAt && Date.now() - new Date(convo.lastInboundAt).getTime() < SERVICE_WINDOW_MS;
      if (!open) {
        return await sender.sendTemplate(waId, {
          name,
          language: process.env.STELLA_TEMPLATE_LANGUAGE || 'en',
          bodyParams: template.params.map((p) => String(p).replace(/\s+/g, ' ').trim() || '-'),
        }, text);
      }
    }
    return await sender.sendText(waId, text);
  } catch (err) {
    logger.warn('Storefront sell: customer message failed', { error: err.message });
    return null;
  }
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

const fmtNgn = (n) => `₦${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const COIN_BALANCE = { USDT: 'usdtBalance', USDC: 'usdcBalance', BTC: 'btcBalance', ETH: 'ethBalance', SOL: 'solBalance', BNB: 'bnbBalance' };

async function overLimits(order, merchant, customerNgn) {
  if (merchant.perTradeMaxNgn > 0 && customerNgn > merchant.perTradeMaxNgn) {
    return `Over the desk's per-trade limit (${customerNgn} > ${merchant.perTradeMaxNgn})`;
  }
  const paidSince = async (since, extra = {}) => {
    const [{ total = 0 } = {}] = await StorefrontSellOrder.aggregate([
      { $match: { merchantId: merchant._id, status: 'PAID', paidAt: { $gte: since }, ...extra } },
      { $group: { _id: null, total: { $sum: '$settlement.customerNgn' } } },
    ]);
    return total;
  };
  if (merchant.dailyMaxNgn > 0) {
    const day = new Date(); day.setHours(0, 0, 0, 0);
    const total = await paidSince(day);
    if (total + customerNgn > merchant.dailyMaxNgn) return `Over the desk's daily limit (${total + customerNgn} > ${merchant.dailyMaxNgn})`;
  }
  if (merchant.rateMode === 'SELF' && merchant.selfRate?.payoutLimitNgn > 0) {
    const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
    const total = await paidSince(month, { rateMode: 'SELF' });
    if (total + customerNgn > merchant.selfRate.payoutLimitNgn) return `Over the Self rate monthly payout limit (${total + customerNgn} > ${merchant.selfRate.payoutLimitNgn})`;
  }
  return null;
}

/**
 * Did Obiex refuse the payout for certain? A 4xx refusal means no money moved.
 * A timeout, 408/409/429 or 5xx doesn't say: the customer may have been paid.
 */
const DEFINITE_REFUSALS = [400, 401, 402, 403, 404, 422];
const payoutFailedForSure = (payout) => DEFINITE_REFUSALS.includes(Number(payout?.statusCode));

/** Pay the customer from NGNX. Returns the provider result. */
async function payCustomer(order, merchant, customerNgn) {
  try {
    return await debitNaira({
      destination: order.payoutAccount,
      amount: customerNgn,
      currency: 'NGNX',
      narration: `Bramp ${merchant.brandName || merchant.slug}`.slice(0, 40),
    }, { idempotencyKey: `sf-sell-${order.reference}`, userId: String(merchant.userId) });
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/** Move to PAYING unless the order was flagged for review meanwhile. */
async function toPaying(order, extra = {}) {
  const r = await StorefrontSellOrder.updateOne(
    { _id: order._id, status: 'SELLING' },
    { $set: { status: 'PAYING', 'payout.idempotencyKey': `sf-sell-${order.reference}`, 'payout.requestedAt': new Date(), ...extra } }
  );
  return r.modifiedCount === 1;
}

async function markPaid(order, merchant, payout, { customerNgn, ngnPerCoin, traderEarningNgn }) {
  const paidAt = new Date();
  // The money has gone, so PAID is the truth even if the stuck check flagged it meanwhile.
  const marked = await StorefrontSellOrder.updateOne({ _id: order._id, status: { $in: ['PAYING', 'NEEDS_REVIEW'] } }, {
    $set: { status: 'PAID', paidAt, reviewReason: null, 'payout.providerId': payout.data?.id || payout.data?.data?.id || null },
  });
  if (!marked.modifiedCount) {
    // Resolved by hand while this payout was in flight: the customer may have been
    // paid twice. No totals, earnings or messages - flag it for ops instead.
    await StorefrontSellOrder.updateOne({ _id: order._id }, { $set: { 'payout.providerId': payout.data?.id || payout.data?.data?.id || null } });
    logger.error('Storefront sell: payout went through after the sale was resolved by hand', { reference: order.reference });
    await require('../models/storefrontAlert').create({
      type: 'LATE_PAYOUT', merchantId: order.merchantId, waId: order.waId, orderReference: order.reference, amountNgn: customerNgn,
      detail: 'Obiex paid this sale after it was resolved by hand: check for a double payment',
    }).catch(() => {});
    return null;
  }
  await StorefrontCustomer.updateOne({ _id: order.customerId }, {
    $inc: {
      'stats.completed': 1,
      'stats.volumeNgn': customerNgn,
      [`stats.byCoin.${order.coin}.trades`]: 1,
      [`stats.byCoin.${order.coin}.amount`]: order.deposit.amount,
      [`stats.byCoin.${order.coin}.volumeNgn`]: customerNgn,
    },
    $set: { lastTradeAt: paidAt },
  });
  const paid = await StorefrontSellOrder.findById(order._id);
  logger.info('Storefront sell: paid', { reference: order.reference, rateMode: order.rateMode, customerNgn, traderEarningNgn, ngnPerCoin });
  notifyTrader(merchant, 'paid', paid).catch(() => {});
  tellCustomer(order.waId, `💸 Sent! *${fmtNgn(customerNgn)}* for your ${order.deposit.amount} ${order.coin} (${fmtNgn(ngnPerCoin)} per ${order.coin}) has been sent to ${order.payoutAccount.bankName} ${maskAcct(order.payoutAccount.accountNumber)}. Ref ${order.reference}.`, {
    env: 'STELLA_TEMPLATE_PAYOUT_SENT',
    params: [fmtNgn(customerNgn), `${order.payoutAccount.bankName} ${maskAcct(order.payoutAccount.accountNumber)}`, `${order.deposit.amount} ${order.coin}`, `${fmtNgn(ngnPerCoin)} per ${order.coin}`, order.reference],
  });
  return paidAt;
}

/**
 * The rate a sale settles at: the desk's live rate, except within the honour
 * window after the quote (Platform controls, quoteHonourMinutes): at least
 * what the desk's settings at quote time give
 *    at today's market - the markdown it had (Bramp rate) or its own rate
 *    (Self rate) - so a trader can't lower the rate once the customer has
 *    sent. Market moves still settle live; a better live rate wins.
 */
async function settlementRate(order, merchant) {
  // A coin a Self rate desk hasn't priced has no live rate: the sale goes to review.
  let live = null;
  let liveErr = null;
  try {
    live = { ...(await rateFor(merchant, order.coin, { forSettlement: true })), basis: 'LIVE' };
  } catch (err) {
    liveErr = err;
  }

  const minutes = (await settings.get()).values.quoteHonourMinutes;
  const q = order.quote || {};
  const fresh = minutes > 0 && q.quotedAt && q.ngnPerCoin > 0 && Date.now() - new Date(q.quotedAt).getTime() <= minutes * 60 * 1000;
  // The desk's settings when the deposit was first seen (no time limit).
  const lock = order.rateLock;
  if (lock?.at) {
    let asLocked = null;
    try {
      asLocked = lock.rateMode === 'SELF'
        ? await rateFor(merchant, order.coin, { forSettlement: true, mode: 'SELF', selfNgnPerCoin: lock.ngnPerCoin })
        : await rateFor(merchant, order.coin, { forSettlement: true, mode: 'BRAMP', markdownNgnPerUsd: lock.markdownNgnPerUsd });
    } catch (err) {
      asLocked = null; // e.g. Self rate since revoked
    }
    if (asLocked && (!live || asLocked.ngnPerCoin > live.ngnPerCoin)) live = { ...asLocked, basis: 'LOCKED_AT_DETECTION' };
  }

  if (fresh) {
    let asQuoted = null;
    try {
      asQuoted = order.rateMode === 'SELF'
        ? await rateFor(merchant, order.coin, { forSettlement: true, mode: 'SELF', selfNgnPerCoin: q.ngnPerCoin })
        : await rateFor(merchant, order.coin, { forSettlement: true, mode: 'BRAMP', markdownNgnPerUsd: q.markdownNgnPerUsd ?? merchant.markdownNgnPerUsd });
    } catch (err) {
      asQuoted = null; // e.g. Self rate since revoked: the live rate stands
    }
    if (asQuoted && (!live || asQuoted.ngnPerCoin > live.ngnPerCoin)) live = { ...asQuoted, basis: 'QUOTE_HONOURED' };
  }
  if (!live) throw liveErr;
  return live;
}

/** Work out the naira at the live rate, then pay the customer (Bramp rate: after selling the coin; Self rate: from the trader's NGNB). */
async function settle(orderId) {
  // Only a confirmed deposit is ever paid; an early sale still in flight is waited for.
  const ready = {
    _id: orderId, status: { $in: ['AWAITING_DEPOSIT', 'AWAITING_ACCOUNT', 'AWAITING_FUNDS'] },
    'deposit.transactionId': { $type: 'string' }, 'deposit.confirmedAt': { $type: 'date' }, 'payoutAccount.accountNumber': { $type: 'string' },
    $or: [{ 'sale.early': { $ne: true } }, { 'sale.ok': true }],
  };
  // Bramp's kill switch holds payouts: mark it, and releaseHeld() pays it once they resume.
  if (await settings.payoutsHeld()) {
    await StorefrontSellOrder.updateOne({ ...ready, heldAt: null }, { $set: { heldAt: new Date() } });
    return;
  }
  // Claim: only one settle per order, and only once it has a deposit and an account.
  const order = await StorefrontSellOrder.findOneAndUpdate(
    ready,
    { $set: { status: 'SELLING', heldAt: null } },
    { new: false } // the status before the claim (was it already waiting for funds?)
  );
  if (!order) return;
  const wasAwaitingFunds = order.status === 'AWAITING_FUNDS';
  order.status = 'SELLING';
  const merchant = await StorefrontMerchant.findById(order.merchantId);
  if (!merchant) return review(order, 'Desk not found', null);

  // Sold when the deposit was first seen: pay the locked figures, no second sale.
  if (order.sale?.early && order.sale?.ok) {
    const { ngnPerCoin, customerNgn, traderEarningNgn } = order.settlement;
    await compliance.screen(order, merchant, customerNgn);
    const blocked = await compliance.payoutBlock(order);
    if (blocked) return review(order, `${blocked} (the coin was already sold)`, merchant);
    if (!(await toPaying(order))) return;
    return payBrampSale(order, merchant, { customerNgn, ngnPerCoin, traderEarningNgn });
  }

  // The live rate at settlement (settlementRate: with the quote honoured, or
  // Bramp rate for a coin a Self rate desk hasn't priced).
  let live;
  try {
    live = await settlementRate(order, merchant);
  } catch (err) {
    return review(order, `No rate at settlement: ${err.message}`, merchant);
  }
  const amount = order.deposit.amount;
  const ngnPerCoin = live.ngnPerCoin;
  const customerNgn = floor2(amount * ngnPerCoin);
  const self = live.rateMode === 'SELF';
  const feeNgn = self ? require('./storefrontSelfRate').feeFor(merchant, customerNgn) : 0;
  const traderEarningNgn = self ? null : round2(amount * live.usdPerCoin * live.markdownNgnPerUsd);
  await StorefrontSellOrder.updateOne({ _id: order._id }, {
    $set: { rateMode: live.rateMode, settlement: { ngnPerCoin, rateAt: new Date(), customerNgn, traderEarningNgn, feeNgn, basis: live.basis || 'LIVE' } },
  });
  order.rateMode = live.rateMode;

  // Too small to pay out (each payout has a provider cost): a person decides.
  const { minPayoutNgn } = (await settings.get()).values;
  if (minPayoutNgn > 0 && customerNgn < minPayoutNgn) return review(order, `Below the minimum payout (${fmtNgn(customerNgn)} < ${fmtNgn(minPayoutNgn)})`, merchant);
  // Alerts for bramp-admin (large or rapid trades); they don't stop the sale.
  await compliance.screen(order, merchant, customerNgn);
  // A blocked number or account, or the desk's limits: a person decides.
  const blocked = await compliance.payoutBlock(order);
  if (blocked) return review(order, blocked, merchant);
  const limit = await overLimits(order, merchant, customerNgn);
  if (limit) return review(order, limit, merchant);

  if (self) return settleSelfRate(order, merchant, { customerNgn, ngnPerCoin, feeNgn, wasAwaitingFunds });

  // Bramp rate 1. Sell the coin for NGNX on Obiex.
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
  if (!(await toPaying(order, { sale: { ok: true, at: new Date() } }))) {
    await StorefrontSellOrder.updateOne({ _id: order._id }, { $set: { sale: { ok: true, at: new Date() } } });
    logger.error('Storefront sell: sold but flagged before payout - pay manually', { reference: order.reference });
    return;
  }

  return payBrampSale(order, merchant, { customerNgn, ngnPerCoin, traderEarningNgn });
}

/** Bramp rate, coin sold: pay the customer from NGNX, then credit the desk's earning. */
async function payBrampSale(order, merchant, { customerNgn, ngnPerCoin, traderEarningNgn }) {
  // 2. Pay the customer from NGNX.
  const payout = await payCustomer(order, merchant, customerNgn);
  if (!payout?.success) {
    const sure = payoutFailedForSure(payout);
    await StorefrontSellOrder.updateOne({ _id: order._id }, { $set: { 'payout.error': String(payout?.message || 'payout failed').slice(0, 300), 'payout.outcome': sure ? 'FAILED' : 'UNKNOWN' } });
    return review(order, sure ? 'Payout to the customer failed' : `Payout result unknown - check Obiex for sf-sell-${order.reference} before paying again`, merchant);
  }

  // 3. Paid: the desk's earning, the customer's totals, everyone told.
  const paidAt = await markPaid(order, merchant, payout, { customerNgn, ngnPerCoin, traderEarningNgn });
  if (paidAt && traderEarningNgn > 0) {
    await User.updateOne({ _id: merchant.userId }, { $inc: { ngnbBalance: traderEarningNgn }, $set: { lastBalanceUpdate: paidAt } });
  }
}

/**
 * Self rate: debit the payout plus the flat fee from the trader's NGNB (only
 * if it covers it), pay the customer from NGNX, then credit the coin to the
 * trader. Short of funds: the sale waits (AWAITING_FUNDS) and the trader is
 * asked to top up; the minute job retries it.
 */
async function settleSelfRate(order, merchant, { customerNgn, ngnPerCoin, feeNgn, wasAwaitingFunds }) {
  const selfRate = require('./storefrontSelfRate');
  const debitNgn = round2(customerNgn + feeNgn);

  // A Self rate payout moves the trader's NGNB to a bank account, so it's held
  // to the same rules as an NGNB withdrawal: a person checks a payout to the
  // trader's own name (they'd be paying themselves), and payouts count toward
  // the rolling 7-day withdrawal limit (utils/withdrawalLimits.js).
  const owner = await User.findById(merchant.userId).select('firstname middlename lastname').lean();
  const ownName = [owner?.firstname, owner?.middlename, owner?.lastname].filter(Boolean).join(' ');
  const { namesMatch } = require('../utils/kycHelpers');
  // Two words at least: a first name alone would match strangers who share it.
  if (ownName.split(/\s+/).length >= 2 && order.payoutAccount?.accountName && namesMatch(ownName, order.payoutAccount.accountName)) {
    return review(order, 'Self rate payout to an account in the trader\'s own name', merchant);
  }
  const { checkWithdrawalLimit } = require('../utils/withdrawalLimits');
  const limit = await checkWithdrawalLimit(merchant.userId, debitNgn);
  if (!limit.allowed) {
    return review(order, `Over the trader's 7-day withdrawal limit (₦${Math.round(limit.used).toLocaleString('en-NG')} used of ₦${limit.limit.toLocaleString('en-NG')})`, merchant);
  }

  const debited = await User.updateOne(
    { _id: merchant.userId, ngnbBalance: { $gte: debitNgn } },
    { $inc: { ngnbBalance: -debitNgn }, $set: { lastBalanceUpdate: new Date() } }
  );
  if (!debited.modifiedCount) {
    await StorefrontSellOrder.updateOne({ _id: order._id, status: 'SELLING' }, { $set: { status: 'AWAITING_FUNDS' } });
    if (!wasAwaitingFunds) {
      const waiting = await StorefrontSellOrder.findById(order._id);
      notifyTrader(merchant, 'awaiting_funds', waiting, { neededNgn: debitNgn }).catch(() => {});
      tellCustomer(order.waId, `Your payment is taking a little longer than usual. I'll message you as soon as it's sent. Ref ${order.reference}.`);
    }
    return;
  }
  const debitedAt = new Date();
  if (!(await toPaying(order, { 'selfRateFunds.debitNgn': debitNgn, 'selfRateFunds.debitedAt': debitedAt }))) {
    await User.updateOne({ _id: merchant.userId }, { $inc: { ngnbBalance: debitNgn } }); // flagged meanwhile: give it back
    return;
  }

  const payout = await payCustomer(order, merchant, customerNgn);
  if (!payout?.success) {
    const error = String(payout?.message || 'payout failed').slice(0, 300);
    if (!payoutFailedForSure(payout)) {
      // The customer may have been paid: keep the trader's debit until someone checks Obiex.
      await StorefrontSellOrder.updateOne({ _id: order._id }, { $set: { 'payout.error': error, 'payout.outcome': 'UNKNOWN' } });
      return review(order, `Payout result unknown - check Obiex for sf-sell-${order.reference} (trader not refunded yet)`, merchant);
    }
    await User.updateOne({ _id: merchant.userId }, { $inc: { ngnbBalance: debitNgn }, $set: { lastBalanceUpdate: new Date() } });
    await StorefrontSellOrder.updateOne({ _id: order._id }, { $set: { 'payout.error': error, 'payout.outcome': 'FAILED', 'selfRateFunds.refundedAt': new Date() } });
    return review(order, 'Payout to the customer failed (trader refunded)', merchant);
  }

  const paidAt = await markPaid(order, merchant, payout, { customerNgn, ngnPerCoin, traderEarningNgn: null });
  // The coin stays with the trader, in their Bramp wallet.
  const field = COIN_BALANCE[order.coin];
  if (paidAt && field) {
    await User.updateOne({ _id: merchant.userId }, { $inc: { [field]: order.deposit.amount }, $set: { lastBalanceUpdate: new Date() } });
    await StorefrontSellOrder.updateOne({ _id: order._id }, { $set: { 'selfRateFunds.coinCreditedAt': new Date() } });
  }

  // Quoting stops below the cover level: tell the trader (at most every 6 hours).
  const trader = await User.findById(merchant.userId).select('ngnbBalance');
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000);
  if ((trader?.ngnbBalance || 0) < selfRate.cfg().minCoverNgn) {
    const claimed = await StorefrontMerchant.updateOne(
      { _id: merchant._id, $or: [{ 'selfRate.lowBalanceNotifiedAt': null }, { 'selfRate.lowBalanceNotifiedAt': { $lt: sixHoursAgo } }] },
      { $set: { 'selfRate.lowBalanceNotifiedAt': new Date() } }
    );
    if (claimed.modifiedCount) notifyTrader(merchant, 'low_balance', await StorefrontSellOrder.findById(order._id), { balanceNgn: trader?.ngnbBalance || 0 }).catch(() => {});
  }
}

/** Every minute: Self rate sales waiting for the trader's top-up are tried again. */
async function retryAwaitingFunds() {
  const waiting = await StorefrontSellOrder.find({ status: 'AWAITING_FUNDS' }).sort({ createdAt: 1 }).limit(50).select('_id');
  for (const o of waiting) await settle(o._id);
}

/** Every minute: a sale stuck mid-way (e.g. the server restarted) goes to people, never retried blind. */
/** Sales held while payouts were paused: pay them once Bramp resumes payouts (minute job). */
async function releaseHeld() {
  if (await settings.payoutsHeld()) return;
  const held = await StorefrontSellOrder.find({ heldAt: { $ne: null }, status: { $in: ['AWAITING_DEPOSIT', 'AWAITING_ACCOUNT', 'AWAITING_FUNDS'] } })
    .sort({ heldAt: 1 }).limit(50).select('_id');
  for (const o of held) await settle(o._id);
}

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
    network: networkName(o.coin, o.network),
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
  PAIRS, COINS: Object.keys(PAIRS), NETWORK_NAMES, networkName, sellable, normalizeCoin, normalizeNetwork,
  touchCustomer, brampRate, rateFor, addressFor, startSale, checkAccount, useAccount,
  handleObiexDeposit, settle, flagStuck, retryAwaitingFunds, releaseHeld, customerSales, serializeSale,
  StorefrontSellError,
  _markPaid: markPaid, // tests
  earlySell,
};
