// models/nombaWebhookEvent.js
// Raw log of every Nomba webhook delivery, persisted BEFORE processing so nothing
// is lost even if the process crashes mid-handling. The sweeper re-processes rows
// stuck in 'received'/'failed'.
const mongoose = require('mongoose');

const nombaWebhookEventSchema = new mongoose.Schema({
  eventId: { type: String, unique: true, sparse: true }, // Nomba's event id, if present
  eventType: { type: String },
  payload: { type: mongoose.Schema.Types.Mixed, required: true }, // raw body as received
  signatureValid: { type: Boolean, required: true },
  processingStatus: {
    type: String,
    enum: ['received', 'processed', 'skipped_duplicate', 'failed'],
    default: 'received',
    index: true,
  },
  attempts: { type: Number, default: 0 },
  error: { type: String },
  processedAt: { type: Date },
}, {
  timestamps: true,
});

nombaWebhookEventSchema.index({ processingStatus: 1, createdAt: -1 });

module.exports = mongoose.models.NombaWebhookEvent || mongoose.model('NombaWebhookEvent', nombaWebhookEventSchema);
