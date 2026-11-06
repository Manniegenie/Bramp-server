// AI/whatsapp.js — Stella by Bramp, Storefront's WhatsApp channel.
// Mounted at /whatsapp in server.js, so Meta's webhook URL is
// https://<server>/whatsapp/whatsapp. One endpoint for everything Meta sends:
// - GET: webhook verification (META_VERIFY_TOKEN)
// - POST, Flows: health ping, async error ack, data_exchange (AES-GCM encrypted)
// - POST, messages and delivery statuses
//
// Every POST must carry a valid X-Hub-Signature-256 (META_APP_SECRET); with
// no secret configured we refuse rather than trust. server.js reads the body
// into req.rawBody before express.json runs, so req.body is empty here: we
// parse req.rawBody ourselves. Messages are acknowledged with 200 at once and
// handled afterwards, so a slow reply never makes Meta retry. Sending is done
// by AI/stellaSender.js; models/stellaMessage.js is the duplicate check.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const StellaMessage = require('../models/stellaMessage');
const sender = require('./stellaSender');
const customers = require('./stellaCustomers');
const stellaKyc = require('./stellaKyc');
const logger = require('../utils/logger');

// ===== ENV =====
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'vibecode';

// Flows security
const APP_SECRET  = process.env.META_APP_SECRET || ''; // HMAC for every POST from Meta
const PRIVATE_KEY = (process.env.PRIVATE_KEY || '').replace(/\\n/g, '\n'); // PEM with BEGIN/END lines

// ===== One message at a time per customer =====
// A customer who sends two messages quickly mustn't have both race through
// the same conversation state. Per process: fine while the server runs as
// one instance.
const queues = new Map();
function inOrder(waId, fn) {
  const prev = queues.get(waId) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(waId, next);
  next.finally(() => { if (queues.get(waId) === next) queues.delete(waId); });
  return next;
}

// ===== Body (server.js captures it raw for /whatsapp) =====
function parseBody(req) {
  if (typeof req.rawBody === 'string' && req.rawBody.length) {
    try { return JSON.parse(req.rawBody); } catch { return null; }
  }
  return req.body && typeof req.body === 'object' ? req.body : null;
}

// ===== Webhook verification (GET) =====
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const challenge = req.query['hub.challenge'];
  const token = req.query['hub.verify_token'];
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    logger.info('✅ Meta webhook verified');
    return res.status(200).send(challenge);
  }
  logger.warn('❌ Meta webhook verification failed', { mode, tokenPresent: !!token });
  return res.status(403).end();
});

// ===== HMAC validation (every POST) =====
function validateMetaSignature(req) {
  if (!APP_SECRET) return false; // not configured: refuse, never trust
  const header = req.get('X-Hub-Signature-256') || '';
  const their = header.replace(/^sha256=/i, '');
  const hmac = crypto.createHmac('sha256', APP_SECRET);
  hmac.update(req.rawBody || '');
  const ours = hmac.digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(their, 'hex'), Buffer.from(ours, 'hex')); }
  catch { return false; }
}

