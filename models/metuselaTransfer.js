const mongoose = require('mongoose');

// Every Metusela balance change, as a transfer between two accounts (null =
// outside Bramp: a deposit arriving, a withdrawal leaving). `reference` is
// unique, so retrying the same request can never apply it twice.
//
// The debit and credit sides are claimed separately (NONE → APPLYING →
// DONE), so concurrent retries can't double-apply either side. A side left
// in APPLYING means a crash mid-way and shows up in the admin overview for
// reconciliation.
const metuselaTransferSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  type: {
    type: String,
    required: true,
    enum: [
      'DEPOSIT', 'DEPOSIT_FEE', 'SWAP_FEE',
      'BET_STAKE', 'BET_PAYOUT', 'BET_REFUND',
      'WITHDRAWAL', 'WITHDRAWAL_FEE', 'WITHDRAWAL_REVERSAL', 'WITHDRAWAL_FEE_REVERSAL',
      'FLOAT_TOPUP', 'FLOAT_TOPUP_REVERSAL', 'FLOAT_RETURN',
      'ADJUSTMENT',
    ],
  },
  fromAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'MetuselaAccount', default: null },
  toAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'MetuselaAccount', default: null },
  amountUsdc: { type: Number, required: true, min: 0 },

  debitState: { type: String, enum: ['NONE', 'APPLYING', 'DONE'], default: 'NONE' },
  creditState: { type: String, enum: ['NONE', 'APPLYING', 'DONE'], default: 'NONE' },
  status: { type: String, enum: ['PENDING', 'DONE', 'FAILED'], default: 'PENDING', index: true },
  failureReason: { type: String, default: null },

  meta: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

metuselaTransferSchema.index({ fromAccountId: 1, createdAt: -1 });
metuselaTransferSchema.index({ toAccountId: 1, createdAt: -1 });

module.exports = mongoose.models.MetuselaTransfer || mongoose.model('MetuselaTransfer', metuselaTransferSchema);
