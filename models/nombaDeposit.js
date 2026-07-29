// models/nombaDeposit.js
// One row per Nomba virtual-account deposit. `nombaTransactionRef` is the
// idempotency key that makes webhook redelivery/replay safe — it MUST stay
// unique at the DB level (application-layer checks alone are not enough).
//
// Amounts are stored as integer kobo. Never floats.
const mongoose = require('mongoose');

const nombaDepositSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  virtualAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'VirtualAccount', required: true },
  nombaTransactionRef: { type: String, required: true, unique: true },
  amountKobo: { type: Number, required: true, min: 0 },
  feeKobo: { type: Number, default: 0, min: 0 },
  senderAccountNumber: { type: String },
  senderBank: { type: String },
  senderName: { type: String },
  status: {
    type: String,
    enum: ['pending', 'credited', 'failed', 'flagged'],
    default: 'pending',
    index: true,
  },
  creditedAt: { type: Date },
}, {
  timestamps: true,
});

nombaDepositSchema.index({ status: 1, createdAt: -1 });
nombaDepositSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.models.NombaDeposit || mongoose.model('NombaDeposit', nombaDepositSchema);
