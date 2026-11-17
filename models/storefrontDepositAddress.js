// models/storefrontDepositAddress.js
// Which desk and customer a storefront deposit address belongs to. The Obiex
// deposit webhook only knows the address, so this is its lookup. Addresses
// are never deleted: a deposit can arrive long after the address was issued.
const mongoose = require('mongoose');

const storefrontDepositAddressSchema = new mongoose.Schema({
  address: { type: String, required: true, unique: true },
  coin: { type: String, required: true },
  network: { type: String, required: true },
  memo: { type: String, default: null },
  merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', required: true },
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontCustomer', required: true },
  waId: { type: String, required: true },
}, {
  timestamps: true,
});

// One address per desk, customer, coin and network.
storefrontDepositAddressSchema.index({ customerId: 1, coin: 1, network: 1 }, { unique: true });

module.exports = mongoose.models.StorefrontDepositAddress || mongoose.model('StorefrontDepositAddress', storefrontDepositAddressSchema);
