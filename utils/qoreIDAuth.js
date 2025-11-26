require('dotenv').config();
const axios = require('axios');
const qs = require('qs');

// In-memory token cache
let tokenCache = {
  accessToken: null,
  expiresAt: null,
  tokenType: 'Bearer'
};

/**
 * Validate QoreID configuration at startup
 */
function validateQoreIdConfig() {
  if (!process.env.QOREID_CLIENT_ID || !process.env.QOREID_CLIENT_SECRET) {
    throw new Error('❌ QoreID configuration error: QOREID_CLIENT_ID and QOREID_CLIENT_SECRET must be set in .env');
  }
}

/**
 * Fetches a new QoreID token
 */
async function getQoreIdToken() {
  validateQoreIdConfig();

  try {
    const response = await axios.post(
      'https://api.qoreid.com/token',
      qs.stringify({
        clientId: process.env.QOREID_CLIENT_ID,
        secret: process.env.QOREID_CLIENT_SECRET
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    const { accessToken, expiresIn, tokenType } = response.data;

    // Calculate expiry (subtract 1 minute for safety)
    const expiresInMs = parseInt(expiresIn) * 1000;
    const expiresAt = Date.now() + expiresInMs - 60000;

    tokenCache = {
      accessToken,
      expiresAt,
      tokenType: tokenType || 'Bearer'
    };

    const expiryDate = new Date(expiresAt).toLocaleString();
    console.log(`✅ QoreID token obtained. Expires at: ${expiryDate}`);
    return { accessToken, expiresIn, tokenType };
  } catch (error) {
    console.error('❌ Failed to get QoreID token:', error.response?.data || error.message);
    throw new Error(`QoreID authentication failed: ${error.response?.data?.message || error.message}`);
  }
}

/**
 * Checks if the current token is valid
 */
function isTokenValid() {
  return tokenCache.accessToken && tokenCache.expiresAt && Date.now() < tokenCache.expiresAt;
}

/**
 * Returns a valid token, refreshing if necessary
 */
async function getValidToken() {
  if (isTokenValid()) return tokenCache.accessToken;

  console.log('🔄 Token expired or missing. Refreshing...');
  const tokenData = await getQoreIdToken();
  return tokenData.accessToken;
}

/**
 * Axios interceptor to attach QoreID auth headers
 */
async function attachQoreIdAuth(config) {
  try {
    const token = await getValidToken();
    config.headers = {
      ...config.headers,
      'Authorization': `${tokenCache.tokenType} ${token}`,
      'Content-Type': 'application/json'
    };
    return config;
  } catch (error) {
    console.error('❌ Failed to attach QoreID auth:', error.message);
    throw error;
  }
}

/**
 * Handles token expiration & retries failed requests
 */
async function handleAuthError(error) {
  const originalRequest = error.config;

  if (error.response?.status === 401 && !originalRequest._retry) {
    originalRequest._retry = true;

    try {
      console.log('🔄 Token expired. Refreshing and retrying...');
      tokenCache.accessToken = null;
      tokenCache.expiresAt = null;

      const newConfig = await attachQoreIdAuth(originalRequest);
      return axios(newConfig);
    } catch (refreshError) {
      console.error('❌ Token refresh failed:', refreshError.message);
      throw refreshError;
    }
  }

  throw error;
}

/**
 * Creates an Axios client with QoreID authentication
 */
function createQoreIdClient(baseURL = 'https://api.qoreid.com') {
  const client = axios.create({
    baseURL,
    timeout: 30000
  });

  client.interceptors.request.use(attachQoreIdAuth, (error) => Promise.reject(error));
  client.interceptors.response.use((response) => response, handleAuthError);

  return client;
}

/**
 * Manual token refresh
 */
async function refreshToken() {
  console.log('🔄 Manually refreshing QoreID token...');
  tokenCache.accessToken = null;
  tokenCache.expiresAt = null;
  return await getQoreIdToken();
}

/**
 * Clears the cached token
 */
function clearTokenCache() {
  tokenCache = { accessToken: null, expiresAt: null, tokenType: 'Bearer' };
  console.log('🗑️ QoreID token cache cleared');
}

/**
 * Debugging info about the current token
 */
function getTokenInfo() {
  return {
    hasToken: !!tokenCache.accessToken,
    expiresAt: tokenCache.expiresAt ? new Date(tokenCache.expiresAt) : null,
    isValid: isTokenValid(),
    tokenType: tokenCache.tokenType
  };
}

module.exports = {
  validateQoreIdConfig,
  getQoreIdToken,
  isTokenValid,
  getValidToken,
  attachQoreIdAuth,
  handleAuthError,
  createQoreIdClient,
  refreshToken,
  clearTokenCache,
  getTokenInfo
};
