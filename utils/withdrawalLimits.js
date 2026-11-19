/**
 * Temporary withdrawal limit guard — remove once KYC providers are fully configured.
 *
 * Enforces a rolling 7-day NGNB withdrawal cap per user using a single MongoDB
 * aggregation on the Transaction collection. No extra storage required.
 *
 * To remove: delete this file and the two lines that import/call it in
 * routes/nairawithdrawal.js (search for "withdrawalLimits").
 */

const mongoose   = require('mongoose');
const Transaction = require('../models/transaction');

const ROLLING_WINDOW_DAYS  = 7;
const MAX_NGNB_PER_WINDOW  = 5_000_000; // ₦5,000,000

/**
 * Returns the total NGNB withdrawn by a user in the last ROLLING_WINDOW_DAYS days.
 * FAILED / REJECTED transactions are excluded so refunded attempts don't eat the limit.
 */
async function getRolling7DayWithdrawn(userId) {
  const since = new Date(Date.now() - ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const uid   = typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;

  const [result] = await Transaction.aggregate([
    {
      $match: {
        userId:    uid,
        type:      'WITHDRAWAL',
        currency:  'NGNB',
        status:    { $nin: ['FAILED', 'REJECTED'] },
        createdAt: { $gte: since },
      },
    },
    {
      $group: {
        _id:   null,
        total: { $sum: { $abs: '$amount' } },
      },
    },
  ]);

  // Self rate payouts move NGNB to a bank account too: they count toward the limit.
  const StorefrontMerchant = require('../models/storefrontMerchant');
  const StorefrontSellOrder = require('../models/storefrontSellOrder');
  const desk = await StorefrontMerchant.findOne({ userId: uid }).select('_id').lean();
  let selfRateTotal = 0;
  if (desk) {
    const [sr] = await StorefrontSellOrder.aggregate([
      { $match: { merchantId: desk._id, 'selfRateFunds.debitedAt': { $gte: since }, 'selfRateFunds.refundedAt': null } },
      { $group: { _id: null, total: { $sum: '$selfRateFunds.debitNgn' } } },
    ]);
    selfRateTotal = sr?.total ?? 0;
  }

  return (result?.total ?? 0) + selfRateTotal;
}

/**
 * Checks whether a requested withdrawal would breach the rolling 7-day limit.
 *
 * @param {string|ObjectId} userId
 * @param {number}          requestedAmount  The amount the user wants to withdraw now.
 * @returns {{ allowed: boolean, used: number, remaining: number, limit: number, windowDays: number }}
 */
async function checkWithdrawalLimit(userId, requestedAmount) {
  const used      = await getRolling7DayWithdrawn(userId);
  const remaining = MAX_NGNB_PER_WINDOW - used;
  const allowed   = requestedAmount <= remaining;

  return {
    allowed,
    used,
    remaining: Math.max(0, remaining),
    limit:     MAX_NGNB_PER_WINDOW,
    windowDays: ROLLING_WINDOW_DAYS,
  };
}

module.exports = { checkWithdrawalLimit, MAX_NGNB_PER_WINDOW, ROLLING_WINDOW_DAYS };
