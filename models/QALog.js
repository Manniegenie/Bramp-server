const mongoose = require('mongoose');

// Lives as its own collection in the main app database rather than a
// separate "QAlogs" database — ZeusODX-server hit a production
// MongoServerError (not authorized on QAlogs) because its DB user was
// never granted access to a standalone database via useDb(). Applying
// the same fix here proactively before this codebase hits the identical
// wall. Still its own collection, still gated behind the same
// super-admin-only /admin/qa-logs route either way.

const qaWithdrawalLogSchema = new mongoose.Schema(
  {
    withdrawalType: {
      type: String,
      enum: ['CRYPTO', 'NGNB', 'INTERNAL_USERNAME'],
      required: true,
      index: true,
    },
    route: { type: String, required: true, index: true },
    method: { type: String, required: true },

    userId: { type: String, index: true },
    username: { type: String, index: true },
    email: { type: String },

    requestBody: { type: mongoose.Schema.Types.Mixed },   // PIN / 2FA code redacted
    responseBody: { type: mongoose.Schema.Types.Mixed },
    statusCode: { type: Number, index: true },

    outcome: {
      type: String,
      enum: ['SUCCESS', 'BLOCKED', 'REJECTED', 'ERROR'],
      required: true,
      index: true,
    },
    outcomeReason: { type: String },

    amount: { type: Number },
    currency: { type: String, index: true },
    network: { type: String },
    fee: { type: Number },
    destinationSummary: { type: String }, // masked address / bank account
    transactionId: { type: String, index: true },
    reference: { type: String, index: true },
    idempotencyKey: { type: String },

    ipAddress: { type: String },
    userAgent: { type: String },
    country: { type: String },
    durationMs: { type: Number },

    // Shadow-mode fraud risk score — observational only, never enforced.
    // See services/fraudRiskEngine.js for weights/bands and the proof that
    // no single signal, or pair of signals, can reach riskBand HOLD/BLOCK.
    riskScore: { type: Number, index: true },
    riskBand: { type: String, enum: ['ALLOW', 'FLAG', 'HOLD', 'BLOCK'], index: true },
    riskSignals: { type: mongoose.Schema.Types.Mixed }, // [{ signal, weight, fired, detail? }]

    // Human disposition on a scored entry — record-keeping only. Nothing is
    // ever held or blocked in shadow mode, so "approve"/"reject" here means
    // "reviewed, looks fine" vs "reviewed, this looks like real fraud" for
    // QA/compliance tracking, not a release/reversal of a completed transfer.
    reviewStatus: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING', index: true },
    reviewedBy: { type: String },
    reviewedAt: { type: Date },
    reviewNotes: { type: String },
  },
  { timestamps: true }
);

qaWithdrawalLogSchema.index({ createdAt: -1 });
qaWithdrawalLogSchema.index({ withdrawalType: 1, outcome: 1, createdAt: -1 });
qaWithdrawalLogSchema.index({ userId: 1, createdAt: -1 });
qaWithdrawalLogSchema.index({ riskBand: 1, createdAt: -1 });
qaWithdrawalLogSchema.index({ riskBand: 1, reviewStatus: 1, createdAt: -1 });

module.exports = mongoose.models.QAWithdrawalLog || mongoose.model('QAWithdrawalLog', qaWithdrawalLogSchema);
