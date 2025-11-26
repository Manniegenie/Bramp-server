const express = require('express');
const router = express.Router();

const User = require('../models/user');
const Transaction = require('../models/transaction');
const { getPricesWithCache, SUPPORTED_TOKENS, priceCache } = require('../services/portfolio');

// Import only used functions from offramp service
const { 
  calculateNairaFromCrypto,
  getCurrentRate
} = require('../services/offramppriceservice');

// Import only used functions from onramp service
const { 
  calculateCryptoFromNaira,
  getOnrampRate
} = require('../services/onramppriceservice');

// Import NGNB rate models for naira USD value calculation
const NairaMarkdown = require('../models/offramp'); // For offramp (buy NGNB)
const NairaMarkup = require('../models/onramp');     // For onramp (sell NGNB)

const logger = require('../utils/logger');

// Swap configuration constants
const SWAP_CONFIG = {
  MAX_PENDING_SWAPS: 3,
  DUPLICATE_CHECK_WINDOW: 5 * 60 * 1000, // 5 minutes
  AMOUNT_PRECISION: 8,
  MAX_DECIMAL_PLACES: 8 // Maximum decimal places allowed
  // Removed MAX_USD_VALUE - no limits on swap amounts
};

/**
 * Helper function to count decimal places in a string representation
 * @param {string} value - String representation of number to check
 * @returns {number} Number of decimal places
 */
function countDecimalPlaces(value) {
  // Convert to string if not already
  const str = String(value).trim();
  
  // Check for scientific notation
  if (str.includes('e') || str.includes('E')) {
    // Handle scientific notation (e.g., "1e-8" or "1.23e-5")
    const parts = str.toLowerCase().split('e');
    if (parts.length === 2) {
      const exponent = parseInt(parts[1], 10);
      const basePart = parts[0];
      
      if (exponent < 0) {
        // Negative exponent means decimal places
        const baseDecimals = basePart.includes('.') ? basePart.split('.')[1].length : 0;
        return Math.abs(exponent) + baseDecimals;
      } else {
        // Positive exponent might eliminate decimal places
        const baseDecimals = basePart.includes('.') ? basePart.split('.')[1].length : 0;
        return Math.max(0, baseDecimals - exponent);
      }
    }
  }
  
  // Handle normal decimal notation
  if (str.includes('.')) {
    return str.split('.')[1].length;
  }
  
  // No decimal point means 0 decimal places
  return 0;
}

/**
 * OPTIMIZED: Get prices directly from cache or fetch efficiently
 * @param {Array} tokenSymbols - Array of token symbols
 * @param {string} transactionType - Type of transaction (for NGNB pricing)
 * @param {string} swapType - Swap type (onramp/offramp)
 * @returns {Promise<Object>} Prices object
 */
async function getSwapPricesOptimized(tokenSymbols, transactionType = 'swap', swapType = null) {
  try {
    // Normalize tokens
    const normalizedTokens = [...new Set(
      tokenSymbols
        .map(t => t.toUpperCase())
        .filter(token => SUPPORTED_TOKENS[token])
    )];

    if (normalizedTokens.length === 0) {
      return {};
    }

    // Check if we can use cached prices (skip cache for NGNB to get fresh rates)
    const hasNGNB = normalizedTokens.includes('NGNB');
    const canUseCache = !hasNGNB && priceCache.data && priceCache.data.size > 0 && 
                       priceCache.lastUpdated && 
                       (Date.now() - priceCache.lastUpdated) < (5 * 60 * 1000); // 5 min cache

    if (canUseCache) {
      // Check if all tokens are in cache
      const allInCache = normalizedTokens.every(token => priceCache.data.has(token));
      
      if (allInCache) {
        logger.debug('Using cached prices for swap optimization', { tokens: normalizedTokens });
        return Object.fromEntries(
          normalizedTokens.map(token => [token, priceCache.data.get(token) || 0])
        );
      }
    }

    // Fallback to getPricesWithCache for fresh prices or cache miss
    logger.debug('Fetching fresh prices for swap', { tokens: normalizedTokens, hasNGNB, reason: hasNGNB ? 'NGNB_fresh_rates' : 'cache_miss' });
    return await getPricesWithCache(normalizedTokens, transactionType, swapType);

  } catch (error) {
    logger.error('Error getting optimized swap prices', { error: error.message, tokens: tokenSymbols });
    throw error;
  }
}

/**
 * OPTIMIZED: Updates user balance directly without expensive portfolio recalculation
 * @param {Object} swapData - Swap parameters
 * @returns {Promise<Object>} Processing result
 */
