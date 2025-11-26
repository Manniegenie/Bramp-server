// services/collectionService.js
// Collection API service with integrated authentication
// Supports Glyde Collection API for payment initialization
const axios = require('axios');
const crypto = require('crypto');
const ChatbotTransaction = require('../models/ChatbotTransaction');
const logger = require('../utils/logger');

const { validateCollectionConfig, attachCollectionAuth } = require('../utils/collectionAuth');

// Enhanced baseURL construction with validation for Glyde API
function constructBaseURL() {
  let baseURL = '';
  
  // Use only GLYDE_API_BASE_URL environment variable
  if (!process.env.GLYDE_API_BASE_URL) {
    logger.error('GLYDE_API_BASE_URL environment variable is required');
    throw new Error('GLYDE_API_BASE_URL environment variable not configured');
  }
  
  baseURL = String(process.env.GLYDE_API_BASE_URL).trim().replace(/\/+$/, '');
  
  // Ensure URL starts with http/https
  if (!baseURL.startsWith('http://') && !baseURL.startsWith('https://')) {
    logger.error('GLYDE_API_BASE_URL must start with http:// or https://', { baseURL });
    throw new Error('Invalid GLYDE_API_BASE_URL format - must start with http:// or https://');
  }
  
  // Validate URL syntax
  try {
    new URL(baseURL);
  } catch (err) {
    logger.error('Invalid GLYDE_API_BASE_URL format', { baseURL, error: err.message });
    throw new Error(`Invalid GLYDE_API_BASE_URL: ${err.message}`);
  }
  
  logger.info('Glyde API baseURL configured', { baseURL });
  return baseURL;
}

let collectionClient;

// Initialize client with error handling
function initializeCollectionClient() {
  try {
    const baseURL = constructBaseURL();
    collectionClient = axios.create({ 
      baseURL, 
      timeout: 30000,
      headers: {
        'User-Agent': 'Collection-Service/1.0',
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    });
    collectionClient.interceptors.request.use(attachCollectionAuth);
    return collectionClient;
  } catch (err) {
    logger.error('Failed to initialize Glyde collection client', { error: err.message });
    throw err;
  }
}

// Lazy initialization
function getCollectionClient() {
  if (!collectionClient) {
    return initializeCollectionClient();
  }
  return collectionClient;
}

// ---------- helpers ----------
function uuid() {
  return (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString('hex');
}

function maskEmail(email) {
  if (!email) return '';
  const parts = String(email).split('@');
  if (parts.length !== 2) return email;
  const [local, domain] = parts;
  const maskedLocal = local.length <= 2 ? local : `${local.slice(0, 2)}****`;
  return `${maskedLocal}@${domain}`;
}

function maskPhone(phone) {
  if (!phone) return '';
  const s = String(phone).replace(/\s+/g, '');
  return s.length <= 4 ? s : `${s.slice(0, 2)}****${s.slice(-2)}`;
}

function cleanStr(v) { return (v ?? '').toString().trim(); }

function sanitizeCustomer(c = {}) {
  return {
    name: cleanStr(c.name || c.customer_name),
    email: cleanStr(c.email || c.customer_email),
    phone: c.phone || c.customer_phone ? cleanStr(c.phone || c.customer_phone) : null,
  };
}

function sanitizeChannels(channels = []) {
  const validChannels = ['card_payment', 'bank_transfer'];
  return Array.isArray(channels) 
    ? channels.filter(ch => validChannels.includes(cleanStr(ch)))
    : [];
}

/**
 * For Collection /v1/collection/initialise:
 *   - currency MUST be a valid ISO currency code
 *   - amount MUST be >= 100
 *   - reference MUST be 8-255 characters
 */
function sanitizeCollectionPayload(body = {}) {
  const customer = sanitizeCustomer(body.customer || body);
  const channels = sanitizeChannels(body.channels || ['card_payment']);
  const amount = Number(body.amount);
  const currency = cleanStr(body.currency || 'NGN').toUpperCase();
  const reference = cleanStr(body.reference) || `COL-${Date.now()}-${uuid().slice(0, 8)}`;
  const defaultChannel = body.default_channel && ['card_payment', 'bank_transfer'].includes(body.default_channel) 
    ? body.default_channel 
    : null;
  const meta = body.meta && typeof body.meta === 'object' ? body.meta : null;

  return {
    currency,
    reference,
    amount,
    customer_name: customer.name,
    customer_email: customer.email,
    customer_phone: customer.phone,
    channels,
    default_channel: defaultChannel,
    meta,
  };
}

function validateCollectionPayload(clean) {
  const errs = [];
  
  if (!clean.currency) errs.push('currency is required');
  if (!clean.reference) errs.push('reference is required');
  else if (clean.reference.length < 8 || clean.reference.length > 255) {
    errs.push('reference must be between 8 and 255 characters');
  }
  if (!clean.amount || isNaN(clean.amount) || clean.amount < 100) {
    errs.push('amount must be at least 100');
  }
  if (!clean.customer_name) errs.push('customer_name is required');
  else if (clean.customer_name.length > 255) {
    errs.push('customer_name must not exceed 255 characters');
  }
  if (!clean.customer_email) errs.push('customer_email is required');
  else if (clean.customer_email.length > 255) {
    errs.push('customer_email must not exceed 255 characters');
  }
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.customer_email)) {
    errs.push('customer_email must be a valid email address');
  }
  if (clean.customer_phone && clean.customer_phone.length > 255) {
    errs.push('customer_phone must not exceed 255 characters');
  }
  if (!clean.channels || !Array.isArray(clean.channels) || clean.channels.length === 0) {
    errs.push('at least one payment channel is required');
  }
  
  return errs;
}

