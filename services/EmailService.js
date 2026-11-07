// services/emailService.js
const brevo = require('@getbrevo/brevo');
require('dotenv').config();

// Use your original authentication method (which was working)
const apiInstance = new brevo.TransactionalEmailsApi();
apiInstance.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, process.env.BREVO_API_KEY);

/**
 * Generic function to send transactional emails via Brevo
 */
async function sendEmail({ to, name, templateId, params = {}, options = {} }) {
  try {
    // Validate template ID
    if (!templateId || isNaN(templateId) || templateId <= 0) {
      throw new Error(`Invalid template ID: ${templateId}. Please check your BREVO_TEMPLATE_* environment variables.`);
    }

    const email = new brevo.SendSmtpEmail();

    // Set recipient
    email.to = [{ email: to, name }];

    // Set template ID
    email.templateId = templateId;

    // Set parameters - ensure they're clean strings
    email.params = params;

    // Optional configurations
    if (options.replyTo) email.replyTo = options.replyTo;
    if (options.headers) email.headers = options.headers;

    // Debug logging
    console.log('Sending email with params:', {
      to,
      templateId,
      params: email.params
    });

    const response = await apiInstance.sendTransacEmail(email);

    // Clean logging - just log the message ID
    const messageId = response.body?.messageId || response.messageId || 'No message ID';
    console.log(`Email sent successfully to ${to}: ${messageId}`);

    return { success: true, messageId, response: messageId };
  } catch (error) {
    console.error(`Error sending email to ${to}:`, {
      message: error.message,
      response: error.response?.body || error.response?.data,
      templateId,
      params
    });
    throw error;
  }
}

// === Email Types ===
async function sendLoginEmail(to, name, device, location, time) {
  const params = {
    username: String(name || 'User'),
    device: String(device || 'Unknown Device'),
    location: String(location || 'Unknown Location'),
    time: String(time || new Date().toLocaleString())
  };

  console.log('Login email params:', params);

  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_LOGIN),
    params
  });
}

async function sendDepositEmail(to, name, amount, currency, reference) {
  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_DEPOSIT),
    params: {
      username: String(name || 'User'),
      amount: String(amount),
      currency: String(currency),
      reference: String(reference)
    }
  });
}

async function sendWithdrawalEmail(to, name, amount, currency, reference) {
  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_WITHDRAWAL),
    params: {
      username: String(name || 'User'),
      amount: String(amount),
      currency: String(currency),
      reference: String(reference)
    }
  });
}

async function sendUtilityEmail(to, name, utilityType, amount, reference) {
  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_UTILITY),
    params: {
      username: String(name || 'User'),
      utilityType: String(utilityType),
      amount: String(amount),
      reference: String(reference)
    }
  });
}

async function sendGiftcardEmail(to, name, giftcardType, amount, reference) {
  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_GIFTCARD),
    params: {
      username: String(name || 'User'),
      giftcardType: String(giftcardType),
      amount: String(amount),
      reference: String(reference)
    }
  });
}

async function sendKycEmail(to, name, status, comments) {
  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_KYC),
    params: {
      username: String(name || 'User'),
      status: String(status),
      comments: String(comments || '')
    }
  });
}

async function sendSignupEmail(to, name) {
  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_SIGNUP),
    params: {
      username: String(name || 'User')
    }
  });
}

async function sendOtpEmail(to, name, otpCode, expirationMinutes = 10) {
  const params = {
    username: String(name || 'User'),
    otpCode: String(otpCode),
    expirationMinutes: String(expirationMinutes)
  };

  console.log('OTP email params:', params);

  // Get template ID with fallback to SIGNUP template if OTP template not configured
  const otpTemplateId = parseInt(process.env.BREVO_TEMPLATE_OTP);
  const fallbackTemplateId = parseInt(process.env.BREVO_TEMPLATE_SIGNUP);
  const templateId = (!isNaN(otpTemplateId) && otpTemplateId > 0) 
    ? otpTemplateId 
    : (!isNaN(fallbackTemplateId) && fallbackTemplateId > 0) 
      ? fallbackTemplateId 
      : null;

  if (!templateId) {
    throw new Error('BREVO_TEMPLATE_OTP or BREVO_TEMPLATE_SIGNUP environment variable must be set with a valid template ID');
  }

  return sendEmail({
    to,
    name,
    templateId,
    params
  });
}

