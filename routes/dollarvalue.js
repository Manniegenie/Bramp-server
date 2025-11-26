const express = require('express');
const router = express.Router();

const logger = require('../utils/logger');

// Import portfolio service for cached prices (FIXED!)
const { getPricesWithCache, SUPPORTED_TOKENS } = require('../services/portfolio');

// Import NGNB rate models
const NairaMarkdown = require('../models/offramp'); // For offramp (buy NGNB)
const NairaMarkup = require('../models/onramp');     // For onramp (sell NGNB)

// FIXED: Now uses your existing portfolio service for cached prices
// This aligns with how your swap endpoint works and avoids external API calls

// Supported tokens mapping - use the same tokens from portfolio service
const SUPPORTED_TOKENS_LIST = Object.keys(SUPPORTED_TOKENS);

/**
 * Validates token value request
 * @param {Object} body - Request body
 * @returns {Object} Validation result
 */
function validateTokenValueRequest(body) {
  const { token, amount } = body;
  const errors = [];

  // Helper function to safely convert to string and trim
  const safeStringTrim = (value) => {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  };

  const tokenStr = safeStringTrim(token);

  // Required fields validation
  if (!tokenStr) {
    errors.push('Token symbol is required');
  }
  if (amount === null || amount === undefined) {
    errors.push('Token amount is required');
  }

  // Amount validation
  const numericAmount = Number(amount);
  if (isNaN(numericAmount) || numericAmount < 0) {
    errors.push('Invalid amount. Amount must be a non-negative number.');
  }

  // Token validation
  const upperToken = tokenStr.toUpperCase();
  if (tokenStr && !SUPPORTED_TOKENS[upperToken]) {
    errors.push(`Unsupported token. Supported tokens: ${SUPPORTED_TOKENS_LIST.join(', ')}`);
  }

  if (errors.length > 0) {
    return {
      success: false,
      errors,
      message: errors.join('; ')
    };
  }

  return {
    success: true,
    validatedData: {
      token: upperToken,
      amount: numericAmount
    }
  };
}

/**
 * Gets USD price for a token using the portfolio service (FIXED!)
 * @param {string} token - Token symbol
 * @returns {Promise<Object>} Price data with metadata
 */
async function getTokenUSDPrice(token) {
  try {
    // Use the portfolio service to get cached price
    const prices = await getPricesWithCache([token]);
    const price = prices[token];
    
    if (!price || price <= 0) {
      throw new Error(`No valid price found for token: ${token}`);
    }

    return {
      price: parseFloat(price),
      lastUpdated: new Date(),
      source: 'portfolio_cache'
    };
  } catch (error) {
    logger.error('Failed to get token price from portfolio service', {
      token,
      error: error.message
    });
    
    throw new Error(`Failed to fetch price for ${token}: ${error.message}`);
  }
}

/**
 * Format USD value based on amount
 * @param {number} value - USD value to format
 * @returns {number} Formatted value
 */
function formatUSDValue(value) {
  if (value === 0) return 0;
  
  // For very small values, use more decimal places
  if (value < 0.01) {
    return parseFloat(value.toFixed(8));
  }
  // For normal values, use 2 decimal places
  else if (value < 1000) {
    return parseFloat(value.toFixed(4));
  }
  // For larger values, use 2 decimal places
  else {
    return parseFloat(value.toFixed(2));
  }
}

/**
 * Calculate dollar value endpoint
 * POST /value
 */
