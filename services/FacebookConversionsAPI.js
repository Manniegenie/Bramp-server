// services/FacebookConversionsAPI.js
// Facebook Conversions API service for server-side event tracking

const axios = require('axios');
const crypto = require('crypto');
const logger = require('../utils/logger');

class FacebookConversionsAPI {
  constructor() {
    this.accessToken = process.env.FACEBOOK_ACCESS_TOKEN;
    this.pixelId = process.env.FACEBOOK_PIXEL_ID;
    this.apiVersion = 'v18.0';
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
    
    if (!this.accessToken || !this.pixelId) {
      logger.warn('Facebook Conversions API not configured - missing access token or pixel ID');
    }
  }

  /**
   * Hash email for privacy
   */
  hashEmail(email) {
    if (!email) return null;
    return crypto.createHash('sha256').update(email.toLowerCase().trim()).digest('hex');
  }

  /**
   * Hash phone number for privacy
   */
  hashPhone(phone) {
    if (!phone) return null;
    // Remove all non-digit characters and add country code if missing
    const cleanPhone = phone.replace(/\D/g, '');
    const phoneWithCountryCode = cleanPhone.startsWith('234') ? cleanPhone : `234${cleanPhone}`;
    return crypto.createHash('sha256').update(phoneWithCountryCode).digest('hex');
  }

  /**
   * Send CompleteRegistration event
   */
  async trackCompleteRegistration(userData, eventData = {}) {
    if (!this.accessToken || !this.pixelId) {
      logger.warn('Facebook Conversions API not configured, skipping event tracking');
      return { success: false, error: 'Not configured' };
    }

    try {
      const eventTime = Math.floor(Date.now() / 1000);
      const eventId = crypto.randomUUID();

      const payload = {
        data: [
          {
            event_name: 'CompleteRegistration',
            event_time: eventTime,
            action_source: 'website',
            user_data: {
              em: userData.email ? [this.hashEmail(userData.email)] : [],
              ph: userData.phone ? [this.hashPhone(userData.phone)] : [null],
              client_ip_address: eventData.clientIp || '127.0.0.1',
              client_user_agent: eventData.userAgent || 'Mozilla/5.0 (compatible; BrampBot/1.0)'
            },
            attribution_data: {
              attribution_share: "0.3"
            },
            custom_data: {
              currency: 'USD',
              value: '1.00'
            },
            original_event_data: {
              event_name: 'CompleteRegistration',
              event_time: eventTime
            }
          }
        ]
      };

      // Add test event code if configured
      if (process.env.FACEBOOK_TEST_EVENT_CODE) {
        payload.test_event_code = process.env.FACEBOOK_TEST_EVENT_CODE;
      }

      const url = `${this.baseUrl}/${this.pixelId}/events`;
      const params = {
        access_token: this.accessToken
      };

      logger.info('Sending Facebook CompleteRegistration event', {
        pixelId: this.pixelId,
        eventId,
        hasEmail: !!userData.email,
        hasPhone: !!userData.phone
      });

      const response = await axios.post(url, payload, {
        params,
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      logger.info('Facebook Conversions API response', {
        status: response.status,
        data: response.data
      });

      return {
        success: true,
        eventId,
        response: response.data
      };

    } catch (error) {
      logger.error('Facebook Conversions API error', {
        error: error.message,
        response: error.response?.data,
        status: error.response?.status
      });

      return {
        success: false,
        error: error.message,
        details: error.response?.data
      };
    }
  }

  /**
   * Send Purchase event (for future use)
   */
  async trackPurchase(userData, purchaseData) {
    if (!this.accessToken || !this.pixelId) {
      logger.warn('Facebook Conversions API not configured, skipping purchase tracking');
      return { success: false, error: 'Not configured' };
    }

    try {
      const eventTime = Math.floor(Date.now() / 1000);
      const eventId = crypto.randomUUID();

      const payload = {
        data: [
          {
            event_name: 'Purchase',
            event_time: eventTime,
            action_source: 'website',
            user_data: {
              em: userData.email ? [this.hashEmail(userData.email)] : [],
              ph: userData.phone ? [this.hashPhone(userData.phone)] : [null],
              client_ip_address: purchaseData.clientIp || '127.0.0.1',
              client_user_agent: purchaseData.userAgent || 'Mozilla/5.0 (compatible; BrampBot/1.0)'
            },
            attribution_data: {
              attribution_share: "0.3"
            },
            custom_data: {
              currency: purchaseData.currency || 'USD',
              value: purchaseData.value?.toString() || '0.00'
            },
            original_event_data: {
              event_name: 'Purchase',
              event_time: eventTime
            }
          }
        ]
      };

      // Add test event code if configured
      if (process.env.FACEBOOK_TEST_EVENT_CODE) {
        payload.test_event_code = process.env.FACEBOOK_TEST_EVENT_CODE;
      }

      const url = `${this.baseUrl}/${this.pixelId}/events`;
      const params = {
        access_token: this.accessToken
      };

      const response = await axios.post(url, payload, {
        params,
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });

      return {
        success: true,
        eventId,
        response: response.data
      };

    } catch (error) {
      logger.error('Facebook Conversions API purchase error', {
        error: error.message,
        response: error.response?.data
      });

      return {
        success: false,
        error: error.message,
        details: error.response?.data
      };
    }
  }
}

module.exports = new FacebookConversionsAPI();
