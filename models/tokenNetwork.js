const mongoose = require('mongoose');

// One document per (token, network) pair — lets admins enable/disable and
// reorder which networks show up for deposits/withdrawals per token,
// without touching code. Seeded once from the hardcoded list that used to
// live in the app's depositService.js (see scripts/seed-token-networks.js).
const TokenNetworkSchema = new mongoose.Schema({
  token: {
    type: String,
    required: true,
    uppercase: true,
  },
  networkId: {
    type: String,
    required: true,
    uppercase: true,
  },
  networkName: {
    type: String,
    required: true,
  },
  enabled: {
    type: Boolean,
    default: true,
  },
  order: {
    type: Number,
    default: 0,
  },
}, {
  timestamps: true,
});

TokenNetworkSchema.index({ token: 1, networkId: 1 }, { unique: true });
TokenNetworkSchema.index({ token: 1, order: 1 });

module.exports = mongoose.model('TokenNetwork', TokenNetworkSchema);
