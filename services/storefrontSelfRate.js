// services/storefrontSelfRate.js
// Self rate (spec, 17 Nov 2026): a trader pays storefront customers at their
// own rate, from their own NGNB balance. Because they pay third parties,
// Bramp checks the business first: Bramp KYC, CAC lookup (Dojah), the trader
// is a director or proprietor, and a business bank account in the registered
// name. A Bramp admin reviews the checks, approves or rejects, and sets the
// monthly payout limit.
const axios = require('axios');
const User = require('../models/user');
const KYC = require('../models/kyc');
const StorefrontMerchant = require('../models/storefrontMerchant');
const banks = require('./storefrontBanks');
const { namesMatch, namesSimilar } = require('../utils/kycHelpers');
const logger = require('../utils/logger');

const COMPANY_TYPES = ['BUSINESS_NAME', 'COMPANY', 'INCORPORATED_TRUSTEES', 'LIMITED_PARTNERSHIP', 'LIMITED_LIABILITY_PARTNERSHIP'];
const OWNER_ROLES = /DIRECTOR|PROPRIETOR|PARTNER|TRUSTEE/i;
const COINS = ['USDT', 'USDC'];

class SelfRateError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const cfg = () => ({
  feeNgn: Number(process.env.STOREFRONT_SELF_FEE_NGN || 0),
  // Quoting stops when the trader's NGNB is below this (a payout couldn't be covered).
  minCoverNgn: Number(process.env.STOREFRONT_SELF_MIN_COVER_NGN || 5000),
  // A rate further than this from Bramp's is refused as a likely typo.
  maxRateDeviation: Number(process.env.STOREFRONT_SELF_MAX_RATE_DEVIATION || 0.5),
});

const feeFor = (merchant) => (merchant.selfRate?.feeNgn ?? null) !== null ? merchant.selfRate.feeNgn : cfg().feeNgn;

// ── Checks ─────────────────────────────────────────────────────────────────

/** Dojah's advanced CAC lookup: company name, status, type and affiliates. */
async function lookupCac(rcNumber, companyType) {
  const res = await axios.get(`${process.env.DOJAH_API_URL || 'https://api.dojah.io'}/api/v1/kyc/cac/advance`, {
    params: { rc_number: rcNumber, company_type: companyType },
    headers: { Authorization: process.env.DOJAH_SECRET_KEY, AppId: process.env.DOJAH_APP_ID },
    timeout: 20000,
  });
  return res.data?.entity || null;
}

