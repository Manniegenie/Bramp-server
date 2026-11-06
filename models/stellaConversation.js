const mongoose = require('mongoose');

// Where each WhatsApp number is in its conversation with Stella
// (AI/stellaCustomers.js). Kept in Mongo so a restart never loses a
// half-finished sign-up. Takeover and the order in progress are added in
// later milestones.
//
// Sign-up:  NEW → SIGNUP_NAME → SIGNUP_EMAIL → SIGNUP_CODE → READY
// Link:     NEW → LINK_CONFIRM → SIGNUP_CODE → READY   (number already on a Bramp account)
const stellaConversationSchema = new mongoose.Schema({
  waId: { type: String, required: true, unique: true },
  state: {
    type: String,
    enum: ['NEW', 'SIGNUP_NAME', 'SIGNUP_EMAIL', 'SIGNUP_CODE', 'LINK_CONFIRM', 'READY'],
    default: 'NEW',
  },
  // Customer-service window: free-form replies are allowed for 24 hours
  // after the customer's last message; after that only templates.
  lastInboundAt: { type: Date, default: null },

  // Desk routing (AI/stellaRouter.js).
  entryDeskSlug: { type: String, default: null }, // @desk in a message before they were set up; applied once verified
  awaitingDesk: { type: String, enum: ['CHOOSE', 'SWITCH', 'ONCE', null], default: null }, // waiting for an @username, and why
  pendingSwitch: {
    deskId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', default: null },
    askedAt: { type: Date, default: null },
  },
  // "Another desk, this trade only": used by the next order (M9), never
  // touches the customer's own desk.
  tradeDesk: {
    deskId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', default: null },
    until: { type: Date, default: null },
  },

  signup: {
    firstname: { type: String, default: null },
    middlename: { type: String, default: '' },
    lastname: { type: String, default: null },
    email: { type: String, default: null },
    linkUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // existing account to link instead of creating one
    codeHash: { type: String, default: null }, // sha256(waId:code)
    codeExpiresAt: { type: Date, default: null },
    attempts: { type: Number, default: 0 }, // wrong codes for the current code
    codesSentAt: { type: [Date], default: [] }, // for the per-hour limit
  },
}, { timestamps: true });

module.exports = mongoose.models.StellaConversation || mongoose.model('StellaConversation', stellaConversationSchema);
