// services/storefrontOnboarding.js
// Linking a Bramp Shop to a trader's Bramp account
// (models/storefrontLinkRequest.js):
//
//   1. bramp.shop: start(username, slug, brand, agreement) → we push the
//      trader's Bramp app and email them a 6-digit code
//   2. the trader approves in the app (PIN) or types the code into bramp.shop
//   3. bramp.shop: complete(claimSecret) → StorefrontMerchant created. No key
//      is handed out: bramp.shop acts for the store with its platform key
const crypto = require('crypto');
const brevo = require('@getbrevo/brevo');
const User = require('../models/user');
const StorefrontMerchant = require('../models/storefrontMerchant');
const StorefrontLinkRequest = require('../models/storefrontLinkRequest');
const { sendCustomNotification } = require('./notificationService');
const logger = require('../utils/logger');

const MIN_KYC_LEVEL = Number(process.env.STOREFRONT_MIN_KYC_LEVEL || 2);
const TERMS_VERSION = process.env.STOREFRONT_TERMS_VERSION || '2026-11-03';
const LINK_TTL_MINUTES = Number(process.env.STOREFRONT_LINK_TTL_MINUTES || 15);
const MAX_ATTEMPTS = 5;
const MAX_REQUESTS_PER_HOUR = 3; // per Bramp user: stops anyone spamming a trader's phone and inbox
// New storefronts start on low limits; admin raises them (adminRoutes/storefront.js).
const START_PER_TRADE_MAX_NGN = Number(process.env.STOREFRONT_START_PER_TRADE_MAX_NGN || 100000);
const START_DAILY_MAX_NGN = Number(process.env.STOREFRONT_START_DAILY_MAX_NGN || 500000);

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
const RESERVED_SLUGS = new Set(['www', 'api', 'app', 'admin', 'shop', 'bramp', 'support', 'help', 'mail', 'status', 'docs', 'sample']);
const E164 = /^\+[1-9]\d{7,14}$/;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const codeHash = (requestId, code) => sha256(`${requestId}:${code}`);
const fail = (status, message, extra) => Object.assign(new Error(message), { status, ...extra });

