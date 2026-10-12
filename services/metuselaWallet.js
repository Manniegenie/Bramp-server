// services/metuselaWallet.js
// Metusela crypto balances at Bramp, modelled on ZeusODX: Bramp keeps each
// Metusela user's USDC balance; the coins sit in Bramp's pooled Obiex
// account. (Naira is paused; see services/metuselaOnramp.js.)
//
//   Deposits    — per-user Obiex deposit addresses for USDC and USDT on every
//                 network Obiex offers. USDT is swapped to USDC on Obiex.
//                 Credited from the Obiex webhook, less the deposit fee.
//   Bets        — stake: user → POOL; payout/refund: POOL → user.
//   Withdrawals — USDC on any Obiex network to an external address.
//   Float       — POOL → Metusela's Polymarket wallet (Obiex withdrawal to its
//                 Polymarket bridge address); money coming back lands on the
//                 POOL's own deposit addresses.
// Every balance change is a MetuselaTransfer with a unique reference.
const MetuselaAccount = require('../models/metuselaAccount');
const MetuselaTransfer = require('../models/metuselaTransfer');
const MetuselaDeposit = require('../models/metuselaDeposit');
const MetuselaWithdrawal = require('../models/metuselaWithdrawal');
const { MetuselaSettings } = require('../models/metuselaSettings');
const { notifyMetusela } = require('./metuselaNotify');
const { networkTerms, termsFor, normalizeNetwork } = require('./metuselaNetworks');
const logger = require('../utils/logger');

class WalletError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;
const floor2 = (n) => Math.floor(n * 100 + 1e-9) / 100;

// Obiex clients are required lazily: createwalletaddress validates Obiex
// config at require time, which would crash a server without Obiex keys.
const obiex = {
  swap: () => require('./ObiexSwap'),
  addresses: () => require('./createwalletaddress'),
  withdraw: () => require('./ObiexWithdraw'),
};

// ── Accounts ───────────────────────────────────────────────────────────────

async function systemAccount(kind) {
  const found = await MetuselaAccount.findOne({ kind });
  if (found) return found;
  try {
    return await MetuselaAccount.create({ kind });
  } catch (err) {
    if (err.code === 11000) return MetuselaAccount.findOne({ kind });
    throw err;
  }
}

async function ensureAccount(partnerUserId) {
  const id = String(partnerUserId || '').trim();
  if (!id || id.length > 64) throw new WalletError('partnerUserId is required (max 64 chars).');
  const existing = await MetuselaAccount.findOne({ kind: 'USER', partnerUserId: id });
  if (existing) return { account: existing, created: false };
  try {
    return { account: await MetuselaAccount.create({ kind: 'USER', partnerUserId: id }), created: true };
  } catch (err) {
    if (err.code === 11000) return { account: await MetuselaAccount.findOne({ kind: 'USER', partnerUserId: id }), created: false };
    throw err;
  }
}

async function getUserAccount(partnerUserId) {
  const account = await MetuselaAccount.findOne({ kind: 'USER', partnerUserId: String(partnerUserId) });
  if (!account) throw new WalletError('Account not found.', 404);
  return account;
}

function serializeAccount(a) {
  return {
    partnerUserId: a.partnerUserId,
    kind: a.kind,
    usdcBalance: round6(a.usdcBalance),
    status: a.status,
    depositAddresses: a.depositAddresses.map((d) => ({ currency: d.currency, network: d.network, address: d.address, memo: d.memo })),
    createdAt: a.createdAt,
  };
}

// ── Ledger ─────────────────────────────────────────────────────────────────

/**
 * Move `amount` USDC from one account to another (null = outside Bramp).
 * Idempotent on `reference`: a repeat with the same details returns the
 * first result; with different details it's a 409. The source can't go
 * below zero unless `allowNegative` (the POOL can be temporarily short
 * while the float is out at Polymarket).
 */