async function processSwapBalancesOptimized(swapData) {
  const { userId, fromCurrency, toCurrency, fromAmount, toAmount, transactionId, swapType } = swapData;

  try {
    logger.info('Processing swap balances with optimized direct updates', {
      userId,
      transactionId,
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount,
      swapType
    });

    // Get prices efficiently using cache-first approach
    const prices = await getSwapPricesOptimized([fromCurrency, toCurrency], 'swap', swapType);
    
    const fromPrice = prices[fromCurrency] || 0;
    const toPrice = prices[toCurrency] || 0;

    logger.debug('Retrieved prices for swap processing', {
      fromCurrency,
      fromPrice,
      toCurrency,
      toPrice,
      fromPriceCached: priceCache.data.has(fromCurrency),
      toPriceCached: priceCache.data.has(toCurrency)
    });

    // Calculate USD amounts for the balance updates
    const fromUSDAmount = fromAmount * fromPrice;
    const toUSDAmount = toAmount * toPrice;

    // Prepare balance field mappings
    const fromCurrencyLower = fromCurrency.toLowerCase();
    const toCurrencyLower = toCurrency.toLowerCase();
    
    const fromBalanceField = `${fromCurrencyLower}Balance`;
    const fromUSDBalanceField = `${fromCurrencyLower}BalanceUSD`;
    const toBalanceField = `${toCurrencyLower}Balance`;
    const toUSDBalanceField = `${toCurrencyLower}BalanceUSD`;

    // Build single atomic update operation
    const updateFields = {
      $inc: {
        // Debit source currency
        [fromBalanceField]: -fromAmount,
        [fromUSDBalanceField]: -fromUSDAmount,
        // Credit destination currency
        [toBalanceField]: toAmount,
        [toUSDBalanceField]: toUSDAmount
      },
      $set: {
        lastBalanceUpdate: new Date()
      }
    };

    // Execute single atomic update
    const updatedUser = await User.findByIdAndUpdate(
      userId,
      updateFields,
      { new: true, runValidators: true }
    );

    if (!updatedUser) {
      throw new Error(`User not found: ${userId}`);
    }

    // OPTIMIZED: Calculate only the total portfolio balance without full recalculation
    // This is much faster than updateUserPortfolioBalance()
    const totalPortfolioBalance = 
      (updatedUser.btcBalanceUSD || 0) +
      (updatedUser.ethBalanceUSD || 0) +
      (updatedUser.solBalanceUSD || 0) +
      (updatedUser.usdtBalanceUSD || 0) +
      (updatedUser.usdcBalanceUSD || 0) +
      (updatedUser.bnbBalanceUSD || 0) +
      (updatedUser.maticBalanceUSD || 0) +
      (updatedUser.avaxBalanceUSD || 0) +
      (updatedUser.ngnbBalanceUSD || 0);

    // Update only the total portfolio balance
    await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          totalPortfolioBalance: parseFloat(totalPortfolioBalance.toFixed(2)),
          portfolioLastUpdated: new Date()
        }
      },
      { runValidators: true }
    );

    logger.info('Swap balances processed with optimized direct updates', {
      userId,
      transactionId,
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount,
      fromUSDAmount: parseFloat(fromUSDAmount.toFixed(2)),
      toUSDAmount: parseFloat(toUSDAmount.toFixed(2)),
      newTotalPortfolio: parseFloat(totalPortfolioBalance.toFixed(2)),
      pricesUsed: {
        [fromCurrency]: fromPrice,
        [toCurrency]: toPrice
      }
    });

    return { 
      success: true,
      message: 'Balances updated using optimized direct cache access',
      optimizationData: {
        singleAtomicUpdate: true,
        skipPortfolioRecalculation: true,
        pricesFromCache: {
          [fromCurrency]: priceCache.data.has(fromCurrency),
          [toCurrency]: priceCache.data.has(toCurrency)
        }
      }
    };

  } catch (error) {
    logger.error('Failed to process swap balances with optimization', { 
      swapData, 
      error: error.message,
      stack: error.stack 
    });
    throw error;
  }
}

/**
 * Validates user balance for swap using portfolio.js
 * @param {string} userId - User ID
 * @param {string} currency - Currency to check
 * @param {number} amount - Amount to validate
 * @param {Object} options - Additional options
 * @returns {Promise<Object>} Validation result
 */
async function validateUserBalance(userId, currency, amount, options = {}) {
  try {
    const user = await User.findById(userId);
    if (!user) {
      return {
        success: false,
        message: 'User not found'
      };
    }

    // Helper function to get balance field name
    const getBalanceField = (curr) => {
      const currencyLower = curr.toLowerCase();
      return `${currencyLower}Balance`;
    };

    const balanceField = getBalanceField(currency);
    const availableBalance = user[balanceField] || 0;

    if (availableBalance < amount) {
      return {
        success: false,
        message: `Insufficient ${currency} balance. Available: ${availableBalance}, Required: ${amount}`,
        availableBalance: availableBalance
      };
    }

    return {
      success: true,
      availableBalance: availableBalance
    };

  } catch (error) {
    logger.error('Error validating user balance', {
      userId,
      currency,
      amount,
      error: error.message
    });
    return {
      success: false,
      message: 'Failed to validate balance'
    };
  }
}

