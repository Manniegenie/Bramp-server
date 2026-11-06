const mongoose = require('mongoose');

// A trader linking a Bramp Shop (name.bramp.shop) to their Bramp account.
// bramp.shop starts it with the trader's Bramp username and what they filled
// in at setup; the trader approves it in the Bramp app (with their PIN) or by
// typing the code we emailed them into bramp.shop. bramp.shop then completes
// it, which creates the StorefrontMerchant (models/storefrontMerchant.js).
//
//   PENDING → APPROVED → COMPLETED
//           ↘ DECLINED / EXPIRED
const storefrontLinkRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  username: { type: String, required: true }, // as the trader typed it on bramp.shop

  // What the trader set up on bramp.shop.
  slug: { type: String, required: true, lowercase: true, trim: true, index: true },
  brandName: { type: String, required: true, trim: true },
  whatsapp: { type: String, default: null }, // E.164, the number their customers reach them on

  // The setup agreement: the trader is responsible for who pays into their
  // storefront, and proceeds are held before they can be withdrawn.
  agreement: {
    version: { type: String, required: true },
    acceptedAt: { type: Date, required: true },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
  },

  status: { type: String, enum: ['PENDING', 'APPROVED', 'DECLINED', 'EXPIRED', 'COMPLETED'], default: 'PENDING', index: true },
  expiresAt: { type: Date, required: true },

  // bramp.shop keeps claimSecret in the trader's browser session; completing
  // needs it, so only the session that started the link can collect the key.
  claimHash: { type: String, required: true },

  // The emailed code, hashed. Wrong codes and wrong PINs both count.
  emailCodeHash: { type: String, required: true },
  emailSent: { type: Boolean, default: false },
  failedAttempts: { type: Number, default: 0 },

  approvedVia: { type: String, enum: ['APP', 'EMAIL', null], default: null },
  decidedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', default: null },
}, { timestamps: true });

storefrontLinkRequestSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.models.StorefrontLinkRequest || mongoose.model('StorefrontLinkRequest', storefrontLinkRequestSchema);
