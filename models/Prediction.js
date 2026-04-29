'use strict';

const mongoose = require('mongoose');

const MARKET_TOKENS = ['BTC', 'ETH', 'SOL', 'BNB', 'MATIC', 'AVAX'];

const pickSchema = new mongoose.Schema({
  symbol:        { type: String, enum: MARKET_TOKENS,                          required: true },
  marketType:    { type: String, enum: ['directional', 'volatility'],          default: 'directional' },
  direction:     { type: String, enum: ['up', 'down', 'high', 'low'],          required: true },
  threshold:     { type: Number },   // % threshold for volatility picks only
  window:        { type: String, enum: ['1H', '4H', '24H'],                    required: true },
  marketId:      { type: String, required: true },  // e.g. 'BTC-1H-...' or 'VOL-BTC-1H-...'
  roundStart:    { type: Date,   required: true },
  roundEnd:      { type: Date,   required: true },
  odds:          { type: Number, required: true },
  entryPriceUSD: { type: Number },
  openPriceUSD:  { type: Number },
  closePriceUSD: { type: Number },
  result:        { type: String, enum: ['pending', 'won', 'lost'], default: 'pending' },
}, { _id: false });

const predictionSchema = new mongoose.Schema({
  userId: {
    type:     mongoose.Schema.Types.ObjectId,
    ref:      'User',
    required: true,
    index:    true,
  },
  picks: {
    type:     [pickSchema],
    required: true,
    validate: { validator: a => a.length > 0, message: 'At least one pick required' },
  },
  stake:           { type: Number, required: true, min: 0 },
  totalOdds:       { type: Number, required: true },
  potentialPayout: { type: Number, required: true },
  // 'settling' is a transient lock state used by the cron to prevent double-processing
  status:          { type: String, enum: ['pending', 'settling', 'won', 'lost'], default: 'pending', index: true },
  settledAt:       { type: Date },
  idempotencyKey:  { type: String, index: true, sparse: true }, // optional client-generated UUID

  // Obiex swap: NGNB stake → USDC for backing Hyperliquid positions
  usdcAmount:      { type: Number },   // USDC received from the NGNB→USDC swap
  obiexQuoteId:    { type: String },   // Obiex quote ID for audit trail

  // Hyperliquid position (populated once the perp trade is opened)
  hlOrderId:       { type: String },   // Hyperliquid order/fill ID
  hlPositionSide:  { type: String, enum: ['long', 'short', null], default: null },
}, {
  timestamps: true,
  collection: 'predictions',
});

// Settlement cron: finds pending bets with expired picks
predictionSchema.index({ status: 1, 'picks.roundEnd': 1 });
// Pool aggregation: sums stakes by marketId
predictionSchema.index({ 'picks.marketId': 1, status: 1 });
// User history
predictionSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Prediction', predictionSchema);
