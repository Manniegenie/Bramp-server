// models/KYCBlacklist.js
// Stores banned identifiers — BVN, phone number, email — to block re-registration
// after account suspension for fraud or policy violations.
'use strict';

const mongoose = require('mongoose');

const kycBlacklistSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['bvn', 'phone', 'email'],
    required: true,
    index: true
  },
  value: {
    type: String,
    required: true,
    index: true
  },
  reason: { type: String, default: 'Account suspended — policy violation' },
  incidentRef: { type: String },
  addedBy: { type: String, default: 'system' },
  originalUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  originalEmail: { type: String }
}, { timestamps: true });

kycBlacklistSchema.index({ type: 1, value: 1 }, { unique: true });

kycBlacklistSchema.statics.isBanned = async function(type, value) {
  if (!value) return false;
  const entry = await this.findOne({ type, value: value.toLowerCase().trim() });
  return !!entry;
};

kycBlacklistSchema.statics.banUser = async function(user, reason, incidentRef) {
  const entries = [];
  if (user.bvn) entries.push({ type: 'bvn', value: user.bvn.trim() });
  if (user.phonenumber) entries.push({ type: 'phone', value: user.phonenumber.trim() });
  if (user.email) entries.push({ type: 'email', value: user.email.toLowerCase().trim() });

  const meta = {
    reason: reason || 'Account suspended — policy violation',
    incidentRef: incidentRef || '',
    originalUserId: user._id,
    originalEmail: user.email
  };

  const results = [];
  for (const entry of entries) {
    try {
      const doc = await this.findOneAndUpdate(
        { type: entry.type, value: entry.value },
        { $setOnInsert: { ...entry, ...meta } },
        { upsert: true, new: true }
      );
      results.push(doc);
    } catch (e) {
      // Duplicate key — already banned, skip
    }
  }
  return results;
};

kycBlacklistSchema.statics.unbanUser = async function(user) {
  const values = [user.bvn?.trim(), user.phonenumber?.trim(), user.email?.toLowerCase().trim()].filter(Boolean);
  if (!values.length) return { deletedCount: 0 };
  return this.deleteMany({ originalUserId: user._id, value: { $in: values } });
};

module.exports = mongoose.model('KYCBlacklist', kycBlacklistSchema);
