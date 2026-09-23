// services/fraudRiskEngine.js
//
// Shadow-mode withdrawal risk scoring. SCORES AND LOGS ONLY — this module
// never holds, blocks, or otherwise affects a withdrawal. It is called from
// middleware/qaWithdrawalLog.js after a withdrawal request has already been
// fully processed and responded to, purely to attach a risk score + signal
// breakdown to that request's QA log entry for later review.
//
// Ported from ZeusODX-server's equivalent engine. One signal is dropped here:
// ZeusODX has a Redis-backed 2FA/PIN attempt counter (services/securityService.js)
// this codebase doesn't have, so "recent auth friction" has no data source to
// read and is omitted rather than faked. Seven signals instead of eight — the
// HOLD/BLOCK band proof below still holds with the remaining weights.

const Transaction = require('../models/transaction');
const User = require('../models/user');
const QAWithdrawalLog = require('../models/QALog');

const WEIGHTS = {
  NEW_DESTINATION: 20,
  VELOCITY_COUNT: 20,
  VOLUME_VS_AVERAGE: 20,
  DEPOSIT_FUNNEL: 25,
  NEW_IP: 8,
  NEW_KYC: 10,
  AMOUNT_VS_MAX: 15,
};

const SUCCESS_STATUSES = ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'];

/**
 * Score bands. Any two signals max out at 45 (25+20) — short of HOLD.
 * The strongest possible three (DEPOSIT_FUNNEL + two of the 20-weight
 * signals) land exactly on 65, the HOLD floor. Four signals can never
 * reach 95 (ceiling for any four is 20+20+20+25=85), so BLOCK requires
 * at least five independent signals firing at once.
 */
