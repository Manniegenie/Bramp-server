// AI/stellaFlowTokens.js
// Which WhatsApp Flows Stella uses, and the token that ties a Flow back to
// the customer. Meta sends a Flow's screens to AI/whatsapp.js with only our
// flow_token, never the phone number, so the token is the session: random,
// one per Flow sent (a new one replaces the old), valid for an hour, and only
// its hash is stored on StellaConversation.
//
// Flows are off until their IDs are set (each made in WhatsApp Manager from
// the JSON in AI/flows/):
//   STELLA_SIGNUP_FLOW_ID — sign-up: name → email → code (uses the endpoint)
//   STELLA_SIGNIN_FLOW_ID — sign-in: email → code (uses the endpoint)
//   STELLA_KYC_FLOW_ID    — identity: NIN/BVN → camera selfie (no endpoint)
//   STELLA_FLOW_MODE      — 'draft' to test unpublished Flows; default 'published'
// Without them Stella falls back to sign-up by text and the bramp.shop link.
const crypto = require('crypto');
const StellaConversation = require('../models/stellaConversation');
const logger = require('../utils/logger');

const TOKEN_TTL_MINUTES = 60;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const FLOW_ENV = { SIGNUP: 'STELLA_SIGNUP_FLOW_ID', SIGNIN: 'STELLA_SIGNIN_FLOW_ID', KYC: 'STELLA_KYC_FLOW_ID' };
const flowId = (purpose) => process.env[FLOW_ENV[purpose]] || null;

// When Meta refuses to send a Flow (e.g. "Blocked by Integrity" while the app
// is unreviewed), Stella falls back to text and stops trying Flows for an hour.
const PAUSE_AFTER_FAILURE_MS = 60 * 60 * 1000;
let pausedUntil = 0;
function sendFailed(purpose, error) {
  pausedUntil = Date.now() + PAUSE_AFTER_FAILURE_MS;
  logger.warn('Stella: Flow could not be sent; using text for an hour', { purpose, error });
}

const enabled = (purpose) => Boolean(flowId(purpose)) && Date.now() >= pausedUntil;
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

module.exports = { flowId, enabled, mode, sendFailed, issue, find, retire, TOKEN_TTL_MINUTES };
