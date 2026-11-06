// routes/stellaVerify.js — the one-time identity check behind the link Stella
// sends (AI/stellaKyc.js). Called by the bramp.shop/verify page in the
// customer's browser; no login: the link's token is the key. Mounted at
// /stella-verify in server.js.
//
//   GET  /:token   — { firstname, verified } if the link is still usable
//   POST /:token   — { idType: 'nin' | 'bvn', idNumber, selfieImage (data:image/jpeg;base64,…) }
//                    → { status: 'verified' | 'rejected' | 'pending', message }
//
// The check is Bramp's existing Dojah handler (routes/KYC.js
// biometricVerification), run as the customer's Bramp user. That handler
// always answers "pending" and records the real outcome on the KYC and User
// records, so we read those back to answer the page and the customer.
const router = require('express').Router();
const KYC = require('../models/kyc');
const User = require('../models/user');
const { biometricVerification } = require('./KYC');
const stellaKyc = require('../AI/stellaKyc');
const logger = require('../utils/logger');

const GONE = { success: false, message: 'This link has expired or was already used. Message Stella on WhatsApp for a new one.' };

async function loadLink(req, res, next) {
  try {
    const customer = await stellaKyc.customerForToken(req.params.token);
    if (!customer) return res.status(410).json(GONE);
    req.stellaCustomer = customer;
    next();
  } catch (err) {
    next(err);
  }
}

router.get('/:token', loadLink, async (req, res, next) => {
  try {
    const user = await User.findById(req.stellaCustomer.userId).select('firstname kycLevel bvnVerified');
    res.json({ success: true, data: { firstname: user?.firstname || null, verified: stellaKyc.isVerified(user) } });
  } catch (err) {
    next(err);
  }
});

/** Works out what the Dojah handler decided, from what it recorded. */
async function outcomeOf(userId, handlerStatus, handlerBody) {
  const user = await User.findById(userId).select('kycLevel bvnVerified kyc');
  if (stellaKyc.isVerified(user)) return { status: 'verified', message: "You're verified. You can go back to WhatsApp." };
  if (handlerStatus !== 200 || !handlerBody?.success) {
    // e.g. "BVN already registered to another account", wrong format, blacklisted.
    return { status: 'error', message: handlerBody?.message || 'Something went wrong. Please try again.' };
  }
  const kyc = handlerBody.data?.kycId ? await KYC.findById(handlerBody.data.kycId).select('status resultText') : null;
  if (kyc?.status === 'REJECTED') {
    return { status: 'rejected', message: kyc.resultText || user?.kyc?.level2?.rejectionReason || 'Your details or selfie did not match.' };
  }
  return { status: 'pending', message: 'Your check needs a quick review by our team. You will get an email when it is done.' };
}

// Body parsed by server.js's express.json (1mb): the page sends a downscaled JPEG.
router.post('/:token', loadLink, async (req, res, next) => {
  const customer = req.stellaCustomer;
  const { idType, idNumber } = req.body || {};
  if (!['nin', 'bvn'].includes(idType)) return res.status(400).json({ success: false, message: 'Choose NIN or BVN.' });
  if (!/^\d{11}$/.test(String(idNumber || ''))) return res.status(400).json({ success: false, message: `Your ${idType.toUpperCase()} is 11 digits.` });

  try {
    const user = await User.findById(customer.userId).select('kycLevel bvnVerified');
    if (stellaKyc.isVerified(user)) return res.json({ success: true, data: { status: 'verified', message: "You're already verified." } });
    if (!(await stellaKyc.useAttempt(customer))) {
      return res.status(429).json({ success: false, message: 'This link has no tries left. Message Stella on WhatsApp for a new one.' });
    }
  } catch (err) {
    return next(err);
  }
  customer.verifyLink.attempts += 1;

  // Run the existing handler as this customer, catching its reply so we can
  // answer with the real outcome instead.
  req.user = { id: String(customer.userId) };
  const json = res.json.bind(res);
  res.json = (body) => {
    const handlerStatus = res.statusCode;
    outcomeOf(customer.userId, handlerStatus, body)
      .then(async (outcome) => {
        logger.info('Stella: identity check', { userId: String(customer.userId), idType, outcome: outcome.status });
        if (outcome.status !== 'error') {
          await stellaKyc.reportResult(customer, outcome.status, outcome.status === 'rejected' ? outcome.message : null)
            .catch((err) => logger.warn('Stella: could not report identity result', { error: err.message }));
        }
        res.status(outcome.status === 'error' ? (handlerStatus >= 400 ? handlerStatus : 400) : 200);
        json({ success: outcome.status !== 'error', ...(outcome.status === 'error' ? { message: outcome.message } : { data: outcome }) });
      })
      .catch((err) => {
        logger.error('Stella: identity check follow-up failed', { error: err.message, stack: err.stack });
        res.status(500);
        json({ success: false, message: 'Something went wrong. Please try again.' });
      });
    return res;
  };
  next();
}, ...biometricVerification);

module.exports = router;