/**
 * Gets the NGNB to USD rate for calculating naira dollar value
 * @param {string} swapType - "offramp" or "onramp"
 * @returns {Promise<Object>} Rate data
 */
async function getNairaUSDRate(swapType) {
  try {
    let rateData;
    let rateType;
    let effectiveRate;

    if (swapType === 'offramp') {
      // Offramp (crypto to NGNB) - use NairaMarkdown
      rateData = await NairaMarkdown.findOne().sort({ createdAt: -1 });
      rateType = 'offramp';
      effectiveRate = rateData?.offrampRate;
    } else {
      // Onramp (NGNB to crypto) - use NairaMarkup  
      rateData = await NairaMarkup.findOne().sort({ createdAt: -1 });
      rateType = 'onramp';
      effectiveRate = rateData?.onrampRate;
    }

    if (!rateData || !effectiveRate || effectiveRate <= 0) {
      throw new Error(`No valid ${rateType} rate found for naira USD conversion`);
    }

    // NGNB to USD conversion (1 USD = effectiveRate NGNB)
    const ngnbToUsdRate = 1 / effectiveRate;

    return {
      success: true,
      data: {
        ngnbToUsdRate: parseFloat(ngnbToUsdRate.toFixed(8)),
        usdToNgnbRate: parseFloat(effectiveRate.toFixed(2)),
        rateType,
        lastUpdated: rateData.updatedAt
      }
    };

  } catch (error) {
    logger.error('Error fetching naira USD rate for swap', {
      swapType,
      error: error.message
    });
    
    return {
      success: false,
      message: error.message
    };
  }
}

/**
 * Calculates USD value for swap (for tracking purposes only - no limits enforced)
 * @param {Object} swapData - Swap parameters
 * @param {number} cryptoPrice - Current crypto price (for offramp)
 * @param {Object} exchangeRate - Exchange rate object (for onramp)
 * @returns {Object} USD calculation result
 */
function calculateUSDValue(swapData, cryptoPrice = null, exchangeRate = null) {
  const { fromCurrency, toCurrency, amount, swapType } = swapData;

  try {
    let usdValue = 0;

    if (swapType === 'onramp') {
      // NGNB to Crypto: Convert NGNB amount to USD
      if (!exchangeRate || !exchangeRate.finalPrice) {
        throw new Error('Exchange rate required for onramp USD calculation');
      }
      usdValue = amount / exchangeRate.finalPrice;
    } else if (swapType === 'offramp') {
      // Crypto to NGNB: Convert crypto amount to USD
      if (!cryptoPrice || cryptoPrice <= 0) {
        throw new Error('Crypto price required for offramp USD calculation');
      }
      usdValue = amount * cryptoPrice;
    }

    logger.debug('USD value calculation', {
      swapType,
      amount,
      cryptoPrice,
      exchangeRate: exchangeRate?.finalPrice,
      calculatedUSDValue: usdValue
    });

    return {
      success: true,
      usdValue: parseFloat(usdValue.toFixed(2))
    };

  } catch (error) {
    logger.error('USD value calculation error', { 
      swapData, 
      error: error.message 
    });
    return {
      success: false,
      message: `Failed to calculate USD value: ${error.message}`,
      usdValue: 0
    };
  }
}

/**
 * Validates swap request parameters
 * @param {Object} body - Request body
 * @returns {Object} Validation result
 */
