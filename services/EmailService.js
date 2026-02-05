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

async function sendFinancialAnalysisCompleteEmail(to, name, jobId, bankStatementProcessed, cryptoStatementProcessed) {
  const params = {
    username: String(name || 'User'),
    jobId: String(jobId || 'N/A'),
    bankStatementStatus: String(bankStatementProcessed ? 'Processed' : 'Pending'),
    cryptoStatementStatus: String(cryptoStatementProcessed ? 'Processed' : 'Pending'),
    completionDate: String(new Date().toLocaleDateString()),
    completionTime: String(new Date().toLocaleTimeString()),
    reportUrl: String(`${process.env.CLIENT_URL || 'https://www.chatbramp.com'}/financial-analysis/report/${jobId}`)
  };

  console.log('Financial Analysis Complete email params:', params);

  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_FINANCIAL_ANALYSIS || process.env.BREVO_TEMPLATE_DEPOSIT), // Fallback to deposit template if financial analysis template not set
    params
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

module.exports = {
  sendDepositEmail,
  sendWithdrawalEmail,
  sendUtilityEmail,
  sendGiftcardEmail,
  sendKycEmail,
  sendLoginEmail,
  sendSignupEmail,
  sendOtpEmail,
  sendChatbotSellEmail,
  sendChatbotDepositEmail,
  sendFinancialAnalysisCompleteEmail,
  sendAdminWelcomeEmail,
  sendNINVerificationEmail,
  SendGiftcardMail
};