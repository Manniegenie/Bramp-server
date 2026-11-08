// AI/stellaIdentity.js
// Runs Bramp's existing Dojah check (routes/KYC.js biometricVerification) for
// a Stella customer, from the bramp.shop/verify page (routes/stellaVerify.js)
// or the identity Flow (AI/stellaFlows.js). The handler is an Express route:
// we run its validators and handler with a stand-in request and response.
// It answers "pending" and records the real outcome on the KYC and User
// records, so the outcome is read back from those.
const KYC = require('../models/kyc');
const User = require('../models/user');
const { biometricVerification } = require('../routes/KYC');
const stellaKyc = require('./stellaKyc');

/** Calls the handler as this user; resolves to { status, body } as it would have answered. */
async function callHandler(userId, body) {
  const req = { body, user: { id: String(userId) }, headers: {}, get: () => undefined };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); return this; },
    };
    (async () => {
      const [validators, handler] = biometricVerification;
      for (const v of validators) await new Promise((next) => v(req, res, next));
      await handler(req, res);
      reject(new Error('Identity handler finished without answering'));
    })().catch(reject);
  });
}

/** Works out what the Dojah handler decided, from what it recorded. */
async function outcomeOf(userId, handlerStatus, handlerBody) {
  const user = await User.findById(userId).select('kycLevel bvnVerified kyc');
  if (stellaKyc.isVerified(user)) return { status: 'verified', message: "You're verified. You can go back to WhatsApp." };
  if (handlerStatus !== 200 || !handlerBody?.success) {
    // e.g. "BVN already registered to another account", wrong format, blacklisted.
    return { status: 'error', httpStatus: handlerStatus >= 400 ? handlerStatus : 400, message: handlerBody?.message || 'Something went wrong. Please try again.' };
  }
  const kyc = handlerBody.data?.kycId ? await KYC.findById(handlerBody.data.kycId).select('status resultText') : null;
  if (kyc?.status === 'REJECTED') {
    return { status: 'rejected', message: kyc.resultText || user?.kyc?.level2?.rejectionReason || 'Your details or selfie did not match.' };
  }
  return { status: 'pending', message: 'Your check needs a quick review by our team. You will get an email when it is done.' };
}

/**
 * One identity check. input: { idType: 'nin' | 'bvn', idNumber, selfieImage (data URI) }.
 * Resolves to { status: 'verified' | 'rejected' | 'pending' | 'error', message }.
 */
async function runCheck(userId, input) {
  const { status, body } = await callHandler(userId, input);
  return outcomeOf(userId, status, body);
}

module.exports = { runCheck, outcomeOf };