function validateSwapRequest(body) {
  const { fromCurrency, toCurrency, amount, swapType } = body;

  const errors = [];

  // Helper function to safely convert to string and trim
  const safeStringTrim = (value) => {
    if (value === null || value === undefined) return '';
    return String(value).trim();
  };

  // Convert values to strings safely
  const fromCurrencyStr = safeStringTrim(fromCurrency);
  const toCurrencyStr = safeStringTrim(toCurrency);
  const swapTypeStr = safeStringTrim(swapType);

  // Required fields validation
  if (!fromCurrencyStr) {
    errors.push('From currency is required');
  }
  if (!toCurrencyStr) {
    errors.push('To currency is required');
  }
  if (!amount && amount !== 0) {
    errors.push('Swap amount is required');
  }
  if (!swapTypeStr) {
    errors.push('Swap type is required (onramp/offramp)');
  }

  // Convert amount to string for validation
  const amountStr = String(amount).trim();
  
  // Validate amount format using regex (allows integers and decimals)
  const amountRegex = /^(\d+\.?\d*|\.\d+)$/;
  if (!amountRegex.test(amountStr)) {
    errors.push('Invalid swap amount format. Amount must be a positive number.');
  } else {
    // Check decimal places on the original string representation
    const decimalPlaces = countDecimalPlaces(amountStr);
    if (decimalPlaces > SWAP_CONFIG.MAX_DECIMAL_PLACES) {
      errors.push(`Amount cannot have more than ${SWAP_CONFIG.MAX_DECIMAL_PLACES} decimal places.`);
    }

    // Convert to number and validate value
    const numericAmount = parseFloat(amountStr);
    if (isNaN(numericAmount) || numericAmount <= 0) {
      errors.push('Invalid swap amount. Amount must be a positive number.');
    }
  }

  // Swap type validation
  const validSwapTypes = ['onramp', 'offramp'];
  if (swapTypeStr && !validSwapTypes.includes(swapTypeStr.toLowerCase())) {
    errors.push('Invalid swap type. Must be either "onramp" or "offramp"');
  }

  // Currency validation
  const upperFromCurrency = fromCurrencyStr.toUpperCase();
  const upperToCurrency = toCurrencyStr.toUpperCase();

  // For onramp: NGNB to crypto
  if (swapTypeStr.toLowerCase() === 'onramp') {
    if (upperFromCurrency !== 'NGNB') {
      errors.push('For onramp swaps, from currency must be NGNB');
    }
    if (upperToCurrency === 'NGNB' || !SUPPORTED_TOKENS[upperToCurrency]) {
      errors.push(`For onramp swaps, to currency must be a supported crypto: ${Object.keys(SUPPORTED_TOKENS).join(', ')}`);
    }
  }

  // For offramp: crypto to NGNB
  if (swapTypeStr.toLowerCase() === 'offramp') {
    if (upperToCurrency !== 'NGNB') {
      errors.push('For offramp swaps, to currency must be NGNB');
    }
    if (upperFromCurrency === 'NGNB' || !SUPPORTED_TOKENS[upperFromCurrency]) {
      errors.push(`For offramp swaps, from currency must be a supported crypto: ${Object.keys(SUPPORTED_TOKENS).join(', ')}`);
    }
  }

  // Same currency check
  if (upperFromCurrency === upperToCurrency) {
    errors.push('From and to currencies cannot be the same');
  }

  if (errors.length > 0) {
    return {
      success: false,
      errors,
      message: errors.join('; ')
    };
  }

  // Parse the final numeric amount
  const finalAmount = parseFloat(amountStr);

  return {
    success: true,
    validatedData: {
      fromCurrency: upperFromCurrency,
      toCurrency: upperToCurrency,
      amount: finalAmount,
      swapType: swapTypeStr.toLowerCase()
    }
  };
}

/**
 * Checks for duplicate pending swaps
 * @param {string} userId - User ID
 * @param {string} fromCurrency - From currency
 * @param {string} toCurrency - To currency
 * @param {number} amount - Amount
 * @returns {Promise<Object>} Check result
 */
async function checkDuplicateSwap(userId, fromCurrency, toCurrency, amount) {
  try {
    const checkTime = new Date(Date.now() - SWAP_CONFIG.DUPLICATE_CHECK_WINDOW);
    
    const existingTransaction = await Transaction.findOne({
      userId,
      type: 'SWAP', // Updated to use 'SWAP' type
      fromCurrency,
      toCurrency,
      fromAmount: amount, // Use fromAmount field instead of amount
      status: { $in: ['PENDING', 'PROCESSING'] },
      createdAt: { $gte: checkTime }
    });

    if (existingTransaction) {
      return {
        isDuplicate: true,
        message: `A similar swap request is already pending. Transaction ID: ${existingTransaction._id}`,
        existingTransactionId: existingTransaction._id
      };
    }

    // Check for too many pending swaps
    const pendingCount = await Transaction.countDocuments({
      userId,
      type: 'SWAP', // Updated to use 'SWAP' type
      status: { $in: ['PENDING', 'PROCESSING'] }
    });

    if (pendingCount >= SWAP_CONFIG.MAX_PENDING_SWAPS) {
      return {
        isDuplicate: true,
        message: `Too many pending swaps. Maximum allowed: ${SWAP_CONFIG.MAX_PENDING_SWAPS}`,
        pendingCount
      };
    }

    return { isDuplicate: false };
  } catch (error) {
    logger.error('Error checking duplicate swap', { userId, error: error.message });
    throw new Error('Failed to validate swap request');
  }
}

/**
 * Calculates swap rates and amounts with USD tracking and naira USD value
 * @param {Object} swapData - Swap parameters
 * @returns {Promise<Object>} Calculation result
 */
