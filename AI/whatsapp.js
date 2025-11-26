// routes/whatsapp.js
// Single endpoint for everything:
// - Normal WhatsApp webhook (messages)
// - Flows: health ping (unencrypted OR encrypted → Base64 text/plain)
// - Flows: async error ack (unencrypted, Base64 text/plain)
// - Flows: data_exchange (AES-GCM encrypted, Base64 text/plain)

const express = require('express');
const router = express.Router();
const axios = require('axios');
const OpenAI = require('openai');
const crypto = require('crypto');
const logger = require('../utils/logger');

// ===== ENV =====
const META_ACCESS_TOKEN    = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;
const META_VERIFY_TOKEN    = process.env.META_VERIFY_TOKEN || 'vibecode';

// Flows security
const APP_SECRET  = process.env.META_APP_SECRET || ''; // HMAC for flows requests
const PRIVATE_KEY = (process.env.PRIVATE_KEY || '').replace(/\\n/g, '\n'); // PEM with BEGIN/END lines

// Optional placeholders
const SIGNUP_FLOW_ID = process.env.SIGNUP_FLOW_ID || '';
const OTP_FLOW_ID    = process.env.OTP_FLOW_ID || '';

// ===== AI (idle) =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
let openai = null;
if (OPENAI_API_KEY && OPENAI_API_KEY.startsWith('sk-')) {
  try { openai = new OpenAI({ apiKey: OPENAI_API_KEY }); console.log('✅ OpenAI ready'); }
  catch (e) { console.error('❌ OpenAI init failed:', e.message); }
} else {
  console.log('ℹ️ OPENAI_API_KEY missing/invalid; AI idle');
}
async function getAIResponse(_userId, _text) { return openai ? '...' : '...'; }

// ===== In-memory state =====
const seenMessages      = new Map();
const lastWelcomeAt     = new Map();
const followUpSentOnce  = new Map();

// ===== Helpers =====
function toWabaId(v) { return String(v || '').replace(/[^\d]/g, ''); }
function normalizePhoneNumber(phone) {
  if (!phone) return '';
  let c = phone.replace(/[^\d]/g, '');
  if (c.startsWith('234') && c.length === 13) return '+' + c;
  if (c.startsWith('0') && c.length === 11)  return '+234' + c.slice(1);
  if (c.length >= 10 && c.length <= 15)      return '+' + c;
  return c;
}
function isValidPhoneNumber(phone) { return /^\+?\d{10,15}$/.test(phone); }

function rememberSeen(id) {
  const now = Date.now();
  seenMessages.set(id, now);
  for (const [k, ts] of seenMessages) if (now - ts > 5 * 60 * 1000) seenMessages.delete(k);
}
function alreadySeen(id) {
  if (!id) return false;
  const ts = seenMessages.get(id);
  return ts ? (Date.now() - ts) < 5 * 60 * 1000 : false;
}
function canSendWelcome(waId) {
  const last = lastWelcomeAt.get(waId) || 0;
  return (Date.now() - last) > 45 * 1000;
}
function markWelcomeSent(waId) { lastWelcomeAt.set(waId, Date.now()); }
function hasSentFollowUp(waId) { return !!followUpSentOnce.get(waId); }
function markFollowUpSent(waId) { followUpSentOnce.set(waId, true); }

// ===== WhatsApp senders (Graph v22.0) =====
async function sendTypingIndicator(messageId, toWaId) {
  try {
    if (!META_ACCESS_TOKEN || !META_PHONE_NUMBER_ID) return;
    const payload = {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      typing_indicator: { type: 'text' },
      to: toWabaId(toWaId)
    };
    const resp = await axios.post(
      `https://graph.facebook.com/v22.0/${META_PHONE_NUMBER_ID}/messages`,
      payload,
      { headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    logger.info('📝 Typing indicator sent', {
      messageId,
      status: resp.status,
      fbMsgId: resp.data?.messages?.[0]?.id || null
    });
  } catch (e) {
    logger.warn('Typing indicator failed (non-critical)', {
      error: e.message, status: e.response?.status, data: e.response?.data
    });
  }
}

async function sendInteractiveWelcome(to, displayName) {
  if (!META_ACCESS_TOKEN || !META_PHONE_NUMBER_ID) throw new Error('Missing Meta WhatsApp credentials');
  const waTo = toWabaId(to);
  const txt =
    `👋 Welcome ${displayName || 'there'}, Welcome to Bramp AI where you can buy and sell digital assets like USDT, USDC, BTC, ETH, BSC and many more with your local bank bank account. Click the button to get started. 🚀`;
  const payload = {
    messaging_product: 'whatsapp',
    to: waTo,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: txt },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'start_signup', title: 'Get Started' } }
        ]
      }
    }
  };
  const resp = await axios.post(
    `https://graph.facebook.com/v22.0/${META_PHONE_NUMBER_ID}/messages`,
    payload,
    { headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
  );
  const msgId = resp.data?.messages?.[0]?.id;
  logger.info('📤 Welcome interactive sent', { id: msgId, to: waTo.slice(0, 8) + '****' });
  return msgId;
}

