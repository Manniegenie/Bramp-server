// models/storefrontAlert.js
// Something in a storefront sale an admin should look at: a large trade, or
// one WhatsApp number selling many times in a short window (across desks).
// Raised at settlement (services/storefrontCompliance.js); never blocks a sale.
const mongoose = require('mongoose');

const TYPES = ['LARGE_TRADE', 'VELOCITY'];

const storefrontAlertSchema = new mongoose.Schema({
  type: { type: String, enum: TYPES, required: true },
  merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', required: true, index: true },
  waId: { type: String, required: true, index: true },
  orderReference: { type: String, required: true },
  amountNgn: { type: Number, default: null },
  detail: { type: String, default: null, maxlength: 300 },
  status: { type: String, enum: ['OPEN', 'ACKNOWLEDGED'], default: 'OPEN', index: true },
  ackBy: { type: String, default: null },
  ackAt: { type: Date, default: null },
  ackNote: { type: String, default: null, maxlength: 500 },
}, { timestamps: true });

// One alert of each type per sale.
storefrontAlertSchema.index({ orderReference: 1, type: 1 }, { unique: true });

storefrontAlertSchema.statics.TYPES = TYPES;

module.exports = mongoose.models.StorefrontAlert || mongoose.model('StorefrontAlert', storefrontAlertSchema);