async function calculateSwapRates(swapData) {
  const { fromCurrency, toCurrency, amount, swapType } = swapData;

  try {
    let result = {};
    let usdCalculation = {};
    let nairaUsdValue = 0;
    let nairaAmount = 0;
    let cryptoUsdValue = 0;
    let cryptoAmount = 0;

    if (swapType === 'onramp') {
      // NGNB to Crypto (onramp)
      const prices = await getSwapPricesOptimized([toCurrency], 'swap', swapType);
      const cryptoPrice = prices[toCurrency];
      
      if (!cryptoPrice || cryptoPrice <= 0) {
        throw new Error(`Unable to fetch current price for ${toCurrency}`);
      }

      // Get onramp rate and calculate USD value for tracking
      const onrampRate = await getOnrampRate();
      
      // Calculate USD value (no limit validation)
      usdCalculation = calculateUSDValue(swapData, null, onrampRate);

      cryptoAmount = await calculateCryptoFromNaira(amount, toCurrency, cryptoPrice);

      // Calculate naira USD value for onramp (NGNB is the source)
      nairaAmount = amount; // The NGNB amount being swapped
      const nairaRateResult = await getNairaUSDRate('onramp');
      
      if (nairaRateResult.success) {
        nairaUsdValue = nairaAmount * nairaRateResult.data.ngnbToUsdRate;
      } else {
        logger.warn('Could not get naira USD rate for onramp', { error: nairaRateResult.message });
        nairaUsdValue = 0; // fallback
      }

      // Calculate crypto USD value (crypto is the destination)
      cryptoUsdValue = cryptoAmount * cryptoPrice;

      result = {
        fromAmount: amount,
        toAmount: parseFloat(cryptoAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
        cryptoPrice,
        exchangeRate: onrampRate,
        usdValue: usdCalculation.usdValue || 0,
        nairaInvolved: {
          amount: nairaAmount,
          usdValue: parseFloat(nairaUsdValue.toFixed(2)),
          currency: 'NGNB',
          role: 'source', // NGNB is being spent
          rate: nairaRateResult.success ? {
            ngnbToUsdRate: nairaRateResult.data.ngnbToUsdRate,
            usdToNgnbRate: nairaRateResult.data.usdToNgnbRate,
            rateType: nairaRateResult.data.rateType,
            lastUpdated: nairaRateResult.data.lastUpdated
          } : null
        },
        cryptoInvolved: {
          amount: parseFloat(cryptoAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
          usdValue: parseFloat(cryptoUsdValue.toFixed(2)),
          currency: toCurrency,
          role: 'destination', // Crypto is being received
          price: parseFloat(cryptoPrice.toFixed(2))
        }
      };

    } else if (swapType === 'offramp') {
      // Crypto to NGNB (offramp)
      const prices = await getSwapPricesOptimized([fromCurrency], 'swap', swapType);
      const cryptoPrice = prices[fromCurrency];
      
      if (!cryptoPrice || cryptoPrice <= 0) {
        throw new Error(`Unable to fetch current price for ${fromCurrency}`);
      }

      // Calculate USD value for tracking (no limit validation)
      usdCalculation = calculateUSDValue(swapData, cryptoPrice, null);

      // Get offramp rate and calculate NGNB amount
      const offrampRate = await getCurrentRate();
      nairaAmount = await calculateNairaFromCrypto(amount, fromCurrency, cryptoPrice);

      // Calculate naira USD value for offramp (NGNB is the destination)
      const nairaRateResult = await getNairaUSDRate('offramp');
      
      if (nairaRateResult.success) {
        nairaUsdValue = nairaAmount * nairaRateResult.data.ngnbToUsdRate;
      } else {
        logger.warn('Could not get naira USD rate for offramp', { error: nairaRateResult.message });
        nairaUsdValue = 0; // fallback
      }

      // Calculate crypto USD value (crypto is the source)
      cryptoAmount = amount; // The crypto amount being swapped
      cryptoUsdValue = cryptoAmount * cryptoPrice;

      result = {
        fromAmount: amount,
        toAmount: parseFloat(nairaAmount.toFixed(2)),
        cryptoPrice,
        exchangeRate: offrampRate,
        usdValue: usdCalculation.usdValue || 0,
        nairaInvolved: {
          amount: parseFloat(nairaAmount.toFixed(2)),
          usdValue: parseFloat(nairaUsdValue.toFixed(2)),
          currency: 'NGNB',
          role: 'destination', // NGNB is being received
          rate: nairaRateResult.success ? {
            ngnbToUsdRate: nairaRateResult.data.ngnbToUsdRate,
            usdToNgnbRate: nairaRateResult.data.usdToNgnbRate,
            rateType: nairaRateResult.data.rateType,
            lastUpdated: nairaRateResult.data.lastUpdated
          } : null
        },
        cryptoInvolved: {
          amount: parseFloat(cryptoAmount.toFixed(SWAP_CONFIG.AMOUNT_PRECISION)),
          usdValue: parseFloat(cryptoUsdValue.toFixed(2)),
          currency: fromCurrency,
          role: 'source', // Crypto is being spent
          price: parseFloat(cryptoPrice.toFixed(2))
        }
      };
    }

    return {
      success: true,
      data: result
    };

  } catch (error) {
    logger.error('Error calculating swap rates', { swapData, error: error.message });
    return {
      success: false,
      message: error.message
    };
  }
}

/**
 * Creates swap transaction record with naira and crypto USD values
 * @param {Object} transactionData - Transaction parameters
 * @returns {Promise<Object>} Created transaction
 */
async function createSwapTransaction(transactionData) {
  const {
    userId,
    fromCurrency,
    toCurrency,
    fromAmount,
    toAmount,
    swapType,
    exchangeRate,
    cryptoPrice,
    usdValue,
    nairaInvolved,
    cryptoInvolved
  } = transactionData;

  try {
    const transaction = await Transaction.create({
      userId,
      type: 'SWAP', // Now supported in the updated schema
      currency: fromCurrency, // Required currency field (source currency)
      fromCurrency, // Swap-specific field
      toCurrency, // Swap-specific field
      amount: fromAmount, // Required amount field (source amount)
      fromAmount, // Swap-specific field
      toAmount, // Swap-specific field
      swapType, // Swap-specific field (onramp/offramp)
      status: 'PENDING',
      metadata: {
        initiatedAt: new Date(),
        exchangeRate: exchangeRate?.finalPrice || exchangeRate,
        cryptoPrice,
        priceSource: exchangeRate?.source,
        usdValue,
        nairaInvolved, // Add naira USD value to metadata
        cryptoInvolved, // Add crypto USD value to metadata
        twoFactorRequired: false,
        optimizedProcessing: true // Flag for optimized processing
      }
    });

    logger.info('Swap transaction created with naira and crypto USD values', {
      transactionId: transaction._id,
      userId,
      fromCurrency,
      toCurrency,
      fromAmount,
      toAmount,
      swapType,
      usdValue,
      nairaUsdValue: nairaInvolved?.usdValue,
      cryptoUsdValue: cryptoInvolved?.usdValue
    });

    return transaction;
  } catch (error) {
    logger.error('Failed to create swap transaction', {
      userId,
      fromCurrency,
      toCurrency,
      error: error.message
    });
    throw error;
  }
}

/**
 * GET /swap/limits - Get current swap limits and restrictions
 */
router.get('/limits', async (req, res) => {
  try {
    res.status(200).json({
      success: true,
      data: {
        maxDecimalPlaces: SWAP_CONFIG.MAX_DECIMAL_PLACES,
        maxPendingSwaps: SWAP_CONFIG.MAX_PENDING_SWAPS,
        duplicateCheckWindow: SWAP_CONFIG.DUPLICATE_CHECK_WINDOW / 1000, // in seconds
        supportedTokens: Object.keys(SUPPORTED_TOKENS),
        restrictions: {
          onramp: "NGNB → Crypto",
          offramp: "Crypto → NGNB",
          maxValue: "No limits", // Updated to reflect no USD limit
          precision: `Maximum ${SWAP_CONFIG.MAX_DECIMAL_PLACES} decimal places`
        },
        optimization: {
          directCacheAccess: true,
          skipPortfolioRecalculation: true,
          singleAtomicUpdate: true
        }
      },
      message: 'Swap limits and restrictions retrieved successfully'
    });
  } catch (error) {
    logger.error('Error fetching swap limits', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch swap limits'
    });
  }
});

/**
 * Main swap endpoint - OPTIMIZED VERSION
 */
router.post('/crypto', async (req, res) => {
  const startTime = Date.now();
  let transaction = null;

  try {
    const userId = req.user.id;
    
    // Validate request parameters
    const validation = validateSwapRequest(req.body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: validation.message,
        errors: validation.errors
      });
    }

    const { fromCurrency, toCurrency, amount, swapType } = validation.validatedData;

    logger.info('Processing optimized swap request', {
      userId,
      fromCurrency,
      toCurrency,
      amount,
      swapType
    });

    // Validate user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Check for duplicate swaps
    const duplicateCheck = await checkDuplicateSwap(userId, fromCurrency, toCurrency, amount);
    if (duplicateCheck.isDuplicate) {
      return res.status(400).json({
        success: false,
        message: duplicateCheck.message
      });
    }

    // Validate user balance for from currency
    const balanceValidation = await validateUserBalance(userId, fromCurrency, amount);
    
    if (!balanceValidation.success) {
      return res.status(400).json({
        success: false,
        message: balanceValidation.message,
        availableBalance: balanceValidation.availableBalance
      });
    }

    // Calculate swap rates and amounts (includes USD tracking and naira USD value)
    const rateCalculation = await calculateSwapRates({
      fromCurrency,
      toCurrency,
      amount,
      swapType
    });

    if (!rateCalculation.success) {
      return res.status(400).json({
        success: false,
        message: rateCalculation.message
      });
    }

    const { toAmount, exchangeRate, cryptoPrice, usdValue, nairaInvolved, cryptoInvolved } = rateCalculation.data;

    // Create transaction record
    transaction = await createSwapTransaction({
      userId,
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount,
      swapType,
      exchangeRate,
      cryptoPrice,
      usdValue,
      nairaInvolved,
      cryptoInvolved
    });

    // OPTIMIZED: Process balance updates using direct cache access
    await processSwapBalancesOptimized({
      userId,
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount,
      transactionId: transaction._id,
      swapType
    });

    // Update transaction status to completed
    transaction.status = 'COMPLETED';
    transaction.completedAt = new Date();
    await transaction.save();

    const processingTime = Date.now() - startTime;
    logger.info('Optimized swap processed successfully', {
      userId,
      transactionId: transaction._id,
      fromCurrency,
      toCurrency,
      fromAmount: amount,
      toAmount,
      usdValue,
      nairaUsdValue: nairaInvolved?.usdValue,
      cryptoUsdValue: cryptoInvolved?.usdValue,
      processingTime,
      optimizations: {
        directCacheAccess: true,
        skipPortfolioRecalculation: true,
        singleAtomicUpdate: true
      }
    });

    res.status(200).json({
      success: true,
      message: 'Swap completed successfully',
      data: {
        transactionId: transaction._id,
        fromCurrency,
        toCurrency,
        fromAmount: amount,
        toAmount,
        swapType,
        exchangeRate: exchangeRate?.finalPrice || exchangeRate,
        cryptoPrice,
        usdValue,
        nairaInvolved, // Include naira USD value in response
        cryptoInvolved, // Include crypto USD value in response
        status: 'COMPLETED',
        completedAt: transaction.completedAt,
        performance: {
          processingTime: `${processingTime}ms`,
          optimizationsUsed: {
            directCacheAccess: true,
            skipPortfolioRecalculation: true,
            singleAtomicUpdate: true
          }
        }
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    // Mark transaction as failed if it was created
    if (transaction) {
      try {
        transaction.status = 'FAILED';
        transaction.failedAt = new Date();
        transaction.metadata.error = error.message;
        await transaction.save();
      } catch (saveError) {
        logger.error('Failed to update transaction status to FAILED', {
          transactionId: transaction._id,
          error: saveError.message
        });
      }
    }

    logger.error('Optimized swap processing failed', {
      userId: req.user?.id,
      transactionId: transaction?._id,
      error: error.message,
      stack: error.stack,
      processingTime
    });

    res.status(500).json({
      success: false,
      message: 'Internal server error during swap processing. Please contact support if this persists.',
      transactionId: transaction?._id
    });
  }
});

/**
 * Get swap quote endpoint (preview without executing) - OPTIMIZED
 */
router.post('/quote', async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Validate request parameters
    const validation = validateSwapRequest(req.body);
    
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: validation.message,
        errors: validation.errors
      });
    }

    const { fromCurrency, toCurrency, amount, swapType } = validation.validatedData;

    // Calculate swap rates (includes USD tracking and naira USD value)
    const rateCalculation = await calculateSwapRates({
      fromCurrency,
      toCurrency,
      amount,
      swapType
    });

    if (!rateCalculation.success) {
      return res.status(400).json({
        success: false,
        message: rateCalculation.message
      });
    }

    res.json({
      success: true,
      message: 'Swap quote calculated successfully',
      data: {
        ...rateCalculation.data,
        fromCurrency,
        toCurrency,
        swapType,
        quoteValidFor: '2 minutes',
        quotedAt: new Date(),
        optimization: {
          directCacheAccess: true,
          pricesFromCache: {
            [fromCurrency]: priceCache.data.has(fromCurrency),
            [toCurrency]: priceCache.data.has(toCurrency)
          }
        }
      }
    });

  } catch (error) {
    logger.error('Optimized swap quote calculation failed', {
      userId: req.user?.id,
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to calculate swap quote'
    });
  }
});