async function sendTextMessage(to, text) {
  if (!META_ACCESS_TOKEN || !META_PHONE_NUMBER_ID) throw new Error('Missing Meta WhatsApp credentials');
  const waTo = toWabaId(to);
  const payload = {
    messaging_product: 'whatsapp',
    to: waTo,
    type: 'text',
    text: { body: text }
  };
  const resp = await axios.post(
    `https://graph.facebook.com/v22.0/${META_PHONE_NUMBER_ID}/messages`,
    payload,
    { headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
  );
  const msgId = resp.data?.messages?.[0]?.id;
  logger.info('📤 Text sent', { id: msgId, to: waTo.slice(0, 8) + '****' });
  return msgId;
}

// ===== Body parser for this route that preserves raw body (for HMAC) =====
router.use('/whatsapp', express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; }
}));

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

// ===== HMAC validation (Flows requests) =====
function validateMetaSignature(req) {
  if (!APP_SECRET) return true; // skip if not configured
  const header = req.get('X-Hub-Signature-256') || req.get('x-hub-signature-256') || '';
  const their = header.replace(/^sha256=/i, '');
  const hmac = crypto.createHmac('sha256', APP_SECRET);
  hmac.update(req.rawBody || Buffer.alloc(0));
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

// ===== Unified endpoint =====
router.post('/whatsapp', async (req, res) => {
  try {
    const b = req.body || {};

    // 1) Health check (unencrypted)
    if (!b.encrypted_aes_key && String(b.action || '').toLowerCase() === 'ping') {
      if (!validateMetaSignature(req)) return res.status(401).send(''); // empty on failure
      logger.info('Flow health ping (UNENCRYPTED) @ /whatsapp');
      return sendBase64Plain(res, { data: { status: 'active' } }, 200);
    }

    // 2) Async error (unencrypted)
    if (!b.encrypted_aes_key && b.data?.error) {
      if (!validateMetaSignature(req)) return res.status(401).send('');
      logger.warn('Flow async error notification', { body: b });
      return sendBase64Plain(res, { data: { acknowledged: true } }, 200);
    }

    // 3) Encrypted (health or data_exchange)
    if (b.encrypted_aes_key && b.encrypted_flow_data && b.initial_vector) {
      if (!validateMetaSignature(req)) return res.status(401).send('');
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

    // --- Not a Flows call → normal WhatsApp webhook handling below ---
    logger.info('🔔 Incoming webhook', {
      headers: req.headers,
      preview: JSON.stringify(b).slice(0, 600),
      timestamp: new Date().toISOString()
    });

    const entry   = b.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    if (changes?.field === 'messages' && value?.messages?.[0]) {
      const msg         = value.messages[0];
      const messageId   = msg.id;
      const fromWaId    = msg.from;
      const waFrom      = toWabaId(fromWaId);
      const contact     = value.contacts?.[0];
      const displayName = contact?.profile?.name || 'there';

      if (alreadySeen(messageId)) return res.status(200).json({ status: 'ok' });
      rememberSeen(messageId);

      const normalized = normalizePhoneNumber(fromWaId);
      if (!isValidPhoneNumber(normalized)) {
        logger.warn('Invalid phone; ignoring', { from: normalized || fromWaId });
        return res.status(200).json({ status: 'ok' });
      }

      if (msg.interactive && msg.interactive.type === 'button_reply') {
        logger.info('Button pressed (ignored for now)', { id: msg.interactive.button_reply?.id });
        return res.status(200).json({ status: 'ok' });
      }

      if (canSendWelcome(waFrom)) {
        await sendTypingIndicator(messageId, fromWaId);
        await new Promise(r => setTimeout(r, 2200));
        try {
          await sendInteractiveWelcome(waFrom, displayName);
          markWelcomeSent(waFrom);
        } catch (e) {
          logger.error('Failed to send welcome interactive', {
            error: e.message, status: e.response?.status, data: e.response?.data
          });
        }
        return res.status(200).json({ status: 'ok' });
      }

      if (!hasSentFollowUp(waFrom)) {
        await sendTypingIndicator(messageId, fromWaId);
        await new Promise(r => setTimeout(r, 2200));
        const followUp = `🤖 Click the button and we can get right into it, ${displayName}.`;
        try {
          await sendTextMessage(waFrom, followUp);
          markFollowUpSent(waFrom);
        } catch (e) {
          logger.error('Failed to send follow-up text', {
            error: e.message, status: e.response?.status, data: e.response?.data
          });
        }
        return res.status(200).json({ status: 'ok' });
      }

      return res.status(200).json({ status: 'ok' });
    }

    // Status/other
    return res.status(200).json({ status: 'ok' });

  } catch (err) {
    logger.error('Webhook error', { error: err.message, stack: err.stack });
    return res.status(200).json({ status: 'error' });
  }
});

module.exports = router;
