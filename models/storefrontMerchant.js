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
}, { timestamps: true });

module.exports = mongoose.models.StorefrontMerchant || mongoose.model('StorefrontMerchant', storefrontMerchantSchema);
