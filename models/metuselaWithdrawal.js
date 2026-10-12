const mongoose = require('mongoose');

// USDC leaving Bramp via Obiex: a user withdrawal, or a float top-up from
// the POOL to Metusela's Polymarket wallet.
const metuselaWithdrawalSchema = new mongoose.Schema({
  kind: { type: String, enum: ['USER', 'FLOAT_TOPUP'], required: true },
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'MetuselaAccount', required: true, index: true },
  reference: { type: String, required: true, unique: true }, // the caller's idempotency key
  network: { type: String, required: true, uppercase: true },
  address: { type: String, required: true },
  amountUsdc: { type: Number, required: true, min: 0 },   // sent to Obiex (its network fee comes out of this)
  feeUsdc: { type: Number, default: 0 },                  // our fee, on top
  networkFeeUsdc: { type: Number, default: null },        // Obiex's fee on that network
  recipientReceivesUsdc: { type: Number, default: null }, // amountUsdc − networkFeeUsdc
  status: { type: String, enum: ['SUBMITTED', 'COMPLETED', 'FAILED'], default: 'SUBMITTED', index: true },
  obiexWithdrawalId: { type: String, default: null, index: true, sparse: true },
  txHash: { type: String, default: null },
  failureReason: { type: String, default: null },
  completedAt: { type: Date, default: null },
}, { timestamps: true });

module.exports = mongoose.models.MetuselaWithdrawal || mongoose.model('MetuselaWithdrawal', metuselaWithdrawalSchema);