async function transfer({ reference, type, fromId = null, toId = null, amount, meta = {}, allowNegative = false }) {
  const amountUsdc = round6(Number(amount));
  if (!(amountUsdc > 0)) throw new WalletError('Amount must be positive.');

  let t;
  try {
    t = await MetuselaTransfer.create({ reference, type, fromAccountId: fromId, toAccountId: toId, amountUsdc, meta });
  } catch (err) {
    if (err.code !== 11000) throw err;
    t = await MetuselaTransfer.findOne({ reference });
    const same = t.type === type && t.amountUsdc === amountUsdc
      && String(t.fromAccountId) === String(fromId) && String(t.toAccountId) === String(toId);
    if (!same) throw new WalletError('That reference was already used for a different transfer.', 409);
    if (t.status === 'FAILED') throw new WalletError(t.failureReason || 'Transfer failed.', 402);
    if (t.status === 'DONE') return t;
  }

  // Debit side — claimed once, so concurrent retries can't double-debit.
  if (fromId && t.debitState !== 'DONE') {
    const claim = await MetuselaTransfer.findOneAndUpdate({ _id: t._id, debitState: 'NONE' }, { debitState: 'APPLYING' }, { new: true });
    if (claim) {
      const debited = await MetuselaAccount.findOneAndUpdate(
        { _id: fromId, status: 'ACTIVE', ...(allowNegative ? {} : { usdcBalance: { $gte: amountUsdc - 1e-9 } }) },
        { $inc: { usdcBalance: -amountUsdc } },
        { new: true }
      );
      if (!debited) {
        await MetuselaTransfer.updateOne({ _id: t._id }, { debitState: 'NONE', status: 'FAILED', failureReason: 'INSUFFICIENT_BALANCE' });
        throw new WalletError('Insufficient balance.', 402);
      }
      await MetuselaTransfer.updateOne({ _id: t._id }, { debitState: 'DONE' });
    }
  }

  // Credit side.
  if (toId && t.creditState !== 'DONE') {
    const claim = await MetuselaTransfer.findOneAndUpdate({ _id: t._id, creditState: 'NONE' }, { creditState: 'APPLYING' }, { new: true });
    if (claim) {
      await MetuselaAccount.updateOne({ _id: toId }, { $inc: { usdcBalance: amountUsdc } });
      await MetuselaTransfer.updateOne({ _id: t._id }, { creditState: 'DONE' });
    }
  }

  return MetuselaTransfer.findOneAndUpdate({ _id: t._id }, { status: 'DONE' }, { new: true });
}

// ── Networks & deposit addresses ───────────────────────────────────────────

const networkCache = new Map();

/** Networks Obiex currently offers for a currency (live API), codes normalized. */
async function obiexNetworks(currency) {
  const hit = networkCache.get(currency);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.list;
  const res = await obiex.swap().obiexClient.get(`/currencies/${currency}/networks`);
  const raw = Array.isArray(res.data) ? res.data : (res.data?.data || []);
  const list = raw.map((n) => {
    const net = n.network && typeof n.network === 'object' ? n.network : n;
    return {
      code: normalizeNetwork(net.code || n.code),
      addressRegex: n.addressRegex ?? net.addressRegex ?? null,
      memoRegex: n.memoRegex ?? net.memoRegex ?? null,
    };
  }).filter((n) => n.code && n.code !== 'UNDEFINED');
  networkCache.set(currency, { at: Date.now(), list });
  return list;
}

// Built-in address formats, used when Obiex's live list isn't reachable.
const EVM = /^0x[0-9a-fA-F]{40}$/;
const ADDRESS_FORMATS = {
  ETH: EVM, BASE: EVM, AVAXC: EVM, ARBITRUM: EVM, MATIC: EVM, BSC: EVM,
  SOL: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  TRX: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
};

/**
 * Networks usable right now for a currency: Obiex's terms (defaults +
 * admin overrides), enabled, optionally limited to `allowed`, and — when
 * Obiex's live list can be fetched — actually offered by Obiex today.
 */
async function availableTerms(currency, { allowed = [], settings } = {}) {
  const s = settings || await MetuselaSettings.get();
  let terms = networkTerms(currency, s.networkOverrides).filter((t) => t.enabled !== false);
  const allow = allowed.map(normalizeNetwork);
  if (allow.length) terms = terms.filter((t) => allow.includes(t.code));
  let live = null;
  try {
    live = await obiexNetworks(currency);
  } catch (err) {
    logger.warn('Metusela: Obiex live networks unavailable, using the fee table', { currency, error: err.message });
  }
  if (live && live.length) {
    const byCode = new Map(live.map((n) => [n.code, n]));
    terms = terms.filter((t) => byCode.has(t.code)).map((t) => ({ ...t, addressRegex: byCode.get(t.code).addressRegex || null }));
  }
  return terms;
}

