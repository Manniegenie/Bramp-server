// models/storefrontCustomer.js
// One record per customer per desk, keyed by the customer's WhatsApp number,
// so a trader can filter and analyse their own customers. The same number at
// two desks is two records. Size-capped (~2 KB): trade history lives in
// StorefrontSellOrder; only running totals are kept here.
const mongoose = require('mongoose');

const MAX_ACCOUNTS = 3;
const MAX_TAGS = 10;
const MAX_NOTE = 500;

const accountSchema = new mongoose.Schema({
  accountNumber: { type: String, required: true },
  bankCode: { type: String, required: true }, // Obiex sort code
  bankName: { type: String, required: true },
  accountName: { type: String, required: true }, // from the bank name lookup, confirmed by the customer
  lastUsedAt: { type: Date, default: Date.now },
}, { _id: true });

const addressSchema = new mongoose.Schema({
  coin: { type: String, required: true },
  network: { type: String, required: true },
  address: { type: String, required: true },
  memo: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const coinStatSchema = new mongoose.Schema({
  trades: { type: Number, default: 0 },
  amount: { type: Number, default: 0 }, // coins sold
  volumeNgn: { type: Number, default: 0 },
}, { _id: false });

const storefrontCustomerSchema = new mongoose.Schema({
  merchantId: { type: mongoose.Schema.Types.ObjectId, ref: 'StorefrontMerchant', required: true },
  waId: { type: String, required: true }, // WhatsApp number, digits only
  displayName: { type: String, default: null, maxlength: 100 },

  firstSeenAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  lastTradeAt: { type: Date, default: null },

  stats: {
    trades: { type: Number, default: 0 }, // sell orders opened
    completed: { type: Number, default: 0 }, // paid out
    volumeNgn: { type: Number, default: 0 }, // naira paid to the customer
    byCoin: { type: Map, of: coinStatSchema, default: {} },
  },

  accounts: {
    type: [accountSchema],
    default: [],
    validate: [(v) => v.length <= MAX_ACCOUNTS, `At most ${MAX_ACCOUNTS} saved accounts`],
  },
  addresses: { type: [addressSchema], default: [] }, // one per coin + network, created on request

  tags: {
    type: [{ type: String, trim: true, maxlength: 30 }],
    default: [],
    validate: [(v) => v.length <= MAX_TAGS, `At most ${MAX_TAGS} tags`],
  },
  note: { type: String, default: null, maxlength: MAX_NOTE },
}, {
  timestamps: true,
});

// One record per desk and number; the indexes behind the trader's filters.
storefrontCustomerSchema.index({ merchantId: 1, waId: 1 }, { unique: true });
storefrontCustomerSchema.index({ merchantId: 1, lastSeenAt: -1 });
storefrontCustomerSchema.index({ merchantId: 1, lastTradeAt: -1 });
storefrontCustomerSchema.index({ merchantId: 1, 'stats.volumeNgn': -1 });
storefrontCustomerSchema.index({ merchantId: 1, 'stats.trades': -1 });
storefrontCustomerSchema.index({ merchantId: 1, tags: 1 });

storefrontCustomerSchema.statics.LIMITS = { MAX_ACCOUNTS, MAX_TAGS, MAX_NOTE };

module.exports = mongoose.models.StorefrontCustomer || mongoose.model('StorefrontCustomer', storefrontCustomerSchema);
