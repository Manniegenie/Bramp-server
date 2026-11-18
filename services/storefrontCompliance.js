// services/storefrontCompliance.js
// Storefront's compliance checks: the blocklist (a WhatsApp number or bank
// account Bramp won't trade with) and alerts for large or rapid trades. The
// blocklist stops a trade; alerts only tell bramp-admin. Never throws from
// screen(): an alert failing mustn't disturb a payout.
const StorefrontBlock = require('../models/storefrontBlock');
const StorefrontAlert = require('../models/storefrontAlert');
const StorefrontSellOrder = require('../models/storefrontSellOrder');
const settings = require('./storefrontSettings');
const logger = require('../utils/logger');

const digits = (s) => String(s || '').replace(/\D/g, '');

const isBlocked = (kind, value) => (value ? StorefrontBlock.findOne({ kind, value, active: true }).lean() : null);
const numberBlocked = (waId) => isBlocked('WHATSAPP', digits(waId));
const accountBlocked = (accountNumber) => isBlocked('BANK_ACCOUNT', digits(accountNumber));

/** Why this sale mustn't be paid (a blocked number or payout account), or null. */
async function payoutBlock(order) {
  if (await numberBlocked(order.waId)) return 'Customer\'s WhatsApp number is blocked';
  if (order.payoutAccount?.accountNumber && await accountBlocked(order.payoutAccount.accountNumber)) return 'Payout account is blocked';
  return null;
}

async function raise(fields) {
  try {
    await StorefrontAlert.create(fields);
    logger.warn('Storefront alert', { type: fields.type, order: fields.orderReference, detail: fields.detail });
  } catch (err) {
    if (err.code !== 11000) logger.warn('Storefront: alert not saved', { error: err.message }); // 11000: already raised for this sale
  }
}

/** Alerts for this sale at settlement: a large payout, or many deposits from one number in a short window. */
async function screen(order, merchant, customerNgn) {
  try {
    const { values: v } = await settings.get();
    const base = { merchantId: order.merchantId, waId: order.waId, orderReference: order.reference, amountNgn: customerNgn };
    if (v.largeTradeNgn > 0 && customerNgn >= v.largeTradeNgn) {
      await raise({ ...base, type: 'LARGE_TRADE', detail: `Payout of ₦${Math.round(customerNgn).toLocaleString('en-NG')} at @${merchant?.slug || '?'}` });
    }
    if (v.velocityCount > 0) {
      const since = new Date(Date.now() - v.velocityWindowMinutes * 60 * 1000);
      const recent = await StorefrontSellOrder.find({ waId: order.waId, 'deposit.confirmedAt': { $gte: since } }).select('merchantId').lean();
      if (recent.length >= v.velocityCount) {
        const desks = new Set(recent.map((o) => String(o.merchantId))).size;
        await raise({ ...base, type: 'VELOCITY', detail: `${recent.length} deposits in ${v.velocityWindowMinutes} min across ${desks} desk${desks === 1 ? '' : 's'}` });
      }
    }
  } catch (err) {
    logger.warn('Storefront: screening failed', { order: order.reference, error: err.message });
  }
}

module.exports = { digits, numberBlocked, accountBlocked, payoutBlock, screen };