// ChatbotSell Email Function
async function sendChatbotSellEmail(to, name, sellAmount, token, receiveAmount, receiveCurrency, paymentId, bankName, accountNumber, status = 'initiated') {
  // Convert NGNX to NGNB for user-facing display
  const displayCurrency = String(receiveCurrency || 'NGNX').toUpperCase() === 'NGNX' ? 'NGNB' : String(receiveCurrency || 'NGNX');

  const params = {
    username: String(name || 'User'),
    sellAmount: String(sellAmount),
    token: String(token),
    receiveAmount: String(receiveAmount),
    receiveCurrency: displayCurrency, // Show NGNB to user
    paymentId: String(paymentId),
    bankName: String(bankName || ''),
    accountNumber: String(accountNumber || ''),
    status: String(status),
    transactionDate: String(new Date().toLocaleDateString()),
    transactionTime: String(new Date().toLocaleTimeString())
  };

  console.log('Chatbot Sell email params:', params);

  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_CHATBOT_SELL),
    params
  });
}

// NEW: ChatbotDeposit Email Function
async function sendChatbotDepositEmail(to, name, depositAmount, token, creditAmount, creditCurrency, paymentId, transactionHash, status = 'confirmed') {
  const params = {
    username: String(name || 'User'),
    depositAmount: String(depositAmount),
    token: String(token),
    creditAmount: String(creditAmount),
    creditCurrency: String(creditCurrency || 'NGNX'),
    paymentId: String(paymentId),
    transactionHash: String(transactionHash || ''),
    status: String(status),
    transactionDate: String(new Date().toLocaleDateString()),
    transactionTime: String(new Date().toLocaleTimeString())
  };

  console.log('Chatbot Deposit email params:', params);

  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_CHATBOT_DEPOSIT),
    params
  });
}

async function sendChatbotWithdrawalEmail(to, name, amount, currency, reference, status = 'completed') {
  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_CHATBOT_WITHDRAWAL),
    params: {
      username: String(name || 'User'),
      amount: String(amount),
      currency: String(currency),
      reference: String(reference),
      status: String(status),
      transactionDate: String(new Date().toLocaleDateString()),
      transactionTime: String(new Date().toLocaleTimeString())
    }
  });
}

/**
 * Send giftcard response email (approved or rejected)
 */
async function SendGiftcardMail(to, name, options = {}) {
  try {
    const {
      status,
      submissionId,
      giftcardType,
      cardFormat,
      country,
      cardValue,
      paymentAmount,
      paymentCurrency = 'NGN',
      rejectionReason,
      reviewNotes,
      approvedValue,
      paymentRate,
      transactionId,
      reviewedAt
    } = options;

    let templateId;
    if (status === 'APPROVED' || status === 'PAID') {
      templateId = parseInt(process.env.BREVO_TEMPLATE_GIFTCARD_APPROVED);
      if (!templateId || isNaN(templateId)) throw new Error('Giftcard approved email template ID not configured');
    } else if (status === 'REJECTED') {
      templateId = parseInt(process.env.BREVO_TEMPLATE_GIFTCARD_REJECTED);
      if (!templateId || isNaN(templateId)) throw new Error('Giftcard rejected email template ID not configured');
    } else {
      throw new Error(`Invalid status for giftcard email: ${status}`);
    }

    const rejectionReasons = {
      'INVALID_IMAGE': 'The uploaded image(s) were invalid or unclear',
      'ALREADY_USED': 'This gift card has already been used',
      'INSUFFICIENT_BALANCE': 'The gift card has insufficient balance',
      'FAKE_CARD': 'The gift card appears to be fake or counterfeit',
      'UNREADABLE': 'The gift card code is unreadable',
      'WRONG_TYPE': 'The gift card type does not match what was submitted',
      'EXPIRED': 'The gift card has expired',
      'INVALID_ECODE': 'The e-code provided is invalid',
      'DUPLICATE_ECODE': 'This e-code has already been submitted',
      'OTHER': 'Other reason'
    };

    const params = {
      username: String(name || 'User'),
      submissionId: String(submissionId || ''),
      giftcardType: String(giftcardType || ''),
      cardFormat: String(cardFormat || ''),
      country: String(country || ''),
      cardValue: String(cardValue || '0'),
      status: String(status || ''),
      date: new Date(reviewedAt || Date.now()).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      companyName: 'Bramp',
      supportEmail: 'support@chatbramp.com',
      approvedValue: String(approvedValue || cardValue || '0'),
      paymentAmount: String(paymentAmount || '0'),
      paymentCurrency: String(paymentCurrency || 'NGN'),
      paymentRate: String(paymentRate || '0'),
      transactionId: String(transactionId || ''),
      rejectionReason: String(rejectionReasons[rejectionReason] || rejectionReasons['OTHER']),
      additionalNotes: String(reviewNotes || '')
    };

    return await sendEmail({ to, name, templateId, params });
  } catch (error) {
    console.error('Failed to send giftcard response email:', error.message);
    throw error;
  }
}

