// utils/SmileIDauth.js
const crypto = require('crypto');

const SANDBOX_URL = 'https://testapi.smileidentity.com/v1';
const PRODUCTION_URL = 'https://api.smileidentity.com/v1';

class SmileIDAuth {
  constructor(options = {}) {
    this.partnerId   = options.partnerId   || process.env.SMILEID_PARTNER_ID   || '';
    this.apiKey      = options.apiKey      || process.env.SMILEID_API_KEY       || '';
    this.callbackUrl = options.callbackUrl || process.env.SMILEID_CALLBACK_URL  || '';
    this.isProduction = options.isProduction !== undefined
      ? options.isProduction
      : process.env.SMILEID_ENV === 'production';

    this.apiURL = this.isProduction ? PRODUCTION_URL : SANDBOX_URL;
  }

  getConfig() {
    return {
      partnerId:   this.partnerId,
      apiURL:      this.apiURL,
      callbackUrl: this.callbackUrl,
      isProduction: this.isProduction,
      environment: this.isProduction ? 'production' : 'sandbox',
    };
  }

  /**
   * Generate HMAC-SHA256 signature required by SmileID API.
   * signature = base64( HMAC-SHA256( api_key, timestamp + partner_id + "sid_request" ) )
   */
  generateAuthData() {
    const timestamp = new Date().toISOString();
    const hmac = crypto.createHmac('sha256', this.apiKey);
    hmac.update(`${timestamp}${this.partnerId}sid_request`);
    const signature = hmac.digest('base64');

    return {
      partner_id: this.partnerId,
      signature,
      timestamp,
    };
  }

  generateAuthHeaders() {
    const { signature, timestamp } = this.generateAuthData();
    return {
      'Content-Type': 'application/json',
      'X-Partner-ID': this.partnerId,
      'X-Signature':  signature,
      'X-Timestamp':  timestamp,
    };
  }

  getEndpoints() {
    return {
      basicKycAsync:  `${this.apiURL}/id_verification`,
      basicKycSync:   `${this.apiURL}/id_verification_sync`,
      getJobStatus:   `${this.apiURL}/job_status`,
    };
  }
}

module.exports = SmileIDAuth;