const LEGAL_WORDS = /\b(ltd|limited|plc|llc|llp|nig|nigeria|company|co|enterprises?|ventures?|global|services?|int'?l|international)\b/g;
const businessName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(LEGAL_WORDS, ' ').replace(/\s+/g, ' ').trim();

/** The bank account name is the registered business name (banks truncate and abbreviate). */
function businessNamesMatch(accountName, companyName) {
  const a = businessName(accountName);
  const c = businessName(companyName);
  if (!a || !c) return false;
  return namesMatch(a, c) || namesSimilar(a, c, 0.9);
}

/** The trader's verified names: their profile (set by app KYC) and their latest approved KYC record. */
async function verifiedNames(user) {
  const names = [[user.firstname, user.middlename, user.lastname].filter(Boolean).join(' ')];
  const kyc = await KYC.findOne({ userId: user._id, status: 'APPROVED' }).sort({ updatedAt: -1 }).select('fullName firstName middleName lastName').lean().catch(() => null);
  if (kyc) names.push(kyc.fullName || [kyc.firstName, kyc.middleName, kyc.lastName].filter(Boolean).join(' '));
  return names.filter((n) => n && n.trim());
}

/** Run every automatic check; never throws (a provider error is recorded as a failed check). */
async function runChecks(merchant) {
  const app = merchant.selfRate.application;
  const user = await User.findById(merchant.userId).select('firstname middlename lastname kycLevel kycStatus');
  const checks = { ranAt: new Date() };

  checks.kyc = { ok: (user?.kycLevel || 0) >= 2, level: user?.kycLevel || 0 };

  let entity = null;
  try {
    entity = await lookupCac(app.cacNumber, app.companyType);
    checks.cac = entity?.company_name
      ? { ok: !/inactive|struck|dissolved|wound/i.test(entity.status || ''), companyName: entity.company_name, companyStatus: entity.status || null, companyType: entity.type_of_company || null }
      : { ok: false, error: 'No company found for that number and type' };
  } catch (err) {
    checks.cac = { ok: false, error: `CAC lookup failed: ${err.response?.status || err.message}` };
  }

  const names = user ? await verifiedNames(user) : [];
  const owners = (entity?.affiliates || []).filter((a) => OWNER_ROLES.test(a.affiliate_type || ''));
  const match = owners.find((a) => names.some((n) => namesMatch(n, `${a.first_name || ''} ${a.last_name || ''}`)));
  checks.director = match
    ? { ok: true, matchedName: `${match.first_name} ${match.last_name}`.trim(), role: match.affiliate_type, traderName: names[0] || null }
    : { ok: false, traderName: names[0] || null };

  const acctName = app.businessAccount?.accountName;
  checks.bankName = { ok: !!(acctName && checks.cac.companyName && businessNamesMatch(acctName, checks.cac.companyName)), accountName: acctName || null };

  return checks;
}

// ── Trader: apply, rates ───────────────────────────────────────────────────

/**
 * The trader's Self rate application: CAC number and type, business bank
 * account, expected monthly volume and source of funds. Runs the automatic
 * checks and puts the application in front of Bramp (PENDING).
 */
async function apply(merchant, body = {}) {
  if (merchant.selfRate?.status === 'APPROVED') throw new SelfRateError('Self rate is already approved for this storefront.', 409);
  if (merchant.selfRate?.status === 'PENDING') throw new SelfRateError('Your application is being reviewed.', 409);

  const cacNumber = String(body.cacNumber || '').trim().toUpperCase().replace(/^(RC|BN)\s*/, '');
  if (!/^\d{4,10}$/.test(cacNumber)) throw new SelfRateError('Enter the CAC registration number (RC or BN), digits only.');
  const companyType = String(body.companyType || '').trim().toUpperCase();
  if (!COMPANY_TYPES.includes(companyType)) throw new SelfRateError(`companyType must be one of: ${COMPANY_TYPES.join(', ')}.`);
  const volume = Number(body.expectedMonthlyVolumeNgn);
  if (!(volume > 0)) throw new SelfRateError('Enter your expected monthly volume in naira.');
  const sourceOfFunds = String(body.sourceOfFunds || '').trim();
  if (sourceOfFunds.length < 3 || sourceOfFunds.length > 500) throw new SelfRateError('Describe your source of funds (3 to 500 characters).');

  const accountNumber = String(body.accountNumber || '').replace(/\D/g, '');
  const accountName = await banks.resolveAccount(body.bankCode, accountNumber);
  if (!accountName) throw new SelfRateError('That business bank account could not be verified.');
  const bank = (await banks.listBanks()).find((b) => b.code === String(body.bankCode));

  merchant.selfRate.application = {
    cacNumber, companyType,
    businessAccount: { bankCode: String(body.bankCode), bankName: bank?.name || 'Bank', accountNumber, accountName },
    expectedMonthlyVolumeNgn: volume, sourceOfFunds, submittedAt: new Date(),
  };
  merchant.selfRate.application.checks = await runChecks(merchant);
  merchant.selfRate.status = 'PENDING';
  merchant.selfRate.decision = { by: null, at: null, reason: null };
  await merchant.save();
  logger.info('Storefront self rate: application submitted', { merchant: merchant.slug, checks: summarize(merchant.selfRate.application.checks) });
  return view(merchant);
}

/** The trader's own rates (naira per coin). A rate far from Bramp's is refused as a likely typo. */
async function setRates(merchant, rates = {}) {
  const { getSellQuote } = require('../routes/sell');
  for (const coin of COINS) {
    if (rates[coin] === undefined) continue;
    if (rates[coin] === null) { merchant.selfRate.rates[coin] = null; continue; }
    const r = Number(rates[coin]);
    if (!(r > 0)) throw new SelfRateError(`${coin} rate must be a positive number of naira.`);
    const q = await getSellQuote({ token: coin, amount: 0 });
    const ref = Number(q.rate);
    const dev = cfg().maxRateDeviation;
    if (ref > 0 && (r > ref * (1 + dev) || r < ref * (1 - dev))) {
      throw new SelfRateError(`₦${r.toLocaleString('en-NG')} per ${coin} looks wrong (Bramp's is about ₦${Math.round(ref).toLocaleString('en-NG')}). Check the number.`);
    }
    merchant.selfRate.rates[coin] = Math.floor(r * 100) / 100;
  }
  await merchant.save();
  return view(merchant);
}

const summarize = (c = {}) => ({ kyc: !!c.kyc?.ok, cac: !!c.cac?.ok, director: !!c.director?.ok, bankName: !!c.bankName?.ok });

/** What the trader sees. */
function view(merchant) {
  const sr = merchant.selfRate || {};
  const app = sr.application || {};
  return {
    status: sr.status || 'NONE',
    rates: { USDT: sr.rates?.USDT ?? null, USDC: sr.rates?.USDC ?? null },
    payoutLimitNgn: sr.payoutLimitNgn || 0,
    feeNgn: feeFor(merchant),
    application: app.submittedAt ? {
      cacNumber: app.cacNumber, companyType: app.companyType,
      businessAccount: app.businessAccount ? { bankName: app.businessAccount.bankName, accountNumber: app.businessAccount.accountNumber, accountName: app.businessAccount.accountName } : null,
      expectedMonthlyVolumeNgn: app.expectedMonthlyVolumeNgn, submittedAt: app.submittedAt,
      checks: summarize(app.checks),
    } : null,
    decision: sr.decision?.at ? { at: sr.decision.at, reason: sr.decision.reason } : null,
  };
}

// ── Admin ──────────────────────────────────────────────────────────────────

async function recheck(merchant) {
  if (!merchant.selfRate?.application?.submittedAt) throw new SelfRateError('No application to check.', 404);
  merchant.selfRate.application.checks = await runChecks(merchant);
  await merchant.save();
  return merchant.selfRate.application.checks;
}

/** Approve: Self rate available, with a monthly payout limit (and optionally a fee for this desk). */
async function approve(merchant, { payoutLimitNgn, feeNgn } = {}, by) {
  if (merchant.selfRate?.status !== 'PENDING') throw new SelfRateError('Only a pending application can be approved.', 409);
  const limit = Number(payoutLimitNgn);
  if (!(limit > 0)) throw new SelfRateError('Set a monthly payout limit in naira.');
  if (feeNgn !== undefined && feeNgn !== null && !(Number(feeNgn) >= 0)) throw new SelfRateError('feeNgn must be 0 or more.');
  merchant.selfRate.status = 'APPROVED';
  merchant.selfRate.payoutLimitNgn = limit;
  if (feeNgn !== undefined) merchant.selfRate.feeNgn = feeNgn === null ? null : Number(feeNgn);
  merchant.selfRate.decision = { by, at: new Date(), reason: null };
  await merchant.save();
  return merchant;
}

/** Reject, with the reason the trader will see. Turns Self rate off if it was on. */
async function reject(merchant, { reason } = {}, by) {
  const why = String(reason || '').trim();
  if (why.length < 3) throw new SelfRateError('Give the reason the trader will see.');
  if (!['PENDING', 'APPROVED'].includes(merchant.selfRate?.status)) throw new SelfRateError('Nothing to reject.', 409);
  merchant.selfRate.status = 'REJECTED';
  merchant.selfRate.decision = { by, at: new Date(), reason: why.slice(0, 300) };
  if (merchant.rateMode === 'SELF') merchant.rateMode = 'BRAMP';
  await merchant.save();
  return merchant;
}

module.exports = {
  COMPANY_TYPES, apply, setRates, view, recheck, approve, reject, runChecks, businessNamesMatch, feeFor, cfg, SelfRateError,
  _lookupCac: lookupCac,
};
