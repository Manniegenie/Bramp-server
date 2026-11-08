// AI/stellaCustomers.js
// Who Stella is talking to. Every customer is a Bramp user: their KYC and
// wallet live on the Bramp account, so one verification covers every desk on
// Stella and bramp.shop. The first time a WhatsApp number messages Stella:
//
//   number already on a Bramp account → "Is that you?" → code to that
//     account's email → linked (LINKED)
//   new number → full name (as on BVN/NIN) → email → 6-digit code → a Bramp
//     account is created (CREATED). An email that's already on a Bramp
//     account links that account instead, once its code is entered.
//
// The code always goes to the account's email, so a recycled phone number
// can't take over someone's account. No PIN here: a PIN is never typed into
// the chat, it's set through a WhatsApp Flow before the first trade (M9).
//
// handleIncoming() returns the StellaCustomer once the number is linked;
// until then it runs the sign-up and returns null.
//
// A new number gets the sign-up as a WhatsApp Flow when one is set up
// (AI/stellaFlows.js), and can still answer by text. Both run the same steps
// below (setName, setEmail, issueCode, checkCode, complete), which only change
// the conversation and say what happened; the text path adds the replies.
const crypto = require('crypto');
const validator = require('validator');
const User = require('../models/user');
const KYCBlacklist = require('../models/KYCBlacklist');
const StellaCustomer = require('../models/stellaCustomer');
const StellaConversation = require('../models/stellaConversation');
const { generateUniqueUsername } = require('../routes/passwordpin');
const { sendOtpEmail } = require('../services/EmailService');
const sender = require('./stellaSender');
const stellaKyc = require('./stellaKyc');
const flowTokens = require('./stellaFlowTokens');
const logger = require('../utils/logger');

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 3;

const BTN = {
  LINK_YES: 'link_yes',
  LINK_NO: 'link_no',
  RESEND: 'code_resend',
  CHANGE_EMAIL: 'email_change',
};

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const codeHash = (waId, code) => sha256(`${waId}:${code}`);

function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(local.length - 1, 2))}@${domain}`;
}

// Bramp stores numbers as +234…; older records may differ.
function phoneVariants(waId) {
  const v = [`+${waId}`, waId];
  if (waId.startsWith('234')) v.push(`0${waId.slice(3)}`);
  return v;
}

/** "Ada Chioma Okafor" → { firstname: Ada, middlename: Chioma, lastname: Okafor } */
function parseFullName(text) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return null;
  if (!words.every((w) => /^[\p{L}][\p{L}'-]{0,39}$/u.test(w))) return null;
  const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
  return {
    firstname: cap(words[0]),
    middlename: words.slice(1, -1).map(cap).join(' '),
    lastname: cap(words[words.length - 1]),
  };
}

// ── Prompts ────────────────────────────────────────────────────────────────

async function askName(to) {
  if (flowTokens.enabled('SIGNUP')) {
    return sender.sendFlow(to, {
      body: 'Tap below to set up your account, or just reply with your full name as it appears on your BVN or NIN.',
      cta: 'Set up my account',
      flowId: flowTokens.flowId('SIGNUP'),
      token: await flowTokens.issue(to, 'SIGNUP'),
      screen: 'NAME',
      mode: flowTokens.mode(),
    });
  }
  return sender.sendText(to, "What's your full name, as it appears on your BVN or NIN?");
}
const askEmail = (to, firstname) => sender.sendText(to,
  `Thanks, ${firstname}. What's your email address? I'll send a 6-digit code to confirm it, and your receipts go there too.`);

function askCode(to, convo) {
  const buttons = [{ id: BTN.RESEND, title: 'Resend code' }];
  // Only on the sign-up path (they typed the email); linking uses the account's own.
  if (convo.signup.firstname) buttons.push({ id: BTN.CHANGE_EMAIL, title: 'Change email' });
  return sender.sendButtons(to, `I've sent a 6-digit code to ${maskEmail(convo.signup.email)}. Reply with the code.`, buttons);
}

/** Re-asks whatever the current step needs, for messages that don't answer it. */
async function repeatStep(to, convo) {
  switch (convo.state) {
    case 'SIGNUP_NAME': return askName(to);
    case 'SIGNUP_EMAIL': return askEmail(to, convo.signup.firstname);
    case 'SIGNUP_CODE': return askCode(to, convo);
    case 'LINK_CONFIRM': return askLinkConfirm(to, convo);
    default: return null;
  }
}

