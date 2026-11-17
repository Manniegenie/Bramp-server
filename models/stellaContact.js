// models/stellaContact.js
// A WhatsApp number talking to Stella, and the desk it trades with. Storefront
// customers need no Bramp account (spec, 17 Nov 2026), so this replaces
// StellaCustomer (which requires one) for routing. The desk fields mirror
// StellaCustomer's so AI/stellaRouter.js works on either.
const mongoose = require('mongoose');

const stellaContactSchema = new mongoose.Schema({
  waId: { type: String, required: true, unique: true }, // digits only
  displayName: { type: String, default: null, maxlength: 100 },

  // The sticky desk: changes only when the customer explicitly switches.
  deskId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', default: null, index: true },
  deskSetVia: { type: String, enum: ['ENTRY', 'MENTION', 'SWITCH', null], default: null },
  deskSetAt: { type: Date, default: null },
  firstDeskId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', default: null },
  deskHistory: {
    type: [{
      _id: false,
      fromDeskId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', default: null },
      toDeskId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', required: true },
      via: { type: String, required: true },
      changedAt: { type: Date, default: Date.now },
    }],
    default: [],
  },
}, {
  timestamps: true,
});

module.exports = mongoose.models.StellaContact || mongoose.model('StellaContact', stellaContactSchema);
