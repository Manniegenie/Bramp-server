// models/pendinguser.js
const mongoose = require('mongoose');

const OTP_EXPIRY_MINUTES = parseInt(process.env.OTP_EXPIRY_MINUTES || '10', 10); // default 10 minutes

const pendingUserSchema = new mongoose.Schema(
  {
    email:        { type: String, required: true, unique: true },
    firstname:    { type: String, required: true },
    lastname:     { type: String, required: true },
    phonenumber:  { type: String, required: true, unique: true },

    // ✅ Keep BVN (optional)
    bvn:          { type: String, required: false },

    verificationCode:            { type: String, required: true },
    verificationCodeCreatedAt:   { type: Date,   required: true },
    verificationCodeExpiresAt:   {
      type: Date,
      required: true,
      index: { expires: 0 } // TTL index
    },
    otpVerified:   { type: Boolean, default: false },
    otpVerifiedAt: { type: Date,    default: null }
  },
  { timestamps: true }
);

/**
 * Helper method to generate expiry date
 */
pendingUserSchema.statics.generateExpiryDate = function () {
  const createdAt = new Date();
  return new Date(createdAt.getTime() + OTP_EXPIRY_MINUTES * 60 * 1000);
};

/**
 * TTL Note:
 * MongoDB will automatically delete the document once `verificationCodeExpiresAt` is reached.
 * Cleanup runs roughly every 60 seconds.
 */

module.exports = mongoose.model('PendingUser', pendingUserSchema);
