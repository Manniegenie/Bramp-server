// services/storefrontJobs.js
// Every minute: send storefront payouts whose first-payer delay has passed
// (services/storefrontBuy.js) and release held proceeds past their hold to
// traders' NGNB balances (services/storefrontLedger.js). Started from
// server.js once the server is listening.
const cron = require('node-cron');
const { releaseDelayed } = require('./storefrontBuy');
const { releaseMatured } = require('./storefrontLedger');
const logger = require('../utils/logger');

let running = false;

async function tick() {
  if (running) return; // a slow run (Obiex, say) shouldn't overlap the next
  running = true;
  try {
    await releaseDelayed();
    await releaseMatured();
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