/**
 * Get swap status endpoint
 */
router.get('/status/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const userId = req.user.id;

    const transaction = await Transaction.findOne({
      _id: transactionId,
      userId,
      type: 'SWAP' // Updated to use 'SWAP' type
    });

    if (!transaction) {
      return res.status(404).json({
        success: false,
        message: 'Swap transaction not found'
      });
    }

    res.json({
      success: true,
      data: {
        transactionId: transaction._id,
        status: transaction.status,
        fromCurrency: transaction.fromCurrency,
        toCurrency: transaction.toCurrency,
        fromAmount: transaction.fromAmount,
        toAmount: transaction.toAmount,
        swapType: transaction.swapType,
        createdAt: transaction.createdAt,
        completedAt: transaction.completedAt,
        failedAt: transaction.failedAt,
        metadata: transaction.metadata,
        optimizedProcessing: transaction.metadata?.optimizedProcessing || false
      }
    });

  } catch (error) {
    logger.error('Error fetching swap status', {
      userId: req.user?.id,
      transactionId: req.params.transactionId,
      error: error.message
    });

    res.status(500).json({
      success: false,
      message: 'Failed to fetch swap status'
    });
  }
});

/**
 * Quick swap endpoint (simplified version for frequent traders) - OPTIMIZED
 */