function computeBand(score) {
  if (score >= 95) return 'BLOCK';
  if (score >= 65) return 'HOLD';
  if (score >= 30) return 'FLAG';
  return 'ALLOW';
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

function minutesAgo(n) {
  return new Date(Date.now() - n * 60 * 1000);
}

/**
 * @param {object} ctx
 * @param {string} ctx.userId
 * @param {'CRYPTO'|'NGNB'|'INTERNAL_USERNAME'} ctx.withdrawalType
 * @param {number} ctx.amount
 * @param {string} ctx.currency
 * @param {object} ctx.destination - { address, network } for crypto,
 *   { accountNumber, bankCode } for NGNB, { username } for internal
 * @param {string} ctx.ipAddress
 * @returns {Promise<{score:number, band:string, signals:Array}>}
 */
async function scoreWithdrawal(ctx) {
  const { userId, withdrawalType, amount, currency, destination = {}, ipAddress } = ctx;
  const signals = [];
  let score = 0;

  const fire = (name, weight, detail) => {
    score += weight;
    signals.push({ signal: name, weight, fired: true, detail });
  };
  const miss = (name, weight) => {
    signals.push({ signal: name, weight, fired: false });
  };

  try {
    const [
      destinationMatchCount,
      velocityCount,
      volumeAgg,
      recentDeposit,
      ipMatchCount,
      user,
      maxPriorAgg,
    ] = await Promise.all([
      countPriorDestinationMatches(userId, withdrawalType, destination),
      QAWithdrawalLog.countDocuments({ userId, createdAt: { $gte: minutesAgo(60) } }).catch(() => 0),
      Transaction.aggregate([
        { $match: { userId: toObjectIdSafe(userId), type: 'WITHDRAWAL', currency, status: { $in: SUCCESS_STATUSES }, createdAt: { $gte: daysAgo(30) } } },
        { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } },
      ]).catch(() => []),
      Transaction.findOne({
        userId: toObjectIdSafe(userId), type: 'DEPOSIT', currency,
        status: { $in: SUCCESS_STATUSES }, createdAt: { $gte: minutesAgo(30) },
      }).sort({ createdAt: -1 }).lean().catch(() => null),
      ipAddress
        ? QAWithdrawalLog.countDocuments({ userId, ipAddress, createdAt: { $gte: daysAgo(30) } }).catch(() => 0)
        : Promise.resolve(0),
      User.findById(userId).select('kyc.level2.approvedAt').lean().catch(() => null),
      Transaction.aggregate([
        { $match: { userId: toObjectIdSafe(userId), type: 'WITHDRAWAL', currency, status: { $in: SUCCESS_STATUSES } } },
        { $group: { _id: null, max: { $max: { $abs: '$amount' } } } },
      ]).catch(() => []),
    ]);

    // 1. New destination — never used by this user before.
    if (destinationHasIdentifier(destination)) {
      if (destinationMatchCount <= 0) fire('NEW_DESTINATION', WEIGHTS.NEW_DESTINATION, 'first withdrawal to this destination');
      else miss('NEW_DESTINATION', WEIGHTS.NEW_DESTINATION);
    } else {
      miss('NEW_DESTINATION', WEIGHTS.NEW_DESTINATION);
    }

    // 2. Velocity — more than 3 withdrawal attempts in the trailing hour.
    if (velocityCount > 3) fire('VELOCITY_COUNT', WEIGHTS.VELOCITY_COUNT, `${velocityCount} attempts in 60m`);
    else miss('VELOCITY_COUNT', WEIGHTS.VELOCITY_COUNT);

    // 3. 24h volume vs 30-day average daily volume, same currency.
    const totalLast30d = volumeAgg?.[0]?.total || 0;
    const avgDaily = totalLast30d / 30;
    const total24h = await Transaction.aggregate([
      { $match: { userId: toObjectIdSafe(userId), type: 'WITHDRAWAL', currency, status: { $in: SUCCESS_STATUSES }, createdAt: { $gte: daysAgo(1) } } },
      { $group: { _id: null, total: { $sum: { $abs: '$amount' } } } },
    ]).then(r => r?.[0]?.total || 0).catch(() => 0);
    if (avgDaily > 0 && total24h > avgDaily * 3) fire('VOLUME_VS_AVERAGE', WEIGHTS.VOLUME_VS_AVERAGE, `24h ${total24h} vs avg/day ${avgDaily.toFixed(2)}`);
    else miss('VOLUME_VS_AVERAGE', WEIGHTS.VOLUME_VS_AVERAGE);

    // 4. Deposit -> withdraw funnel — withdrawal >=80% of a same-currency deposit in the prior 30 minutes.
    if (recentDeposit && Math.abs(recentDeposit.amount) > 0 && amount >= 0.8 * Math.abs(recentDeposit.amount)) {
      fire('DEPOSIT_FUNNEL', WEIGHTS.DEPOSIT_FUNNEL, `deposit ${recentDeposit.amount} at ${recentDeposit.createdAt}`);
    } else {
      miss('DEPOSIT_FUNNEL', WEIGHTS.DEPOSIT_FUNNEL);
    }

    // 5. New IP for this account in the trailing 30 days.
    if (ipAddress) {
      if (ipMatchCount <= 1) fire('NEW_IP', WEIGHTS.NEW_IP, 'IP not seen on this account in 30d');
      else miss('NEW_IP', WEIGHTS.NEW_IP);
    } else {
      miss('NEW_IP', WEIGHTS.NEW_IP);
    }

    // 6. Reached KYC level 2 less than 7 days ago.
    const level2At = user?.kyc?.level2?.approvedAt;
    if (level2At && new Date(level2At) >= daysAgo(7)) fire('NEW_KYC', WEIGHTS.NEW_KYC, `KYC-2 approved ${level2At}`);
    else miss('NEW_KYC', WEIGHTS.NEW_KYC);

    // 7. Amount more than 5x this user's own largest prior successful withdrawal (same currency).
    const priorMax = maxPriorAgg?.[0]?.max || 0;
    if (priorMax > 0 && amount > priorMax * 5) fire('AMOUNT_VS_MAX', WEIGHTS.AMOUNT_VS_MAX, `${amount} vs prior max ${priorMax}`);
    else miss('AMOUNT_VS_MAX', WEIGHTS.AMOUNT_VS_MAX);

    return { score, band: computeBand(score), signals };
  } catch (err) {
    // Scoring must never break QA logging or the withdrawal itself.
    return { score: 0, band: 'ALLOW', signals: [], error: err.message };
  }
}

function destinationHasIdentifier(destination) {
  return !!(destination.address || destination.accountNumber || destination.username);
}

async function countPriorDestinationMatches(userId, withdrawalType, destination) {
  try {
    if (withdrawalType === 'CRYPTO' && destination.address) {
      return Transaction.countDocuments({
        userId: toObjectIdSafe(userId), type: 'WITHDRAWAL', status: { $in: SUCCESS_STATUSES },
        address: destination.address,
      });
    }
    if (withdrawalType === 'NGNB' && destination.accountNumber) {
      // No dedicated destination subdoc on this schema — bank details live
      // under metadata (see routes/nairawithdrawal.js's Transaction.create).
      return Transaction.countDocuments({
        userId: toObjectIdSafe(userId), type: 'WITHDRAWAL', currency: 'NGNB', status: { $in: SUCCESS_STATUSES },
        'metadata.account_number': destination.accountNumber,
        ...(destination.bankCode ? { 'metadata.bank_code': destination.bankCode } : {}),
      });
    }
    if (withdrawalType === 'INTERNAL_USERNAME' && destination.username) {
      return Transaction.countDocuments({
        senderUserId: toObjectIdSafe(userId), type: 'INTERNAL_TRANSFER_SENT', status: { $in: SUCCESS_STATUSES },
        recipientUsername: destination.username,
      });
    }
    return 0;
  } catch {
    return 0;
  }
}

function toObjectIdSafe(id) {
  try {
    const { Types } = require('mongoose');
    return new Types.ObjectId(id);
  } catch {
    return id;
  }
}

module.exports = { scoreWithdrawal, WEIGHTS, computeBand };
