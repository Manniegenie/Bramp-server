// AI/stellaRouter.js
// Which desk a Stella customer is trading with (spec §5.3). A desk is a
// StorefrontMerchant; its @username is the slug, the same name as
// name.bramp.shop.
//
// The desk is sticky. The first @desk (or the one in their very first
// message, before sign-up) becomes the customer's desk and stays theirs.
// It changes only when the customer explicitly switches: another @username,
// "change desk", or another desk's link, always confirmed with a button.
// Nothing else moves it: silence, a new chat, the 24-hour window, a paused
// or closed desk, or a one-off trade elsewhere.
//
//   paused desk  → wait, or another desk for this trade only (default kept)
//   closed desk  → told, and asked to choose; never reassigned silently
//
// route() returns the desk when the conversation should carry on with it
// (the agent, M7), or null when routing has replied itself.
const StorefrontMerchant = require('../models/storefrontMerchant');
const StellaCustomer = require('../models/stellaCustomer');
const StellaConversation = require('../models/stellaConversation');
const sender = require('./stellaSender');
const logger = require('../utils/logger');

const BTN = {
  SWITCH_YES: 'desk_switch_yes',
  SWITCH_NO: 'desk_switch_no',
  WAIT: 'desk_wait',
  OTHER_ONCE: 'desk_other_once',
};
const PENDING_SWITCH_TTL_MS = 60 * 60 * 1000;
const TRADE_DESK_TTL_MS = 60 * 60 * 1000;

// "@tolu" or "@tolu-exchange" as its own word; not the @ inside an email address.
const MENTION = /(?:^|\s)@([a-z0-9][a-z0-9-]{0,30}[a-z0-9])(?![\w.@-])/i;

/** The first @desk in a message, lower-cased, or null. */
function parseMention(text) {
  const m = MENTION.exec(String(text || ''));
  return m ? m[1].toLowerCase() : null;
}

const deskName = (d) => d.brandName || `@${d.slug}`;
const deskLabel = (d) => (d.brandName ? `*${d.brandName}* (@${d.slug})` : `*@${d.slug}*`);
// Button titles are capped at 20 characters by WhatsApp.
const btnTitle = (prefix, d) => `${prefix} ${deskName(d)}`.slice(0, 20);

const askChoose = (to) => sender.sendText(to,
  'Which desk do you trade with? Send their Stella username, for example *@tolu*. Your desk can share their Stella link with you.');

async function setDesk(customer, desk, via) {
  const from = customer.deskId || null;
  const now = new Date();
  customer.deskId = desk._id;
  customer.deskSetVia = via;
  customer.deskSetAt = now;
  if (!customer.firstDeskId) customer.firstDeskId = desk._id;
  customer.deskHistory.push({ fromDeskId: from, toDeskId: desk._id, via, changedAt: now });
  await customer.save();
  logger.info('Stella: desk set', { waId: sender.mask(customer.waId), desk: desk.slug, via, from: from ? String(from) : null });
}

async function clearPrompts(convo) {
  convo.awaitingDesk = null;
  convo.pendingSwitch = { deskId: null, askedAt: null };
  await convo.save();
}

