// models/storefrontSettings.js
// Storefront platform controls, one document (key 'global'), edited in
// bramp-admin (adminRoutes/storefrontOfframp.js /settings) and read through
// services/storefrontSettings.js. Values left null fall back to the env
// defaults, so an empty document changes nothing.
const mongoose = require('mongoose');

const storefrontSettingsSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, default: 'global' },

  // Kill switch. selling: no new quotes, addresses or sales (Stella says
  // message). payouts: deposits that arrive are held, not paid, until it's off.
  killSwitch: {
    selling: { type: Boolean, default: false },
    payouts: { type: Boolean, default: false },
    message: { type: String, default: null, maxlength: 300 },
    by: { type: String, default: null },
    at: { type: Date, default: null },
  },

  // Coin + network pairs not on sale, as 'USDT:ETH'. Deposits already sent still settle.
  disabledPairs: { type: [String], default: [] },

  // Overrides of the env defaults (null = use the default).
  values: {
    selfFeePct: { type: Number, default: null, min: 0, max: 5 },
    selfFeeMinNgn: { type: Number, default: null, min: 0 },
    selfFeeMaxNgn: { type: Number, default: null, min: 0 },
    selfMinCoverNgn: { type: Number, default: null, min: 0 },
    maxMarkdownNgnPerUsd: { type: Number, default: null, min: 0 },
    newDeskPerTradeMaxNgn: { type: Number, default: null, min: 0 },
    newDeskDailyMaxNgn: { type: Number, default: null, min: 0 },
    largeTradeNgn: { type: Number, default: null, min: 0 },
    velocityCount: { type: Number, default: null, min: 0 },
    velocityWindowMinutes: { type: Number, default: null, min: 1 },
  },
}, { timestamps: true });

module.exports = mongoose.models.StorefrontSettings || mongoose.model('StorefrontSettings', storefrontSettingsSchema);
