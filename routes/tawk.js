/**
 * Tawk.to Webhook Route
 *
 * Receives POST events from Tawk.to when a visitor sends a message,
 * then notifies all giftcard admin emails via Brevo.
 *
 * Tawk.to sends a HMAC-SHA1 signature in the `x-tawk-signature` header.
 * Set TAWK_WEBHOOK_SECRET in .env to enable signature verification.
 *
 * Supported events: chat:start, chat:message
 */

const express = require('express');
const crypto = require('crypto');
const { sendTawkMessageNotify } = require('../services/EmailService');

const router = express.Router();

function verifySignature(secret, rawBody, signature) {
  const expected = crypto
    .createHmac('sha1', secret)
    .update(rawBody)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

// POST /tawk/webhook
router.post('/', (req, res) => {
  const secret = process.env.TAWK_WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers['x-tawk-signature'];
    if (!sig) {
      return res.status(401).json({ success: false, error: 'Missing signature' });
    }
    const raw = req.rawBody || JSON.stringify(req.body);
    try {
      if (!verifySignature(secret, raw, sig)) {
        return res.status(401).json({ success: false, error: 'Invalid signature' });
      }
    } catch (_) {
      return res.status(401).json({ success: false, error: 'Signature verification failed' });
    }
  }

  let payload;
  try {
    const raw = req.rawBody || (Buffer.isBuffer(req.body) ? req.body.toString('utf8') : null);
    payload = raw ? JSON.parse(raw) : req.body;
  } catch (_) {
    return res.status(400).json({ success: false, error: 'Invalid JSON body' });
  }

  const event = payload?.event;

  if (event !== 'chat:start' && event !== 'chat:message') {
    return res.status(200).json({ success: true, ignored: true });
  }

  const senderType = payload?.message?.sender?.type;
  if (event === 'chat:message' && senderType !== 'visitor') {
    return res.status(200).json({ success: true, ignored: true });
  }

  const visitorName = payload?.visitor?.name || 'Unknown';
  const visitorEmail = payload?.visitor?.email || '';
  const message = payload?.message?.text || '(new chat started)';
  const chatId = payload?.chatId || '';

  sendTawkMessageNotify({ visitorName, visitorEmail, message, chatId, event })
    .catch(err => console.error('[tawk] Email notify failed:', err.message));

  return res.status(200).json({ success: true });
});

module.exports = router;
