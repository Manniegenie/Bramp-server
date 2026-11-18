// models/storefrontBlock.js
// A WhatsApp number or bank account Bramp won't trade with, at any desk.
// Stella ignores a blocked number, a blocked account can't be saved or paid,
// and a deposit from either is held for review (services/storefrontCompliance.js).
const mongoose = require('mongoose');

const KINDS = ['WHATSAPP', 'BANK_ACCOUNT'];

const storefrontBlockSchema = new mongoose.Schema({
  kind: { type: String, enum: KINDS, required: true },
  value: { type: String, required: true }, // digits: the WhatsApp number, or the 10-digit account number (any bank)
  reason: { type: String, required: true, maxlength: 500 },
  active: { type: Boolean, default: true },
  by: { type: String, required: true },
  liftedBy: { type: String, default: null },
  liftedAt: { type: Date, default: null },
}, { timestamps: true });

// One live block per value; lifted ones stay as history.
storefrontBlockSchema.index({ kind: 1, value: 1 }, { unique: true, partialFilterExpression: { active: true } });

storefrontBlockSchema.statics.KINDS = KINDS;

module.exports = mongoose.models.StorefrontBlock || mongoose.model('StorefrontBlock', storefrontBlockSchema);
