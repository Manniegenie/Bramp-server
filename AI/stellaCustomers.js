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
const { sendEmailVerificationOTP } = require('../services/EmailService');
const sender = require('./stellaSender');
const stellaKyc = require('./stellaKyc');
const flowTokens = require('./stellaFlowTokens');
const logger = require('../utils/logger');

const CODE_TTL_MINUTES = 10;
const STELLA_CHAT_URL = `https://wa.me/${process.env.STELLA_WA_NUMBER || '2349020883541'}`;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 3;

const BTN = {
  LINK_YES: 'link_yes',
  LINK_NO: 'link_no',
  RESEND: 'code_resend',
  CHANGE_EMAIL: 'email_change',
  NOT_ME: 'acct_moved_not_me', // the "This wasn't me" button on the account-moved template
};

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const codeHash = (waId, code) => sha256(`${waId}:${code}`);

// "sign in" / "log in" from a number that isn't linked yet: any message that
// short and saying so. From a linked number only the bare keyword counts, so
// "I can't log in to the app" still goes to Stella.
const SIGNIN_LOOSE = /\b(sign[\s-]?in|log[\s-]?in|login|signin)\b/i;
const SIGNIN_EXACT = /^\s*(sign[\s-]?in|log[\s-]?in|login|signin)\s*[.!]?\s*$/i;
const SIGNUP_EXACT = /^\s*(sign[\s-]?up|signup|register|create (an )?account)\s*[.!]?\s*$/i;
const SIGNOUT_EXACT = /^\s*(sign[\s-]?out|log[\s-]?out|logout|signout)\s*[.!]?\s*$/i;
const wantsSignIn = (text, linked) => Boolean(text) && !text.includes('@') // login@… is an email, not a request
  && (linked ? SIGNIN_EXACT.test(text) : text.length <= 80 && SIGNIN_LOOSE.test(text));

const maskPhone = (waId) => `+${waId.slice(0, 3)} ${waId.slice(3, 6)} ••• ${waId.slice(-4)}`;

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
      body: 'Tap below to set up your account, or just reply with your full name as it appears on your BVN or NIN.\n\nAlready on Bramp? Reply *sign in*.',
      cta: 'Set up my account',
      flowId: flowTokens.flowId('SIGNUP'),
      token: await flowTokens.issue(to, 'SIGNUP'),
      screen: 'NAME',
      mode: flowTokens.mode(),
    });
  }
  return sender.sendText(to, "What's your full name, as it appears on your BVN or NIN?\n\nAlready on Bramp? Reply *sign in*.");
}

const askSigninEmail = (to) => sender.sendText(to, "Let's sign you in. What's the email address on your Bramp account?");
const askEmail = (to, firstname) => sender.sendText(to,
  `Thanks, ${firstname}. What's your email address? I'll send a 6-digit code to confirm it, and your receipts go there too.`);

function askCode(to, convo) {
  const buttons = [{ id: BTN.RESEND, title: 'Resend code' }];
  // Only when they typed the email (sign-up or sign-in); linking by number uses the account's own.
  if (convo.signup.firstname || convo.signup.mode === 'SIGNIN') buttons.push({ id: BTN.CHANGE_EMAIL, title: 'Change email' });
  return sender.sendButtons(to, `I've sent a 6-digit code to ${maskEmail(convo.signup.email)}. Reply with the code.`, buttons);
}

