// AI/stellaFlows.js
// Stella's WhatsApp Flows (forms inside the chat). The Flow JSON to paste
// into WhatsApp Manager is in AI/flows/; AI/stellaFlowTokens.js has the IDs
// and the tokens that tie a Flow to the customer.
//
// Sign-up (AI/flows/stella-signup.json) uses the endpoint: each screen comes
// to AI/whatsapp.js encrypted, and handleExchange() answers with the next
// screen. NAME → EMAIL → CODE, running the same steps as the text sign-up
// (AI/stellaCustomers.js), then the Flow closes and Stella carries on in chat.
//
// Identity (AI/flows/stella-kyc.json) needs no endpoint: ID → SELFIE, then the
// Flow completes and WhatsApp sends us the answers as a message (nfm_reply)
// with the selfie as media. handleCompletion() downloads it and runs the same
// Dojah check as the bramp.shop page (AI/stellaIdentity.js). One check per Flow.
const StellaConversation = require('../models/stellaConversation');
const StellaCustomer = require('../models/stellaCustomer');
const User = require('../models/user');
const customers = require('./stellaCustomers');
const stellaKyc = require('./stellaKyc');
const { runCheck } = require('./stellaIdentity');
const flowTokens = require('./stellaFlowTokens');
const sender = require('./stellaSender');
const logger = require('../utils/logger');

const MAX_SELFIE_BYTES = 10 * 1024 * 1024;

const screen = (id, data = {}) => ({ screen: id, data });
const closeFlow = (flowToken, params = {}) => ({
  screen: 'SUCCESS',
  data: { extension_message_response: { params: { flow_token: flowToken, ...params } } },
});
const later = (fn) => setImmediate(() => Promise.resolve().then(fn).catch((err) => logger.error('Stella: after-Flow step failed', { error: err.message, stack: err.stack })));

// ── Sign-up (endpoint) ─────────────────────────────────────────────────────

const SIGNUP_ERRORS = {
  NAME: 'Enter your first and last name as on your BVN or NIN. Letters only.',
  EMAIL: "That doesn't look like an email address.",
  BANNED: "Sorry, we can't open an account for you.",
  LIMIT: "We've sent the most codes allowed for now. Try again in an hour.",
  EMAIL_FAILED: "We couldn't send the email. Try again in a few minutes.",
  FORMAT: 'The code is 6 digits.',
  TOO_MANY: 'Too many wrong codes. Tap "Send a new code".',
  EXPIRED: 'That code has expired. Tap "Send a new code".',
  TAKEN: 'That email was just registered. Go back and use another email.',
};

async function signupScreen(convo, payload) {
  const to = convo.waId;
  const data = payload.data || {};
  const firstName = () => convo.signup.firstname || 'there';
  const masked = () => customers.maskEmail(convo.signup.email || '');

  switch (payload.screen) {
    case 'NAME': {
      if (convo.state === 'LINK_CONFIRM') {
        return screen('NAME', { error_message: 'This number is already on Bramp. Close this and reply in the chat.' });
      }
      const full = [data.first_name, data.middle_name, data.last_name].map((s) => String(s || '').trim()).filter(Boolean).join(' ');
      if (!String(data.first_name || '').trim() || !String(data.last_name || '').trim()) return screen('NAME', { error_message: SIGNUP_ERRORS.NAME });
      const r = await customers.setName(convo, full);
      if (!r.ok) return screen('NAME', { error_message: SIGNUP_ERRORS.NAME });
      return screen('EMAIL', { first_name: r.firstname });
    }
    case 'EMAIL': {
      if (!convo.signup.firstname) return screen('NAME', { error_message: 'Please start with your name.' });
      const r = await customers.setEmail(to, convo, data.email);
      if (!r.ok) return screen('EMAIL', { first_name: firstName(), error_message: SIGNUP_ERRORS[r.error] });
      const sent = await customers.issueCode(to, convo);
      if (!sent.ok) return screen('EMAIL', { first_name: firstName(), error_message: SIGNUP_ERRORS[sent.error] });
      return screen('CODE', { email_masked: masked() });
    }
    case 'CODE': {
      if (convo.state !== 'SIGNUP_CODE') return screen('EMAIL', { first_name: firstName(), error_message: 'Please enter your email again.' });
      if (data.action === 'resend') {
        const sent = await customers.issueCode(to, convo);
        return screen('CODE', { email_masked: masked(), error_message: sent.ok ? 'We sent you a new code.' : SIGNUP_ERRORS[sent.error] });
      }
      const r = await customers.checkCode(to, convo, data.code);
      if (!r.ok) {
        const msg = r.error === 'WRONG' ? (r.left > 0 ? `That code isn't right. ${r.left} ${r.left === 1 ? 'try' : 'tries'} left.` : SIGNUP_ERRORS.TOO_MANY) : SIGNUP_ERRORS[r.error];
        return screen('CODE', { email_masked: masked(), error_message: msg });
      }
      const done = await customers.complete(to, convo);
      if (!done.ok && done.error === 'TAKEN') return screen('CODE', { email_masked: masked(), error_message: SIGNUP_ERRORS.TAKEN });
      await flowTokens.retire(convo._id);
      // Answer Meta first (it waits on us); then carry on in the chat.
      later(() => (done.ok ? customers.welcome(to, done.customer, done.source) : sender.sendText(to, customers.LINKED_ELSEWHERE)));
      return closeFlow(payload.flow_token, { signup: done.ok ? 'done' : 'linked_elsewhere' });
    }
    default:
      return screen('NAME', { error_message: 'Something went wrong. Please start again.' });
  }
}

