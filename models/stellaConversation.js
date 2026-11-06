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
