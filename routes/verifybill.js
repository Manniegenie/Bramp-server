const express = require('express');
const { payBetaAuth } = require('../auth/paybetaAuth');
const logger = require('../utils/logger');

const router = express.Router();

// Electricity and betting providers are fetched dynamically from PayBeta (see
// routes/electricity.js and routes/betting.js /providers) rather than hardcoded here —
// only cable TV has a fixed, verified-accurate provider set. Category is inferred from
// shape (electricity always carries a prepaid/postpaid variation_id; cable_tv is one of
// the 4 known slugs; anything else is treated as betting, the dynamic catch-all).
const CABLE_TV_SERVICES = ['dstv', 'gotv', 'startimes', 'showmax'];
const VALID_METER_TYPES = ['prepaid', 'postpaid'];

/**
 * Validate customer verification request
 */
function validateVerificationRequest(body) {
  const errors = [];

  if (!body.customer_id) {
    errors.push('Customer ID is required');
  } else if (typeof body.customer_id !== 'string' || body.customer_id.trim().length === 0) {
    errors.push('Customer ID must be a non-empty string');
  }

  if (!body.service_id || typeof body.service_id !== 'string' || !body.service_id.trim()) {
    errors.push('Service ID is required');
  }

  if (body.variation_id && !VALID_METER_TYPES.includes(body.variation_id)) {
    errors.push('Variation ID must be "prepaid" or "postpaid" when provided');
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Determine service category
 */
function getServiceCategory(service_id, variation_id) {
  if (variation_id && VALID_METER_TYPES.includes(variation_id)) return 'electricity';
  if (CABLE_TV_SERVICES.includes(String(service_id).toLowerCase())) return 'cable_tv';
  return 'betting';
}

/**
 * Call PayBeta for customer verification, branching by category — each PayBeta
 * validate endpoint has a different payload/response shape.
 */
async function callPayBetaVerificationAPI({ customer_id, service_id, variation_id, serviceCategory, requestId, userId }) {
  try {
    let response;
    let normalized;

    if (serviceCategory === 'electricity') {
      response = await payBetaAuth.makeRequest('POST', '/v2/electricity/validate', {
        service: service_id.toLowerCase(),
        meterNumber: customer_id.trim(),
        meterType: variation_id.toLowerCase()
      }, { timeout: 15000 });

      if (response.status !== 'successful') throw new Error(response.message || 'Customer verification failed');
      const d = response.data || {};
      normalized = {
        customer_name: d.customerName,
        customer_address: d.customerAddress,
        min_purchase_amount: d.minimuVendAmount || d.minimumAmount || 0,
        max_purchase_amount: 100000,
        customer_arrears: 0,
        outstanding: 0
      };
    } else if (serviceCategory === 'cable_tv') {
      response = await payBetaAuth.makeRequest('POST', '/v2/cable/validate', {
        service: service_id.toLowerCase(),
        smartCardNumber: customer_id.trim()
      }, { timeout: 15000 });

      if (response.status !== 'successful') throw new Error(response.message || 'Customer verification failed');
      const d = response.data || {};
      normalized = {
        customer_name: d.customerName,
        status: d.status,
        current_bouquet: d.currentBouquet,
        renewal_amount: d.renewalAmount || 0,
        due_date: d.dueDate,
        balance: d.balance || 0
      };
    } else {
      response = await payBetaAuth.makeRequest('POST', '/v2/gaming/validate', {
        service: service_id.toLowerCase(),
        customerId: customer_id.trim()
      }, { timeout: 15000 });

      if (response.status !== 'successful') throw new Error(response.message || 'Customer verification failed');
      const d = response.data || {};
      normalized = {
        customer_name: d.customerName,
        customer_username: d.customerName,
        minimum_amount: d.minimumAmount || 100,
        maximum_amount: 100000
      };
    }

    return { code: 'success', data: normalized };
  } catch (error) {
    logger.error(`❌ [${requestId}] PayBeta customer verification failed:`, {
      requestId, userId, service_id, serviceCategory, error: error.message
    });
    throw new Error(`Customer Verification API error: ${error.message}`);
  }
}

/**
 * Main customer verification endpoint - Updated to match other utilities' patterns
 */
router.post('/customer', async (req, res) => {
  const startTime = Date.now();
  const requestId = `verify_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    // Step 1: Log incoming request
    logger.info(`🔍 Customer verification request from user:`, {
      requestId,
      userId: req.user?.id,
      userAgent: req.get('User-Agent'),
      ip: req.ip || req.connection.remoteAddress,
      timestamp: new Date().toISOString()
    });

    const requestBody = req.body;
    
    // Step 2: Check authentication
    if (!req.user) {
      logger.error(`❌ [${requestId}] No user object found in request`);
      return res.status(401).json({
        success: false,
        error: 'UNAUTHORIZED',
        message: 'Authentication required',
        requestId
      });
    }

    const userId = req.user.id;
    
    // Step 3: Validate request
    const validation = validateVerificationRequest(requestBody);
    
    if (!validation.isValid) {
      logger.warn(`❌ [${requestId}] Request validation failed`, {
        requestId,
        userId,
        errors: validation.errors
      });
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validation.errors,
        requestId
      });
    }
    
    const { customer_id, service_id, variation_id } = requestBody;
    const serviceCategory = getServiceCategory(service_id, variation_id);

    logger.info(`📊 [${requestId}] Service details determined`, {
      requestId,
      userId,
      customer_id: customer_id?.substring(0, 4) + '***',
      service_id,
      serviceCategory,
      variation_id: variation_id || 'not_provided'
    });

    // Step 4: Call PayBeta using the consistent pattern
    let payBetaResponse;
    try {
      payBetaResponse = await callPayBetaVerificationAPI({
        customer_id,
        service_id,
        variation_id,
        serviceCategory,
        requestId,
        userId
      });
    } catch (apiError) {
      logger.error(`PayBeta verification API call failed:`, {
        requestId,
        userId,
        customer_id: customer_id?.substring(0, 4) + '***',
        service_id,
        error: apiError.message,
        processingTime: Date.now() - startTime
      });
      
      // Map API errors to appropriate responses - consistent with other utilities
      let statusCode = 500;
      let errorCode = 'VERIFICATION_API_ERROR';
      let errorMessage = apiError.message;
      
      if (apiError.message.includes('timeout')) {
        statusCode = 504;
        errorCode = 'VERIFICATION_TIMEOUT';
        errorMessage = 'Customer verification request timed out. Please try again.';
      } else if (apiError.message.includes('Customer Verification API error')) {
        statusCode = 400;
        errorCode = 'CUSTOMER_NOT_FOUND';
        errorMessage = 'Customer not found or invalid customer details';
      } else if (apiError.message.includes('Authentication failed')) {
        statusCode = 503;
        errorCode = 'SERVICE_UNAVAILABLE';
        errorMessage = 'Customer verification service is temporarily unavailable';
      }
      
      return res.status(statusCode).json({
        success: false,
        error: errorCode,
        message: errorMessage,
        details: {
          customer_id,
          service_id,
          service_category: serviceCategory,
          variation_id: variation_id || null,
          requestId
        }
      });
    }
    
    // Step 5: Process successful verification response
    const customerData = payBetaResponse.data;
    
    // Enhance response with service category and additional info
    const enhancedResponse = {
      success: true,
      message: 'Customer verification successful',
      service_category: serviceCategory,
      data: {
        ...customerData,
        service_category: serviceCategory,
        verified_at: new Date().toISOString(),
        requestId
      }
    };
    
    // Add category-specific enhancements
    if (serviceCategory === 'electricity') {
      enhancedResponse.data.purchase_info = {
        min_amount: customerData.min_purchase_amount || 1000,
        max_amount: customerData.max_purchase_amount || 100000,
        meter_type: variation_id,
        has_arrears: (customerData.customer_arrears || 0) > 0,
        outstanding_amount: customerData.outstanding || 0
      };
      logger.info(`⚡ [${requestId}] Added electricity-specific data`);
    } else if (serviceCategory === 'cable_tv') {
      enhancedResponse.data.subscription_info = {
        current_status: customerData.status || 'Unknown',
        current_bouquet: customerData.current_bouquet || 'N/A',
        renewal_amount: customerData.renewal_amount || 0,
        due_date: customerData.due_date || null,
        balance: customerData.balance || 0
      };
      logger.info(`📺 [${requestId}] Added cable TV-specific data`);
    } else if (serviceCategory === 'betting') {
      enhancedResponse.data.account_info = {
        username: customerData.customer_username || 'N/A',
        email: customerData.customer_email_address || 'N/A',
        phone: customerData.customer_phone_number || 'N/A',
        min_amount: customerData.minimum_amount || 100,
        max_amount: customerData.maximum_amount || 100000
      };
      logger.info(`🎲 [${requestId}] Added betting-specific data`);
    }
    
    const totalDuration = Date.now() - startTime;
    
    logger.info(`✅ [${requestId}] Customer verification completed successfully`, {
      requestId,
      userId,
      customer_id: customer_id?.substring(0, 4) + '***',
      serviceCategory,
      totalDuration: `${totalDuration}ms`,
      hasCustomerData: !!customerData
    });
    
    return res.status(200).json(enhancedResponse);
    
  } catch (error) {
    const totalDuration = Date.now() - startTime;
    
    logger.error(`💀 [${requestId}] Customer verification unexpected error`, {
      requestId,
      userId: req.user?.id,
      errorMessage: error.message,
      errorName: error.name,
      stack: error.stack,
      totalDuration: `${totalDuration}ms`,
      requestBody: req.body
    });
    
    return res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred during customer verification',
      requestId
    });
  }
});

module.exports = router;