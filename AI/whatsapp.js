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
//
// POST /whatsapp/ycloud is the same for YCloud (https://<server>/whatsapp/ycloud):
// signed with YCloud-Signature (YCLOUD_WEBHOOK_SECRET), one event per request.
// Inbound messages and delivery updates are turned into Meta's shape and go
// through the same handlers. Flows created on YCloud call /whatsapp/ycloud-flow
// (plain JSON); Flows on the old Meta number still call /whatsapp/whatsapp.

const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const StellaMessage = require('../models/stellaMessage');
const sender = require('./stellaSender');
const StellaConversation = require('../models/stellaConversation');
const StellaContact = require('../models/stellaContact');
const deskRouter = require('./stellaRouter');
const storefrontSell = require('../services/storefrontSell');
const agent = require('./stellaAgent');
const flows = require('./stellaFlows');
const logger = require('../utils/logger');

// ===== ENV =====
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || 'vibecode';

// Flows security
const APP_SECRET  = process.env.META_APP_SECRET || ''; // HMAC for every POST from Meta
const PRIVATE_KEY = (process.env.PRIVATE_KEY || '').replace(/\\n/g, '\n'); // PEM with BEGIN/END lines

// YCloud: the endpoint's signing secret (whsec_...), shown when the endpoint is created
const YCLOUD_WEBHOOK_SECRET = process.env.YCLOUD_WEBHOOK_SECRET || '';
const YCLOUD_TOLERANCE_SECONDS = 300;

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