/** Deposit options: enabled currencies × available networks, with minimums. */
async function depositOptions() {
  const s = await MetuselaSettings.get();
  const out = [];
  for (const currency of s.depositCurrencies) {
    const terms = await availableTerms(currency, { allowed: s.depositNetworks?.[currency] || [], settings: s });
    out.push({
      currency,
      creditedAs: 'USDC',
      networks: terms.map((t) => ({ code: t.code, name: t.name, minDeposit: t.minDeposit, depositFee: t.depositFee })),
    });
  }
  return {
    depositsEnabled: s.depositsEnabled,
    options: out,
    fees: { depositFeeBps: s.depositFeeBps, depositFeeFlatUsdc: s.depositFeeFlatUsdc, usdtSwapMarkupBps: s.usdtSwapMarkupBps },
  };
}

/**
 * The account's deposit address for a currency + network, created on
 * Obiex (broker address, ZeusODX-style) the first time it's asked for.
 * Accepts common network names ("POLYGON" → Obiex's "MATIC").
 */
async function depositAddress(account, currency, network) {
  const cur = String(currency || '').toUpperCase();
  const net = normalizeNetwork(network);
  const s = await MetuselaSettings.get();
  if (!s.depositsEnabled) throw new WalletError('Deposits are paused.', 503);
  if (!s.depositCurrencies.includes(cur)) throw new WalletError(`Deposits in ${cur} aren't enabled.`);

  const existing = account.depositAddresses.find((d) => d.currency === cur && d.network === net);
  if (existing) return existing;

  const terms = await availableTerms(cur, { allowed: s.depositNetworks?.[cur] || [], settings: s });
  if (!terms.some((t) => t.code === net)) throw new WalletError(`${cur} deposits on ${net} aren't available.`);

  const purpose = `metusela-${account._id}`; // Obiex purpose: letters, digits, dashes
  const data = await obiex.addresses().createDepositAddress({ purpose, currency: cur, network: net });
  const address = data?.value || data?.address;
  if (!address) throw new WalletError('Obiex did not return an address.', 502);
  const entry = { currency: cur, network: net, address, memo: data?.memo || null, createdAt: new Date() };

  // Only add if another request didn't just add the same pair.
  await MetuselaAccount.updateOne(
    { _id: account._id, depositAddresses: { $not: { $elemMatch: { currency: cur, network: net } } } },
    { $push: { depositAddresses: entry } }
  );
  const fresh = await MetuselaAccount.findById(account._id);
  return fresh.depositAddresses.find((d) => d.currency === cur && d.network === net);
}

// ── Deposits (Obiex webhook) ───────────────────────────────────────────────

/** USDT → USDC on Obiex. Returns the USDC received, or throws. */
async function swapUsdtToUsdc(amount) {
  const sw = obiex.swap();
  const [sourceId, targetId] = await Promise.all([sw.getCurrencyIdByCode('USDT'), sw.getCurrencyIdByCode('USDC')]);
  const q = await sw.createQuote({ sourceId, targetId, amount, side: 'SELL' });
  if (!q.success) throw new Error(`QUOTE_FAILED: ${JSON.stringify(q.error)}`);
  const a = await sw.acceptQuote(q.quoteId);
  if (!a.success) throw new Error(`ACCEPT_FAILED: ${JSON.stringify(a.error)}`);
  // Obiex's response field names vary by endpoint version; take the first
  // explicit "received" amount, else amount × the quoted rate. If neither is
  // there we stop rather than guess what to credit.
  const d = { ...q.data, ...a.data };
  const explicit = [d.amountReceived, d.receivedAmount, d.targetAmount, d.amountOut].map(Number).find((n) => n > 0);
  const viaRate = Number(d.rate || d.price) > 0 ? amount * Number(d.rate || d.price) : null;
  const received = explicit || viaRate;
  if (!(received > 0)) throw new Error('SWAP_AMOUNT_UNKNOWN');
  return { receivedUsdc: round6(received), quoteId: q.quoteId, raw: d };
}

