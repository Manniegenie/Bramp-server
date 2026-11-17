// services/storefrontTraderNotify.js
// Tells a trader about their storefront's trades by push notification (Bramp
// app) and email - never through Stella. Never throws: a failed notification
// mustn't disturb a trade.
const User = require('../models/user');
const { sendCustomNotification } = require('./notificationService');
const { sendEmail } = require('./EmailService');
const logger = require('../utils/logger');

const naira = (n) => `₦${Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const maskPhone = (waId) => `+${String(waId).slice(0, 3)} ••• ${String(waId).slice(-4)}`;
const maskAcct = (n) => `••${String(n || '').slice(-4)}`;

function message(event, order, merchant) {
  const coins = `${order.deposit?.amount ?? ''} ${order.coin}`.trim();
  const who = maskPhone(order.waId);
  switch (event) {
    case 'deposit_confirmed':
      return { title: 'Customer deposit received', body: `${who} sent ${coins} to your storefront.` };
    case 'paid': {
      const earned = order.settlement?.traderEarningNgn > 0 ? ` You earned ${naira(order.settlement.traderEarningNgn)}.` : '';
      return {
        title: 'Customer paid',
        body: `${who} was paid ${naira(order.settlement?.customerNgn)} for ${coins} (${order.payoutAccount?.bankName} ${maskAcct(order.payoutAccount?.accountNumber)}).${earned}`,
      };
    }
    case 'needs_review':
      return { title: 'Storefront trade under review', body: `A payout to ${who} for ${coins} needs a check by Bramp. We'll update you. Ref ${order.reference}.` };
    default:
      return { title: `${merchant.brandName || 'Storefront'} update`, body: `Trade ${order.reference}: ${event}.` };
  }
}

async function notifyTrader(merchant, event, order) {
  const { title, body } = message(event, order, merchant);
  const data = { type: 'STOREFRONT_TRADE', event, reference: order.reference };

  try {
    await sendCustomNotification(merchant.userId, title, body, data);
  } catch (err) {
    logger.warn('Storefront: trader push failed', { merchant: merchant.slug, event, error: err.message });
  }

  const templateId = Number(process.env.BREVO_TEMPLATE_STOREFRONT_TRADER);
  if (!templateId) return; // email template not configured yet
  try {
    const user = await User.findById(merchant.userId).select('email firstname username');
    if (!user?.email) return;
    await sendEmail({
      to: user.email,
      name: user.firstname || user.username || 'there',
      templateId,
      params: { title, message: body, reference: order.reference, storefront: merchant.brandName || `@${merchant.slug}` },
    });
  } catch (err) {
    logger.warn('Storefront: trader email failed', { merchant: merchant.slug, event, error: err.message });
  }
}

module.exports = { notifyTrader, _message: message };
