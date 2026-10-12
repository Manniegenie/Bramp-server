const mongoose = require('mongoose');

// Metusela balances held at Bramp (crypto only for now). Modelled on
// ZeusODX's per-user balances: Bramp keeps each Metusela user's USDC in
// its own records while the coins sit in Bramp's pooled Obiex account.
//
//   USER — one per Metusela user (partnerUserId = Metusela's user id)
//   POOL — Metusela's betting pool: stakes in, payouts out, and the float
//          sent to / returned from Metusela's Polymarket wallet
//   FEES — fees Bramp/Metusela collect (deposit, swap, withdrawal)
//
// Balances only change through MetuselaTransfer (services/metuselaWallet.js).
const depositAddressSchema = new mongoose.Schema({
  currency: { type: String, required: true, uppercase: true }, // USDC | USDT
  network: { type: String, required: true, uppercase: true },  // Obiex network code
  address: { type: String, required: true },
  memo: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const metuselaAccountSchema = new mongoose.Schema({
  kind: { type: String, enum: ['USER', 'POOL', 'FEES'], required: true },
  partnerUserId: { type: String, default: null },
  usdcBalance: { type: Number, default: 0 },
  depositAddresses: { type: [depositAddressSchema], default: [] },
  status: { type: String, enum: ['ACTIVE', 'FROZEN'], default: 'ACTIVE' },
}, { timestamps: true });

metuselaAccountSchema.index({ partnerUserId: 1 }, { unique: true, partialFilterExpression: { kind: 'USER' } });
// Exactly one POOL and one FEES account. Named explicitly, and one index
// each (partial indexes don't accept $in on older MongoDB versions).
metuselaAccountSchema.index({ kind: 1 }, { name: 'one_pool', unique: true, partialFilterExpression: { kind: 'POOL' } });
metuselaAccountSchema.index({ kind: 1, partnerUserId: 1 }, { name: 'one_fees', unique: true, partialFilterExpression: { kind: 'FEES' } });
// Incoming Obiex deposits are matched by address.
metuselaAccountSchema.index({ 'depositAddresses.address': 1 });

module.exports = mongoose.models.MetuselaAccount || mongoose.model('MetuselaAccount', metuselaAccountSchema);
