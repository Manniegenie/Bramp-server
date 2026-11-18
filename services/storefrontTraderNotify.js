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

function message(event, order, merchant, extra = {}) {
  const coins = order ? `${order.deposit?.amount ?? ''} ${order.coin}`.trim() : '';
  const who = order ? maskPhone(order.waId) : '';
  switch (event) {
    case 'deposit_confirmed':
      return { title: 'Customer deposit received', body: `${who} sent ${coins} to your storefront.` };
    case 'paid': {
      const earned = order.settlement?.traderEarningNgn > 0 ? ` You earned ${naira(order.settlement.traderEarningNgn)}.` : '';
      const fee = order.settlement?.feeNgn > 0 ? ` Bramp fee ${naira(order.settlement.feeNgn)}.` : '';
      return {
        title: 'Customer paid',
        body: `${who} was paid ${naira(order.settlement?.customerNgn)} for ${coins} (${order.payoutAccount?.bankName} ${maskAcct(order.payoutAccount?.accountNumber)}).${earned}${fee}`,
      };
    }
    case 'awaiting_funds':
      return { title: 'Top up to pay your customer', body: `${who} sent ${coins}. Your NGN balance can't cover the payout of ${naira(extra.neededNgn)} (with the fee). Top up and we'll pay them automatically. Ref ${order.reference}.` };
    case 'low_balance':
      return { title: 'Storefront paused: low balance', body: `Your NGN balance is ${naira(extra.balanceNgn)}, so Stella has stopped quoting your Self rate. Top up to start trading again.` };
    case 'self_rate_approved':
      return { title: 'Self rate approved', body: `Your storefront can now use Self rate, with a monthly payout limit of ${naira(extra.payoutLimitNgn)}. Set your rates and fund your NGN balance to start.` };
    case 'self_rate_rejected':
      return { title: 'Self rate not approved', body: `Your Self rate application wasn't approved: ${extra.reason}. You can keep trading with Bramp rate.` };
    case 'needs_review':
      return { title: 'Storefront trade under review', body: `A payout to ${who} for ${coins} needs a check by Bramp. We'll update you. Ref ${order.reference}.` };
    case 'desk_status': { // Bramp changed the desk's status (bramp-admin)
      const title = { active: 'Your storefront is live again', paused: 'Bramp paused your storefront', closed: 'Bramp closed your storefront' }[extra.status] || 'Your storefront was updated';
      return { title, body: extra.reason ? `Reason: ${extra.reason}` : 'Open the Storefront tab in the Bramp app for details.' };
    }
    case 'admin_message': // a message from Bramp ops (bramp-admin)
      return { title: extra.title || 'A message from Bramp', body: extra.body || '' };
    default:
      return { title: `${merchant.brandName || 'Storefront'} update`, body: order ? `Trade ${order.reference}: ${event}.` : event };
  }
}

async function notifyTrader(merchant, event, order = null, extra = {}) {
  const { title, body } = message(event, order, merchant, extra);
  const data = { type: 'STOREFRONT_TRADE', event, reference: order?.reference || null };

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
      params: { title, message: body, reference: order?.reference || '', storefront: merchant.brandName || `@${merchant.slug}` },
    });
  } catch (err) {
    logger.warn('Storefront: trader email failed', { merchant: merchant.slug, event, error: err.message });
  }
}

module.exports = { notifyTrader, _message: message };