function pickRequestId(headers = {}) {
  return (
    headers['x-request-id'] ||
    headers['x-correlation-id'] ||
    headers['cf-ray'] ||
    headers['traceparent'] ||
    null
  );
}

// ---------- main service ----------
/**
 * Initialize a collection request via the Glyde Collection API.
 *
 * Pass:
 *   amount     => amount to collect (must be >= 100)
 *   currency   => ISO currency code (e.g., "NGN")
 *   customer   => { name, email, phone? }
 *   channels   => array of payment channels
 */
async function initializeCollection(payload, opts = {}) {
  // Validate configuration before proceeding
  try {
    validateCollectionConfig();
  } catch (configErr) {
    logger.error('Glyde collection configuration validation failed', { error: configErr.message });
    return { 
      success: false, 
      statusCode: 500, 
      message: 'Glyde collection service configuration error' 
    };
  }

  // Get client with URL validation
  let client;
  try {
    client = getCollectionClient();
  } catch (clientErr) {
    logger.error('Failed to get Glyde collection client', { error: clientErr.message });
    return { 
      success: false, 
      statusCode: 500, 
      message: 'Glyde collection service unavailable - configuration error' 
    };
  }

  const clean = sanitizeCollectionPayload(payload);
  const errors = validateCollectionPayload(clean);
  if (errors.length) {
    return { success: false, statusCode: 400, message: errors.join('; ') };
  }

  const idempotencyKey =
    opts.idempotencyKey ||
    `collection-${clean.currency}:${opts.userId || 'anon'}:${clean.reference}:${clean.amount}:${Date.now()}:${uuid()}`;

  const { chatbotPaymentId, userId } = opts;

  // Pre-write: REQUESTED
  if (chatbotPaymentId) {
    try {
      await ChatbotTransaction.findOneAndUpdate(
        { paymentId: chatbotPaymentId, ...(userId ? { userId } : {}) },
        {
          $set: {
            collectionStatus: 'REQUESTED',
            collectionSuccess: false,
            collectionRequestedAt: new Date(),
            collectionCurrency: clean.currency,
            collectionAmount: Number(clean.amount),
            collectionReference: clean.reference,
            collectionDetails: {
              customerName: clean.customer_name,
              customerEmail: clean.customer_email,
              customerPhone: clean.customer_phone,
              channels: clean.channels,
              defaultChannel: clean.default_channel,
              meta: clean.meta,
              capturedAt: new Date(),
            },
            'collectionResult.provider': 'GLYDE_API',
            'collectionResult.idempotencyKey': idempotencyKey,
          },
        },
        { new: true }
      );
    } catch (e) {
      logger.warn('Failed to pre-mark ChatbotTransaction collection REQUESTED', {
        e: e.message, paymentId: chatbotPaymentId, userId,
      });
    }
  }

  const payloadPreview = {
    currency: clean.currency,
    reference: clean.reference,
    amount: clean.amount,
    customer_name: clean.customer_name,
    customer_email: maskEmail(clean.customer_email),
    customer_phone: maskPhone(clean.customer_phone),
    channels: clean.channels,
    default_channel: clean.default_channel,
    meta: clean.meta,
    idempotencyKey,
  };

  try {
    logger.info('Initiating collection via Glyde API', payloadPreview);

    // Use fixed endpoint path for Glyde API
    const endpoint = '/v1/collection/initialise';

    const res = await client.post(endpoint, clean, {
      headers: {
        'Idempotency-Key': idempotencyKey,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      maxBodyLength: Infinity,
    });

    const d = res?.data?.data || res?.data || {};
    const out = {
      id: d.id || d.collectionId || null,
      reference: d.reference || clean.reference,
      status: d.status || 'PENDING',
      paymentUrl: d.payment_url || d.paymentUrl || null,
      message: d.message || 'Collection initialized successfully',
      raw: d,
    };

    logger.info('Glyde API initialization success', {
      collectionId: out.id,
      reference: out.reference,
      status: out.status,
      requestId: pickRequestId(res?.headers || {}),
    });

    if (chatbotPaymentId) {
      try {
        await ChatbotTransaction.findOneAndUpdate(
          { paymentId: chatbotPaymentId, ...(userId ? { userId } : {}) },
          {
            $set: {
              collectionStatus: 'SUCCESS',
              collectionSuccess: true,
              collectionCompletedAt: new Date(),
              'collectionResult.collectionId': out.id,
              'collectionResult.collectionReference': out.reference,
              'collectionResult.collectionStatus': out.status,
              'collectionResult.paymentUrl': out.paymentUrl,
            },
          },
          { new: true }
        );
      } catch (e) {
        logger.warn('Failed to mark ChatbotTransaction collection SUCCESS', {
          e: e.message, paymentId: chatbotPaymentId, userId,
        });
      }
    }

    return { success: true, data: out, idempotencyKey };
  } catch (err) {
    // Enhanced error handling with URL-specific checks
    const httpStatus = err.response?.status || 500;
    const httpStatusText = err.response?.statusText || null;
    const providerHeaders = err.response?.headers || {};
    const providerBody = err.response?.data; // RAW
    const requestId = pickRequestId(providerHeaders);
    const providerCode = Object.prototype.hasOwnProperty.call(providerBody || {}, 'code')
      ? providerBody.code
      : null;
    const providerMessage = Object.prototype.hasOwnProperty.call(providerBody || {}, 'message')
      ? providerBody.message
      : null;

    // Special handling for URL errors
    let errorMessage = providerMessage || err.message || 'Glyde collection service temporarily unavailable';
    if (err.code === 'ERR_INVALID_URL') {
      errorMessage = 'Glyde collection service configuration error - invalid URL';
      logger.error('Glyde API URL configuration error', {
        baseURL: client?.defaults?.baseURL,
        error: err.message
      });
    }

    logger.error('Glyde API initialization failed', {
      axiosErrorCode: err.code || null,
      httpStatus,
      httpStatusText,
      payloadPreview,
      providerBody,     // RAW body as-is
      providerCode,     // RAW code if present
      providerHeaders,
      requestId,
      baseURL: client?.defaults?.baseURL,
    });

    if (chatbotPaymentId) {
      try {
        await ChatbotTransaction.findOneAndUpdate(
          { paymentId: chatbotPaymentId, ...(userId ? { userId } : {}) },
          {
            $set: {
              collectionStatus: 'FAILED',
              collectionSuccess: false,
              collectionCompletedAt: new Date(),
              'collectionResult.httpStatus': httpStatus,
              'collectionResult.collectionStatus': 'FAILED',
              'collectionResult.errorCode': providerCode || err.code,
              'collectionResult.errorMessage': errorMessage,
              'collectionResult.providerRaw': providerBody || null,
              'collectionResult.requestId': requestId || null,
            },
          }
        );
      } catch (e) {
        logger.warn('Failed to mark ChatbotTransaction collection FAILED', {
          e: e.message, paymentId: chatbotPaymentId, userId,
        });
      }
    }

    return {
      success: false,
      statusCode: httpStatus,
      message: errorMessage,
      providerCode: providerCode || err.code,
      providerRaw: providerBody,
      requestId,
    };
  }
}

// ---------- additional helper functions ----------
/**
 * Generate a unique collection reference
 */
function generateCollectionReference(prefix = 'COL') {
  const timestamp = Date.now();
  const randomPart = uuid().slice(0, 8).toUpperCase();
  return `${prefix}-${timestamp}-${randomPart}`;
}

/**
 * Validate customer information separately
 */
function validateCustomer(customer = {}) {
  const errs = [];
  if (!customer.name || !cleanStr(customer.name)) errs.push('Customer name is required');
  if (!customer.email || !cleanStr(customer.email)) errs.push('Customer email is required');
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
    errs.push('Customer email must be valid');
  }
  return errs;
}

/**
 * Build collection payload with sensible defaults
 */
function buildCollectionPayload(options = {}) {
  const {
    amount,
    currency = 'NGN',
    customer,
    channels = ['card_payment'],
    defaultChannel,
    reference,
    meta
  } = options;

  return {
    amount: Number(amount),
    currency: currency.toUpperCase(),
    reference: reference || generateCollectionReference(),
    customer_name: customer?.name,
    customer_email: customer?.email,
    customer_phone: customer?.phone || null,
    channels: Array.isArray(channels) ? channels : [channels],
    default_channel: defaultChannel || null,
    meta: meta || null,
  };
}

module.exports = {
  initializeCollection,
  generateCollectionReference,
  validateCustomer,
  buildCollectionPayload,
  getCollectionClient,
};