// AI/stellaKyc.js
// One-time identity check for Stella customers. KYC lives on the customer's
// Bramp account, so it's done once and counts for every desk, on Stella and
// on bramp.shop. The check itself is Bramp's existing Dojah handler
// (routes/KYC.js biometricVerification): NIN or BVN plus a selfie, approved
// when the record is found, the names overlap and the selfie matches the
// photo on the government record. Dojah's liveness score is logged but not
// gating (it scores real front-camera selfies at 0%). The selfie is taken
// with the camera on a bramp.shop page rather than sent as a chat photo.
//
// Stella sends the identity Flow (NIN/BVN and a camera selfie inside the
// chat, AI/stellaFlows.js) when STELLA_KYC_FLOW_ID is set, otherwise a
// one-time link (bramp.shop/verify?t=…) as a WhatsApp button, which
// routes/stellaVerify.js handles. Either way reportResult() tells the
// customer here, and the same daily limit applies.
const crypto = require('crypto');
const User = require('../models/user');
const StellaCustomer = require('../models/stellaCustomer');
const sender = require('./stellaSender');
const flowTokens = require('./stellaFlowTokens');
const logger = require('../utils/logger');

const LINK_TTL_MINUTES = 30;
const MAX_ATTEMPTS_PER_LINK = 3;
const MAX_LINKS_PER_DAY = 5;
const RESEND_AFTER_MS = 2 * 60 * 1000;

const verifyBaseUrl = () => process.env.STELLA_VERIFY_URL || 'https://bramp.shop/verify';
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/**
 * Verified for Stella: a NIN or document check passed (KYC level 2+), or a BVN
 * check passed. In Bramp today a passed BVN check sets bvnVerified but leaves
 * kycLevel at 1, so both count here.
 */
function isVerified(user) {
  return Boolean(user && ((user.kycLevel || 0) >= 2 || user.bvnVerified === true));
}

/** Finds the customer a link token belongs to, if it's still usable. */
async function customerForToken(token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(String(token || ''))) return null;
  return StellaCustomer.findOne({ 'verifyLink.tokenHash': sha256(token), 'verifyLink.expiresAt': { $gt: new Date() } });
}

/**
 * Sends the customer a fresh verification link, unless they're already
 * verified or got one moments ago. Returns 'verified' | 'sent' | 'recent' | 'limit'.
 */
async function promptIfNeeded(waId, customer) {
  const user = await User.findById(customer.userId).select('kycLevel bvnVerified firstname');
  if (isVerified(user)) return 'verified';

  const sent = (customer.verifyLink?.sentAt || []).filter((d) => d.getTime() > Date.now() - 24 * 60 * 60 * 1000);
  const last = sent[sent.length - 1];
  const useFlow = flowTokens.enabled('KYC');
  if (last && Date.now() - last.getTime() < RESEND_AFTER_MS && customer.verifyLink?.expiresAt > new Date()) {
    await sender.sendText(waId, useFlow
      ? 'Tap "Verify identity" in my last message. It opens your camera for the selfie.'
      : 'Use the verification link I just sent. It opens your camera for the selfie.');
    return 'recent';
  }
  if (sent.length >= MAX_LINKS_PER_DAY) {
    await sender.sendText(waId, "You've tried to verify the most times allowed today. Please try again tomorrow.");
    return 'limit';
  }

  if (useFlow) {
    // No link token: the Flow's own token (one check per Flow) is the key.
    customer.verifyLink = { tokenHash: null, expiresAt: new Date(Date.now() + flowTokens.TOKEN_TTL_MINUTES * 60 * 1000), attempts: 0, sentAt: [...sent, new Date()] };
    await customer.save();
    const r = await sender.sendFlow(waId, {
      body: "One last step: verify your identity once. You'll need your NIN or BVN and your phone's camera for a quick selfie. It counts for every desk on Stella.",
      cta: 'Verify identity',
      flowId: flowTokens.flowId('KYC'),
      token: await flowTokens.issue(waId, 'KYC'),
      screen: 'ID',
      mode: flowTokens.mode(),
    });
    if (r.ok) {
      logger.info('Stella: identity Flow sent', { waId: sender.mask(waId) });
      return 'sent';
    }
    flowTokens.sendFailed('KYC', r.error); // the bramp.shop link below instead
  }

  const token = crypto.randomBytes(32).toString('base64url'); // 43 chars
  customer.verifyLink = {
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + LINK_TTL_MINUTES * 60 * 1000),
    attempts: 0,
    sentAt: [...sent, new Date()],
  };
  await customer.save();

  const url = `${verifyBaseUrl()}?t=${token}`;
  await sender.sendLink(waId,
    `One last step: verify your identity once. You'll need your NIN or BVN and your phone's camera for a quick selfie. It counts for every desk on Stella.\n\nThe link works for ${LINK_TTL_MINUTES} minutes.`,
    'Verify identity', url);
  logger.info('Stella: verification link sent', { waId: sender.mask(waId) });
  return 'sent';
}

/** Counts an attempt on the link; false if it's used up. */
async function useAttempt(customer) {
  const updated = await StellaCustomer.findOneAndUpdate(
    { _id: customer._id, 'verifyLink.tokenHash': customer.verifyLink.tokenHash, 'verifyLink.attempts': { $lt: MAX_ATTEMPTS_PER_LINK } },
    { $inc: { 'verifyLink.attempts': 1 } },
    { new: true }
  );
  return Boolean(updated);
}

/** After a check: retire the link if verified, and tell the customer on WhatsApp. */
async function reportResult(customer, outcome, reason) {
  if (outcome === 'verified') {
    await StellaCustomer.updateOne({ _id: customer._id }, { $set: { 'verifyLink.tokenHash': null, 'verifyLink.expiresAt': null } });
    await sender.sendText(customer.waId, "You're verified ✅ You can now trade with any desk on Stella.");
  } else if (outcome === 'rejected' && !customer.verifyLink?.tokenHash) {
    // From the Flow: one check per Flow, any message brings a new one.
    await sender.sendText(customer.waId, `I couldn't verify you: ${reason || 'the details or selfie did not match'}. Send me any message to try again.`);
  } else if (outcome === 'rejected') {
    const left = MAX_ATTEMPTS_PER_LINK - (customer.verifyLink?.attempts || 0);
    await sender.sendText(customer.waId, left > 0
      ? `I couldn't verify you: ${reason || 'the details or selfie did not match'}. You can try again with the same link (${left} ${left === 1 ? 'try' : 'tries'} left).`
      : `I couldn't verify you: ${reason || 'the details or selfie did not match'}. Send me a message for a new link.`);
  } else if (outcome === 'pending') {
    // Provider unavailable: an admin reviews it (routes/KYC.js marks it PROVISIONAL).
    await sender.sendText(customer.waId, "Thanks, your check needs a quick review by our team. You'll get an email when it's done.");
  }
}

module.exports = { isVerified, customerForToken, promptIfNeeded, useAttempt, reportResult, MAX_ATTEMPTS_PER_LINK };
