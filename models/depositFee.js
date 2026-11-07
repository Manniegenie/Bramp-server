// models/depositFee.js
// Singleton config for the flat fee deducted from a confirmed Glyde deposit
// before crediting the user's NGNB balance - accounts for Glyde's own fixed
// per-deposit charge (currently ₦150) rather than absorbing it as a cost.
const mongoose = require('mongoose');

const depositFeeSchema = new mongoose.Schema({
  feeAmount: {
    type: Number,
    required: true,
    min: 0,
    default: 150,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  updatedBy: {
    type: String,
    default: 'admin',
  },
  description: {
    type: String,
    default: 'Flat fee deducted from each confirmed NGNB deposit before crediting the user',
  },
}, {
  timestamps: true,
});

depositFeeSchema.statics.getCurrentFee = function () {
  return this.findOne();
};

// Atomic find-or-create: the fee must be active from the very first deposit,
// not conditional on an admin having opened the Fee Settings page first (the
// webhook needs this to exist, not just the admin GET /fee endpoint).
// findOneAndUpdate+upsert is also race-safe against two callers both finding
// nothing and creating separate documents, unlike a plain findOne-then-create.
depositFeeSchema.statics.getOrCreateCurrentFee = async function () {
  return this.findOneAndUpdate(
    {},
    { $setOnInsert: {} },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

module.exports = mongoose.models.DepositFee || mongoose.model('DepositFee', depositFeeSchema);