router.post('/value', async (req, res) => {
  const startTime = Date.now();

  try {
    // Validate request parameters
    const validation = validateTokenValueRequest(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: validation.message,
        errors: validation.errors
      });
    }

    const { token, amount } = validation.validatedData;

    logger.info('Calculating token dollar value', {
      token,
      amount,
      userId: req.user?.id
    });

    // Handle zero amount case
    if (amount === 0) {
      return res.json({
        success: true,
        message: 'Token value calculated successfully',
        data: {
          token,
          amount: 0,
          pricePerToken: 0,
          totalValueUSD: 0,
          priceSource: 'n/a',
          calculatedAt: new Date(),
          processingTime: `${Date.now() - startTime}ms`
        }
      });
    }

    // Get USD price for the token
    const priceData = await getTokenUSDPrice(token);
    
    // Calculate total value
    const totalValueUSD = amount * priceData.price;
    const formattedTotalUSD = formatUSDValue(totalValueUSD);

    const processingTime = Date.now() - startTime;

    logger.info('Token value calculated successfully', {
      token,
      amount,
      pricePerToken: priceData.price,
      totalValueUSD: formattedTotalUSD,
      processingTime,
      userId: req.user?.id
    });

    res.json({
      success: true,
      message: 'Token value calculated successfully',
      data: {
        token,
        amount,
        pricePerToken: parseFloat(priceData.price.toFixed(8)),
        totalValueUSD: formattedTotalUSD,
        priceSource: priceData.source,
        calculatedAt: new Date(),
        processingTime: `${processingTime}ms`
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;

    logger.error('Token value calculation failed', {
      token: req.body?.token,
      amount: req.body?.amount,
      error: error.message,
      processingTime,
      userId: req.user?.id
    });

    // Handle specific error types
    if (error.message.includes('No valid price found')) {
      return res.status(404).json({
        success: false,
        message: 'Price not available for this token. Please try again later.',
        error: 'PRICE_NOT_AVAILABLE'
      });
    }

    if (error.message.includes('Failed to fetch price')) {
      return res.status(503).json({
        success: false,
        message: 'Price service temporarily unavailable. Please try again later.',
        error: 'PRICE_SERVICE_ERROR'
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to calculate token value. Please try again.',
      error: 'CALCULATION_ERROR'
    });
  }
});

/**
 * Get supported tokens endpoint
 * GET /supported-tokens
 */
router.get('/supported-tokens', (req, res) => {
  try {
    const tokens = SUPPORTED_TOKENS_LIST.sort();
    
    res.json({
      success: true,
      message: 'Supported tokens retrieved successfully',
      data: {
        tokens,
        totalCount: tokens.length,
        lastUpdated: new Date(),
        source: 'portfolio_service'
      }
    });
  } catch (error) {
    logger.error('Failed to get supported tokens', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      success: false,
      message: 'Failed to retrieve supported tokens'
    });
  }
});

/**
 * Batch token value calculation endpoint
 * POST /batch-value
 */
router.post('/batch-value', async (req, res) => {
  const startTime = Date.now();

  try {
    const { tokens } = req.body;

    if (!Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Tokens array is required and must not be empty'
      });
    }

    if (tokens.length > 10) {
      return res.status(400).json({
        success: false,
        message: 'Maximum 10 tokens allowed per batch request'
      });
    }

    const results = [];
    const errors = [];

    // Process each token
    for (const tokenData of tokens) {
      try {
        const validation = validateTokenValueRequest(tokenData);
        if (!validation.success) {
          errors.push({
            token: tokenData.token,
            error: validation.message
          });
          continue;
        }

        const { token, amount } = validation.validatedData;
        
        if (amount === 0) {
          results.push({
            token,
            amount: 0,
            pricePerToken: 0,
            totalValueUSD: 0,
            priceSource: 'n/a'
          });
          continue;
        }

        const priceData = await getTokenUSDPrice(token);
        const totalValueUSD = amount * priceData.price;

        results.push({
          token,
          amount,
          pricePerToken: parseFloat(priceData.price.toFixed(8)),
          totalValueUSD: formatUSDValue(totalValueUSD),
          priceSource: priceData.source
        });

      } catch (error) {
        errors.push({
          token: tokenData.token,
          error: error.message
        });
      }
    }

    const processingTime = Date.now() - startTime;

    res.json({
      success: true,
      message: 'Batch token values calculated',
      data: {
        results,
        errors,
        totalProcessed: results.length,
        totalErrors: errors.length,
        calculatedAt: new Date(),
        processingTime: `${processingTime}ms`
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;

    logger.error('Batch token value calculation failed', {
      error: error.message,
      processingTime,
      userId: req.user?.id
    });

    res.status(500).json({
      success: false,
      message: 'Batch calculation failed. Please try again.'
    });
  }
});

/**
 * Validates NGNB value request
 * @param {Object} body - Request body
 * @returns {Object} Validation result
 */
function validateNGNBValueRequest(body) {
  const { action, amount } = body;
  const errors = [];

  // Helper function to safely convert to string and trim
  const safeStringTrim = (value) => {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  };

  const actionStr = safeStringTrim(action);

  // Required fields validation
  if (!actionStr) {
    errors.push('Action is required (buy or sell)');
  }
  if (amount === null || amount === undefined) {
    errors.push('NGNB amount is required');
  }

  // Amount validation
  const numericAmount = Number(amount);
  if (isNaN(numericAmount) || numericAmount < 0) {
    errors.push('Invalid amount. Amount must be a non-negative number.');
  }

  // Action validation
  const validActions = ['buy', 'sell'];
  if (actionStr && !validActions.includes(actionStr.toLowerCase())) {
    errors.push('Invalid action. Must be either "buy" or "sell"');
  }

  if (errors.length > 0) {
    return {
      success: false,
      errors,
      message: errors.join('; ')
    };
  }

  return {
    success: true,
    validatedData: {
      action: actionStr.toLowerCase(),
      amount: numericAmount
    }
  };
}

/**
 * Fetches NGNB to USD rate based on action
 * @param {string} action - "buy" or "sell"
 * @returns {Promise<Object>} Rate data
 */
async function getNGNBUSDRate(action) {
  try {
    let rateData;
    let rateType;

    if (action === 'buy') {
      // Buy NGNB = offramp (crypto to NGNB) - use NairaMarkdown
      rateData = await NairaMarkdown.findOne().sort({ createdAt: -1 });
      rateType = 'offramp';
    } else {
      // Sell NGNB = onramp (NGNB to crypto) - use NairaMarkup  
      rateData = await NairaMarkup.findOne().sort({ createdAt: -1 });
      rateType = 'onramp';
    }

    if (!rateData) {
      throw new Error(`No ${rateType} rate configuration found`);
    }

    let effectiveRate;
    let rateSource;

    // Determine which rate to use
    if (rateData.rateSource === 'manual') {
      // Use manual rate
      effectiveRate = action === 'buy' ? rateData.offrampRate : rateData.onrampRate;
      rateSource = 'manual';
      
      if (!effectiveRate || effectiveRate <= 0) {
        throw new Error(`Invalid manual ${rateType} rate configured`);
      }
    } else {
      // Use CurrencyAPI rate with markup/markdown
      if (!rateData.lastCurrencyAPIRate || rateData.lastCurrencyAPIRate <= 0) {
        throw new Error(`No valid CurrencyAPI rate found for ${rateType}`);
      }

      const markup = rateData.markup || 0;
      
      if (action === 'buy') {
        // For buying NGNB (offramp), apply markdown (reduce rate)
        effectiveRate = rateData.lastCurrencyAPIRate * (1 - markup / 100);
      } else {
        // For selling NGNB (onramp), apply markup (increase rate)
        effectiveRate = rateData.lastCurrencyAPIRate * (1 + markup / 100);
      }
      
      rateSource = 'currencyapi_with_adjustment';
    }

    // NGNB to USD conversion (1 USD = effectiveRate NGNB)
    const usdRate = 1 / effectiveRate;

    return {
      success: true,
      data: {
        ngnbToUsdRate: parseFloat(usdRate.toFixed(8)),
        usdToNgnbRate: parseFloat(effectiveRate.toFixed(2)),
        markup: rateData.markup || 0,
        rateSource,
        rateType,
        lastUpdated: rateData.updatedAt
      }
    };

  } catch (error) {
    logger.error('Error fetching NGNB USD rate', {
      action,
      error: error.message
    });
    
    return {
      success: false,
      message: error.message
    };
  }
}

/**
 * Calculate NGNB dollar value endpoint
 * POST /ngnb-value
 */
router.post('/ngnb-value', async (req, res) => {
  const startTime = Date.now();

  try {
    // Validate request parameters
    const validation = validateNGNBValueRequest(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: validation.message,
        errors: validation.errors
      });
    }

    const { action, amount } = validation.validatedData;

    logger.info('Calculating NGNB dollar value', {
      action,
      amount,
      userId: req.user?.id
    });

    // Handle zero amount case
    if (amount === 0) {
      return res.json({
        success: true,
        message: 'NGNB value calculated successfully',
        data: {
          action,
          amountNGNB: 0,
          totalValueUSD: 0,
          rate: {
            ngnbToUsdRate: 0,
            usdToNgnbRate: 0
          },
          calculatedAt: new Date(),
          processingTime: `${Date.now() - startTime}ms`
        }
      });
    }

    // Get current NGNB to USD rate
    const rateResult = await getNGNBUSDRate(action);
    
    if (!rateResult.success) {
      return res.status(500).json({
        success: false,
        message: rateResult.message
      });
    }

    const { ngnbToUsdRate } = rateResult.data;
    
    // Calculate total USD value
    const totalValueUSD = amount * ngnbToUsdRate;

    const processingTime = Date.now() - startTime;

    logger.info('NGNB value calculated successfully', {
      action,
      amount,
      ngnbToUsdRate,
      totalValueUSD,
      processingTime,
      userId: req.user?.id
    });

    res.json({
      success: true,
      message: 'NGNB value calculated successfully',
      data: {
        action,
        amountNGNB: amount,
        totalValueUSD: formatUSDValue(totalValueUSD),
        rate: rateResult.data,
        calculatedAt: new Date(),
        processingTime: `${processingTime}ms`
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;

    logger.error('NGNB value calculation failed', {
      action: req.body?.action,
      amount: req.body?.amount,
      error: error.message,
      processingTime,
      userId: req.user?.id
    });

    res.status(500).json({
      success: false,
      message: 'Failed to calculate NGNB value. Please try again.',
      error: 'CALCULATION_ERROR'
    });
  }
});

/**
 * Get current NGNB rates endpoint
 * GET /ngnb-rates
 */
router.get('/ngnb-rates', async (req, res) => {
  try {
    const { action } = req.query;

    if (action && !['buy', 'sell'].includes(action.toLowerCase())) {
      return res.status(400).json({
        success: false,
        message: 'Invalid action. Must be either "buy" or "sell"'
      });
    }

    const results = {};

    if (!action || action.toLowerCase() === 'buy') {
      const buyRate = await getNGNBUSDRate('buy');
      results.buy = buyRate.success ? buyRate.data : { error: buyRate.message };
    }

    if (!action || action.toLowerCase() === 'sell') {
      const sellRate = await getNGNBUSDRate('sell');
      results.sell = sellRate.success ? sellRate.data : { error: sellRate.message };
    }

    res.json({
      success: true,
      message: 'NGNB rates retrieved successfully',
      data: {
        rates: results,
        retrievedAt: new Date()
      }
    });

  } catch (error) {
    logger.error('Failed to get NGNB rates', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      success: false,
      message: 'Failed to retrieve NGNB rates'
    });
  }
});

/**
 * Get price health check endpoint
 * GET /price-health
 */
router.get('/price-health', async (req, res) => {
  try {
    const { token } = req.query;
    
    if (token) {
      // Check specific token
      const upperToken = token.toUpperCase();
      if (!SUPPORTED_TOKENS[upperToken]) {
        return res.status(400).json({
          success: false,
          message: `Unsupported token: ${token}`
        });
      }
      
      try {
        const priceData = await getTokenUSDPrice(upperToken);
        res.json({
          success: true,
          message: 'Price health check completed',
          data: {
            token: upperToken,
            price: priceData.price,
            lastUpdated: priceData.lastUpdated,
            source: priceData.source
          }
        });
      } catch (error) {
        res.status(404).json({
          success: false,
          message: `Price not available for ${upperToken}`,
          error: error.message
        });
      }
    } else {
      // Check all supported tokens
      const healthData = {};
      const sampleTokens = ['BTC', 'ETH', 'USDT']; // Check a few key tokens
      
      for (const token of sampleTokens) {
        try {
          const priceData = await getTokenUSDPrice(token);
          healthData[token] = {
            available: true,
            price: priceData.price,
            source: priceData.source
          };
        } catch (error) {
          healthData[token] = {
            available: false,
            error: error.message
          };
        }
      }
      
      res.json({
        success: true,
        message: 'Price health check completed',
        data: {
          checkedAt: new Date(),
          sampledTokens: healthData,
          totalSupportedTokens: SUPPORTED_TOKENS_LIST.length
        }
      });
    }
  } catch (error) {
    logger.error('Price health check failed', {
      error: error.message,
      userId: req.user?.id
    });

    res.status(500).json({
      success: false,
      message: 'Health check failed'
    });
  }
});

module.exports = router;