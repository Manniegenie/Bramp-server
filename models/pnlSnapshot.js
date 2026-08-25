const mongoose = require('mongoose');

const pnlSnapshotSchema = new mongoose.Schema({
  providerTotalUsd:  { type: Number, required: true },
  providerTotalNgn:  { type: Number, required: true },
  platformTotalUsd:  { type: Number, required: true },
  platformTotalNgn:  { type: Number, required: true },
  pnlTotalUsd:       { type: Number, required: true },
  pnlTotalNgn:       { type: Number, required: true },
  offrampRate:       { type: Number, required: true },
  userCount:         { type: Number, default: 0 },
}, { timestamps: true });

pnlSnapshotSchema.index({ createdAt: -1 });

module.exports = mongoose.model('PnlSnapshot', pnlSnapshotSchema);