async function askLinkConfirm(to, convo) {
  const user = await User.findById(convo.signup.linkUserId).select('email');
  return sender.sendButtons(to,
    `This WhatsApp number is already on a Bramp account (${maskEmail(user?.email || '')}). Is that you?`,
    [{ id: BTN.LINK_YES, title: "Yes, that's me" }, { id: BTN.LINK_NO, title: 'No' }]);
}

// ── Steps shared by text and the Flow ──────────────────────────────────────
// Each changes the conversation and returns { ok } or { ok: false, error }.

/** Full name as one string ("Ada Chioma Okafor"). */
async function setName(convo, fullName) {
  const name = parseFullName(fullName);
  if (!name) return { ok: false, error: 'NAME' };
  Object.assign(convo.signup, name);
  convo.state = 'SIGNUP_EMAIL';
  await convo.save();
  return { ok: true, firstname: name.firstname };
}

/** Checks the email; an email already on Bramp links that account once its code is entered. */
async function setEmail(to, convo, raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!validator.isEmail(email)) return { ok: false, error: 'EMAIL' };
  const [emailBanned, phoneBanned] = await Promise.all([
    KYCBlacklist.isBanned('email', email),
    KYCBlacklist.isBanned('phone', `+${to}`),
  ]);
  if (emailBanned || phoneBanned) {
    logger.warn('Stella: blacklisted sign-up attempt', { waId: sender.mask(to) });
    return { ok: false, error: 'BANNED' };
  }
  const existing = await User.findOne({ email }).select('_id');
  convo.signup.email = email;
  convo.signup.linkUserId = existing ? existing._id : null; // the code proves it's theirs
  return { ok: true };
}

/** Emails a new 6-digit code. error: LIMIT (too many this hour) | EMAIL_FAILED. */
async function issueCode(to, convo) {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const recent = (convo.signup.codesSentAt || []).filter((d) => d.getTime() > hourAgo);
  if (recent.length >= MAX_CODES_PER_HOUR) return { ok: false, error: 'LIMIT' };
  const code = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  try {
    await sendOtpEmail(convo.signup.email, convo.signup.firstname || 'there', code, CODE_TTL_MINUTES);
  } catch (err) {
    logger.error('Stella: code email failed', { waId: sender.mask(to), error: err.message });
    return { ok: false, error: 'EMAIL_FAILED' };
  }
  convo.signup.codeHash = codeHash(to, code);
  convo.signup.codeExpiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);
  convo.signup.attempts = 0;
  convo.signup.codesSentAt = [...recent, new Date()];
  convo.state = 'SIGNUP_CODE';
  await convo.save();
  return { ok: true };
}

