// services/storefrontJobs.js
// Every minute: send storefront payouts whose first-payer delay has passed
// (services/storefrontBuy.js) and release held proceeds past their hold to
// traders' NGNB balances (services/storefrontLedger.js), and hand offramp
// sales stuck mid-way to Bramp ops and retry Self rate sales waiting for a
// trader's top-up (services/storefrontSell.js). Started from
// server.js once the server is listening.
const cron = require('node-cron');
const { releaseDelayed } = require('./storefrontBuy');
const { releaseMatured } = require('./storefrontLedger');
const { flagStuck, retryAwaitingFunds, releaseHeld } = require('./storefrontSell');
const logger = require('../utils/logger');

let running = false;

async function tick() {
  if (running) return; // a slow run (Obiex, say) shouldn't overlap the next
  running = true;
  try {
    await releaseDelayed();
    await releaseMatured();
    await flagStuck();
    await retryAwaitingFunds();
    await releaseHeld();
  } catch (err) {
    logger.error('Storefront job failed', { error: err.message, stack: err.stack });
  } finally {
    running = false;
  }
}

function startStorefrontJobs() {
  cron.schedule('* * * * *', tick);
}

module.exports = { startStorefrontJobs, tick };
