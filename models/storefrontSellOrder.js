// models/storefrontSellOrder.js
// One offramp trade: a storefront customer sells crypto to a desk and is paid
// naira. Opened when Stella shows the address and rate; settled when the
// deposit confirms (services/storefrontSell.js).
const mongoose = require('mongoose');

const STATUSES = [
  'AWAITING_DEPOSIT', // address and rate shown, no deposit yet
  'AWAITING_ACCOUNT', // deposit confirmed, customer hasn't chosen where to be paid
  'AWAITING_FUNDS', // Self rate: the trader's NGNB can't cover the payout yet - retried when they top up
  'SELLING', // Bramp rate: selling the coin for NGNX on Obiex
  'PAYING', // naira payout sent to Obiex
  'PAID', // customer paid, earnings credited
  'NEEDS_REVIEW', // sale or payout failed: Bramp ops
  'RESOLVED', // ops closed a review by hand (see resolution)
];

const storefrontSellOrderSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true },
  merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', required: true, index: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontCustomer', required: true, index: true },
  waId: { type: String, required: true },
  channel: { type: String, enum: ['whatsapp', 'web'], default: 'whatsapp' },
  openedByDeposit: { type: Boolean, default: false }, // a repeat deposit with no sale open: priced at deposit time

  coin: { type: String, required: true },
  network: { type: String, required: true },
  address: { type: String, required: true },

  rateMode: { type: String, enum: ['BRAMP', 'SELF'], required: true },
  // Rate shown when the sale opened: a guide only - it settles at the live rate.
  quote: {
    ngnPerUsd: { type: Number, default: null }, // Bramp rate mode: Bramp's rate minus the markdown
    brampNgnPerUsd: { type: Number, default: null },
    markdownNgnPerUsd: { type: Number, default: null },
    usdPerCoin: { type: Number, default: null },
    ngnPerCoin: { type: Number, required: true },
    quotedAt: { type: Date, required: true },
  },

  payoutAccount: {
    accountNumber: String,
    bankCode: String,
    bankName: String,
    accountName: String,
  },

  deposit: {
    transactionId: { type: String, default: null }, // Obiex's; unique when set
    hash: { type: String, default: null },
    amount: { type: Number, default: null },
    confirmedAt: { type: Date, default: null },
  },

  // Settled figures, at the live rate when the deposit was processed.
  settlement: {
    ngnPerCoin: { type: Number, default: null },
    rateAt: { type: Date, default: null }, // when the live rate was taken
    customerNgn: { type: Number, default: null },
    traderEarningNgn: { type: Number, default: null },
    feeNgn: { type: Number, default: 0 },
  },

  // Self rate: the trader's NGNB debited (payout + fee), the coin credited to them.
  selfRateFunds: {
    debitNgn: { type: Number, default: null },
    debitedAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    coinCreditedAt: { type: Date, default: null },
  },

  sale: { // Bramp rate: the coin sold for NGNX
    ok: { type: Boolean, default: null },
    error: { type: String, default: null },
    at: { type: Date, default: null },
  },
  payout: {
    idempotencyKey: { type: String, default: null },
    providerId: { type: String, default: null },
    error: { type: String, default: null },
    requestedAt: { type: Date, default: null },
  },

  status: { type: String, enum: STATUSES, default: 'AWAITING_DEPOSIT', index: true },
  reviewReason: { type: String, default: null },
  resolution: {
    outcome: { type: String, enum: ['PAID_MANUALLY', 'REFUNDED_CUSTOMER', 'NO_ACTION', null], default: null },
    note: { type: String, default: null, maxlength: 500 },
    by: { type: String, default: null },
    at: { type: Date, default: null },
  },
  paidAt: { type: Date, default: null },
  // Payouts paused platform-wide when this sale was ready: paid once they resume (storefrontSell.releaseHeld).
  heldAt: { type: Date, default: null },
  customerNotifiedAt: { type: Date, default: null },
}, {
  timestamps: true,
});

storefrontSellOrderSchema.index({ 'deposit.transactionId': 1 }, { unique: true, partialFilterExpression: { 'deposit.transactionId': { $type: 'string' } } });
storefrontSellOrderSchema.index({ customerId: 1, coin: 1, network: 1, status: 1, createdAt: -1 });
storefrontSellOrderSchema.index({ merchantId: 1, createdAt: -1 });

storefrontSellOrderSchema.statics.STATUSES = STATUSES;

module.exports = mongoose.models.StorefrontSellOrder || mongoose.model('StorefrontSellOrder', storefrontSellOrderSchema);
