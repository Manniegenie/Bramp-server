require('dotenv').config();
const AfricasTalking = require('africastalking');

// Initialize the SDK lazily. Constructing it with undefined credentials
// throws a validation error at module load, which crashes the whole server
// on boot when AT creds aren't configured. Only build the client when creds
// are present; sendVerificationCode() already guards the missing-creds case.
let sms = null;
if (process.env.AT_API_KEY && process.env.AT_USERNAME) {
  const africastalking = AfricasTalking({
    apiKey: process.env.AT_API_KEY,
    username: process.env.AT_USERNAME, // e.g., 'Bramp' or 'sandbox'
  });
  sms = africastalking.SMS;
}

/**
 * Send verification code via SMS
 * @param {string} phoneNumber - e.g. '2348141751569' (no plus sign)
 * @param {string} code - e.g. '123456'
 */
async function sendVerificationCode(phoneNumber, code) {
  if (!process.env.AT_API_KEY || !process.env.AT_USERNAME) {
    console.error('⚠️ Africa’s Talking API credentials missing in .env');
    return { success: false, error: 'Missing API credentials' };
  }

  const recipient = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
  const senderId = process.env.AT_SENDER_ID || 'sandbox';
  const message = `Your Bramp verification code is: ${code}`;

  // Log final values
  console.log('📨 Prepared SMS:');
  console.log('To:', [recipient]);
  console.log('From:', senderId);
  console.log('Message:', message);

  try {
    const response = await sms.send({
      to: [recipient],
      message,
      from: senderId,
    });

    console.log('✅ SMS sent:', response);
    return { success: true, response };
  } catch (error) {
    console.error('❌ Failed to send SMS:', error.message || error);
    return { success: false, error };
  }
}

module.exports = { sendVerificationCode };
