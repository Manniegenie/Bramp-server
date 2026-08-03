// One-off backfill: every existing User was created via the PendingUser +
// email-OTP + passwordpin.js flow, which already proves email ownership
// before the account exists — but the field recording that was never set.
// Run once: node scripts/backfill-email-verified.js
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/user');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected. Backfilling emailVerified for existing users...');

  const result = await User.updateMany(
    { emailVerified: { $ne: true } },
    { $set: { emailVerified: true } }
  );

  console.log(`Matched: ${result.matchedCount ?? result.n}, Modified: ${result.modifiedCount ?? result.nModified}`);

  await mongoose.disconnect();
  console.log('Done.');
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
