const mongoose = require('mongoose');

// A crypto deposit to a Metusela deposit address, from the Obiex webhook.
// USDT is swapped to USDC on Obiex before crediting.
const metuselaDepositSchema = new mongoose.Schema({
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'MetuselaAccount', required: true, index: true },
  obiexTransactionId: { type: String, required: true, unique: true },
  currency: { type: String, required: true, uppercase: true },
  network: { type: String, required: true, uppercase: true },
  address: { type: String, required: true },
  amount: { type: Number, required: true, min: 0 }, // in `currency`
  txHash: { type: String, default: null },

  status: {
    type: String,
    enum: ['PENDING', 'CONFIRMED', 'CREDITED', 'SWAP_FAILED', 'BELOW_FEE', 'IGNORED'],
    default: 'PENDING',
  },
  swap: {
    quoteId: { type: String, default: null },
    receivedUsdc: { type: Number, default: null },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  grossUsdc: { type: Number, default: null },
  feeUsdc: { type: Number, default: null },
  creditedUsdc: { type: Number, default: null },
  creditedAt: { type: Date, default: null },
  failureReason: { type: String, default: null },
}, { timestamps: true });

module.exports = mongoose.models.MetuselaDeposit || mongoose.model('MetuselaDeposit', metuselaDepositSchema);
