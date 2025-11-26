// models/ChatbotTransaction.js
const mongoose = require('mongoose');

const PayoutSchema = new mongoose.Schema({
  bankName: { type: String, trim: true },
  bankCode: { type: String, trim: true },
  accountNumber: {
    type: String,
    trim: true,
    validate: { validator: v => !v || /^\d{6,20}$/.test(v), message: 'Account number must be 6–20 digits' },
  },
  accountName: { type: String, trim: true },
  capturedAt: { type: Date },
}, { _id: false });

const PayoutResultSchema = new mongoose.Schema({
  provider: { type: String, default: 'OBIEX' },
  obiexId: { type: String, index: true, sparse: true },
  obiexReference: { type: String, index: true, sparse: true },
  obiexStatus: { type: String },              // e.g. PENDING | SUCCESS | FAILED
  idempotencyKey: { type: String },
  errorCode: { type: String },
  errorMessage: { type: String },
  providerRaw: { type: mongoose.Schema.Types.Mixed },
  requestId: { type: String },
  httpStatus: { type: Number },
  isAuthError: { type: Boolean, default: false },
}, { _id: false });

// Collection (BUY) specific schemas - renamed to avoid Mongoose reserved keyword
const CollectionDetailsSchema = new mongoose.Schema({
  customerName: { type: String, trim: true },
  customerEmail: { type: String, trim: true },
  customerPhone: { type: String, trim: true },
  channels: [{ type: String, enum: ['card_payment', 'bank_transfer'] }],
  defaultChannel: { type: String, enum: ['card_payment', 'bank_transfer'] },
  meta: { type: mongoose.Schema.Types.Mixed },
  capturedAt: { type: Date },
  // User's wallet details for token delivery
  walletAddress: { type: String, trim: true },
  walletNetwork: { type: String, trim: true },
}, { _id: false });

const CollectionResultSchema = new mongoose.Schema({
  provider: { type: String, default: 'COLLECTION_API' },
  collectionId: { type: String, index: true, sparse: true },
  collectionReference: { type: String, index: true, sparse: true },
  collectionStatus: { type: String },         // e.g. PENDING | SUCCESS | FAILED
  paymentUrl: { type: String },
  idempotencyKey: { type: String },
  errorCode: { type: String },
  errorMessage: { type: String },
  providerRaw: { type: mongoose.Schema.Types.Mixed },
  requestId: { type: String },
  httpStatus: { type: Number },
  isAuthError: { type: Boolean, default: false },
}, { _id: false });

const ChatbotTransactionSchema = new mongoose.Schema({
  paymentId: { type: String, unique: true, index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

  kind: { type: String, enum: ['SELL', 'BUY'], required: true },
  token: { type: String, required: true },
  network: { type: String, required: true },

  // SELL fields
  sellAmount: { type: Number }, // only for SELL - actual token amount to send
  originalAmount: { type: Number }, // original input amount (TOKEN or NGN)
  originalCurrency: { type: String, enum: ['TOKEN', 'NGN'], default: 'TOKEN' }, // original currency

  // BUY fields
  buyAmount: { type: Number }, // NGN amount for BUY
  tokenAmount: { type: Number }, // token amount user will receive for BUY

  quoteRate: { type: Number, required: true },
  receiveCurrency: { type: String, default: 'NGN' }, // For SELL: NGN, For BUY: token symbol
  receiveAmount: { type: Number, required: true },

  // SELL specific fields
  depositAddress: { type: String }, // for SELL: where user sends crypto
  depositMemo: { type: String },

  // Reference no longer used; keep optional and ensure any unique index is sparse
  webhookRef: { type: String },

  // ---- Crypto calculation fields (Obiex rate based calculation)
  cryptoToReceive: { type: Number },           // (sellAmount * offrampRate) / obiexRate
  obiexRate: { type: Number },                 // Obiex rate used in calculation
  calculationOfframpRate: { type: Number },    // Offramp rate used in calculation

  // ---- Payout info (bank details captured from payout step for SELL)
  payout: { type: PayoutSchema, default: undefined },

  // ---- Collection info (payment collection details for BUY) - renamed to avoid reserved keyword
  collectionDetails: { type: CollectionDetailsSchema, default: undefined },

  // ---- Payout tracking (for SELL - sending crypto to user's bank)
  payoutCurrency: { type: String, default: 'NGN' },
  payoutAmount: { type: Number },
  payoutNarration: { type: String },
  payoutStatus: { type: String, enum: ['NOT_SET', 'REQUESTED', 'SUCCESS', 'FAILED'], default: 'NOT_SET', index: true },
  payoutSuccess: { type: Boolean, default: false },
  payoutRequestedAt: { type: Date },
  payoutCompletedAt: { type: Date },
  payoutResult: { type: PayoutResultSchema, default: undefined },

  // ---- Collection tracking (for BUY - collecting payment from user)
  collectionCurrency: { type: String, default: 'NGN' },
  collectionAmount: { type: Number },
  collectionReference: { type: String },
  collectionStatus: { type: String, enum: ['NOT_SET', 'REQUESTED', 'SUCCESS', 'FAILED'], default: 'NOT_SET', index: true },
  collectionSuccess: { type: Boolean, default: false },
  collectionRequestedAt: { type: Date },
  collectionCompletedAt: { type: Date },
  collectionResult: { type: CollectionResultSchema, default: undefined },

  // SELL status (deposit leg) / BUY status (payment leg)
  status: {
    type: String,
    enum: ['PENDING', 'CONFIRMED', 'COMPLETED', 'UNDERPAID', 'OVERPAID', 'EXPIRED', 'CANCELLED', 'PAID'],
    default: 'PENDING',
    index: true
  },

  observedTxHash: { type: String },
  observedAmount: { type: Number },
  observedAt: { type: Date },

  // TTL
  expiresAt: { type: Date },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Helpful indexes
ChatbotTransactionSchema.index({ userId: 1, status: 1 });
ChatbotTransactionSchema.index({ token: 1, network: 1, status: 1 });
ChatbotTransactionSchema.index({ kind: 1, status: 1 });
ChatbotTransactionSchema.index({ collectionReference: 1 }, { sparse: true });
// Ensure webhookRef index is sparse to avoid E11000 on null values
ChatbotTransactionSchema.index({ webhookRef: 1 }, { unique: true, sparse: true });
// TTL index completely removed - we keep all transactions forever
// ChatbotTransactionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

ChatbotTransactionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

// Method to check if transaction is expired
ChatbotTransactionSchema.methods.isExpired = function () {
  return this.expiresAt && this.expiresAt < new Date();
};

// Static method to get non-expired transactions
ChatbotTransactionSchema.statics.findNonExpired = function (filter = {}) {
  return this.find({
    ...filter,
    $or: [
      { expiresAt: { $exists: false } },
      { expiresAt: null },
      { expiresAt: { $gt: new Date() } }
    ]
  });
};

// Static method to get expired transactions
ChatbotTransactionSchema.statics.findExpired = function (filter = {}) {
  return this.find({
    ...filter,
    expiresAt: { $lte: new Date() }
  });
};

module.exports = mongoose.model('ChatbotTransaction', ChatbotTransactionSchema);