router.post('/quick', async (req, res) => {
  const startTime = Date.now();
  let transaction = null;

  try {
    const userId = req.user.id;
    const { fromCurrency, toCurrency, amount } = req.body;
    
    // Auto-detect swap type based on currencies
    let swapType;
    if (fromCurrency?.toUpperCase() === 'NGNB') {
      swapType = 'onramp';
    } else if (toCurrency?.toUpperCase() === 'NGNB') {
      swapType = 'offramp';
    } else {
      return res.status(400).json({
        success: false,
        message: 'Quick swap requires either from or to currency to be NGNB'
      });
    }

    // Use existing validation and processing logic
    const validation = validateSwapRequest({
      fromCurrency,
      toCurrency,
      amount,
      swapType
    });

    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: validation.message,
        errors: validation.errors
      });
    }

    const validatedData = validation.validatedData;

    logger.info('Processing optimized quick swap request', {
      userId,
      ...validatedData
    });

    // Check user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Skip duplicate check for quick swaps (traders need speed)
    // But still validate balance
    const balanceValidation = await validateUserBalance(userId, validatedData.fromCurrency, validatedData.amount);
    
    if (!balanceValidation.success) {
      return res.status(400).json({
        success: false,
        message: balanceValidation.message
      });
    }

    // Calculate rates and execute swap (includes USD tracking and naira USD value)
    const rateCalculation = await calculateSwapRates(validatedData);

    if (!rateCalculation.success) {
      return res.status(400).json({
        success: false,
        message: rateCalculation.message
      });
    }

    const { toAmount, exchangeRate, cryptoPrice, usdValue, nairaInvolved, cryptoInvolved } = rateCalculation.data;

    // Create and process transaction
    transaction = await createSwapTransaction({
      userId,
      fromCurrency: validatedData.fromCurrency,
      toCurrency: validatedData.toCurrency,
      fromAmount: validatedData.amount,
      toAmount,
      swapType: validatedData.swapType,
      exchangeRate,
      cryptoPrice,
      usdValue,
      nairaInvolved,
      cryptoInvolved
    });

    // OPTIMIZED: Process balance updates using direct cache access
    await processSwapBalancesOptimized({
      userId,
      fromCurrency: validatedData.fromCurrency,
      toCurrency: validatedData.toCurrency,
      fromAmount: validatedData.amount,
      toAmount,
      transactionId: transaction._id,
      swapType: validatedData.swapType
    });

    transaction.status = 'COMPLETED';
    transaction.completedAt = new Date();
    await transaction.save();

    const processingTime = Date.now() - startTime;
    
    res.status(200).json({
      success: true,
      message: 'Quick swap completed successfully',
      data: {
        transactionId: transaction._id,
        fromCurrency: validatedData.fromCurrency,
        toCurrency: validatedData.toCurrency,
        fromAmount: validatedData.amount,
        toAmount,
        swapType: validatedData.swapType,
        exchangeRate: exchangeRate?.finalPrice || exchangeRate,
        usdValue,
        nairaInvolved, // Include naira USD value in response
        cryptoInvolved, // Include crypto USD value in response
        status: 'COMPLETED',
        processingTime: `${processingTime}ms`,
        optimizations: {
          directCacheAccess: true,
          skipPortfolioRecalculation: true,
          singleAtomicUpdate: true,
          skipDuplicateCheck: true
        }
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    if (transaction) {
      try {
        transaction.status = 'FAILED';
        transaction.failedAt = new Date();
        transaction.metadata.error = error.message;
        await transaction.save();
      } catch (saveError) {
        logger.error('Failed to update transaction status', {
          transactionId: transaction._id,
          error: saveError.message
        });
      }
    }

    logger.error('Optimized quick swap processing failed', {
      userId: req.user?.id,
      error: error.message,
      processingTime
    });

    res.status(500).json({
      success: false,
      message: 'Quick swap failed. Please try again.',
      transactionId: transaction?._id
    });
  }
});

// Ensure proper export
module.exports = router;