function codeMatches(to, convo, code) {
  if (!convo.signup.codeHash) return false;
  const a = Buffer.from(convo.signup.codeHash, 'hex');
  const b = Buffer.from(codeHash(to, code), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** error: FORMAT | TOO_MANY | EXPIRED | WRONG (with `left`). */
async function checkCode(to, convo, raw) {
  const code = String(raw || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return { ok: false, error: 'FORMAT' };
  if (convo.signup.attempts >= MAX_ATTEMPTS) return { ok: false, error: 'TOO_MANY' };
  if (!convo.signup.codeExpiresAt || convo.signup.codeExpiresAt < new Date()) return { ok: false, error: 'EXPIRED' };
  if (!codeMatches(to, convo, code)) {
    convo.signup.attempts += 1;
    await convo.save();
    return { ok: false, error: 'WRONG', left: MAX_ATTEMPTS - convo.signup.attempts };
  }
  return { ok: true };
}

// ── Codes (text) ───────────────────────────────────────────────────────────

async function sendCode(to, convo) {
  const r = await issueCode(to, convo);
  if (!r.ok) {
    await sender.sendText(to, r.error === 'LIMIT'
      ? "I've sent the most codes allowed for now. Please try again in an hour."
      : "I couldn't send the email just now. Please try again in a few minutes.");
    return false;
  }
  await askCode(to, convo);
  return true;
}

// ── Finishing ──────────────────────────────────────────────────────────────

async function createUser(waId, s) {
  const now = new Date();
  const user = new User({
    email: s.email,
    emailVerified: true, // the code we emailed proves it
    firstname: s.firstname,
    middlename: s.middlename || '',
    lastname: s.lastname,
    phonenumber: `+${waId}`, // WhatsApp has verified the number
    phoneVerified: true,
    username: await generateUniqueUsername(s.firstname),
    isUsernameCustom: false,
    password: null,
    passwordpin: null, // set through a WhatsApp Flow before the first trade
    transactionpin: null,
    // Same starting point as routes/passwordpin.js: wallets generated on demand.
    wallets: {
      BTC_BTC: { address: null, network: null, walletReferenceId: null },
      ETH_ETH: { address: null, network: null, walletReferenceId: null },
      SOL_SOL: { address: null, network: null, walletReferenceId: null },
      USDT_ETH: { address: null, network: null, walletReferenceId: null },
      USDT_TRX: { address: null, network: null, walletReferenceId: null },
      USDT_BSC: { address: null, network: null, walletReferenceId: null },
      USDC_ETH: { address: null, network: null, walletReferenceId: null },
      USDC_BSC: { address: null, network: null, walletReferenceId: null },
      BNB_ETH: { address: null, network: null, walletReferenceId: null },
      BNB_BSC: { address: null, network: null, walletReferenceId: null },
      MATIC_ETH: { address: null, network: null, walletReferenceId: null },
      AVAX_BSC: { address: null, network: null, walletReferenceId: null },
      NGNB: { address: null, network: null, walletReferenceId: null },
    },
    kycLevel: 1,
    kycStatus: 'approved',
    kyc: {
      level1: { status: 'approved', phoneVerified: true, verifiedAt: now, submittedAt: now, approvedAt: now, rejectedAt: null, rejectionReason: null },
      level2: { status: 'not_submitted', emailVerified: false, documentSubmitted: false, documentType: null, documentNumber: null, submittedAt: null, approvedAt: null, rejectedAt: null, rejectionReason: null },
      level3: { status: 'not_submitted', submittedAt: null, approvedAt: null, rejectedAt: null, rejectionReason: null, addressVerified: false, sourceOfFunds: null },
    },
  });
  try {
    await user.save();
  } catch (err) {
    if (err.code === 11000 && Object.keys(err.keyPattern || {})[0] === 'username') {
      user.username = await generateUniqueUsername(s.firstname);
      await user.save();
    } else {
      throw err;
    }
  }
  return user;
}

/**
 * Creates or links the Bramp account once the code is right.
 * error: TAKEN (email or number registered meanwhile; back to the email step)
 *      | LINKED_ELSEWHERE (that account is on another WhatsApp number).
 */
async function complete(to, convo) {
  const s = convo.signup;
  let userId = s.linkUserId;
  let source = 'LINKED';

  if (!userId) {
    try {
      userId = (await createUser(to, s))._id;
      source = 'CREATED';
    } catch (err) {
      if (err.code === 11000) {
        // Someone registered this email or number since we checked.
        logger.warn('Stella: sign-up hit an existing account', { waId: sender.mask(to), key: Object.keys(err.keyPattern || {})[0] });
        convo.state = 'SIGNUP_EMAIL';
        convo.signup.codeHash = null;
        await convo.save();
        return { ok: false, error: 'TAKEN' };
      }
      throw err;
    }
  }

  if (await StellaCustomer.exists({ userId })) {
    convo.state = 'NEW';
    convo.signup = {};
    await convo.save();
    return { ok: false, error: 'LINKED_ELSEWHERE' };
  }

  const customer = await StellaCustomer.create({ waId: to, userId, source });
  convo.state = 'READY';
  convo.signup = {};
  await convo.save();
  logger.info('Stella: customer ready', { waId: sender.mask(to), source });
  return { ok: true, customer, source };
}

const LINKED_ELSEWHERE = 'That Bramp account is already linked to another WhatsApp number. Please contact Bramp support to move it.';

/** What Stella says once the account is ready, then straight on to the identity check. */
async function welcome(to, customer, source) {
  await sender.sendText(to, source === 'LINKED'
    ? "You're linked ✅ Stella now uses your Bramp account."
    : "You're set up ✅ Your Bramp account is ready.");
  return stellaKyc.promptIfNeeded(to, customer);
}

async function finish(to, convo) {
  const r = await complete(to, convo);
  if (r.ok) return welcome(to, r.customer, r.source);
  return sender.sendText(to, r.error === 'TAKEN'
    ? 'That email or number was just registered on Bramp. Please send a different email address.'
    : LINKED_ELSEWHERE);
}

// ── Steps ──────────────────────────────────────────────────────────────────

async function start(to, convo, displayName) {
  const existing = await User.findOne({ phonenumber: { $in: phoneVariants(to) } }).select('_id');
  const hello = `Hi ${displayName} 👋 I'm Stella by Bramp. I help you buy and sell crypto with desks you trust, right here on WhatsApp.`;
  if (existing) {
    convo.state = 'LINK_CONFIRM';
    convo.signup = { linkUserId: existing._id };
    await convo.save();
    await sender.sendText(to, hello);
    return askLinkConfirm(to, convo);
  }
  convo.state = 'SIGNUP_NAME';
  convo.signup = {};
  await convo.save();
  await sender.sendText(to, `${hello}\n\nLet's set you up. It takes a minute.`);
  return askName(to);
}

async function onLinkConfirm(to, convo, { replyId }) {
  if (replyId === BTN.LINK_NO) {
    return sender.sendText(to, "No problem. This number is already registered on Bramp, so I can't open a new account with it. Please contact Bramp support.");
  }
  if (replyId !== BTN.LINK_YES) return askLinkConfirm(to, convo);
  const user = await User.findById(convo.signup.linkUserId).select('email firstname');
  if (!user) return start(to, convo, 'there');
  convo.signup.email = user.email;
  convo.signup.firstname = null; // linking: no name step, so no "Change email"
  return sendCode(to, convo);
}

async function onName(to, convo, { text }) {
  const r = await setName(convo, text);
  if (!r.ok) return sender.sendText(to, 'Please send your first and last name, for example: Ada Okafor');
  return askEmail(to, r.firstname);
}

async function onEmail(to, convo, { text }) {
  const r = await setEmail(to, convo, text);
  if (r.error === 'EMAIL') return sender.sendText(to, "That doesn't look like an email address. Please send it again, for example: ada@gmail.com");
  if (r.error === 'BANNED') return sender.sendText(to, "Sorry, I can't open an account for you.");
  return sendCode(to, convo);
}

async function onCode(to, convo, { text, replyId }) {
  if (replyId === BTN.RESEND) return sendCode(to, convo);
  if (replyId === BTN.CHANGE_EMAIL && convo.signup.firstname) {
    convo.state = 'SIGNUP_EMAIL';
    convo.signup.codeHash = null;
    convo.signup.linkUserId = null;
    await convo.save();
    return sender.sendText(to, "Sure. What's the right email address?");
  }

  const r = await checkCode(to, convo, text);
  if (r.ok) return finish(to, convo);
  if (r.error === 'FORMAT') return askCode(to, convo);
  if (r.error === 'TOO_MANY') {
    return sender.sendButtons(to, 'Too many wrong codes. Tap below for a new one.', [{ id: BTN.RESEND, title: 'Resend code' }]);
  }
  if (r.error === 'EXPIRED') {
    return sender.sendButtons(to, 'That code has expired. Tap below for a new one.', [{ id: BTN.RESEND, title: 'Resend code' }]);
  }
  return sender.sendText(to, r.left > 0 ? `That code isn't right. ${r.left} ${r.left === 1 ? 'try' : 'tries'} left.` : 'That code isn\'t right. Tap "Resend code" for a new one.');
}

const STEPS = { SIGNUP_NAME: onName, SIGNUP_EMAIL: onEmail, SIGNUP_CODE: onCode, LINK_CONFIRM: onLinkConfirm };

/**
 * One inbound message. Returns the StellaCustomer if this number is linked
 * (the caller carries on with the conversation), or null if the sign-up
 * handled the message.
 */
async function handleIncoming({ waId, text, replyId, displayName }) {
  const convo = await StellaConversation.findOneAndUpdate(
    { waId },
    { $set: { lastInboundAt: new Date() }, $setOnInsert: { waId } },
    { upsert: true, new: true }
  );

  const customer = await StellaCustomer.findOne({ waId });
  if (customer) return customer;

  if (/^\s*(start over|restart)\s*$/i.test(text || '')) return start(waId, convo, displayName).then(() => null);

  const step = STEPS[convo.state];
  if (!step) {
    await start(waId, convo, displayName);
    return null;
  }
  if (!text && !replyId) {
    await repeatStep(waId, convo);
    return null;
  }
  await step(waId, convo, { text, replyId });
  return null;
}

module.exports = {
  handleIncoming, parseFullName, BTN, maskEmail,
  // For the sign-up Flow (AI/stellaFlows.js).
  setName, setEmail, issueCode, checkCode, complete, welcome, LINKED_ELSEWHERE,
};
