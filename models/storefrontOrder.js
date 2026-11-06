const mongoose = require('mongoose');

// A customer buying crypto on a trader's storefront, paid by bank transfer
// to a one-time Glyde account (services/storefrontBuy.js). Like
// metuselaOnrampOrder, deliberately not tied to the User model: the payer is
// the trader's customer, not a Bramp user.
//
// Flow: the trader's storefront-api creates the order at the trader's rate →
// Bramp issues a dynamic Glyde account for the exact amount → the customer
// pays → the Glyde collection webhook hands the payment here → the payer's
// name is checked against the name given at checkout → the crypto is sent
// from Bramp's Obiex treasury, or the payment is held for the trader →
// the Obiex withdrawal webhook confirms it → the trader's margin is credited
// to their held balance (models/storefrontLedger.js).
const storefrontOrderSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true }, // ours, also the Glyde customer.reference
  merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', required: true, index: true },
  storeReference: { type: String, required: true }, // the storefront-api's own id: idempotency key per merchant
  customerRef: { type: String, required: true, index: true }, // the trader's customer id, for trusted payers

  payerName: { type: String, required: true }, // name on the account the customer said they'd pay from

  asset: { type: String, enum: ['USDT', 'USDC'], required: true },
  network: { type: String, required: true, uppercase: true }, // Obiex network code
  address: { type: String, required: true },

  amountNgn: { type: Number, required: true, min: 0 },
  // Locked at creation. rate: the trader's price (₦ per 1 unit). brampRate:
  // Bramp's own on-ramp price, what the crypto costs the trader.
  rate: { type: Number, required: true, min: 0 },
  brampRate: { type: Number, required: true, min: 0 },
  feeBps: { type: Number, required: true, min: 0 },
  quotedAmount: { type: Number, required: true, min: 0 },

  virtualAccount: {
    uid: { type: String, default: null },
    accountNumber: { type: String, default: null },
    accountName: { type: String, default: null },
    bankName: { type: String, default: null },
  },
  expiresAt: { type: Date, required: true },

  status: {
    type: String,
    enum: [
      'AWAITING_PAYMENT', 'EXPIRED',
      'HELD_REVIEW', // payer name doesn't match: the trader approves or rejects
      'HELD_DELAY', // large payment from a first-time payer: sent at releaseAt
      'PAYOUT_SUBMITTED', 'COMPLETED', 'PAYOUT_FAILED',
      'REJECTED', // the trader rejected it: refund to the payer (manual for now)
    ],
    default: 'AWAITING_PAYMENT',
    index: true,
  },

  // The payment as Glyde reported it.
  receivedNgn: { type: Number, default: null },
  receivedPayerName: { type: String, default: null },
  nameCheck: { type: String, enum: ['MATCH', 'TRUSTED', 'MISMATCH', 'UNVERIFIABLE', null], default: null },
  glydeReference: { type: String, default: null, index: true, sparse: true },
  paidAt: { type: Date, default: null },
  releaseAt: { type: Date, default: null, index: true, sparse: true },
  decidedBy: { type: String, enum: ['AUTO', 'TRADER', null], default: null },

  payoutAmount: { type: Number, default: null },
  marginNgn: { type: Number, default: null },
  obiexWithdrawalId: { type: String, default: null, index: true, sparse: true },
  payoutTxHash: { type: String, default: null },
  completedAt: { type: Date, default: null },
  failureReason: { type: String, default: null },

  lastNotify: {
    event: { type: String, default: null },
    ok: { type: Boolean, default: null },
    at: { type: Date, default: null },
    error: { type: String, default: null },
  },
}, { timestamps: true });

storefrontOrderSchema.index({ merchantId: 1, storeReference: 1 }, { unique: true });
storefrontOrderSchema.index({ merchantId: 1, paidAt: -1 });

module.exports = mongoose.models.StorefrontOrder || mongoose.model('StorefrontOrder', storefrontOrderSchema);