/**
 * From routes/obiexwebhooktrx.js for DEPOSIT events whose address isn't a
 * Bramp user's. Returns true if the address is a Metusela one.
 */
async function handleObiexDeposit({ address, network, currency, amount, status, transactionId, hash }) {
  const account = await MetuselaAccount.findOne({ 'depositAddresses.address': address });
  if (!account) return false;

  const cur = String(currency).toUpperCase();
  const net = normalizeNetwork(network);
  let dep = await MetuselaDeposit.findOneAndUpdate(
    { obiexTransactionId: transactionId },
    { $setOnInsert: { accountId: account._id, obiexTransactionId: transactionId, currency: cur, network: net, address, amount: Number(amount) }, ...(hash ? { $set: { txHash: hash } } : {}) },
    { upsert: true, new: true }
  );

  const s = String(status || '').toUpperCase();
  if (s !== 'CONFIRMED' && s !== 'SUCCESSFUL' && s !== 'COMPLETED') {
    if (dep.status === 'PENDING') notifyMetusela('wallet.deposit_pending', { partnerUserId: account.partnerUserId, deposit: serializeDeposit(dep) });
    return true;
  }

  // Claim crediting once (Obiex may resend CONFIRMED).
  dep = await MetuselaDeposit.findOneAndUpdate({ _id: dep._id, status: 'PENDING' }, { status: 'CONFIRMED' }, { new: true });
  if (!dep) return true;

  if (!['USDC', 'USDT'].includes(cur)) {
    await MetuselaDeposit.updateOne({ _id: dep._id }, { status: 'IGNORED', failureReason: `Unsupported currency ${cur}` });
    logger.error('Metusela: deposit in unsupported currency — needs manual handling', { transactionId, cur });
    return true;
  }

  const settings = await MetuselaSettings.get();
  const isPool = account.kind === 'POOL';

  // 1) USDT → USDC
  let gross = Number(amount);
  let swapFee = 0;
  if (cur === 'USDT') {
    try {
      const sw = await swapUsdtToUsdc(gross);
      gross = sw.receivedUsdc;
      if (!isPool) swapFee = floor2(gross * settings.usdtSwapMarkupBps / 10000);
      await MetuselaDeposit.updateOne({ _id: dep._id }, { swap: { quoteId: sw.quoteId, receivedUsdc: sw.receivedUsdc, raw: sw.raw } });
    } catch (err) {
      await MetuselaDeposit.updateOne({ _id: dep._id }, { status: 'SWAP_FAILED', failureReason: err.message });
      logger.error('Metusela: USDT→USDC swap failed — deposit held for review', { transactionId, error: err.message });
      notifyMetusela('wallet.deposit_held', { partnerUserId: account.partnerUserId, reason: 'SWAP_FAILED', obiexTransactionId: transactionId });
      return true;
    }
  }

  // 2) Fees (none on the POOL's own float returns)
  const depositFee = isPool ? 0 : floor2(settings.depositFeeFlatUsdc + gross * settings.depositFeeBps / 10000);
  const fee = round6(depositFee + swapFee);
  const credited = round6(gross - fee);
  if (!(credited > 0)) {
    await MetuselaDeposit.updateOne({ _id: dep._id }, { status: 'BELOW_FEE', grossUsdc: gross, feeUsdc: fee, failureReason: 'Deposit smaller than the fee' });
    notifyMetusela('wallet.deposit_held', { partnerUserId: account.partnerUserId, reason: 'BELOW_FEE', obiexTransactionId: transactionId });
    return true;
  }

  // 3) Credit gross, then take fees — each a separate, idempotent transfer.
  const ref = `dep:${transactionId}`;
  await transfer({ reference: ref, type: isPool ? 'FLOAT_RETURN' : 'DEPOSIT', toId: account._id, amount: gross, meta: { currency: cur, network: net, txHash: hash || null } });
  if (fee > 0) {
    const fees = await systemAccount('FEES');
    if (depositFee > 0) await transfer({ reference: `${ref}:fee`, type: 'DEPOSIT_FEE', fromId: account._id, toId: fees._id, amount: depositFee });
    if (swapFee > 0) await transfer({ reference: `${ref}:swapfee`, type: 'SWAP_FEE', fromId: account._id, toId: fees._id, amount: swapFee });
  }

  const done = await MetuselaDeposit.findOneAndUpdate(
    { _id: dep._id },
    { status: 'CREDITED', grossUsdc: gross, feeUsdc: fee, creditedUsdc: credited, creditedAt: new Date() },
    { new: true }
  );
  const fresh = await MetuselaAccount.findById(account._id);
  logger.info('Metusela deposit credited', { kind: account.kind, partnerUserId: account.partnerUserId, cur, net, gross, fee, credited });
  notifyMetusela(isPool ? 'pool.float_returned' : 'wallet.deposit_credited', {
    partnerUserId: account.partnerUserId, deposit: serializeDeposit(done), usdcBalance: round6(fresh.usdcBalance),
  });
  return true;
}