/**
 * Send admin welcome email with 2FA setup instructions
 */
async function sendAdminWelcomeEmail(to, adminName, role) {
  try {
    const templateId = parseInt(process.env.BREVO_TEMPLATE_ADMIN_WELCOME);
    if (!templateId || isNaN(templateId) || templateId <= 0) {
      throw new Error('Admin welcome email template ID not configured');
    }

    const ADMIN_BASE_URL = process.env.ADMIN_BASE_URL || 'https://www.chatbramp.com';
    const setup2FAUrl = `${ADMIN_BASE_URL}/admin-2fa-setup?email=${encodeURIComponent(to)}`;

    const roleDescriptions = {
      super_admin: 'Super Administrator - Full system access',
      admin: 'Administrator - Manage wallets, fees, and notifications',
      moderator: 'Moderator - View transactions and manage user accounts'
    };

    return await sendEmail({
      to,
      name: adminName,
      templateId,
      params: {
        adminName: String(adminName || 'Admin'),
        email: String(to),
        role: String(role || 'admin'),
        roleDescription: String(roleDescriptions[role] || roleDescriptions.admin),
        setup2FAUrl: String(setup2FAUrl),
        loginUrl: String(`${ADMIN_BASE_URL}/login`),
        companyName: 'Bramp',
        supportEmail: 'support@chatbramp.com',
        registrationDate: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      }
    });
  } catch (error) {
    console.error('Failed to send admin welcome email:', error.message);
    throw error;
  }
}

/**
 * Send NIN verification email
 */
async function sendNINVerificationEmail(to, name, options = {}) {
  try {
    const templateId = parseInt(process.env.BREVO_TEMPLATE_NIN_VERIFICATION || process.env.BREVO_TEMPLATE_KYC);
    if (!templateId || isNaN(templateId) || templateId <= 0) {
      throw new Error('NIN verification email template ID not configured');
    }

    return await sendEmail({
      to,
      name,
      templateId,
      params: {
        name: String(name || 'User'),
        status: String(options.status || 'verified'),
        ninNumber: String(options.ninNumber || ''),
        verificationDate: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
      }
    });
  } catch (error) {
    console.error('Failed to send NIN verification email:', error.message);
    throw error;
  }
}

// --- Additional functions ported from ZeusODX ---

const COMPANY_NAME = process.env.COMPANY_NAME || 'Bramp';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@chatbramp.com';
const SENDER_EMAIL = process.env.SENDER_EMAIL || 'noreply@chatbramp.com';
const SENDER_NAME = process.env.SENDER_NAME || COMPANY_NAME;
const APP_WEB_BASE_URL = (process.env.APP_WEB_BASE_URL || process.env.FRONTEND_BASE_URL || '').replace(/\/$/, '');
const APP_DEEP_LINK = (process.env.APP_DEEP_LINK || 'bramp://').replace(/\/$/, '');

