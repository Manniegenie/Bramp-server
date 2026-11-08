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
  // Signed in from a new number (AI/stellaCustomers.js): the account moves
  // here with its desk; the numbers it left are kept.
  movedFrom: { type: [{ _id: false, waId: String, movedAt: Date }], default: [] },

  // The customer's desk (AI/stellaRouter.js). Sticky: set once and kept
  // until the customer explicitly switches; never changed by silence, a new
  // chat, the 24-hour window, a paused or closed desk, or a one-off trade
  // with another desk. Orders keep the desk they were created with.
  deskId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', default: null, index: true },
  deskSetVia: { type: String, enum: ['ENTRY', 'MENTION', 'SWITCH', null], default: null },
  deskSetAt: { type: Date, default: null },
  firstDeskId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', default: null }, // the desk that brought them
  deskHistory: {
    type: [{
      fromDeskId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', default: null },
      toDeskId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', required: true },
      via: { type: String, required: true },
      changedAt: { type: Date, default: Date.now },
    }],
    default: [],
  },

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