function serializeDeposit(d) {
  return {
    obiexTransactionId: d.obiexTransactionId, currency: d.currency, network: d.network, amount: d.amount,
    txHash: d.txHash, status: d.status, grossUsdc: d.grossUsdc, feeUsdc: d.feeUsdc, creditedUsdc: d.creditedUsdc,
    createdAt: d.createdAt, creditedAt: d.creditedAt,
  };
}

// ── Bets ───────────────────────────────────────────────────────────────────

/** Stake for a call/tail/fade: user → POOL. Idempotent on reference. */
async function stake(partnerUserId, { reference, amountUsdc }) {
  const s = await MetuselaSettings.get();
  if (!s.betsEnabled) throw new WalletError('Betting is paused.', 503);
  const account = await getUserAccount(partnerUserId);
  const pool = await systemAccount('POOL');
  await transfer({ reference: `stake:${reference}`, type: 'BET_STAKE', fromId: account._id, toId: pool._id, amount: amountUsdc });
  return MetuselaAccount.findById(account._id);
}

/** Winnings (PAYOUT) or a returned stake (REFUND): POOL → user. */
async function credit(partnerUserId, { reference, amountUsdc, kind = 'PAYOUT' }) {
  if (!['PAYOUT', 'REFUND'].includes(kind)) throw new WalletError('kind must be PAYOUT or REFUND.');
  const account = await getUserAccount(partnerUserId);
  const pool = await systemAccount('POOL');
  await transfer({
    reference: `${kind.toLowerCase()}:${reference}`, type: kind === 'PAYOUT' ? 'BET_PAYOUT' : 'BET_REFUND',
    fromId: pool._id, toId: account._id, amount: amountUsdc, allowNegative: true,
  });
  return MetuselaAccount.findById(account._id);
}

// ── Withdrawals & float top-ups (Obiex) ────────────────────────────────────

/** USDC terms for a network, or a clear error. Accepts common names. */
async function usdcNetwork(network, settings) {
  const code = normalizeNetwork(network);
  const t = (await availableTerms('USDC', { settings })).find((x) => x.code === code);
  if (!t) throw new WalletError(`USDC withdrawals on ${code} aren't available.`);
  return t;
}

function checkAddress(terms, address) {
  const re = terms.addressRegex ? new RegExp(terms.addressRegex) : ADDRESS_FORMATS[terms.code];
  if (re && !re.test(String(address || ''))) throw new WalletError(`That address is not valid for ${terms.name}.`);
}

/**
 * What a withdrawal costs and delivers. The user is debited amount + our
 * fee; Obiex takes its network fee out of the amount, so the recipient gets
 * amount − network fee.
 */
async function quoteWithdrawal({ amountUsdc, network }) {
  const s = await MetuselaSettings.get();
  const t = await usdcNetwork(network, s);
  const amount = round6(Number(amountUsdc));
  const minimum = Math.max(s.minWithdrawalUsdc, Number(t.minWithdrawal));
  const networkFee = Number(t.withdrawalFee);
  const platformFee = round6(s.withdrawalFeeFlatUsdc);
  return {
    network: t.code,
    networkName: t.name,
    amountUsdc: amount,
    minimumUsdc: minimum,
    networkFeeUsdc: networkFee,
    platformFeeUsdc: platformFee,
    totalDebitedUsdc: round6(amount + platformFee),
    recipientReceivesUsdc: round6(amount - networkFee),
    ok: Number.isFinite(amount) && amount >= minimum && amount - networkFee > 0,
  };
}

