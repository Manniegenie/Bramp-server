/**
 * Finds users likely affected by the double-hashing bug in changepasswordpin.js,
 * forgotpasswordpin.js, and transactionpin.js (fixed in commit 69efea4), and
 * clears their corrupted PIN field so they're forced through the (now-fixed)
 * set/forgot-PIN flow to establish a working one.
 *
 * IMPORTANT — this does NOT and CANNOT recover the user's actual PIN. A
 * double-hashed value (bcrypt(bcrypt(pin))) cannot be reversed back into a
 * correct single hash without the plain PIN, which was never stored anywhere.
 * The only real fix is clearing the corrupted value so the user sets a fresh
 * one. This is exactly what "forgot PIN" already does for a user who
 * legitimately forgot — the outcome is identical and expected.
 *
 * IMPORTANT — detection is BEST-EFFORT and INCOMPLETE. A double-hashed value
 * is still a syntactically valid 60-character bcrypt string, so there is no
 * way to detect corruption from the stored value itself. The only lead is the
 * success-log line each buggy route emitted, and this server's log retention
 * is 14 days (see utils/logger.js maxFiles). Anyone who used one of these
 * flows more than 14 days before this script is run will NOT show up here —
 * only users who hit the bug recently will be found. Treat this as a partial
 * list, not a complete one; anyone who reports a broken PIN later should
 * still be manually cleared the same way (see resetOnePin() below, or run
 * this script again with their userId appended manually).
 *
 * Usage:
 *   node scripts/fixDoubleHashedPins.js                 # dry run — lists candidates only
 *   node scripts/fixDoubleHashedPins.js --execute        # clears the corrupted field for real
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const User = require('../models/user');
const logger = console;

const EXECUTE = process.argv.includes('--execute');
const LOGS_DIR = path.join(process.cwd(), 'logs');

// message text -> which PIN field that route writes
const TARGET_MESSAGES = [
  { match: 'Pin changed successfully', field: 'passwordpin', source: 'changepasswordpin.js (/changepin)' },
  { match: '✅ Pin reset successfully after 2FA verification', field: 'passwordpin', source: 'forgotpasswordpin.js (/forgotpin)' },
  { match: 'Transaction PIN created', field: 'transactionpin', source: 'transactionpin.js (/transactionpin)' },
];

const ENTRY_START = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[/;

function extractUserId(entryText) {
  const m = entryText.match(/"userId":\s*"([a-f0-9]{24})"/i);
  return m ? m[1] : null;
}

function scanLogFile(filePath) {
  const found = [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let currentEntry = [];

  const flush = () => {
    if (currentEntry.length === 0) return;
    const entryText = currentEntry.join('\n');
    for (const target of TARGET_MESSAGES) {
      if (entryText.includes(target.match)) {
        const userId = extractUserId(entryText);
        const timestampMatch = entryText.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
        if (userId) {
          found.push({ userId, field: target.field, source: target.source, timestamp: timestampMatch ? timestampMatch[0] : 'unknown' });
        }
        break;
      }
    }
    currentEntry = [];
  };

  for (const line of lines) {
    if (ENTRY_START.test(line)) {
      flush();
    }
    currentEntry.push(line);
  }
  flush();

  return found;
}

function scanAllLogs() {
  if (!fs.existsSync(LOGS_DIR)) {
    logger.warn(`No logs directory found at ${LOGS_DIR} — nothing to scan.`);
    return [];
  }

  const files = fs.readdirSync(LOGS_DIR)
    .filter(f => /^app-.*\.log$/.test(f))
    .map(f => path.join(LOGS_DIR, f));

  logger.log(`Scanning ${files.length} log file(s) in ${LOGS_DIR}...`);

  let all = [];
  for (const file of files) {
    try {
      all = all.concat(scanLogFile(file));
    } catch (err) {
      logger.warn(`  Failed to read ${file}: ${err.message}`);
    }
  }
  return all;
}

async function run() {
  const rawMatches = scanAllLogs();

  // Keep only the latest event per (userId, field) pair
  const latestByKey = new Map();
  for (const m of rawMatches) {
    const key = `${m.userId}:${m.field}`;
    const existing = latestByKey.get(key);
    if (!existing || m.timestamp > existing.timestamp) {
      latestByKey.set(key, m);
    }
  }

  const candidates = [...latestByKey.values()];

  logger.log(`\nFound ${candidates.length} candidate (user, field) pair(s) from log history (14-day window, best-effort):\n`);
  for (const c of candidates) {
    logger.log(`  [${c.timestamp}] userId=${c.userId} field=${c.field} source=${c.source}`);
  }

  if (candidates.length === 0) {
    logger.log('\nNothing found in logs. This does NOT mean no one is affected — it means');
    logger.log('no one hit the bug within the last 14 days of retained logs. Affected users');
    logger.log('outside that window need to be cleared manually as they report the issue.');
  }

  if (!EXECUTE) {
    logger.log('\nDry run only — no changes made. Re-run with --execute to clear these fields.');
    await mongoose.disconnect().catch(() => {});
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  logger.log('\nConnected to MongoDB — clearing corrupted PIN fields...\n');

  let cleared = 0;
  let skipped = 0;

  for (const c of candidates) {
    const user = await User.findById(c.userId).select(`_id email ${c.field}`);
    if (!user) {
      logger.warn(`  SKIPPED — user ${c.userId} not found`);
      skipped++;
      continue;
    }
    if (!user[c.field]) {
      logger.log(`  SKIPPED — ${c.userId} (${user.email}) already has no ${c.field} set`);
      skipped++;
      continue;
    }
    await User.updateOne({ _id: c.userId }, { $unset: { [c.field]: 1 } });
    logger.log(`  CLEARED — ${c.userId} (${user.email}): ${c.field}`);
    cleared++;
  }

  logger.log(`\nDone. Cleared: ${cleared}. Skipped: ${skipped}.`);
  logger.log('Affected users will be prompted to set a new PIN next time they try to use one.');

  await mongoose.disconnect();
}

/**
 * Manually clear one user's corrupted PIN by email — for reports that fall
 * outside the log-retention window. Usage:
 *   node -e "require('./scripts/fixDoubleHashedPins').resetOnePin('user@example.com', 'passwordpin')"
 */
async function resetOnePin(email, field) {
  if (!['passwordpin', 'transactionpin'].includes(field)) {
    throw new Error('field must be "passwordpin" or "transactionpin"');
  }
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const user = await User.findOne({ email }).select(`_id email ${field}`);
  if (!user) {
    console.log(`No user found for ${email}`);
  } else if (!user[field]) {
    console.log(`${email} already has no ${field} set`);
  } else {
    await User.updateOne({ _id: user._id }, { $unset: { [field]: 1 } });
    console.log(`Cleared ${field} for ${email} (${user._id})`);
  }
  await mongoose.disconnect();
}

module.exports = { resetOnePin };

if (require.main === module) {
  run().catch(err => {
    console.error('Script failed:', err.message);
    process.exit(1);
  });
}
