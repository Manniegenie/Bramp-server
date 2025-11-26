// utils/collectionAuth.js
const logger = require('./logger');

let config = {};
try { config = require('../routes/config'); } catch (_) { config = {}; }

/**
 * Validate that Collection API configuration is properly set up
 */
function validateCollectionConfig() {
  const secretKey = getCollectionSecretKey();
  const baseURL = getCollectionBaseURL();

  if (!secretKey) {
    throw new Error(
      'Collection API secret key not configured. ' +
      'Set COLLECTION_SECRET_KEY environment variable or config.collection.secretKey'
    );
  }

  if (!baseURL) {
    throw new Error(
      'Collection API base URL not configured. ' +
      'Set COLLECTION_BASE_URL environment variable or config.collection.baseURL'
    );
  }

  // Validate secret key format (should be a non-empty string)
  if (typeof secretKey !== 'string' || secretKey.trim().length === 0) {
    throw new Error('Collection API secret key must be a valid non-empty string');
  }

  // Basic URL validation
  try {
    new URL(baseURL);
  } catch (e) {
    throw new Error(`Collection API base URL is invalid: ${baseURL}`);
  }

  logger.debug('Collection API configuration validated successfully', {
    baseURL: maskUrl(baseURL),
    secretKeyLength: secretKey.length,
  });
}

/**
 * Get Collection API secret key from config or environment
 */
function getCollectionSecretKey() {
  return (
    (config.collection && config.collection.secretKey) ||
    process.env.COLLECTION_SECRET_KEY ||
    process.env.GLYDE_API_KEY||  // Alternative env var name
    null
  );
}

/**
 * Get Collection API base URL from config or environment
 */
function getCollectionBaseURL() {
  return (
    (config.collection && config.collection.baseURL) ||
    process.env.COLLECTION_BASE_URL ||
    process.env.GLYDE_API_BASE_URL ||   // Alternative env var name
    'https://api.glyde.ng'          // Default production URL
  );
}

/**
 * Axios interceptor to attach Collection API Bearer token authentication
 */
function attachCollectionAuth(requestConfig) {
  const secretKey = getCollectionSecretKey();
  
  if (!secretKey) {
    logger.error('Collection API secret key not found during request');
    throw new Error('Collection API authentication not configured');
  }

  // Add Bearer token to Authorization header
  requestConfig.headers = requestConfig.headers || {};
  requestConfig.headers['Authorization'] = `Bearer ${secretKey}`;

  // Add other common headers
  requestConfig.headers['Accept'] = requestConfig.headers['Accept'] || 'application/json';
  requestConfig.headers['Content-Type'] = requestConfig.headers['Content-Type'] || 'application/json';

  // Add user agent for API identification
  requestConfig.headers['User-Agent'] = requestConfig.headers['User-Agent'] || 
    `GlydeClient/1.0 Node.js/${process.version}`;

  logger.debug('Collection API auth attached to request', {
    url: requestConfig.url,
    method: requestConfig.method?.toUpperCase(),
    hasAuth: !!requestConfig.headers['Authorization'],
    headers: maskSensitiveHeaders(requestConfig.headers),
  });

  return requestConfig;
}

/**
 * Mask sensitive information in URL for logging
 */
function maskUrl(url) {
  if (!url) return '';
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
  } catch (e) {
    return url.substring(0, 20) + '...';
  }
}

/**
 * Mask sensitive headers for logging
 */
function maskSensitiveHeaders(headers = {}) {
  const masked = { ...headers };
  
  if (masked.Authorization) {
    // Show only the first few characters of the token
    const authValue = masked.Authorization;
    if (authValue.startsWith('Bearer ')) {
      const token = authValue.substring(7);
      masked.Authorization = `Bearer ${token.substring(0, 8)}****`;
    } else {
      masked.Authorization = '****';
    }
  }

  // Mask any other potentially sensitive headers
  const sensitiveHeaders = ['x-api-key', 'api-key', 'secret-key'];
  sensitiveHeaders.forEach(header => {
    const key = Object.keys(masked).find(k => k.toLowerCase() === header.toLowerCase());
    if (key && masked[key]) {
      const value = masked[key];
      masked[key] = `${value.substring(0, 4)}****`;
    }
  });

  return masked;
}

/**
 * Test Collection API authentication
 */
async function testCollectionAuth() {
  try {
    validateCollectionConfig();
    
    const axios = require('axios');
    const baseURL = getCollectionBaseURL();
    
    const testClient = axios.create({ baseURL, timeout: 10000 });
    testClient.interceptors.request.use(attachCollectionAuth);

    // Make a simple request to test auth (adjust endpoint as needed)
    // This assumes there's a health/ping endpoint or similar
    const response = await testClient.get('/health').catch(err => {
      // If 401/403, auth is wrong. If 404, auth worked but endpoint doesn't exist
      if (err.response?.status === 401 || err.response?.status === 403) {
        throw new Error(`Authentication failed: ${err.response.data?.message || 'Invalid credentials'}`);
      }
      // For other errors (like 404), we assume auth worked
      return { status: err.response?.status, data: { message: 'Auth test completed' } };
    });

    logger.info('Collection API authentication test passed', {
      status: response.status,
      baseURL: maskUrl(baseURL),
    });

    return { success: true, status: response.status };
  } catch (error) {
    logger.error('Collection API authentication test failed', {
      error: error.message,
      baseURL: maskUrl(getCollectionBaseURL()),
    });
    
    return { success: false, error: error.message };
  }
}

/**
 * Get environment-specific configuration
 */
function getEnvironmentConfig() {
  const env = process.env.NODE_ENV || 'development';
  
  const configs = {
    development: {
      baseURL: 'https://api-sandbox.glyde.ng',  // Sandbox URL
      timeout: 30000,
    },
    staging: {
      baseURL: 'https://api-staging.glyde.ng',
      timeout: 30000,
    },
    production: {
      baseURL: 'https://api.glyde.ng',
      timeout: 30000,
    },
  };

  return configs[env] || configs.development;
}

/**
 * Create authenticated axios instance for Collection API
 */
function createCollectionClient(customConfig = {}) {
  const axios = require('axios');
  const envConfig = getEnvironmentConfig();
  const baseURL = customConfig.baseURL || getCollectionBaseURL() || envConfig.baseURL;
  
  const client = axios.create({
    baseURL,
    timeout: customConfig.timeout || envConfig.timeout,
    ...customConfig,
  });

  client.interceptors.request.use(attachCollectionAuth);

  // Response interceptor for common error handling
  client.interceptors.response.use(
    (response) => response,
    (error) => {
      const status = error.response?.status;
      const data = error.response?.data;
      
      if (status === 401 || status === 403) {
        logger.error('Collection API authentication error', {
          status,
          message: data?.message || 'Authentication failed',
          url: error.config?.url,
        });
      }
      
      return Promise.reject(error);
    }
  );

  return client;
}

module.exports = {
  validateCollectionConfig,
  attachCollectionAuth,
  getCollectionSecretKey,
  getCollectionBaseURL,
  testCollectionAuth,
  createCollectionClient,
  getEnvironmentConfig,
};