/** Withdrawal networks for USDC with their minimums and fees. */
async function withdrawalNetworks() {
  const s = await MetuselaSettings.get();
  const terms = await availableTerms('USDC', { settings: s });
  return terms.map((t) => ({
    code: t.code,
    name: t.name,
    minimumUsdc: Math.max(s.minWithdrawalUsdc, Number(t.minWithdrawal)),
    networkFeeUsdc: Number(t.withdrawalFee),
    platformFeeUsdc: round6(s.withdrawalFeeFlatUsdc),
  })).sort((a, b) => a.networkFeeUsdc - b.networkFeeUsdc);
}

/**
 * Withdraw USDC on-chain. The user pays `amountUsdc` + our flat fee;
 * Obiex's own network fee comes out of what's sent. On failure the user
 * is refunded in full.
 */
async function withdraw(partnerUserId, { reference, amountUsdc, network, address }) {
  const s = await MetuselaSettings.get();
  if (!s.withdrawalsEnabled) throw new WalletError('Withdrawals are paused.', 503);
  const q = await quoteWithdrawal({ amountUsdc, network });
  if (!q.ok) throw new WalletError(`Minimum withdrawal on ${q.networkName} is ${q.minimumUsdc} USDC.`);
  checkAddress(await usdcNetwork(q.network, s), address);

  const ref = `wd:${reference}`;
  const existing = await MetuselaWithdrawal.findOne({ reference: ref });
  if (existing) return existing;

  const account = await getUserAccount(partnerUserId);
  await transfer({ reference: ref, type: 'WITHDRAWAL', fromId: account._id, amount: q.amountUsdc, meta: { network: q.network, address } });
  if (q.platformFeeUsdc > 0) {
    const fees = await systemAccount('FEES');
    try {
      await transfer({ reference: `${ref}:fee`, type: 'WITHDRAWAL_FEE', fromId: account._id, toId: fees._id, amount: q.platformFeeUsdc });
    } catch (err) {
      await transfer({ reference: `${ref}:reversal`, type: 'WITHDRAWAL_REVERSAL', toId: account._id, amount: q.amountUsdc });
      throw err;
    }
  }

  const w = await MetuselaWithdrawal.create({
    kind: 'USER', accountId: account._id, reference: ref, network: q.network, address,
    amountUsdc: q.amountUsdc, feeUsdc: q.platformFeeUsdc, networkFeeUsdc: q.networkFeeUsdc, recipientReceivesUsdc: q.recipientReceivesUsdc,
  });
  return submitToObiex(w);
}

/** Send POOL funds to Metusela's Polymarket wallet (its bridge address). */
async function floatTopup({ reference, amountUsdc, network, address }) {
  const q = await quoteWithdrawal({ amountUsdc, network });
  if (!(q.amountUsdc >= q.minimumUsdc) || !(q.recipientReceivesUsdc > 0)) {
    throw new WalletError(`Minimum on ${q.networkName} is ${q.minimumUsdc} USDC.`);
  }
  checkAddress(await usdcNetwork(q.network), address);

  const ref = `float:${reference}`;
  const existing = await MetuselaWithdrawal.findOne({ reference: ref });
  if (existing) return existing;

  const pool = await systemAccount('POOL');
  await transfer({ reference: ref, type: 'FLOAT_TOPUP', fromId: pool._id, amount: q.amountUsdc, allowNegative: true, meta: { network: q.network, address } });
  const w = await MetuselaWithdrawal.create({
    kind: 'FLOAT_TOPUP', accountId: pool._id, reference: ref, network: q.network, address,
    amountUsdc: q.amountUsdc, networkFeeUsdc: q.networkFeeUsdc, recipientReceivesUsdc: q.recipientReceivesUsdc,
  });
  return submitToObiex(w);
}

async function submitToObiex(w) {
  const result = await obiex.withdraw().withdrawUSDC(w.address, w.amountUsdc, w.network, `Metusela ${w.reference.slice(-12)}`);
  if (result.success) {
    return MetuselaWithdrawal.findOneAndUpdate({ _id: w._id }, { obiexWithdrawalId: result.transactionId }, { new: true });
  }
  await failWithdrawal(w, `OBIEX: ${result.error}`);
  throw new WalletError(`Withdrawal failed: ${result.error}`, 502);
}

