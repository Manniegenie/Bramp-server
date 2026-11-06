const mongoose = require('mongoose');

// Every WhatsApp message Stella receives or sends (AI/whatsapp.js,
// AI/stellaSender.js). The unique waMessageId is the duplicate check: Meta
// retries webhooks, and an insert that hits the index means we've already
// handled that message, even across restarts. Outbound rows pick up Meta's
// delivery statuses, and orderReference ties a message's cost to an order.
const stellaMessageSchema = new mongoose.Schema({
  waMessageId: { type: String, required: true, unique: true },
  direction: { type: String, enum: ['IN', 'OUT'], required: true },
  waId: { type: String, required: true, index: true }, // the customer's WhatsApp ID (digits)
  type: { type: String, required: true }, // text, interactive, image, template...
  text: { type: String, default: null }, // text body, or the button/list title tapped
  replyId: { type: String, default: null }, // id of the button or list row tapped

  // Outbound only: sent → delivered → read, or failed.
  status: { type: String, enum: ['sent', 'delivered', 'read', 'failed', null], default: null },
  statusError: { type: String, default: null },

  orderReference: { type: String, default: null, index: true, sparse: true },
}, { timestamps: true });

stellaMessageSchema.index({ waId: 1, createdAt: -1 });

module.exports = mongoose.models.StellaMessage || mongoose.model('StellaMessage', stellaMessageSchema);
