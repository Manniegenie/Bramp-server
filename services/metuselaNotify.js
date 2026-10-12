// Signed webhooks from Bramp to Metusela, shared by the on-ramp
// (services/metuselaOnramp.js) and crypto wallet (services/metuselaWallet.js).
//
// POST { event, data } to METUSELA_WEBHOOK_URL with
//   X-Bramp-Timestamp: unix seconds
//   X-Bramp-Signature: hex HMAC-SHA256 of `${timestamp}.${rawBody}` (METUSELA_WEBHOOK_SECRET)
// Three attempts with backoff; Metusela can always GET the resource too.
// Resolves to { ok, error } and never throws.
const crypto = require('crypto');
const axios = require('axios');
const logger = require('../utils/logger');

async function notifyMetusela(event, data) {
  const url = process.env.METUSELA_WEBHOOK_URL;
  const secret = process.env.METUSELA_WEBHOOK_SECRET;
  if (!url || !secret) {
    logger.warn('Metusela webhook not configured, skipping', { event });
    return { ok: false, error: 'NOT_CONFIGURED' };
  }
  const body = JSON.stringify({ event, data });
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
    try {
      await axios.post(url, body, {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json', 'X-Bramp-Timestamp': ts, 'X-Bramp-Signature': sig },
      });
      return { ok: true, error: null };
    } catch (err) {
      lastError = err.response ? `HTTP ${err.response.status}` : err.message;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  logger.error('Metusela webhook delivery failed', { event, error: lastError });
  return { ok: false, error: lastError };
}

module.exports = { notifyMetusela };
