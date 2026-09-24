// models/glydeVirtualAccount.js
// Dedicated bank account (Glyde Virtual Accounts API) per user for
// bank-transfer deposits. Separate from models/virtualAccount.js (Nomba) -
// Glyde is intended to replace Nomba, but that cutover happens later; this
// model exists so the two providers' data never mix during the transition.
const mongoose = require('mongoose');

const glydeVirtualAccountSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  uid: { type: String, required: true, unique: true }, // Glyde's va_... identifier
  reference: { type: String, required: true, unique: true }, // our customer.reference sent to Glyde

  type: { type: String, enum: ['static', 'dynamic'], required: true },
  status: { type: String, enum: ['active', 'inactive'], default: 'active', index: true },

  accountNumber: { type: String, required: true },
  accountName: { type: String, required: true },
  bankName: { type: String },

  // static-only
  bvn: { type: String },

  // dynamic-only
  expectedAmount: { type: Number },
  expiresAt: { type: Date },

  raw: { type: mongoose.Schema.Types.Mixed }, // full Glyde response, for debugging
}, {
  timestamps: true,
});

module.exports = mongoose.models.GlydeVirtualAccount || mongoose.model('GlydeVirtualAccount', glydeVirtualAccountSchema);
