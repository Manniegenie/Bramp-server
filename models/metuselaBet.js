const mongoose = require('mongoose');

// One bet per stake, kept so Bramp knows how much customer money is live at
// Polymarket. OPEN bets count towards the open-bets caps (overall and per
// market); a bet leaves the count when it's settled (market resolved) or
// refunded (order didn't fill).
const metuselaBetSchema = new mongoose.Schema({
  reference: { type: String, required: true, unique: true }, // the stake reference
  accountId: { type: mongoose.Schema.Types.ObjectId, ref: 'MetuselaAccount', required: true },
  marketId: { type: String, required: true },
  // What can sit at Polymarket for this bet: the stake less our bet fee.
  budgetUsdc: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['OPEN', 'SETTLED', 'REFUNDED'], default: 'OPEN' },
  payoutUsdc: { type: Number, default: null },
  closedAt: { type: Date, default: null },
}, { timestamps: true });

metuselaBetSchema.index({ status: 1, marketId: 1 });

module.exports = mongoose.models.MetuselaBet || mongoose.model('MetuselaBet', metuselaBetSchema);
