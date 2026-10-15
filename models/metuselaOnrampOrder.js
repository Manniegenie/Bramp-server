const mongoose = require('mongoose');

// A Naira → USDC on-ramp order requested by Metusela (partner API, see
// routes/metusela.js). Deliberately NOT tied to the User model: the payer
// is a Metusela user, not a Bramp user.
//
// Flow: Metusela creates the order → Bramp issues a dynamic Glyde virtual
// account for the exact Naira amount → the user transfers → the Glyde
// collection webhook (routes/nairawebhook.js) hands the payment here →
// Bramp converts at the rate locked on the order and sends USDC from its
// Obiex treasury to the user's own wallet → the Obiex withdrawal webhook
// (routes/obiexwebhooktrx.js) confirms it on-chain. Every step is pushed to
// Metusela's webhook.
const customerSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true },
}, { _id: false });

const metuselaOnrampOrderSchema = new mongoose.Schema({
  // Ours: also the Glyde virtual account's customer.reference / the
  // collection webhook's merchant_reference.
  reference: { type: String, required: true, unique: true },
  // Metusela's own id for this top-up (their Funding id) — idempotency key.
  partnerReference: { type: String, required: true, unique: true },
  partnerUserId: { type: String, required: true, index: true },
  customer: { type: customerSchema, required: true },

  amountNgn: { type: Number, required: true, min: 0 },
  // Locked at creation: Bramp's on-ramp rate (₦ per $1) and its fee.
  ngnPerUsdc: { type: Number, required: true, min: 0 },
  feeBps: { type: Number, required: true, min: 0 },
  quotedUsdc: { type: Number, required: true, min: 0 },

  // WALLET: USDC is sent on-chain to `address`. BALANCE: it's credited to
  // the user's Metusela balance at Bramp (services/metuselaWallet.js).
  destination: {
    type: { type: String, enum: ['WALLET', 'BALANCE'], default: 'WALLET' },
    network: { type: String, uppercase: true, required() { return this.destination?.type !== 'BALANCE'; } }, // Obiex network code, e.g. POLYGON
    address: { type: String, required() { return this.destination?.type !== 'BALANCE'; } },
  },

  virtualAccount: {
    uid: { type: String, default: null },
    accountNumber: { type: String, default: null },
    accountName: { type: String, default: null },
    bankName: { type: String, default: null },
  },
  expiresAt: { type: Date, required: true },

  status: {
    type: String,
    enum: ['AWAITING_PAYMENT', 'PAYMENT_RECEIVED', 'PAYOUT_SUBMITTED', 'COMPLETED', 'PAYOUT_FAILED', 'EXPIRED'],
    default: 'AWAITING_PAYMENT',
    index: true,
  },

  // What actually arrived (may differ from amountNgn — we convert what was paid).
  receivedNgn: { type: Number, default: null },
  glydeReference: { type: String, default: null, index: true, sparse: true },
  paidAt: { type: Date, default: null },

  payoutUsdc: { type: Number, default: null },
  obiexWithdrawalId: { type: String, default: null, index: true, sparse: true },
  payoutTxHash: { type: String, default: null },
  payoutSubmittedAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  failureReason: { type: String, default: null },

  // Last webhook delivery to Metusela, for debugging.
  lastNotify: {
    event: { type: String, default: null },
    ok: { type: Boolean, default: null },
    at: { type: Date, default: null },
    error: { type: String, default: null },
  },
}, { timestamps: true });

module.exports = mongoose.models.MetuselaOnrampOrder || mongoose.model('MetuselaOnrampOrder', metuselaOnrampOrderSchema);