/** Mark failed and give the money back (amount + our fee). Idempotent. */
async function failWithdrawal(w, reason) {
  const failed = await MetuselaWithdrawal.findOneAndUpdate(
    { _id: w._id, status: 'SUBMITTED' }, { status: 'FAILED', failureReason: reason }, { new: true }
  );
  if (!failed) return null;
  const isFloat = failed.kind === 'FLOAT_TOPUP';
  await transfer({
    reference: `${failed.reference}:reversal`, type: isFloat ? 'FLOAT_TOPUP_REVERSAL' : 'WITHDRAWAL_REVERSAL',
    toId: failed.accountId, amount: failed.amountUsdc,
  });
  if (failed.feeUsdc > 0) {
    const fees = await systemAccount('FEES');
    await transfer({ reference: `${failed.reference}:fee:reversal`, type: 'WITHDRAWAL_FEE_REVERSAL', fromId: fees._id, toId: failed.accountId, amount: failed.feeUsdc, allowNegative: true });
  }
  const account = await MetuselaAccount.findById(failed.accountId);
  notifyMetusela(isFloat ? 'pool.float_topup_failed' : 'wallet.withdrawal_failed', {
    partnerUserId: account.partnerUserId, withdrawal: serializeWithdrawal(failed), usdcBalance: round6(account.usdcBalance),
  });
  return failed;
}

/**
 * From routes/obiexwebhooktrx.js for WITHDRAWAL events. Returns true if
 * the withdrawal is a Metusela one.
 */
async function handleObiexWithdrawal({ transactionId, status, hash }) {
  const w = await MetuselaWithdrawal.findOne({ obiexWithdrawalId: transactionId });
  if (!w) return false;
  const s = String(status || '').toUpperCase();
  if (['SUCCESSFUL', 'CONFIRMED', 'COMPLETED'].includes(s)) {
    const done = await MetuselaWithdrawal.findOneAndUpdate(
      { _id: w._id, status: 'SUBMITTED' }, { status: 'COMPLETED', txHash: hash || null, completedAt: new Date() }, { new: true }
    );
    if (done) {
      const account = await MetuselaAccount.findById(done.accountId);
      notifyMetusela(done.kind === 'FLOAT_TOPUP' ? 'pool.float_topup_completed' : 'wallet.withdrawal_completed', {
        partnerUserId: account.partnerUserId, withdrawal: serializeWithdrawal(done), usdcBalance: round6(account.usdcBalance),
      });
    }
  } else if (['FAILED', 'REJECTED', 'CANCELLED'].includes(s)) {
    await failWithdrawal(w, `OBIEX_${s}`);
  }
  return true;
}

function serializeWithdrawal(w) {
  return {
    reference: w.reference, kind: w.kind, network: w.network, address: w.address, amountUsdc: w.amountUsdc,
    feeUsdc: w.feeUsdc, networkFeeUsdc: w.networkFeeUsdc, recipientReceivesUsdc: w.recipientReceivesUsdc, status: w.status, txHash: w.txHash, failureReason: w.failureReason,
    createdAt: w.createdAt, completedAt: w.completedAt,
  };
}

async function history(account, { limit = 50 } = {}) {
  const transfers = await MetuselaTransfer.find({ $or: [{ fromAccountId: account._id }, { toAccountId: account._id }], status: 'DONE' })
    .sort({ createdAt: -1 }).limit(Math.min(limit, 200));
  return transfers.map((t) => ({
    reference: t.reference,
    type: t.type,
    // Signed from this account's point of view.
    amountUsdc: String(t.toAccountId) === String(account._id) ? t.amountUsdc : -t.amountUsdc,
    meta: t.meta,
    createdAt: t.createdAt,
  }));
}

module.exports = {
  WalletError, ensureAccount, getUserAccount, serializeAccount, systemAccount,
  transfer, obiexNetworks, availableTerms, depositOptions, depositAddress,
  quoteWithdrawal, withdrawalNetworks,
  handleObiexDeposit, handleObiexWithdrawal, serializeDeposit, serializeWithdrawal,
  stake, credit, withdraw, floatTopup, history,
};
