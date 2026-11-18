const crypto = require('crypto');
const mongoose = require('mongoose');

// A trader running an exchange on Bramp Storefront (name.bramp.shop). The
// trader is an ordinary Bramp user (KYC'd); this record holds what the
// storefront module needs on top: how they want payments from other people's
// accounts handled, their risk settings, and an API key if they have one.
// Their customers are theirs, not Bramp users: Bramp only sees each order's
// payer name and payout address (models/storefrontOrder.js).
const storefrontMerchantSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true }, // name in name.bramp.shop
  status: { type: String, enum: ['active', 'paused', 'closed'], default: 'active', index: true },
  // Who closed it: a trader can reopen a desk they closed, not one Bramp closed.
  closedBy: { type: String, enum: ['TRADER', 'ADMIN', null], default: null },
  closedAt: { type: Date, default: null },
  // Who paused it: only a desk the trader paused can be switched back on from
  // the app. ADMIN is bramp-admin; SYSTEM is a recall the trader still owes for.
  pausedBy: { type: String, enum: ['TRADER', 'ADMIN', 'SYSTEM', null], default: null },

  // Hosted stores have no key: bramp.shop acts for them with its own
  // platform key (auth/storefrontAuth.js). A key is issued only when a trader
  // calls us from outside bramp.shop (Pro server, WhatsApp bot).
  // X-Storefront-Key is `sfk_<keyId>_<secret>`; only sha256(secret) is kept.
  // No default: the sparse index skips stores without a key, not nulls.
  keyId: { type: String, unique: true, sparse: true },
  keyHash: { type: String },

  // Signed status webhooks go to the trader's storefront-api. The secret
  // only signs what we send; it's shown when a key is issued.
  webhookUrl: { type: String, default: null },
  webhookSecret: { type: String, required: true, default: () => crypto.randomBytes(32).toString('hex') },

  // Payer name doesn't match the name the customer gave at checkout:
  //   STRICT — always held for the trader
  //   REVIEW — held, the trader approves or rejects (default)
  //   AUTO   — released automatically up to autoLimitNgn, held above it
  mismatchPolicy: { type: String, enum: ['STRICT', 'REVIEW', 'AUTO'], default: 'REVIEW' },
  autoLimitNgn: { type: Number, default: 0, min: 0 },

  // Risk (admin-set). Proceeds are withdrawable holdDays after they land.
  // An AUTO trader's autoLimitNgn can't exceed depositNgn: on a one-time
  // account the whole payment sits with Bramp and only the margin is the
  // trader's, so the deposit is what covers a recall.
  holdDays: { type: Number, default: 3, min: 0 },
  depositNgn: { type: Number, default: 0, min: 0 },
  perTradeMaxNgn: { type: Number, default: 500000, min: 0 },
  dailyMaxNgn: { type: Number, default: 2000000, min: 0 },

  // Recalls the held balance couldn't cover. While above zero the
  // storefront is paused and later proceeds pay it down first.
  owedNgn: { type: Number, default: 0, min: 0 },

  // From Bramp Shop setup (models/storefrontLinkRequest.js). Admin-created
  // storefronts have no link request and may have no agreement yet.
  brandName: { type: String, default: null, trim: true },
  whatsapp: { type: String, default: null },
  agreement: {
    version: { type: String, default: null },
    acceptedAt: { type: Date, default: null },
    ip: { type: String, default: null },
  },
  linkRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontLinkRequest', default: null },

  // How Stella sounds for this desk (AI/stellaProfile.js checks it).
  stellaProfile: {
    greeting: { type: String, default: null },
    tone: { type: String, enum: ['friendly', 'formal', 'pidgin', 'brief', null], default: null },
    phrases: { type: [String], default: [] },
    faqs: { type: [{ _id: false, q: String, a: String }], default: [] },
    about: { type: String, default: null },
    updatedAt: { type: Date, default: null },
  },

  // Offramp (spec, 17 Nov 2026). BRAMP: customers get Bramp's rate minus the
  // markdown and the trader earns the markdown. SELF: the trader's own rate,
  // paid from their pre-funded NGN balance - only once selfRate.status is
  // APPROVED (Phase 2).
  rateMode: { type: String, enum: ['BRAMP', 'SELF', null], default: null },
  markdownNgnPerUsd: { type: Number, default: 0, min: 0 }, // naira per $1 below Bramp's rate
  // Self rate (services/storefrontSelfRate.js): the trader's own rate, paid
  // from their NGNB balance. Switched on only after Bramp approves the business.
  selfRate: {
    status: { type: String, enum: ['NONE', 'PENDING', 'APPROVED', 'REJECTED'], default: 'NONE', index: true },
    rates: { // naira per coin, set by the trader
      USDT: { type: Number, default: null, min: 0 },
      USDC: { type: Number, default: null, min: 0 },
      BTC: { type: Number, default: null, min: 0 },
      ETH: { type: Number, default: null, min: 0 },
      SOL: { type: Number, default: null, min: 0 },
      BNB: { type: Number, default: null, min: 0 },
    },
    payoutLimitNgn: { type: Number, default: 0, min: 0 }, // per calendar month, set at approval
    // Fee per payout: pct of the payout, between minNgn and maxNgn. null = the
    // default (STOREFRONT_SELF_FEE_PCT / _MIN_NGN / _MAX_NGN: 0.2%, ₦100, ₦50,000).
    fee: {
      pct: { type: Number, default: null, min: 0 },
      minNgn: { type: Number, default: null, min: 0 },
      maxNgn: { type: Number, default: null, min: 0 },
    },
    application: {
      cacNumber: { type: String, default: null },
      companyType: { type: String, default: null },
      businessAccount: {
        bankCode: { type: String, default: null },
        bankName: { type: String, default: null },
        accountNumber: { type: String, default: null },
        accountName: { type: String, default: null },
      },
      expectedMonthlyVolumeNgn: { type: Number, default: null },
      sourceOfFunds: { type: String, default: null, maxlength: 500 },
      submittedAt: { type: Date, default: null },
      // Automatic checks, for the admin's review.
      checks: {
        kyc: { ok: Boolean, level: Number },
        cac: { ok: Boolean, companyName: String, companyStatus: String, companyType: String, error: String },
        director: { ok: Boolean, matchedName: String, role: String, traderName: String },
        bankName: { ok: Boolean, accountName: String },
        ranAt: Date,
      },
    },
    decision: {
      by: { type: String, default: null },
      at: { type: Date, default: null },
      reason: { type: String, default: null },
    },
    lowBalanceNotifiedAt: { type: Date, default: null },
  },
}, { timestamps: true });

module.exports = mongoose.models.StorefrontMerchant || mongoose.model('StorefrontMerchant', storefrontMerchantSchema);
