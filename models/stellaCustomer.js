const mongoose = require('mongoose');

// A customer on Stella, Storefront's WhatsApp channel: their WhatsApp ID
// linked to the Bramp account that holds their KYC and wallet. Created by
// AI/stellaCustomers.js once the customer confirms their email with a code.
// Desk preference (the sticky @desk) is added in tracker M6.
const stellaCustomerSchema = new mongoose.Schema({
  waId: { type: String, required: true, unique: true }, // WhatsApp ID, digits only
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },

  // CREATED: Stella made this Bramp account, so the customer belongs to the
  // desk that brought them and Bramp doesn't market to them. LINKED: an
  // existing Bramp user connected WhatsApp to their account.
  source: { type: String, enum: ['CREATED', 'LINKED'], required: true },
  linkedAt: { type: Date, required: true, default: Date.now },

  // One-time identity check (AI/stellaKyc.js, routes/stellaVerify.js): a
  // link to bramp.shop/verify. Only one is live at a time; only its sha256
  // is kept. Each attempt is a paid Dojah check, so attempts are capped.
  verifyLink: {
    tokenHash: { type: String, default: null, index: true, sparse: true },
    expiresAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 },
    sentAt: { type: [Date], default: [] }, // for the per-day limit
  },
}, { timestamps: true });

module.exports = mongoose.models.StellaCustomer || mongoose.model('StellaCustomer', stellaCustomerSchema);
