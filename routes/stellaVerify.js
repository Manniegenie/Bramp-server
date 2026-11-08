// routes/stellaVerify.js — the one-time identity check behind the link Stella
// sends (AI/stellaKyc.js). Called by the bramp.shop/verify page in the
// customer's browser; no login: the link's token is the key. Mounted at
// /stella-verify in server.js.
//
//   GET  /:token   — { firstname, verified } if the link is still usable
//   POST /:token   — { idType: 'nin' | 'bvn', idNumber, selfieImage (data:image/jpeg;base64,…) }
//                    → { status: 'verified' | 'rejected' | 'pending', message }
//
// The check is Bramp's existing Dojah handler, run as the customer's Bramp
// user through AI/stellaIdentity.js (shared with the identity Flow).
const router = require('express').Router();
const User = require('../models/user');
const stellaKyc = require('../AI/stellaKyc');
const { runCheck } = require('../AI/stellaIdentity');
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

  try {
    const outcome = await runCheck(customer.userId, { idType, idNumber: String(idNumber), selfieImage: req.body.selfieImage });
    logger.info('Stella: identity check', { userId: String(customer.userId), idType, via: 'link', outcome: outcome.status });
    if (outcome.status === 'error') return res.status(outcome.httpStatus).json({ success: false, message: outcome.message });
    await stellaKyc.reportResult(customer, outcome.status, outcome.status === 'rejected' ? outcome.message : null)
      .catch((err) => logger.warn('Stella: could not report identity result', { error: err.message }));
    return res.json({ success: true, data: { status: outcome.status, message: outcome.message } });
  } catch (err) {
    logger.error('Stella: identity check failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
