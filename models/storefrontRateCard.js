const mongoose = require('mongoose');

// A desk's price for one coin and one side (spec §3.3). Desks own their
// prices: Bramp never sets them. Read by Stella (AI/stellaAgent.js) and set
// by the desk through the storefront API (PUT /storefront/rates).
//
// side is the customer's side: BUY = the customer buys crypto from the desk,
// SELL = the customer sells crypto to the desk.
//
// MANUAL is a fixed rate the desk types in. REFERENCE_MARGIN (a reference
// price plus the desk's margin, updated automatically) and the stale-rate
// auto-pause come with tracker M10.
const storefrontRateCardSchema = new mongoose.Schema({
  merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', required: true },
  asset: { type: String, enum: ['USDT', 'USDC'], required: true },
  side: { type: String, enum: ['BUY', 'SELL'], required: true },
  mode: { type: String, enum: ['MANUAL', 'REFERENCE_MARGIN'], default: 'MANUAL' },
  rateNgn: { type: Number, required: true, min: 0 }, // ₦ per 1 unit
  minNgn: { type: Number, default: null, min: 0 }, // per trade
  maxNgn: { type: Number, default: null, min: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

storefrontRateCardSchema.index({ merchantId: 1, asset: 1, side: 1 }, { unique: true });

module.exports = mongoose.models.StorefrontRateCard || mongoose.model('StorefrontRateCard', storefrontRateCardSchema);