function safeParseTemplateId(val) {
  const n = parseInt(val);
  return (!isNaN(n) && n > 0) ? n : null;
}

function formatDate(date) {
  return new Date(date).toLocaleString('en-US', {
    year: 'numeric', month: 'long', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}

function getKycAdminEmails() {
  const raw = process.env.KYC_ADMIN_EMAILS || '';
  return raw.split(',').map(e => e.trim()).filter(Boolean).map(entry => {
    const [email, name] = entry.split(':').map(s => s.trim());
    return { email, name: name || email };
  });
}

function getGiftcardAdminEmails() {
  const raw = process.env.GIFTCARD_ADMIN_EMAILS || '';
  return raw.split(',').map(e => e.trim()).filter(Boolean).map(entry => {
    const [email, name] = entry.split(':').map(s => s.trim());
    return { email, name: name || email };
  });
}

/**
 * Send email verification OTP
 */
async function sendEmailVerificationOTP(to, name, otp, expiryMinutes = 10, extras = {}) {
  try {
    const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_EMAIL_VERIFICATION);
    if (!templateId) throw new Error('Email verification template ID not configured (BREVO_TEMPLATE_EMAIL_VERIFICATION)');

    const qs = `email=${encodeURIComponent(to)}`;
    const verifyUrl = extras.verifyUrl || `${APP_WEB_BASE_URL}/kyc/verify-email?${qs}`;
    const appDeepLink = extras.appDeepLink || `${APP_DEEP_LINK}/kyc/verify-email?${qs}`;
    const expiryTime = new Date(Date.now() + expiryMinutes * 60 * 1000);

    const params = {
      username: String(name || 'User'),
      otp: String(otp),
      expiryMinutes: String(expiryMinutes),
      expiryTime: formatDate(expiryTime),
      verifyUrl: String(verifyUrl),
      appDeepLink: String(appDeepLink),
      ctaText: String(extras.ctaText || 'Verify email'),
      companyName: String(extras.companyName || COMPANY_NAME),
      supportEmail: String(extras.supportEmail || SUPPORT_EMAIL)
    };

    return await sendEmail({ to, name, templateId, params });
  } catch (error) {
    console.error('Failed to send email verification OTP:', error.message);
    throw error;
  }
}

/**
 * Send KYC provisional email to user
 */
async function sendKycProvisionalEmail(to, name, idType, provisionalReason) {
  try {
    const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_KYC_PROVISIONAL || process.env.BREVO_TEMPLATE_KYC);
    if (!templateId) throw new Error('KYC provisional email template ID not configured');

    return await sendEmail({
      to, name, templateId,
      params: {
        username: String(name || 'User'),
        idType: String(idType || 'document'),
        provisionalReason: String(provisionalReason || 'Your verification is currently under review.'),
        date: formatDate(new Date()),
        kycUrl: String(`${APP_WEB_BASE_URL}/kyc`),
        appDeepLink: String(`${APP_DEEP_LINK}/kyc`),
        companyName: String(COMPANY_NAME),
        supportEmail: String(SUPPORT_EMAIL)
      }
    });
  } catch (error) {
    console.error('Failed to send KYC provisional email:', error.message);
    throw error;
  }
}

/**
 * Notify KYC admins of a provisional/manual-review submission
 */
async function sendKycProvisionalAdminNotify({ username, userId, idType, provisionalReason, kycId }) {
  const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_KYC_PROVISIONAL_ADMIN);
  if (!templateId) throw new Error('KYC provisional admin notify template ID not configured');

  const adminEmails = getKycAdminEmails();
  if (!adminEmails.length) {
    console.warn('No KYC admin emails configured (KYC_ADMIN_EMAILS)');
    return { success: false };
  }

  const params = {
    username: String(username || 'Unknown User'),
    userId: String(userId || ''),
    idType: String(idType || 'document'),
    provisionalReason: String(provisionalReason || 'No reason provided'),
    kycId: String(kycId || ''),
    reviewUrl: String(kycId ? `${APP_WEB_BASE_URL}/admin/kyc/${kycId}` : `${APP_WEB_BASE_URL}/admin/kyc`),
    date: formatDate(new Date()),
    companyName: String(COMPANY_NAME)
  };

  const results = await Promise.allSettled(
    adminEmails.map(admin => sendEmail({ to: admin.email, name: admin.name, templateId, params }))
  );

  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length) failed.forEach(r => console.error('KYC provisional admin notify failed:', r.reason?.message));
  return { success: failed.length < adminEmails.length };
}

