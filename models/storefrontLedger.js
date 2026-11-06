const mongoose = require('mongoose');

// A trader's storefront proceeds, held before they reach their Bramp NGNB
// balance (services/storefrontLedger.js). Each completed order credits one
// HELD entry, released holdDays later; a recall reverses it, or what it
// can't cover is added to the merchant's owedNgn.
const storefrontLedgerSchema = new mongoose.Schema({
  merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', required: true, index: true },
  reference: { type: String, required: true, unique: true }, // `margin:<order reference>`: one credit per order
  orderReference: { type: String, required: true, index: true },
  amountNgn: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['HELD', 'RELEASED', 'REVERSED'], default: 'HELD', index: true },
  availableAt: { type: Date, required: true, index: true },
  releasedAt: { type: Date, default: null },
  reversedAt: { type: Date, default: null },
  note: { type: String, default: null },
}, { timestamps: true });

module.exports = mongoose.models.StorefrontLedger || mongoose.model('StorefrontLedger', storefrontLedgerSchema);