// ===== Crypto helpers (Flows) =====
function rsaOaepSha256Decrypt(base64Payload) {
  const buf = Buffer.from(base64Payload, 'base64');
  return crypto.privateDecrypt(
    { key: crypto.createPrivateKey(PRIVATE_KEY), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    buf
  );
}
function aesGcmDecrypt({ ciphertextB64, keyBuf, ivB64 }) {
  const ciphertext = Buffer.from(ciphertextB64, 'base64');
  const iv = Buffer.from(ivB64, 'base64');
  const TAG_LEN = 16;
  const body = ciphertext.subarray(0, -TAG_LEN);
  const tag  = ciphertext.subarray(-TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-128-gcm', keyBuf, iv);
  decipher.setAuthTag(tag);
  const clear = Buffer.concat([decipher.update(body), decipher.final()]);
  return clear.toString('utf8');
}
function flipIvB64(ivB64) {
  const iv = Buffer.from(ivB64, 'base64');
  const flipped = Buffer.from(iv.map(b => (~b) & 0xff));
  return flipped;
}
function aesGcmEncrypt({ jsonObject, keyBuf, flippedIvBuf }) {
  const cipher = crypto.createCipheriv('aes-128-gcm', keyBuf, flippedIvBuf);
  const enc = Buffer.concat([cipher.update(JSON.stringify(jsonObject), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([enc, tag]).toString('base64');
}
function sendBase64Plain(res, obj, status = 200) {
  const b64 = Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
  res.set('Content-Type', 'text/plain');
  return res.status(status).send(b64);
}

// ===== Simple flow handlers (your business logic goes here) =====
// Placeholders: neither checks anything yet. Don't wire their result to
// anything until they're real (tracker: AI/whatsapp.js).
const phoneRe = /^\+?\d{10,15}$/;
const pinRe   = /^\d{6}$/;
function success(flow_token, extraParams = {}) {
  return { screen: 'SUCCESS', data: { extension_message_response: { params: { flow_token, ...extraParams } } } };
}
const flowHandlers = {
  '/signin/signin-pin': async (form, flow_token) => {
    const phonenumber = String(form.phonenumber || '');
    const pin = String(form.passwordpin || '').padStart(6, '0');
    if (!phoneRe.test(phonenumber)) return { screen: 'SIGN_IN', data: { error_message: 'Enter a valid phone number.' } };
    if (!pinRe.test(pin))           return { screen: 'SIGN_IN', data: { error_message: 'PIN must be exactly 6 digits.' } };
    // TODO: real auth
    return success(flow_token, { login: 'ok' });
  },
  '/signup/add-user': async (form, flow_token) => {
    const { firstname, lastname, email, phonenumber } = form || {};
    if (!firstname || !lastname || !email || !phonenumber) return { screen: 'SIGN_UP', data: { error_message: 'Fill all required fields.' } };
    if (!phoneRe.test(phonenumber)) return { screen: 'SIGN_UP', data: { error_message: 'Invalid phone number.' } };
    // TODO: real create-user
    return success(flow_token, { signup: 'ok' });
  }
};

// ===== Messages =====

/** Records an inbound message; false if we've already handled it (Meta retry). */
async function recordInbound(msg) {
  const reply = msg.interactive?.button_reply || msg.interactive?.list_reply || null;
  try {
    await StellaMessage.create({
      waMessageId: msg.id,
      direction: 'IN',
      waId: sender.waDigits(msg.from),
      type: msg.type || 'unknown',
      text: msg.text?.body ?? reply?.title ?? null,
      replyId: reply?.id ?? null,
    });
    return true;
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
}

async function handleMessage(msg, contact) {
  const waId = sender.waDigits(msg.from);
  if (!msg.id || waId.length < 10 || waId.length > 15) return;
  if (!(await recordInbound(msg))) return;

  const displayName = contact?.profile?.name || 'there';
  const reply = msg.interactive?.button_reply || msg.interactive?.list_reply || null;
  logger.info('Stella: message in', { id: msg.id, from: sender.mask(waId), type: msg.type });

  await sender.markReadWithTyping(msg.id);
  const customer = await customers.handleIncoming({
    waId,
    text: msg.text?.body ?? null,
    replyId: reply?.id ?? null,
    displayName,
  });
  if (!customer) return; // still signing up: AI/stellaCustomers.js replied

  // Nothing else until the one-time identity check is done (AI/stellaKyc.js).
  if ((await stellaKyc.promptIfNeeded(waId, customer)) !== 'verified') return;

  // Desk routing (M6) and the Claude agent (M7) take over from here.
  await sender.sendText(waId, "You're all set on Stella. Trading with desks opens soon, and I'll be able to help right here.");
}

async function handleStatus(st) {
  if (!st.id || !['sent', 'delivered', 'read', 'failed'].includes(st.status)) return;
  const error = st.status === 'failed' ? (st.errors?.[0]?.title || st.errors?.[0]?.message || 'failed') : null;
  // 'read' can arrive before 'delivered'; never move a read message back.
  const filter = st.status === 'read' ? { waMessageId: st.id } : { waMessageId: st.id, status: { $ne: 'read' } };
  await StellaMessage.updateOne(filter, { $set: { status: st.status, statusError: error } });
}

async function processWebhook(b) {
  for (const entry of b.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};
      for (const msg of value.messages || []) {
        const contact = (value.contacts || []).find(c => c.wa_id === msg.from) || value.contacts?.[0];
        await inOrder(sender.waDigits(msg.from), () => handleMessage(msg, contact))
          .catch(err => logger.error('Stella: message handling failed', { id: msg.id, error: err.message, stack: err.stack }));
      }
      for (const st of value.statuses || []) {
        try { await handleStatus(st); }
        catch (err) { logger.warn('Stella: status update failed', { id: st.id, error: err.message }); }
      }
    }
  }
}

// ===== Unified endpoint =====
router.post('/whatsapp', async (req, res) => {
  try {
    if (!validateMetaSignature(req)) {
      logger.warn('Stella: rejected request with a bad or missing Meta signature', { ip: req.ip, secretConfigured: !!APP_SECRET });
      return res.status(401).send('');
    }
    const b = parseBody(req);
    if (!b) return res.status(400).send('');

    // 1) Health check (unencrypted)
    if (!b.encrypted_aes_key && String(b.action || '').toLowerCase() === 'ping') {
      logger.info('Flow health ping (UNENCRYPTED) @ /whatsapp');
      return sendBase64Plain(res, { data: { status: 'active' } }, 200);
    }

    // 2) Async error (unencrypted)
    if (!b.encrypted_aes_key && b.data?.error) {
      logger.warn('Flow async error notification', { error: b.data.error });
      return sendBase64Plain(res, { data: { acknowledged: true } }, 200);
    }

    // 3) Encrypted (health or data_exchange)
    if (b.encrypted_aes_key && b.encrypted_flow_data && b.initial_vector) {
      if (!PRIVATE_KEY) return res.status(500).send('');
      try {
        // Decrypt key and payload
        const aesKeyBuf = rsaOaepSha256Decrypt(b.encrypted_aes_key);
        const clearStr  = aesGcmDecrypt({ ciphertextB64: b.encrypted_flow_data, keyBuf: aesKeyBuf, ivB64: b.initial_vector });
        const payload   = JSON.parse(clearStr);
        const action    = String(payload.action || '').toLowerCase();

        // Encrypted health ping
        if (action === 'ping') {
          logger.info('Flow health ping (ENCRYPTED) @ /whatsapp');
          const healthJson = { data: { status: 'active' } };
          const flippedIvBuf = flipIvB64(b.initial_vector);
          const encryptedResponse = aesGcmEncrypt({ jsonObject: healthJson, keyBuf: aesKeyBuf, flippedIvBuf });
          res.set('Content-Type', 'text/plain');
          return res.status(200).send(encryptedResponse);
        }

        // Normal data-exchange routing
        let responsePayload;
        if (action === 'init' || action === 'back') {
          responsePayload = { screen: 'SIGN_IN', data: {} };
        } else if (action === 'data_exchange') {
          const endpoint = payload?.data?.endpoint;
          const handler  = endpoint && flowHandlers[endpoint];
          if (!handler) {
            responsePayload = { screen: payload.screen || 'SIGN_IN', data: { error_message: 'Unknown action. Please try again.' } };
          } else {
            try {
              responsePayload = await handler(payload.data, payload.flow_token);
            } catch (e) {
              logger.error('Flow handler error', { endpoint, error: e.message, stack: e.stack });
              responsePayload = { screen: payload.screen || 'SIGN_IN', data: { error_message: 'Something went wrong. Please try again.' } };
            }
          }
        } else {
          responsePayload = { screen: 'SIGN_IN', data: { error_message: 'Unsupported action.' } };
        }

        // Encrypt response and return Base64 text/plain
        const flippedIvBuf = flipIvB64(b.initial_vector);
        const encryptedResponse = aesGcmEncrypt({ jsonObject: responsePayload, keyBuf: aesKeyBuf, flippedIvBuf });
        res.set('Content-Type', 'text/plain');
        return res.status(200).send(encryptedResponse);

      } catch (e) {
        logger.error('Flows decrypt/encrypt failure', { error: e.message });
        // 421 forces client to refresh key & retry
        return res.status(421).send('');
      }
    }

    // --- Not a Flows call → messages and statuses: acknowledge first, then handle ---
    res.status(200).json({ status: 'ok' });
    processWebhook(b).catch(err => logger.error('Stella: webhook processing failed', { error: err.message, stack: err.stack }));

  } catch (err) {
    logger.error('Webhook error', { error: err.message, stack: err.stack });
    if (!res.headersSent) return res.status(200).json({ status: 'error' });
  }
});

module.exports = router;