// ===== YCloud signature: "t=<unix seconds>,s=<hex HMAC-SHA256 of `${t}.${rawBody}`>" =====
function validateYCloudSignature(req) {
  if (!YCLOUD_WEBHOOK_SECRET) return false; // not configured: refuse, never trust
  const parts = String(req.get('YCloud-Signature') || '').split(',').map(p => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1] || '';
  const sigs = parts.filter(([k, v]) => k === 's' && /^[0-9a-f]{64}$/i.test(v || '')).map(([, v]) => v);
  if (!/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > YCLOUD_TOLERANCE_SECONDS) return false;
  const ours = crypto.createHmac('sha256', YCLOUD_WEBHOOK_SECRET).update(`${t}.${req.rawBody || ''}`).digest();
  return sigs.some(s => crypto.timingSafeEqual(Buffer.from(s, 'hex'), ours));
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

// ===== Messages =====

/** A tapped button: ours (interactive) or a template's quick reply (type "button"). */
const replyOf = (msg) => msg.interactive?.button_reply || msg.interactive?.list_reply
  || (msg.type === 'button' && msg.button ? { id: msg.button.payload, title: msg.button.text } : null);

/** Records an inbound message; false if we've already handled it (Meta retry). */
async function recordInbound(msg) {
  const reply = replyOf(msg);
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

  const reply = replyOf(msg);
  logger.info('Stella: message in', { id: msg.id, from: sender.mask(waId), type: msg.type });
  // A number Bramp has blocked gets no reply (bramp-admin Storefront blocklist).
  if (await require('../services/storefrontCompliance').numberBlocked(waId)) {
    logger.warn('Stella: message from a blocked number ignored', { from: sender.mask(waId) });
    return;
  }

  await sender.markReadWithTyping(msg.id);
  // Flows aren't used for storefront customers (spec, 17 Nov 2026).
  if (flows.isFlowCompletion(msg)) return;

  // A storefront customer needs no Bramp account, sign-up or KYC: their
  // WhatsApp number is who they are (sign-up and KYC in stellaCustomers.js
  // and stellaKyc.js are no longer called).
  const text = msg.text?.body ?? null;
  const name = contact?.profile?.name ? String(contact.profile.name).slice(0, 100) : null;
  await StellaConversation.updateOne({ waId }, { $set: { lastInboundAt: new Date() }, $setOnInsert: { waId } }, { upsert: true });
  const person = await StellaContact.findOneAndUpdate(
    { waId },
    { ...(name ? { $set: { displayName: name } } : {}), $setOnInsert: { waId } },
    { upsert: true, new: true }
  );

  // Which desk (AI/stellaRouter.js); null when routing has replied itself.
  const desk = await deskRouter.route({ waId, customer: person, text, replyId: reply?.id ?? null });
  if (!desk) return;

  // The desk's own record of this customer (filters, saved accounts, addresses).
  const customer = await storefrontSell.touchCustomer(desk, waId, name);

  // Free text goes to the Claude agent, scoped to this desk (AI/stellaAgent.js).
  // Taps on buttons that aren't routing's have nothing to answer yet.
  if (!text) return;
  const out = {};
  const answer = await agent.reply({ waId, messageId: msg.id, text, desk, customer, out });
  await sender.sendText(waId, answer);
  // Each deposit address alone in its own message, straight from start_sale, so it's copied exactly.
  for (const a of out.addresses || []) {
    await sender.sendText(waId, a.address);
    if (a.memo) await sender.sendText(waId, `Memo / tag (include it, or the deposit can be lost): ${a.memo}`);
  }
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
      // Meta's alerts about a Flow (endpoint errors, latency, status changes):
      // the 'flows' field must be subscribed before a Flow can be published.
      if (change.field === 'flows') {
        logger.warn('Stella: Flows alert from Meta', { event: change.value?.event, flowId: change.value?.flow_id, message: change.value?.message, status: change.value?.new_status || null, alert: change.value?.alert_state || null });
        continue;
      }
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

// ===== YCloud events → Meta's shape =====
// YCloud keeps Meta's message objects (text, interactive, button, image…)
// and adds its own envelope. We key messages by wamid, as with Meta, so the
// duplicate check and the typing indicator work the same way.
function fromYCloudInbound(m) {
  const msg = { ...m, id: m.wamid || m.id, from: m.from };
  delete msg.wamid; delete msg.customerProfile; delete msg.wabaId; delete msg.to; delete msg.sendTime;
  const contact = { wa_id: sender.waDigits(m.from), profile: { name: m.customerProfile?.name } };
  return { msg, contact };
}

function fromYCloudStatus(m) {
  const error = m.errorMessage || m.whatsappApiError?.message || null;
  return { id: m.wamid || m.id, status: m.status, errors: error ? [{ message: error }] : [] };
}

async function processYCloudEvent(ev) {
  if (ev.type === 'whatsapp.inbound_message.received' && ev.whatsappInboundMessage) {
    const { msg, contact } = fromYCloudInbound(ev.whatsappInboundMessage);
    await inOrder(sender.waDigits(msg.from), () => handleMessage(msg, contact))
      .catch(err => logger.error('Stella: message handling failed', { id: msg.id, error: err.message, stack: err.stack }));
    return;
  }
  if (ev.type === 'whatsapp.message.updated' && ev.whatsappMessage) {
    const st = fromYCloudStatus(ev.whatsappMessage);
    try { await handleStatus(st); }
    catch (err) { logger.warn('Stella: status update failed', { id: st.id, error: err.message }); }
    return;
  }
  if (ev.type === 'whatsapp.flow.status_change' || ev.type === 'whatsapp.template.reviewed' || ev.type === 'whatsapp.phone_number.quality_updated') {
    logger.warn('Stella: YCloud account event', { type: ev.type, event: ev });
    return;
  }
  logger.info('Stella: YCloud event ignored', { type: ev.type, id: ev.id });
}

router.post('/ycloud', (req, res) => {
  if (!validateYCloudSignature(req)) {
    logger.warn('Stella: rejected request with a bad or missing YCloud signature', { ip: req.ip, secretConfigured: !!YCLOUD_WEBHOOK_SECRET });
    return res.status(401).send('');
  }
  const ev = parseBody(req);
  if (!ev || !ev.type) return res.status(400).send('');
  // Acknowledge first: YCloud retries on a slow answer. Its retries reuse the
  // event id; for messages the wamid duplicate check catches them.
  res.status(200).json({ status: 'ok' });
  processYCloudEvent(ev).catch(err => logger.error('Stella: YCloud webhook processing failed', { type: ev.type, error: err.message, stack: err.stack }));
});

// ===== YCloud Flow endpoint (POST /whatsapp/ycloud-flow) =====
// The sign-up and sign-in Flows' endpointUri on YCloud. YCloud forwards
// Meta's Flow requests as plain JSON and sends no signature, so the only
// gate is the flow_token: AI/stellaFlows.js answers "expired" to any token
// it didn't issue to that customer. Must answer within 15 seconds.
router.post('/ycloud-flow', async (req, res) => {
  const b = parseBody(req);
  if (!b || typeof b !== 'object' || Array.isArray(b)) return res.status(400).json({ error: 'Expected a JSON object' });
  const action = String(b.action || '').toLowerCase();
  if (action === 'ping') return res.json({ data: { status: 'active' } });
  if (b.data?.error) {
    logger.warn('Stella: YCloud Flow error notification', { error: b.data.error, message: b.data.error_message });
    return res.json({ data: { acknowledged: true } });
  }
  try {
    return res.json(await flows.handleExchange(b));
  } catch (e) {
    logger.error('Flow handler error (YCloud)', { screen: b.screen, action, error: e.message, stack: e.stack });
    return res.json({ screen: b.screen || 'NAME', data: { error_message: 'Something went wrong. Please try again.' } });
  }
});

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

        // A Flow's screen (AI/stellaFlows.js answers with the next one)
        let responsePayload;
        try {
          responsePayload = await flows.handleExchange(payload);
        } catch (e) {
          logger.error('Flow handler error', { screen: payload.screen, action, error: e.message, stack: e.stack });
          responsePayload = { screen: payload.screen || 'NAME', data: { error_message: 'Something went wrong. Please try again.' } };
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