const emailApi = new brevo.TransactionalEmailsApi();
emailApi.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(local.length - 1, 2))}@${domain}`;
}

async function sendLinkEmail(user, request, code) {
  const templateId = parseInt(process.env.BREVO_TEMPLATE_STOREFRONT_LINK, 10);
  if (!(templateId > 0)) {
    logger.warn('Storefront link: BREVO_TEMPLATE_STOREFRONT_LINK not set, no email sent', { requestId: request._id });
    return false;
  }
  const email = new brevo.SendSmtpEmail();
  email.to = [{ email: user.email, name: user.firstname || user.username }];
  email.templateId = templateId;
  email.params = {
    name: String(user.firstname || user.username),
    brandName: request.brandName,
    storeUrl: `${request.slug}.bramp.shop`,
    code,
    minutes: String(LINK_TTL_MINUTES),
  };
  try {
    await emailApi.sendTransacEmail(email);
    return true;
  } catch (err) {
    logger.error('Storefront link: email failed', { requestId: request._id, error: err.message });
    return false;
  }
}

async function assertSlugFree(slug, userId) {
  if (!SLUG.test(slug) || RESERVED_SLUGS.has(slug)) throw fail(400, 'Store name must be 3-32 letters, numbers or dashes.');
  if (await StorefrontMerchant.exists({ slug })) throw fail(409, 'That store name is taken.');
  const pending = await StorefrontLinkRequest.exists({
    slug, userId: { $ne: userId }, status: { $in: ['PENDING', 'APPROVED'] }, expiresAt: { $gt: new Date() },
  });
  if (pending) throw fail(409, 'That store name is taken.');
}

// Lazily expire, so a status read never shows a dead request as pending.
async function load(requestId) {
  if (!/^[a-f0-9]{24}$/.test(String(requestId))) throw fail(404, 'Link request not found.');
  const request = await StorefrontLinkRequest.findById(requestId);
  if (!request) throw fail(404, 'Link request not found.');
  if (['PENDING', 'APPROVED'].includes(request.status) && request.expiresAt <= new Date()) {
    request.status = 'EXPIRED';
    await StorefrontLinkRequest.updateOne({ _id: request._id, status: { $in: ['PENDING', 'APPROVED'] } }, { status: 'EXPIRED' });
  }
  return request;
}

/**
 * Called by bramp.shop when the trader finishes setup. Returns the request
 * id and a claimSecret for bramp.shop to keep in the trader's session.
 */
async function start({ username, slug: slugRaw, brandName, whatsapp, agreement, ip, userAgent }) {
  const slug = String(slugRaw || '').toLowerCase().trim();
  const name = String(brandName || '').trim();
  if (!name || name.length > 60) throw fail(400, 'Brand name is required (60 characters at most).');
  if (whatsapp && !E164.test(String(whatsapp))) throw fail(400, 'WhatsApp number must be in international format, like +2348012345678.');
  if (!agreement?.accepted || agreement.version !== TERMS_VERSION) {
    throw fail(400, 'The trader has to accept the current Bramp Shop agreement.', { termsVersion: TERMS_VERSION });
  }

  const handle = String(username || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9_.-]{2,40}$/.test(handle)) throw fail(400, 'Enter your Bramp username.');
  // Case-insensitive, like username transfers (routes/usernamewithdraw.js).
  const escaped = handle.replace(/[.-]/g, '\\$&');
  const user = await User.findOne({ username: { $regex: new RegExp(`^${escaped}$`, 'i') } })
    .select('email username firstname kycLevel');
  if (!user) throw fail(404, 'No Bramp account with that username.');
  if (user.kycLevel < MIN_KYC_LEVEL) {
    throw fail(403, `This Bramp account needs KYC level ${MIN_KYC_LEVEL} before it can run a store. Finish verification in the Bramp app.`);
  }
  if (await StorefrontMerchant.exists({ userId: user._id })) throw fail(409, 'This Bramp account already has a store.');
  await assertSlugFree(slug, user._id);

  const recent = await StorefrontLinkRequest.countDocuments({ userId: user._id, createdAt: { $gt: new Date(Date.now() - 60 * 60 * 1000) } });
  if (recent >= MAX_REQUESTS_PER_HOUR) throw fail(429, 'Too many link attempts for this account. Try again in an hour.');

  // A new request replaces any still open for this user.
  await StorefrontLinkRequest.updateMany({ userId: user._id, status: { $in: ['PENDING', 'APPROVED'] } }, { status: 'EXPIRED' });

  const claimSecret = crypto.randomBytes(24).toString('base64url');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const _id = new StorefrontLinkRequest()._id;
  const request = await StorefrontLinkRequest.create({
    _id,
    userId: user._id,
    username: handle,
    slug,
    brandName: name,
    whatsapp: whatsapp || null,
    agreement: { version: TERMS_VERSION, acceptedAt: new Date(), ip: ip || null, userAgent: userAgent ? String(userAgent).slice(0, 300) : null },
    expiresAt: new Date(Date.now() + LINK_TTL_MINUTES * 60 * 1000),
    claimHash: sha256(claimSecret),
    emailCodeHash: codeHash(_id, code),
  });

  const [push, emailSent] = await Promise.all([
    sendCustomNotification(user._id, 'Link your Bramp Shop',
      `Approve ${name} (${slug}.bramp.shop) to trade through your Bramp account.`,
      { type: 'STOREFRONT_LINK', requestId: String(request._id) }),
    sendLinkEmail(user, request, code),
  ]);
  if (emailSent) await StorefrontLinkRequest.updateOne({ _id: request._id }, { emailSent: true });
  logger.info('Storefront link requested', { requestId: request._id, userId: user._id, slug, pushed: !!push?.success, emailSent });

  return {
    requestId: String(request._id),
    claimSecret,
    expiresAt: request.expiresAt,
    pushed: !!push?.success,
    emailSent,
    maskedEmail: emailSent ? maskEmail(user.email) : null,
  };
}

function statusOf(request) {
  return {
    requestId: String(request._id),
    status: request.status,
    slug: request.slug,
    brandName: request.brandName,
    approvedVia: request.approvedVia,
    expiresAt: request.expiresAt,
  };
}

async function status(requestId) {
  return statusOf(await load(requestId));
}

async function countFailure(request) {
  const updated = await StorefrontLinkRequest.findOneAndUpdate(
    { _id: request._id, status: 'PENDING' }, { $inc: { failedAttempts: 1 } }, { new: true }
  );
  if (updated && updated.failedAttempts >= MAX_ATTEMPTS) {
    await StorefrontLinkRequest.updateOne({ _id: request._id, status: 'PENDING' }, { status: 'DECLINED', decidedAt: new Date() });
    logger.warn('Storefront link: too many wrong codes or PINs, declined', { requestId: request._id });
    return 0;
  }
  return MAX_ATTEMPTS - (updated?.failedAttempts ?? MAX_ATTEMPTS);
}

async function markApproved(request, via) {
  const approved = await StorefrontLinkRequest.findOneAndUpdate(
    { _id: request._id, status: 'PENDING', expiresAt: { $gt: new Date() } },
    { status: 'APPROVED', approvedVia: via, decidedAt: new Date() },
    { new: true }
  );
  if (!approved) throw fail(409, 'This link request is no longer pending.');
  logger.info('Storefront link approved', { requestId: request._id, via });
  return approved;
}

function assertPending(request) {
  if (request.status !== 'PENDING') throw fail(409, `This link request is ${request.status.toLowerCase()}.`);
}

/** The trader typed the emailed code into bramp.shop. */
async function approveByEmailCode(requestId, code) {
  const request = await load(requestId);
  assertPending(request);
  if (!/^\d{6}$/.test(String(code || '')) || codeHash(request._id, code) !== request.emailCodeHash) {
    const attemptsLeft = await countFailure(request);
    throw fail(400, attemptsLeft ? 'That code is wrong.' : 'Too many wrong codes. Start the link again.', { attemptsLeft });
  }
  return statusOf(await markApproved(request, 'EMAIL'));
}

/** Requests waiting for this user in the Bramp app. */
async function pendingForUser(userId) {
  const rows = await StorefrontLinkRequest.find({ userId, status: 'PENDING', expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
  return rows.map(statusOf);
}

async function loadOwn(userId, requestId) {
  const request = await load(requestId);
  if (String(request.userId) !== String(userId)) throw fail(404, 'Link request not found.');
  assertPending(request);
  return request;
}

/** The trader approved in the Bramp app with their PIN. */
async function approveInApp(userId, requestId, passwordpin) {
  const request = await loadOwn(userId, requestId);
  const user = await User.findById(userId).select('passwordpin');
  if (!passwordpin || !(await user?.comparePasswordPin(String(passwordpin).trim()))) {
    const attemptsLeft = await countFailure(request);
    throw fail(401, attemptsLeft ? 'Wrong PIN.' : 'Too many wrong PINs. Start the link again from Bramp Shop.', { attemptsLeft });
  }
  return statusOf(await markApproved(request, 'APP'));
}

async function declineInApp(userId, requestId) {
  const request = await loadOwn(userId, requestId);
  await StorefrontLinkRequest.updateOne({ _id: request._id, status: 'PENDING' }, { status: 'DECLINED', decidedAt: new Date() });
  logger.info('Storefront link declined in app', { requestId: request._id });
  return statusOf({ ...request.toObject(), status: 'DECLINED' });
}

/**
 * bramp.shop finishes the link once the trader approved: creates the
 * StorefrontMerchant. No key is issued; bramp.shop acts for the store with
 * its platform key and the slug (auth/storefrontAuth.js).
 */
async function complete(requestId, claimSecret) {
  const request = await load(requestId);
  if (!claimSecret || sha256(claimSecret) !== request.claimHash) throw fail(404, 'Link request not found.');
  if (request.status !== 'APPROVED') throw fail(409, `This link request is ${request.status.toLowerCase()}.`);

  // Claim first, so two calls can't both create a storefront.
  const claimed = await StorefrontLinkRequest.findOneAndUpdate(
    { _id: request._id, status: 'APPROVED' }, { status: 'COMPLETED', completedAt: new Date() }, { new: true }
  );
  if (!claimed) throw fail(409, 'This link request was already completed.');

  try {
    const user = await User.findById(claimed.userId).select('kycLevel');
    if (!user || user.kycLevel < MIN_KYC_LEVEL) throw fail(403, `This Bramp account needs KYC level ${MIN_KYC_LEVEL}.`);
    let merchant;
    try {
      merchant = await StorefrontMerchant.create({
        userId: claimed.userId,
        slug: claimed.slug,
        brandName: claimed.brandName,
        whatsapp: claimed.whatsapp,
        agreement: { version: claimed.agreement.version, acceptedAt: claimed.agreement.acceptedAt, ip: claimed.agreement.ip },
        linkRequestId: claimed._id,
        perTradeMaxNgn: START_PER_TRADE_MAX_NGN,
        dailyMaxNgn: START_DAILY_MAX_NGN,
      });
    } catch (err) {
      if (err.code === 11000) throw fail(409, 'That store name or Bramp account already has a store.');
      throw err;
    }
    await StorefrontLinkRequest.updateOne({ _id: claimed._id }, { merchantId: merchant._id });
    logger.info('Storefront linked', { requestId: claimed._id, slug: merchant.slug, userId: claimed.userId, via: claimed.approvedVia });
    return {
      slug: merchant.slug,
      brandName: merchant.brandName,
      status: merchant.status,
      limits: { perTradeMaxNgn: merchant.perTradeMaxNgn, dailyMaxNgn: merchant.dailyMaxNgn, holdDays: merchant.holdDays },
    };
  } catch (err) {
    // Nothing was created: let bramp.shop retry, or show the reason.
    await StorefrontLinkRequest.updateOne({ _id: claimed._id, merchantId: null }, { status: 'APPROVED', completedAt: null });
    throw err;
  }
}

module.exports = {
  TERMS_VERSION, start, status, approveByEmailCode, pendingForUser, approveInApp, declineInApp, complete,
};
