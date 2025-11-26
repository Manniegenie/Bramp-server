const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  type: { 
    type: String, 
    enum: ['DEPOSIT', 'WITHDRAWAL', 'INTERNAL_TRANSFER_SENT', 'INTERNAL_TRANSFER_RECEIVED', 'SWAP', 'GIFTCARD'], 
    required: true 
  },
  currency: { type: String, required: true },
  address: { type: String },
  amount: { type: Number, required: true },
  fee: { type: Number, default: 0 },
  obiexFee: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['PENDING', 'APPROVED', 'PROCESSING', 'SUCCESSFUL', 'COMPLETED', 'FAILED', 'REJECTED', 'CONFIRMED'],
    required: true,
  },
  network: { type: String },
  narration: { type: String },
  source: { type: String, enum: ['CRYPTO_WALLET', 'BANK', 'INTERNAL', 'GIFTCARD'], default: 'CRYPTO_WALLET' },
  hash: { type: String },
  transactionId: { type: String },
  obiexTransactionId: { type: String },
  memo: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed },
  reference: { type: String },
  
  // Internal transfer fields
  recipientUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  recipientUsername: { type: String },
  senderUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  senderUsername: { type: String },
  
  // Swap fields
  fromCurrency: { type: String },
  toCurrency: { type: String },
  fromAmount: { type: Number },
  toAmount: { type: Number },
  swapType: { type: String, enum: ['onramp', 'offramp'] },
  
  // Gift card fields - UPDATED to match endpoint exactly
  giftCardId: { type: mongoose.Schema.Types.ObjectId, ref: 'GiftCard', default: null },
  
  // UPDATED: Fixed cardType enum to match endpoint exactly
  cardType: { 
    type: String, 
    enum: ['APPLE', 'STEAM', 'NORDSTROM', 'MACY', 'NIKE', 'GOOGLE_PLAY', 'AMAZON', 'VISA', 'RAZOR_GOLD', 'AMERICAN_EXPRESS', 'SEPHORA', 'FOOTLOCKER', 'XBOX', 'EBAY'] 
  },
  
  cardFormat: { type: String, enum: ['PHYSICAL', 'E_CODE'] },
  cardRange: { type: String, maxlength: 50 },
  country: { type: String, enum: ['US', 'CANADA', 'AUSTRALIA', 'SWITZERLAND'] },
  
  // Updated for multiple images
  imageUrls: [{ type: String }], // Array of image URLs
  imagePublicIds: [{ type: String }], // Array of Cloudinary public IDs
  totalImages: { type: Number, default: 0, min: 0, max: 20 },
  
  // UPDATED: Added minlength: 5 to match endpoint validation (5-100 characters)
  eCode: { type: String, minlength: 5, maxlength: 100 },
  description: { type: String, maxlength: 500 },
  
  // Rate calculation fields
  expectedRate: { type: Number, min: 0 },
  expectedRateDisplay: { type: String },
  expectedAmountToReceive: { type: Number, min: 0 },
  expectedSourceCurrency: { type: String },
  expectedTargetCurrency: { type: String },
  
  // Timestamps
  completedAt: { type: Date },
  failedAt: { type: Date },
  failureReason: { type: String },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

// Indexes
transactionSchema.index({ userId: 1, type: 1, status: 1 });
transactionSchema.index({ giftCardId: 1 });
transactionSchema.index({ cardType: 1, country: 1 });

transactionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  
  // Update totalImages count
  if (this.imageUrls) {
    this.totalImages = this.imageUrls.length;
  }
  
  next();
});

module.exports = mongoose.model('Transaction', transactionSchema);