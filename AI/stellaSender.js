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

/** A message with one button that opens a URL (WhatsApp "cta_url"); label at most 20 characters. */
async function sendLink(to, body, label, url) {
  const result = await post({
    to: waDigits(to),
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      body: { text: body },
      action: { name: 'cta_url', parameters: { display_text: label, url } },
    },
  });
  await logOutbound(to, 'interactive', body, result);
  return result;
}

/**
 * A WhatsApp Flow (a form inside the chat). It opens on `screen` with `data`;
 * `token` comes back with every screen (AI/stellaFlowTokens.js). cta at most
 * 30 characters, no emoji.
 */
async function sendFlow(to, { body, cta, flowId, token, screen, data, mode = 'published' }) {
  const result = await post({
    to: waDigits(to),
    type: 'interactive',
    interactive: {
      type: 'flow',
      body: { text: body },
      action: {
        name: 'flow',
        parameters: {
          flow_message_version: '3',
          flow_id: flowId,
          flow_token: token,
          flow_cta: cta,
          flow_action: 'navigate',
          flow_action_payload: { screen, ...(data && Object.keys(data).length ? { data } : {}) },
          mode,
        },
      },
    },
  });
  await logOutbound(to, 'interactive', body, result);
  return result;
}

/**
 * An approved message template: the only kind WhatsApp delivers outside the
 * 24-hour window. bodyParams fill {{1}}, {{2}}…; quickReplies are the
 * payloads for the template's quick-reply buttons, in order.
 */
async function sendTemplate(to, { name, language = 'en', bodyParams = [], quickReplies = [] }, logText = null) {
  const components = [];
  if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams.map((t) => ({ type: 'text', text: String(t) })) });
  quickReplies.forEach((payload, i) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload }] }));
  const result = await post({ to: waDigits(to), type: 'template', template: { name, language: { code: language }, components } });
  await logOutbound(to, 'template', logText || `[template ${name}]`, result);
  return result;
}

/**
 * Downloads media a customer sent (e.g. a Flow's photo) by its media id:
 * Meta gives a short-lived URL, fetched with the same token. Resolves to
 * { ok, buffer, mimeType, error } and never throws.
 */
async function downloadMedia(mediaId, { maxBytes = 10 * 1024 * 1024 } = {}) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return { ok: false, error: 'NOT_CONFIGURED' };
  if (!/^\d{5,30}$/.test(String(mediaId || ''))) return { ok: false, error: 'BAD_MEDIA_ID' };
  try {
    const auth = { Authorization: `Bearer ${token}` };
    const meta = await axios.get(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, { timeout: 10000, headers: auth });
    if (Number(meta.data?.file_size) > maxBytes) return { ok: false, error: 'TOO_LARGE' };
    const file = await axios.get(meta.data.url, { timeout: 20000, headers: auth, responseType: 'arraybuffer', maxContentLength: maxBytes });
    return { ok: true, buffer: Buffer.from(file.data), mimeType: meta.data?.mime_type || file.headers['content-type'] || null, error: null };
  } catch (err) {
    const error = err.response?.data?.error?.message || err.message;
    logger.error('Stella: media download failed', { status: err.response?.status, error });
    return { ok: false, error };
  }
}

module.exports = { markReadWithTyping, sendText, sendButtons, sendLink, sendFlow, sendTemplate, downloadMedia, waDigits, mask };