/** Re-asks whatever the current step needs, for messages that don't answer it. */
async function repeatStep(to, convo) {
  switch (convo.state) {
    case 'SIGNUP_NAME': return askName(to);
    case 'SIGNUP_EMAIL': return askEmail(to, convo.signup.firstname);
    case 'SIGNUP_CODE': return askCode(to, convo);
    case 'LINK_CONFIRM': return askLinkConfirm(to, convo);
    case 'SIGNIN_EMAIL': return askSigninEmail(to);
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
  // Linking has no name step: greet them by the account's name.
  const name = convo.signup.firstname
    || (convo.signup.linkUserId && (await User.findById(convo.signup.linkUserId).select('firstname'))?.firstname)
    || 'there';
  try {
    // The same code email as the Bramp app's email verification and PIN reset.
    await sendEmailVerificationOTP(convo.signup.email, name, code, CODE_TTL_MINUTES, {
      ctaText: 'Back to WhatsApp', verifyUrl: STELLA_CHAT_URL, appDeepLink: STELLA_CHAT_URL,
    });
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
 * Creates or links the Bramp account once the code is right. An account
 * already on another WhatsApp number moves here (source MOVED, with
 * oldWaId): the code to the account's email proves it's theirs, and
 * welcome() tells the old number.
 * error: TAKEN (email or number registered meanwhile; back to the email step).
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

  const elsewhere = await StellaCustomer.findOne({ userId });
  if (elsewhere) {
    // A signed-out account's number is the one it signed out on; back on that
    // same number it's a plain sign-in, anywhere else it's a move.
    const oldWaId = elsewhere.signedOut?.at ? elsewhere.signedOut.waId : elsewhere.waId;
    const moved = oldWaId !== to;
    if (moved) elsewhere.movedFrom.push({ waId: oldWaId, movedAt: new Date() });
    elsewhere.waId = to;
    elsewhere.signedOut = { at: null, waId: null };
    await elsewhere.save();
    convo.state = 'READY';
    convo.signup = {};
    await convo.save();
    if (!moved) {
      logger.info('Stella: customer signed back in', { waId: sender.mask(to) });
      return { ok: true, customer: elsewhere, source: 'LINKED' };
    }
    // The number it signed out on may be someone else's account by now; never
    // tell them about this one.
    if (await StellaCustomer.exists({ waId: oldWaId })) {
      logger.warn('Stella: signed-out account signed in on a new number; its old number has another account, not told', { to: sender.mask(to), userId: String(userId) });
      return { ok: true, customer: elsewhere, source: 'LINKED' };
    }
    logger.warn('Stella: account moved to a new number', { from: sender.mask(oldWaId), to: sender.mask(to), userId: String(userId) });
    return { ok: true, customer: elsewhere, source: 'MOVED', oldWaId };
  }

  const customer = await StellaCustomer.create({ waId: to, userId, source });
  convo.state = 'READY';
  convo.signup = {};
  await convo.save();
  logger.info('Stella: customer ready', { waId: sender.mask(to), source });
  return { ok: true, customer, source };
}

/** What Stella says once the account is ready, then straight on to the identity check. */
async function welcome(to, customer, source, oldWaId = null) {
  if (source === 'MOVED') {
    await sender.sendText(to, "You're signed in ✅ Your Stella account is now on this number, with your desk and settings.");
    // The owner should know at once if this wasn't them. A free-form message
    // only reaches a number that wrote to us in the last 24 hours, so this
    // goes as an approved template when one is set (STELLA_TEMPLATE_ACCOUNT_MOVED);
    // its "This wasn't me" button puts the account on hold (handleNotMe).
    const when = new Date().toLocaleString('en-NG', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const told = process.env.STELLA_TEMPLATE_ACCOUNT_MOVED
      ? await sender.sendTemplate(oldWaId, {
        name: process.env.STELLA_TEMPLATE_ACCOUNT_MOVED,
        language: process.env.STELLA_TEMPLATE_LANGUAGE || 'en',
        bodyParams: [to.slice(-4), when],
        quickReplies: [BTN.NOT_ME],
      }, `Account moved to a number ending ${to.slice(-4)} on ${when}.`)
      : await sender.sendText(oldWaId,
        `Your Stella account was just moved to another WhatsApp number (${maskPhone(to)}). If this wasn't you, reply *not me* and I'll pause the account right away.`);
    if (!told.ok) logger.warn('Stella: could not tell the old number about a move', { oldWaId: sender.mask(oldWaId), error: told.error });
  } else {
    await sender.sendText(to, source === 'LINKED'
      ? "You're signed in ✅ Stella now uses your Bramp account."
      : "You're set up ✅ Your Bramp account is ready.");
  }
  return stellaKyc.promptIfNeeded(to, customer);
}

async function finish(to, convo) {
  const r = await complete(to, convo);
  if (r.ok) return welcome(to, r.customer, r.source, r.oldWaId);
  return sender.sendText(to, 'That email or number was just registered on Bramp. Please send a different email address.');
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
    return sender.sendText(to, "No problem. This number is already registered on Bramp, so I can't open a new account with it. If you have a different Bramp account, reply *sign in*. Otherwise please contact Bramp support.");
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
  if (replyId === BTN.CHANGE_EMAIL && (convo.signup.firstname || convo.signup.mode === 'SIGNIN')) {
    convo.state = convo.signup.mode === 'SIGNIN' ? 'SIGNIN_EMAIL' : 'SIGNUP_EMAIL';
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

// ── Sign in ────────────────────────────────────────────────────────────────

async function startSignIn(to, convo) {
  convo.state = 'SIGNIN_EMAIL';
  convo.signup = { mode: 'SIGNIN' };
  await convo.save();
  if (flowTokens.enabled('SIGNIN')) {
    return sender.sendFlow(to, {
      body: "Let's sign you in with your Bramp email and password PIN. Tap below. (Or reply with your Bramp email and I'll send you a code instead.)",
      cta: 'Sign in',
      flowId: flowTokens.flowId('SIGNIN'),
      token: await flowTokens.issue(to, 'SIGNIN'),
      screen: 'SIGNIN',
      mode: flowTokens.mode(),
    });
  }
  return askSigninEmail(to);
}

/** The number an account is signed in on, if it's signed in and not on `to`. */
const otherNumber = (customer, to) => (customer && !customer.signedOut?.at && customer.waId !== to ? customer.waId : null);

const moveNote = (waId) => `This account is on Stella with another WhatsApp number (${maskPhone(waId)}). Signing in here moves it to this number, and that number will be signed out.`;

/**
 * The email of an existing Bramp account to sign in with (text and Flow).
 * error: EMAIL | BANNED | NOT_FOUND. elsewhere: the number it's on now, if any.
 */
async function setSigninEmail(to, convo, raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!validator.isEmail(email)) return { ok: false, error: 'EMAIL' };
  if (await KYCBlacklist.isBanned('email', email) || await KYCBlacklist.isBanned('phone', `+${to}`)) {
    logger.warn('Stella: blacklisted sign-in attempt', { waId: sender.mask(to) });
    return { ok: false, error: 'BANNED' };
  }
  const user = await User.findOne({ email }).select('_id');
  if (!user) return { ok: false, error: 'NOT_FOUND' };
  convo.state = 'SIGNIN_EMAIL';
  convo.signup.email = email;
  convo.signup.linkUserId = user._id;
  convo.signup.mode = 'SIGNIN';
  const other = await StellaCustomer.findOne({ userId: user._id }).select('waId signedOut');
  return { ok: true, elsewhere: otherNumber(other, to) };
}

// Same rules and the same fields as the Bramp app's sign-in (routes/signin.js),
// so a lock on one is a lock on both.
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCK_MS = 6 * 60 * 60 * 1000;

/**
 * Checks the account's password PIN (only ever entered in the sign-in Flow,
 * never typed in the chat). error: FORMAT | NO_PIN | LOCKED (until) | WRONG (left).
 */
async function checkPasswordPin(userId, raw) {
  const pin = String(raw || '').trim().padStart(6, '0');
  if (!/^\d{6}$/.test(pin)) return { ok: false, error: 'FORMAT' };
  const user = await User.findById(userId).select('passwordpin loginAttempts lockUntil');
  if (!user) return { ok: false, error: 'WRONG', left: 0 };
  if (user.lockUntil && user.lockUntil > Date.now()) return { ok: false, error: 'LOCKED', until: user.lockUntil };
  if (!user.passwordpin) return { ok: false, error: 'NO_PIN' };
  if (await user.comparePasswordPin(pin)) {
    await User.updateOne({ _id: userId }, { $set: { loginAttempts: 0, lockUntil: null, lastFailedLogin: null } });
    return { ok: true };
  }
  const lockExpired = Boolean(user.lockUntil && user.lockUntil <= Date.now());
  const attempts = lockExpired ? 1 : (user.loginAttempts || 0) + 1;
  const set = { loginAttempts: attempts, lastFailedLogin: new Date(), ...(lockExpired ? { lockUntil: null } : {}) };
  if (attempts >= MAX_PIN_ATTEMPTS) set.lockUntil = new Date(Date.now() + PIN_LOCK_MS);
  await User.updateOne({ _id: userId }, { $set: set });
  logger.warn('Stella: wrong password PIN at sign-in', { userId: String(userId), attempts });
  return set.lockUntil ? { ok: false, error: 'LOCKED', until: set.lockUntil } : { ok: false, error: 'WRONG', left: MAX_PIN_ATTEMPTS - attempts };
}

/** The code goes to the account's email; entering it signs this number in. */
async function onSigninEmail(to, convo, { text }) {
  const r = await setSigninEmail(to, convo, text);
  if (r.error === 'EMAIL') return sender.sendText(to, "That doesn't look like an email address. Please send the email on your Bramp account, for example: ada@gmail.com");
  if (r.error === 'BANNED') return sender.sendText(to, "Sorry, I can't sign you in.");
  if (r.error === 'NOT_FOUND') {
    return sender.sendText(to, "I couldn't find a Bramp account with that email. Check it and send it again, or reply *sign up* to create a new account.");
  }
  if (r.elsewhere) await sender.sendText(to, moveNote(r.elsewhere));
  return sendCode(to, convo);
}

// ── "This wasn't me" ───────────────────────────────────────────────────────

/**
 * The number an account just moved away from says it wasn't them: pause the
 * account (on its new number) for Bramp support. Returns true if this number
 * had an account moved away from it, so the message is handled.
 */
async function handleNotMe(waId) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const customer = await StellaCustomer.findOne({ movedFrom: { $elemMatch: { waId, movedAt: { $gt: since } } } });
  if (!customer) return false;
  const entry = [...customer.movedFrom].reverse().find((m) => m.waId === waId);
  entry.disputedAt = new Date();
  customer.securityHold = { active: true, reason: `Move disputed by previous number ${sender.mask(waId)}`, at: new Date() };
  await customer.save();
  logger.error('Stella: SECURITY: account move disputed, account on hold', {
    userId: String(customer.userId), from: sender.mask(waId), now: sender.mask(customer.waId),
  });
  await sender.sendText(waId, "Thanks for telling us. I've paused the account straight away, so nothing can be done with it on the other number. Bramp support will contact you on your Bramp email to secure it.");
  if (!customer.signedOut?.at) await sender.sendText(customer.waId, 'This account is paused for a security check. Bramp support will contact the account owner by email.');
  return true;
}

// ── Sign out ───────────────────────────────────────────────────────────────

/**
 * "sign out": this number stops being the account's. The account keeps its
 * desk and history, and its waId becomes a placeholder so the number is free
 * to sign up or sign in to any account. An unused verify link dies with it.
 */
async function signOut(waId, customer) {
  await StellaCustomer.updateOne({ _id: customer._id }, {
    $set: {
      waId: `signedout:${customer._id}`,
      signedOut: { at: new Date(), waId },
      'verifyLink.tokenHash': null,
      'verifyLink.expiresAt': null,
    },
  });
  await StellaConversation.updateOne({ waId }, {
    $set: {
      state: 'NEW', signup: {}, entryDeskSlug: null, awaitingDesk: null,
      pendingSwitch: { deskId: null, askedAt: null }, tradeDesk: { deskId: null, until: null },
      flow: { tokenHash: null, purpose: null, expiresAt: null },
    },
  });
  logger.info('Stella: customer signed out', { waId: sender.mask(waId), userId: String(customer.userId) });
  await sender.sendText(waId, "You're signed out of Stella on this number. Your Bramp account and your desk are kept.\n\nReply *sign in* to sign back in, or *sign up* to create a new account.");
}

const STEPS = { SIGNUP_NAME: onName, SIGNUP_EMAIL: onEmail, SIGNUP_CODE: onCode, LINK_CONFIRM: onLinkConfirm, SIGNIN_EMAIL: onSigninEmail };

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

  // The old number's answer to "your account moved": the template's button or "not me".
  if ((replyId === BTN.NOT_ME || /^\s*(not me|this wasn'?t me)\s*[.!]?\s*$/i.test(text || '')) && await handleNotMe(waId)) return null;

  const customer = await StellaCustomer.findOne({ waId });
  if (customer?.securityHold?.active) {
    await sender.sendText(waId, 'This account is paused for a security check. Bramp support will contact the account owner by email.');
    return null;
  }
  if (customer) {
    if (SIGNOUT_EXACT.test(text || '')) return signOut(waId, customer).then(() => null);
    if (!wantsSignIn(text, true) && !SIGNUP_EXACT.test(text || '')) return customer;
    const user = await User.findById(customer.userId).select('email');
    await sender.sendText(waId, `You're already signed in on this number with ${maskEmail(user?.email || '')}. To use another account here, reply *sign out* first. To use Stella on a new number, message me from that number and reply *sign in*.`);
    return null;
  }

  if (SIGNOUT_EXACT.test(text || '')) {
    await sender.sendText(waId, "You're not signed in on this number. Reply *sign in* to sign in, or *sign up* to create an account.");
    return null;
  }
  if (/^\s*(start over|restart)\s*$/i.test(text || '')) return start(waId, convo, displayName).then(() => null);
  // "sign in" at any point before they're linked; "sign up" starts sign-up over.
  if (convo.state !== 'SIGNUP_CODE' && wantsSignIn(text, false)) return startSignIn(waId, convo).then(() => null);
  if (SIGNUP_EXACT.test(text || '')) return start(waId, convo, displayName).then(() => null);

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
  setName, setEmail, issueCode, checkCode, complete, welcome,
  // For the sign-in Flow.
  setSigninEmail, moveNote, otherNumber, checkPasswordPin, handleNotMe,
  signOut,
};
