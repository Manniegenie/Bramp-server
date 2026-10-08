const axios = require('axios');
const logger = require('../utils/logger');

const DOJAH_CONFIG = {
  secretKey: process.env.DOJAH_SECRET_KEY,
  appId: process.env.DOJAH_APP_ID,
  baseUrl: process.env.DOJAH_API_URL || 'https://api.dojah.io'
};

function dojahHeaders(extra = {}) {
  return {
    Authorization: DOJAH_CONFIG.secretKey,
    AppId: DOJAH_CONFIG.appId,
    ...extra
  };
}

/**
 * Look up a NIN record and match a selfie against the photo on file for it,
 * in one call.
 * POST /api/v1/kyc/nin/verify
 * @param {Object} params
 * @param {string} params.nin - 11-digit National Identity Number
 * @param {string} params.selfieImage - base64 image, with or without a data: URI prefix
 * @param {number} [params.threshold] - minimum selfie-match score (50-100), Dojah defaults to 90
 */
async function verifyNIN({ nin, selfieImage, threshold }) {
  try {
    const selfie_image = selfieImage.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');

    const response = await axios.post(
      `${DOJAH_CONFIG.baseUrl}/api/v1/kyc/nin/verify`,
      { nin, selfie_image, ...(threshold ? { threshold } : {}) },
      {
        headers: dojahHeaders({ 'Content-Type': 'application/json' }),
        timeout: 30000
      }
    );

    return { success: true, entity: response.data?.entity || null };
  } catch (error) {
    logger.error('Dojah NIN verify error', {
      message: error.message,
      status: error.response?.status,
      errorData: JSON.stringify(error.response?.data || {})
    });

    return {
      success: false,
      status: error.response?.status || 500,
      error: error.response?.data || error.message
    };
  }
}

/**
 * Look up a BVN record and match a selfie against the photo on file for it,
 * in one call.
 * POST /api/v1/kyc/bvn/verify
 * @param {Object} params
 * @param {string} params.bvn - 11-digit Bank Verification Number
 * @param {string} params.selfieImage - base64 image, with or without a data: URI prefix
 * @param {number} [params.threshold] - minimum selfie-match score (50-100), Dojah defaults to 90
 */
async function verifyBVN({ bvn, selfieImage, threshold }) {
  try {
    const selfie_image = selfieImage.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');

    const response = await axios.post(
      `${DOJAH_CONFIG.baseUrl}/api/v1/kyc/bvn/verify`,
      { bvn, selfie_image, ...(threshold ? { threshold } : {}) },
      {
        headers: dojahHeaders({ 'Content-Type': 'application/json' }),
        timeout: 30000
      }
    );

    return { success: true, entity: response.data?.entity || null };
  } catch (error) {
    logger.error('Dojah BVN verify error', {
      message: error.message,
      status: error.response?.status,
      errorData: JSON.stringify(error.response?.data || {})
    });

    return {
      success: false,
      status: error.response?.status || 500,
      error: error.response?.data || error.message
    };
  }
}

/**
 * Check whether a selfie is of a real, live person.
 * POST /api/v1/ml/liveness
 * @param {string} imageInput - base64 image, with or without a data: URI prefix
 */
async function checkLiveness(imageInput) {
  try {
    const image = imageInput.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');

    const response = await axios.post(
      `${DOJAH_CONFIG.baseUrl}/api/v1/ml/liveness`,
      { image },
      {
        headers: dojahHeaders({ 'Content-Type': 'application/json' }),
        timeout: 30000
      }
    );

    return { success: true, entity: response.data?.entity || null };
  } catch (error) {
    logger.error('Dojah liveness check error', {
      message: error.message,
      status: error.response?.status,
      errorData: JSON.stringify(error.response?.data || {})
    });

    return {
      success: false,
      status: error.response?.status || 500,
      error: error.response?.data || error.message
    };
  }
}

module.exports = {
  verifyNIN,
  verifyBVN,
  checkLiveness
};