/** A customer named a desk (@username). */
async function onMention(to, customer, convo, current, slug, via) {
  const target = await StorefrontMerchant.findOne({ slug });
  if (!target || target.status === 'closed') {
    return sender.sendText(to, `I couldn't find a desk called *@${slug}* on Stella. Check the username with your desk.`);
  }

  // "Another desk, this trade only": the customer's own desk stays as it is.
  if (convo.awaitingDesk === 'ONCE') {
    if (target.status !== 'active') return sender.sendText(to, `${deskLabel(target)} isn't taking trades right now either. Send another @username, or wait for your desk.`);
    convo.tradeDesk = { deskId: target._id, until: new Date(Date.now() + TRADE_DESK_TTL_MS) };
    await clearPrompts(convo);
    return sender.sendText(to, `For this trade only, you're with ${deskLabel(target)}. ${current ? `Your desk stays ${deskLabel(current)}.` : ''}`.trim());
  }

  // No usable desk yet (or theirs has closed): their choice applies at once.
  if (!current || current.status === 'closed') {
    await setDesk(customer, target, current ? 'SWITCH' : via);
    await clearPrompts(convo);
    return sender.sendText(to, `You're now trading with ${deskLabel(target)}. They stay your desk until you choose another one.${target.status === 'paused' ? `\n\n${deskName(target)} is paused right now, so trading opens when they're back.` : ''}`);
  }

  if (String(current._id) === String(target._id)) {
    await clearPrompts(convo);
    return sender.sendText(to, `You're already trading with ${deskLabel(target)}.`);
  }

  // A different desk: always confirm before switching.
  convo.awaitingDesk = null;
  convo.pendingSwitch = { deskId: target._id, askedAt: new Date() };
  await convo.save();
  return sender.sendButtons(to,
    `You're trading with ${deskLabel(current)}. Switch to ${deskLabel(target)}? Your open orders stay with the desk they were made with.`,
    [{ id: BTN.SWITCH_YES, title: btnTitle('Switch to', target) }, { id: BTN.SWITCH_NO, title: btnTitle('Stay with', current) }]);
}

async function onButton(to, customer, convo, current, replyId) {
  if (replyId === BTN.SWITCH_YES || replyId === BTN.SWITCH_NO) {
    const pending = convo.pendingSwitch?.deskId && convo.pendingSwitch.askedAt > new Date(Date.now() - PENDING_SWITCH_TTL_MS)
      ? await StorefrontMerchant.findById(convo.pendingSwitch.deskId) : null;
    await clearPrompts(convo);
    if (!pending) return sender.sendText(to, 'That question has expired. Send the @username again if you want to switch.');
    if (replyId === BTN.SWITCH_NO) return sender.sendText(to, `OK, you're staying with ${deskLabel(current || pending)}.`);
    if (pending.status === 'closed') return sender.sendText(to, `${deskLabel(pending)} isn't on Stella any more. You're staying with ${deskLabel(current)}.`);
    await setDesk(customer, pending, 'SWITCH');
    return sender.sendText(to, `Done. You're now trading with ${deskLabel(pending)}.`);
  }
  if (replyId === BTN.WAIT) {
    return sender.sendText(to, `OK. You're staying with ${deskLabel(current)}. Message me when you want to trade.`);
  }
  if (replyId === BTN.OTHER_ONCE) {
    convo.awaitingDesk = 'ONCE';
    await convo.save();
    return sender.sendText(to, `Which desk for this trade? Send their @username. ${deskName(current)} stays your desk.`);
  }
  return null; // not a routing button: the conversation carries on
}

/**
 * One message from a verified customer. Returns the desk to carry on with,
 * or null if routing replied.
 */
async function route({ waId, customer, text, replyId }) {
  const convo = await StellaConversation.findOne({ waId });
  const current = customer.deskId ? await StorefrontMerchant.findById(customer.deskId) : null;

  if (replyId && Object.values(BTN).includes(replyId)) {
    await onButton(waId, customer, convo, current, replyId);
    return null;
  }

  let slug = parseMention(text);
  // Just asked for a desk: a bare "tolu" counts too.
  if (!slug && convo.awaitingDesk && /^\s*@?[a-z0-9][a-z0-9-]{0,30}[a-z0-9]\s*$/i.test(text || '')) {
    slug = text.trim().replace(/^@/, '').toLowerCase();
  }
  if (slug) {
    await onMention(waId, customer, convo, current, slug, 'MENTION');
    return null;
  }

  // The desk from their very first message, before they were set up.
  if (!current && convo.entryDeskSlug) {
    const entry = convo.entryDeskSlug;
    convo.entryDeskSlug = null;
    await convo.save();
    await onMention(waId, customer, convo, null, entry, 'ENTRY');
    return null;
  }

  if (/\b(change|switch)\s+(my\s+)?desk\b/i.test(text || '')) {
    convo.awaitingDesk = current ? 'SWITCH' : 'CHOOSE';
    await convo.save();
    await sender.sendText(waId, current
      ? `You're with ${deskLabel(current)}. Send the @username of the desk you want to switch to.`
      : 'Send the @username of the desk you want to trade with.');
    return null;
  }

  if (/\b(which|what)\s+desk\b|\bmy\s+desk\b/i.test(text || '')) {
    await sender.sendText(waId, current ? `You're trading with ${deskLabel(current)}.` : "You haven't picked a desk yet. Send your desk's @username, for example *@tolu*.");
    return null;
  }

  if (!current) {
    convo.awaitingDesk = 'CHOOSE';
    await convo.save();
    await askChoose(waId);
    return null;
  }

  if (current.status === 'closed') {
    convo.awaitingDesk = 'CHOOSE';
    await convo.save();
    await sender.sendText(waId, `${deskLabel(current)} is no longer on Stella. Send the @username of the desk you'd like to trade with instead.`);
    return null;
  }

  if (current.status === 'paused') {
    await sender.sendButtons(waId,
      `${deskLabel(current)} is paused right now. You can wait for them, or use another desk for this trade only. ${deskName(current)} stays your desk either way.`,
      [{ id: BTN.WAIT, title: btnTitle('Wait for', current) }, { id: BTN.OTHER_ONCE, title: 'Another desk, once' }]);
    return null;
  }

  return current;
}

/**
 * Remembers an @desk from a message sent before the customer is set up
 * (signing up or not yet verified), so a desk's link isn't lost on the way.
 * The first one wins; route() applies it once they're verified.
 */
async function rememberEntryDesk(waId, text) {
  const slug = parseMention(text);
  if (!slug) return;
  await StellaConversation.updateOne({ waId, entryDeskSlug: null }, { $set: { entryDeskSlug: slug } });
}

module.exports = { route, rememberEntryDesk, parseMention, BTN };