/**
 * One decrypted request from a Flow's endpoint (AI/whatsapp.js encrypts the
 * answer). Returns the response: the next screen, an error on the same
 * screen, or SUCCESS to close the Flow.
 */
async function handleExchange(payload) {
  const action = String(payload.action || '').toLowerCase();
  const token = payload.flow_token;
  const expired = { error_message: 'This form has expired. Send Stella a message for a new one.' };

  if (!String(token || '').startsWith('signup_')) return screen(payload.screen || 'NAME', expired);
  const convo = await flowTokens.find(token, 'SIGNUP');
  if (!convo) return screen(payload.screen || 'NAME', expired);
  if (await StellaCustomer.exists({ waId: convo.waId })) return closeFlow(token, { signup: 'already' });

  if (action === 'init') return screen('NAME', {});
  if (action === 'back') return screen(payload.screen || 'NAME', {});
  if (action !== 'data_exchange') return screen(payload.screen || 'NAME', { error_message: 'Something went wrong. Please try again.' });

  const r = await signupScreen(convo, payload);
  logger.info('Stella: sign-up Flow', { waId: sender.mask(convo.waId), screen: payload.screen, next: r.screen, error: Boolean(r.data?.error_message) });
  return r;
}

// ── Identity (completion message) ──────────────────────────────────────────

/**
 * A completed Flow arrived as a message (interactive nfm_reply). Returns true
 * when it was handled here, so AI/whatsapp.js stops.
 */
async function handleCompletion(waId, msg) {
  let answers;
  try { answers = JSON.parse(msg.interactive?.nfm_reply?.response_json || '{}'); } catch { answers = {}; }
  const token = String(answers.flow_token || '');
  await StellaConversation.updateOne({ waId }, { $set: { lastInboundAt: new Date() } });

  if (token.startsWith('signup_')) return true; // handled on its last screen
  if (!token.startsWith('kyc_')) {
    logger.warn('Stella: completed Flow with an unknown token', { waId: sender.mask(waId) });
    return true;
  }

  const convo = await flowTokens.find(token, 'KYC');
  if (!convo || convo.waId !== waId) {
    await sender.sendText(waId, 'That form has expired. Send me any message and I\'ll send a new one.');
    return true;
  }
  await flowTokens.retire(convo._id); // one check per Flow

  // Used up, so the customer's next message brings a fresh Flow, not "use the last one".
  const customer = await StellaCustomer.findOneAndUpdate({ waId }, { $set: { 'verifyLink.expiresAt': null } }, { new: true });
  if (!customer) return true;
  const user = await User.findById(customer.userId).select('kycLevel bvnVerified');
  if (stellaKyc.isVerified(user)) {
    await sender.sendText(waId, "You're already verified ✅");
    return true;
  }

  const idType = String(answers.id_type || '').toLowerCase();
  const idNumber = String(answers.id_number || '').replace(/\s/g, '');
  const photo = Array.isArray(answers.selfie) ? answers.selfie[0] : null;
  if (!['nin', 'bvn'].includes(idType) || !/^\d{11}$/.test(idNumber) || !photo?.id) {
    await sender.sendText(waId, "Something was missing from the form. Send me any message and I'll send it again.");
    return true;
  }

  await sender.sendText(waId, 'Thanks. Checking your identity now, it takes about a minute.');
  const media = await sender.downloadMedia(photo.id, { maxBytes: MAX_SELFIE_BYTES });
  const mimeType = media.mimeType || photo.mime_type || '';
  if (!media.ok || !/^image\/(jpeg|jpg|png|webp|heic|heif)$/i.test(mimeType)) {
    logger.warn('Stella: identity Flow selfie unusable', { waId: sender.mask(waId), error: media.error, mimeType });
    await sender.sendText(waId, media.error === 'TOO_LARGE'
      ? "That photo is too large. Send me any message and I'll send the form again."
      : "I couldn't open your selfie. Send me any message and I'll send the form again.");
    return true;
  }

  const outcome = await runCheck(customer.userId, {
    idType, idNumber, selfieImage: `data:${mimeType.toLowerCase()};base64,${media.buffer.toString('base64')}`,
  });
  logger.info('Stella: identity check', { userId: String(customer.userId), idType, via: 'flow', outcome: outcome.status });
  if (outcome.status === 'error') {
    await sender.sendText(waId, `I couldn't check that: ${String(outcome.message).replace(/\.?\s*$/, '.')} Send me any message to try again.`);
    return true;
  }
  await stellaKyc.reportResult(customer, outcome.status, outcome.status === 'rejected' ? outcome.message : null);
  return true;
}

const isFlowCompletion = (msg) => msg?.type === 'interactive' && msg.interactive?.type === 'nfm_reply';

module.exports = { handleExchange, handleCompletion, isFlowCompletion };
