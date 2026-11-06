// Signed webhooks from Bramp to a trader's storefront-api, the same scheme
// as services/metuselaNotify.js but per merchant:
//
// POST { event, data } to merchant.webhookUrl with
//   X-Bramp-Timestamp: unix seconds
//   X-Bramp-Signature: hex HMAC-SHA256 of `${timestamp}.${rawBody}` (merchant.webhookSecret)
// Three attempts with backoff; the storefront-api can always GET the order too.
// Resolves to { ok, error } and never throws.
const crypto = require('crypto');
const axios = require('axios');
const logger = require('../utils/logger');

async function notifyMerchant(merchant, event, data) {
  if (!merchant?.webhookUrl) return { ok: false, error: 'NOT_CONFIGURED' };
  const body = JSON.stringify({ event, data });
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const sig = crypto.createHmac('sha256', merchant.webhookSecret).update(`${ts}.${body}`).digest('hex');
    try {
      await axios.post(merchant.webhookUrl, body, {
        timeout: 10000,
        headers: { 'Content-Type': 'application/json', 'X-Bramp-Timestamp': ts, 'X-Bramp-Signature': sig },
      });
      return { ok: true, error: null };
    } catch (err) {
      lastError = err.response ? `HTTP ${err.response.status}` : err.message;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  logger.error('Storefront webhook delivery failed', { merchant: merchant.slug, event, error: lastError });
  return { ok: false, error: lastError };
}

module.exports = { notifyMerchant };
