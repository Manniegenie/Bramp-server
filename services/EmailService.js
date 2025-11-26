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

  return sendEmail({
    to,
    name,
    templateId: parseInt(process.env.BREVO_TEMPLATE_OTP),
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
  sendFinancialAnalysisCompleteEmail
};