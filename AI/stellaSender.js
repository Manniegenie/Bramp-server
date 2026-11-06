// AI/stellaSender.js
// The only place Stella calls Meta's send API. Everything Stella says goes
// through here, so rate limits, templates outside the 24-hour window and
// per-order message cost can be added in one place later. Each sent message
// is logged in models/stellaMessage.js; Meta's delivery statuses update it
// (AI/whatsapp.js). Resolves to { ok, id, error } and never throws.
const axios = require('axios');
const StellaMessage = require('../models/stellaMessage');
const logger = require('../utils/logger');

const GRAPH_VERSION = 'v22.0';

const waDigits = (v) => String(v || '').replace(/[^\d]/g, '');
const mask = (waId) => `${waDigits(waId).slice(0, 6)}****`;

async function post(payload) {
  const token = process.env.META_ACCESS_TOKEN;
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) return { ok: false, id: null, error: 'NOT_CONFIGURED' };
  try {
    const resp = await axios.post(
      `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', ...payload },
      { timeout: 10000, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );
    return { ok: true, id: resp.data?.messages?.[0]?.id || null, error: null };
  } catch (err) {
    const error = err.response?.data?.error?.message || err.message;
    logger.error('Stella: Meta send failed', { type: payload.type || payload.status, to: payload.to ? mask(payload.to) : undefined, status: err.response?.status, error });
    return { ok: false, id: null, error };
  }
}

async function logOutbound(to, type, text, result, orderReference = null) {
  if (!result.ok || !result.id) return;
  try {
    await StellaMessage.create({ waMessageId: result.id, direction: 'OUT', waId: waDigits(to), type, text, status: 'sent', orderReference });
  } catch (err) {
    logger.warn('Stella: could not log outbound message', { id: result.id, error: err.message });
  }
}

/** Marks the customer's message read and shows typing dots (up to 25s or until we reply). */
function markReadWithTyping(messageId) {
  return post({ status: 'read', message_id: messageId, typing_indicator: { type: 'text' } });
}

async function sendText(to, text, { orderReference } = {}) {
  const result = await post({ to: waDigits(to), type: 'text', text: { body: text } });
  await logOutbound(to, 'text', text, result, orderReference);
  return result;
}

/** Up to 3 reply buttons: [{ id, title }], titles at most 20 characters. */
async function sendButtons(to, body, buttons, { orderReference } = {}) {
  const result = await post({
    to: waDigits(to),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: { buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
    },
  });
  await logOutbound(to, 'interactive', body, result, orderReference);
  return result;
}

module.exports = { markReadWithTyping, sendText, sendButtons, waDigits, mask };