/**
 * Notify giftcard admins of a Tawk visitor message
 */
async function sendTawkMessageNotify({ visitorName, visitorEmail, message, chatId, event }) {
  const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_TAWK_MESSAGE);

  const adminEmails = getGiftcardAdminEmails();
  if (!adminEmails.length) {
    console.warn('No giftcard admin emails configured (GIFTCARD_ADMIN_EMAILS)');
    return { success: false };
  }

  const params = {
    visitorName: String(visitorName || 'Unknown Visitor'),
    visitorEmail: String(visitorEmail || '—'),
    message: String(message || ''),
    chatId: String(chatId || ''),
    event: String(event || 'chat:message'),
    date: formatDate(new Date()),
    companyName: String(COMPANY_NAME)
  };

  const results = await Promise.allSettled(
    adminEmails.map(admin => {
      if (templateId) {
        return sendEmail({ to: admin.email, name: admin.name, templateId, params });
      }
      // Fallback: plain-text email via Brevo when no template is configured
      const email = new brevo.SendSmtpEmail();
      email.to = [{ email: admin.email, name: admin.name }];
      email.sender = { email: SENDER_EMAIL, name: SENDER_NAME };
      email.subject = `💬 Tawk Message from ${params.visitorName}`;
      email.htmlContent = `
        <p><strong>Visitor:</strong> ${params.visitorName} (${params.visitorEmail})</p>
        <p><strong>Message:</strong> ${params.message}</p>
        <p><strong>Chat ID:</strong> ${params.chatId}</p>
        <p><strong>Event:</strong> ${params.event}</p>
        <p><strong>Time:</strong> ${params.date}</p>
      `;
      return apiInstance.sendTransacEmail(email);
    })
  );

  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length) failed.forEach(r => console.error('Tawk message notify failed:', r.reason?.message));
  return { success: failed.length < adminEmails.length };
}

// === Glyde deposit outcome emails (ported from ZeusODX) ===

