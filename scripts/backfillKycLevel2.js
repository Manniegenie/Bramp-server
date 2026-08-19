/**
 * One-time backfill: bump kycLevel to 2 for users whose kyc.level2.status is
 * already 'approved' but whose numeric kycLevel field was never updated.
 *
 * Caused by routes/kycwebhook.js's SmileID callback approving kyc.level2.status
 * via User.findByIdAndUpdate without ever setting kycLevel itself (fixed
 * separately in that file) — any user who completed level 2 verification
 * before that fix is stuck showing kycLevel: 1 despite being fully approved.
 *
 * Defaults to a DRY RUN (prints every planned change, writes nothing).
 * Run for real with: node scripts/backfillKycLevel2.js --execute
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');
const logger = console;

const EXECUTE = process.argv.includes('--execute');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  logger.log(`Connected to MongoDB (${EXECUTE ? 'EXECUTE mode — writes will happen' : 'DRY RUN — no writes'})`);

  const affected = await User.find({
    'kyc.level2.status': 'approved',
    kycLevel: { $lt: 2 },
  }).select('_id email username kycLevel').lean();

  logger.log(`Found ${affected.length} user(s) with approved level2 but kycLevel < 2`);

  for (const user of affected) {
    logger.log(`[UPDATE] ${user._id} (${user.email}): kycLevel ${user.kycLevel} → 2`);
  }

  if (EXECUTE && affected.length > 0) {
    const result = await User.updateMany(
      { 'kyc.level2.status': 'approved', kycLevel: { $lt: 2 } },
      { $set: { kycLevel: 2, kycStatus: 'approved' } }
    );
    logger.log(`Updated ${result.modifiedCount} user(s).`);
  } else if (!EXECUTE) {
    logger.log('\nDry run only — no writes were made. Re-run with --execute to apply.');
  }

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
