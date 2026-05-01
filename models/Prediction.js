'use strict';

const mongoose = require('mongoose');

const MARKET_TOKENS = ['BTC', 'ETH', 'SOL', 'BNB', 'MATIC', 'AVAX'];

const pickSchema = new mongoose.Schema({
  symbol:           { type: String, enum: MARKET_TOKENS,           required: true },
  direction:        { type: String, enum: ['up', 'down'],          required: true },
  multiplier:       { type: Number },   // base multiplier chosen at entry (1.7, 2, 5, 10)
  actualMultiplier: { type: Number },   // realized multiplier after settlement (scales with move size)
  window:           { type: String, enum: ['1H', '4H', '24H', '3M', '6M'], required: true },
  marketId:         { type: String, required: true },
  roundStart:       { type: Date,   required: true },
  roundEnd:         { type: Date,   required: true },
  targetPct:        { type: Number },   // minimum % move required to win (threshold)
  targetPrice:      { type: Number },   // absolute price threshold locked at submission
  odds:             { type: Number, required: true },
  entryPriceUSD:    { type: Number },
  openPriceUSD:     { type: Number },
  closePriceUSD:    { type: Number },
  result:           { type: String, enum: ['pending', 'won', 'lost'], default: 'pending' },
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
  stake:            { type: Number, required: true, min: 0 },
  totalOdds:        { type: Number, required: true },
  potentialPayout:  { type: Number, required: true },  // base payout: stake × totalOdds (threshold just cleared)
  maxPayout:        { type: Number },                  // capped max: stake × totalOdds × 3^numPicks
  actualTotalOdds:  { type: Number },                  // realized odds product after settlement
  actualPayout:     { type: Number },                  // actual NGNB credited on win
  // 'settling' is a transient lock state used by the cron to prevent double-processing
  status:           { type: String, enum: ['pending', 'settling', 'won', 'lost'], default: 'pending', index: true },
  settledAt:        { type: Date },
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
