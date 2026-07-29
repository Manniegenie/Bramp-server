// models/virtualAccount.js
// One static NGN virtual account (Nomba) per user for bank-transfer deposits.
const mongoose = require('mongoose');

const virtualAccountSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  accountRef: { type: String, required: true, unique: true }, // deterministic: bramp-va-{userId}
  accountNumber: { type: String, required: true, unique: true },
  accountName: { type: String, required: true },
  bankName: { type: String },
  nombaAccountId: { type: String }, // Nomba's internal id for the VA, needed for suspend
  status: { type: String, enum: ['active', 'suspended'], default: 'active', index: true },
}, {
  timestamps: true,
});

module.exports = mongoose.models.VirtualAccount || mongoose.model('VirtualAccount', virtualAccountSchema);
