// AI/stellaFlowTokens.js
// Which WhatsApp Flows Stella uses, and the token that ties a Flow back to
// the customer. Meta sends a Flow's screens to AI/whatsapp.js with only our
// flow_token, never the phone number, so the token is the session: random,
// one per Flow sent (a new one replaces the old), valid for an hour, and only
// its hash is stored on StellaConversation.
//
// Flows are off until their IDs are set (both made in WhatsApp Manager from
// the JSON in AI/flows/):
//   STELLA_SIGNUP_FLOW_ID — sign-up: name → email → code (uses the endpoint)
//   STELLA_KYC_FLOW_ID    — identity: NIN/BVN → camera selfie (no endpoint)
//   STELLA_FLOW_MODE      — 'draft' to test unpublished Flows; default 'published'
// Without them Stella falls back to sign-up by text and the bramp.shop link.
const crypto = require('crypto');
const StellaConversation = require('../models/stellaConversation');

const TOKEN_TTL_MINUTES = 60;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const flowId = (purpose) => (purpose === 'SIGNUP' ? process.env.STELLA_SIGNUP_FLOW_ID : process.env.STELLA_KYC_FLOW_ID) || null;
const enabled = (purpose) => Boolean(flowId(purpose));
const mode = () => (process.env.STELLA_FLOW_MODE === 'draft' ? 'draft' : 'published');

/** A fresh token for this customer's next Flow; replaces any earlier one. */
async function issue(waId, purpose) {
  const token = `${purpose.toLowerCase()}_${crypto.randomBytes(24).toString('base64url')}`;
  await StellaConversation.updateOne(
    { waId },
    { $set: { flow: { tokenHash: sha256(token), purpose, expiresAt: new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000) } }, $setOnInsert: { waId } },
    { upsert: true }
  );
  return token;
}

/** The conversation a token belongs to, if it's still live and for this purpose. */
async function find(token, purpose) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  return StellaConversation.findOne({ 'flow.tokenHash': sha256(token), 'flow.purpose': purpose, 'flow.expiresAt': { $gt: new Date() } });
}

/** Retires a token once its Flow has done its job. */
const retire = (convoId) => StellaConversation.updateOne({ _id: convoId }, { $set: { flow: { tokenHash: null, purpose: null, expiresAt: null } } });

module.exports = { flowId, enabled, mode, issue, find, retire, TOKEN_TTL_MINUTES };