function formatNaira(amount) {
  return `₦${Number(amount || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function sendDepositNameMismatchEmail(to, name, amount, currency, reference, payerName) {
  const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_DEPOSIT_NAME_MISMATCH);
  if (!templateId) throw new Error('Deposit name-mismatch email template ID not configured');
  return sendEmail({
    to, name, templateId,
    params: {
      username: String(name || 'User'),
      amountWithCurrency: formatNaira(amount),
      reference: String(reference || ''),
      date: formatDate(new Date()),
      payerName: String(payerName || 'the sender'),
    }
  });
}

async function sendDepositLimitExceededEmail(to, name, amount, currency, reference, limit) {
  const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_DEPOSIT_LIMIT_EXCEEDED);
  if (!templateId) throw new Error('Deposit limit-exceeded email template ID not configured');
  return sendEmail({
    to, name, templateId,
    params: {
      username: String(name || 'User'),
      amountWithCurrency: formatNaira(amount),
      limitWithCurrency: formatNaira(limit),
      reference: String(reference || ''),
      date: formatDate(new Date()),
    }
  });
}

async function sendDepositFeeShortfallEmail(to, name, grossAmount, feeAmount, currency, reference) {
  const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_DEPOSIT_FEE_SHORTFALL);
  if (!templateId) throw new Error('Deposit fee-shortfall email template ID not configured');
  return sendEmail({
    to, name, templateId,
    params: {
      username: String(name || 'User'),
      amountWithCurrency: formatNaira(grossAmount),
      feeWithCurrency: formatNaira(feeAmount),
      reference: String(reference || ''),
      date: formatDate(new Date()),
    }
  });
}

async function sendDepositRejectedEmail(to, name, amount, currency, reference) {
  const templateId = safeParseTemplateId(process.env.BREVO_TEMPLATE_DEPOSIT_REJECTED);
  if (!templateId) throw new Error('Deposit rejected email template ID not configured');
  return sendEmail({
    to, name, templateId,
    params: {
      username: String(name || 'User'),
      amountWithCurrency: formatNaira(amount),
      reference: String(reference || ''),
      date: formatDate(new Date()),
    }
  });
}

/**
 * Notify giftcard admins that a Glyde naira (NGNB) deposit was credited.
 * Never throws - logs failures.
 */
async function sendGlydeDepositAdminNotify({ username, userId, grossAmount, feeAmount, creditedAmount, reference, glydeReference, accountNumber, payerName, transactionId }) {
  const adminEmails = getGiftcardAdminEmails();
  if (!adminEmails.length) {
    console.warn('No recipients for Glyde deposit notify (GIFTCARD_ADMIN_EMAILS)');
    return { success: false };
  }
  const reviewUrl = APP_WEB_BASE_URL ? `${APP_WEB_BASE_URL}/admin/deposits` : '';
  const results = await Promise.allSettled(
    adminEmails.map(admin => {
      const email = new brevo.SendSmtpEmail();
      email.to = [{ email: admin.email, name: admin.name }];
      email.sender = { email: SENDER_EMAIL, name: SENDER_NAME };
      email.subject = `New Glyde naira deposit: ${formatNaira(creditedAmount)} — ${username || userId}`;
      email.htmlContent = `
        <div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
          <h2 style="margin:0 0 12px">New Glyde Naira Deposit</h2>
          <table cellpadding="6" style="border-collapse:collapse">
            <tr><td><b>User</b></td><td>${username || ''} (${userId || ''})</td></tr>
            <tr><td><b>Credited</b></td><td>${formatNaira(creditedAmount)} NGNB</td></tr>
            <tr><td><b>Gross</b></td><td>${formatNaira(grossAmount)}</td></tr>
            <tr><td><b>Fee</b></td><td>${formatNaira(feeAmount)}</td></tr>
            <tr><td><b>Payer name</b></td><td>${payerName || 'N/A'}</td></tr>
            <tr><td><b>Virtual account</b></td><td>${accountNumber || 'N/A'}</td></tr>
            <tr><td><b>Reference</b></td><td>${reference || ''}</td></tr>
            <tr><td><b>Glyde ref</b></td><td>${glydeReference || ''}</td></tr>
            <tr><td><b>Txn ID</b></td><td>${transactionId || ''}</td></tr>
            <tr><td><b>Time</b></td><td>${formatDate(new Date())}</td></tr>
          </table>
          ${reviewUrl ? `<p style="margin-top:14px"><a href="${reviewUrl}">View in admin</a></p>` : ''}
          <p style="color:#666;font-size:12px;margin-top:14px">${COMPANY_NAME} — automated alert</p>
        </div>`;
      return apiInstance.sendTransacEmail(email);
    })
  );
  const failed = results.filter(r => r.status === 'rejected');
  failed.forEach(r => console.error('Glyde deposit admin notify failed:', r.reason?.message));
  return { success: failed.length < adminEmails.length };
}

module.exports = {
  sendDepositEmail,
  sendDepositNameMismatchEmail,
  sendDepositLimitExceededEmail,
  sendDepositFeeShortfallEmail,
  sendDepositRejectedEmail,
  sendGlydeDepositAdminNotify,
  sendWithdrawalEmail,
  sendUtilityEmail,
  sendGiftcardEmail,
  sendKycEmail,
  sendKycProvisionalEmail,
  sendKycProvisionalAdminNotify,
  sendLoginEmail,
  sendSignupEmail,
  sendOtpEmail,
  sendEmailVerificationOTP,
  sendChatbotSellEmail,
  sendChatbotDepositEmail,
  sendChatbotWithdrawalEmail,
  sendAdminWelcomeEmail,
  sendNINVerificationEmail,
  sendTawkMessageNotify,
  SendGiftcardMail
};