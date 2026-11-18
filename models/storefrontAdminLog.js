// models/storefrontAdminLog.js
// Every change an admin makes to Storefront from bramp-admin: who, what, to
// which desk, and why. Read back as a desk's history and the audit log.
const mongoose = require('mongoose');

const storefrontAdminLogSchema = new mongoose.Schema({
  action: { type: String, required: true, index: true }, // e.g. desk.status, block.add, settings.update
  by: { type: String, required: true, index: true },
  merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', default: null, index: true },
  slug: { type: String, default: null },
  target: { type: String, default: null }, // a sale reference, number, account or setting
  reason: { type: String, default: null, maxlength: 500 },
  details: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: { createdAt: true, updatedAt: false } });

storefrontAdminLogSchema.index({ createdAt: -1 });

module.exports = mongoose.models.StorefrontAdminLog || mongoose.model('StorefrontAdminLog', storefrontAdminLogSchema);
