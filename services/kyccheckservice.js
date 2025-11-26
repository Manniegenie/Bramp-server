const User = require('../models/user');
const Transaction = require('../models/transaction');
const BillTransaction = require('../models/billstransaction');
const { offrampService } = require('./offramppriceservice');
const { getPricesWithCache } = require('./portfolio');
const logger = require('../utils/logger');

class KYCLimitService {
  constructor() {
    this.cache = {
      userSpending: new Map(),
      cacheExpiry: new Map()
    };
    this.cacheTimeout = 5 * 60 * 1000; // 5 minutes cache
  }

  /**
   * Validate NGNB/Naira withdrawal or transfer
   * @param {string} userId - User ID
   * @param {number} amount - Transaction amount in NGNB/Naira
   * @returns {Object} Validation result
   */
  async validateNgnbTransaction(userId, amount) {
    try {
      logger.info(`🔍 NGNB validation started for user ${userId}: ₦${amount.toLocaleString()}`);

      const user = await this.getUser(userId);
      if (!user) {
        return this.createErrorResponse('USER_NOT_FOUND', 'User not found');
      }

      const ngnbLimits = user.getNgnbLimits();
      logger.info(`📋 User KYC Level ${user.kycLevel} NGNB limits: Daily ₦${ngnbLimits.daily.toLocaleString()}, Monthly ₦${ngnbLimits.monthly.toLocaleString()}`);

      // Check if user has any NGNB transaction limits
      if (user.kycLevel <= 1) {
        return this.createErrorResponse('KYC_LEVEL_INSUFFICIENT', 'Higher KYC level required for NGNB transactions', {
          kycLevel: user.kycLevel,
          requiredLevel: 2,
          transactionType: 'NGNB',
          requiredAction: 'Complete KYC Level 2 verification for NGNB transactions',
          amount
        });
      }

      const currentSpending = await this.getCurrentSpending(userId);
      const newDailyTotal = currentSpending.ngnb.daily + amount;
      const newMonthlyTotal = currentSpending.ngnb.monthly + amount;

      const dailyExceeded = newDailyTotal > ngnbLimits.daily;
      const monthlyExceeded = newMonthlyTotal > ngnbLimits.monthly;

      if (dailyExceeded || monthlyExceeded) {
        const limitType = dailyExceeded ? 'daily' : 'monthly';
        const currentLimit = dailyExceeded ? ngnbLimits.daily : ngnbLimits.monthly;
        const currentSpent = dailyExceeded ? currentSpending.ngnb.daily : currentSpending.ngnb.monthly;
        const availableAmount = Math.max(0, currentLimit - currentSpent);

        return this.createErrorResponse('NGNB_LIMIT_EXCEEDED', `${limitType.charAt(0).toUpperCase() + limitType.slice(1)} NGNB transaction limit exceeded`, {
          kycLevel: user.kycLevel,
          transactionType: 'NGNB',
          limitType,
          requestedAmount: amount,
          currentLimit,
          currentSpent,
          availableAmount,
          newTotal: limitType === 'daily' ? newDailyTotal : newMonthlyTotal,
          upgradeRecommendation: this.getUpgradeRecommendation(user.kycLevel, 'NGNB')
        });
      }

      return this.createSuccessResponse('NGNB_TRANSACTION_ALLOWED', 'NGNB transaction within limits', {
        kycLevel: user.kycLevel,
        transactionType: 'NGNB',
        limits: ngnbLimits,
        currentSpending: currentSpending.ngnb,
        requestedAmount: amount,
        newDailyTotal,
        newMonthlyTotal,
        dailyRemaining: ngnbLimits.daily - newDailyTotal,
        monthlyRemaining: ngnbLimits.monthly - newMonthlyTotal
      });

    } catch (error) {
      logger.error('❌ NGNB validation error:', error);
      return this.createErrorResponse('VALIDATION_ERROR', 'Failed to validate NGNB transaction limits', {
        error: error.message
      });
    }
  }

  /**
   * Validate crypto withdrawal
   * @param {string} userId - User ID
   * @param {number} amount - Transaction amount in crypto
   * @param {string} currency - Crypto currency (BTC, ETH, SOL, etc.)
   * @returns {Object} Validation result
   */
  async validateCryptoTransaction(userId, amount, currency) {
    try {
      logger.info(`🔍 Crypto validation started for user ${userId}: ${amount} ${currency}`);

      const user = await this.getUser(userId);
      if (!user) {
        return this.createErrorResponse('USER_NOT_FOUND', 'User not found');
      }

      const cryptoLimits = user.getCryptoLimits();
      logger.info(`📋 User KYC Level ${user.kycLevel} Crypto limits: Daily $${cryptoLimits.daily.toLocaleString()}, Monthly $${cryptoLimits.monthly.toLocaleString()}`);

      // Convert crypto amount to USD
      const amountInUSD = await this.convertCryptoToUSD(amount, currency);
      logger.info(`💰 Crypto conversion: ${amount} ${currency} = $${amountInUSD.toLocaleString()}`);

      // Check if user has any crypto transaction limits
      if (user.kycLevel <= 1) {
        return this.createErrorResponse('KYC_LEVEL_INSUFFICIENT', 'Higher KYC level required for crypto transactions', {
          kycLevel: user.kycLevel,
          requiredLevel: 2,
          transactionType: 'CRYPTO',
          requiredAction: 'Complete KYC Level 2 verification for crypto transactions',
          amount,
          currency,
          amountInUSD
        });
      }

      const currentSpending = await this.getCurrentSpending(userId);
      const newDailyTotal = currentSpending.crypto.daily + amountInUSD;
      const newMonthlyTotal = currentSpending.crypto.monthly + amountInUSD;

      const dailyExceeded = newDailyTotal > cryptoLimits.daily;
      const monthlyExceeded = newMonthlyTotal > cryptoLimits.monthly;

      if (dailyExceeded || monthlyExceeded) {
        const limitType = dailyExceeded ? 'daily' : 'monthly';
        const currentLimit = dailyExceeded ? cryptoLimits.daily : cryptoLimits.monthly;
        const currentSpent = dailyExceeded ? currentSpending.crypto.daily : currentSpending.crypto.monthly;
        const availableAmount = Math.max(0, currentLimit - currentSpent);

        return this.createErrorResponse('CRYPTO_LIMIT_EXCEEDED', `${limitType.charAt(0).toUpperCase() + limitType.slice(1)} crypto transaction limit exceeded`, {
          kycLevel: user.kycLevel,
          transactionType: 'CRYPTO',
          limitType,
          requestedAmount: amountInUSD,
          currentLimit,
          currentSpent,
          availableAmount,
          newTotal: limitType === 'daily' ? newDailyTotal : newMonthlyTotal,
          originalAmount: amount,
          currency,
          upgradeRecommendation: this.getUpgradeRecommendation(user.kycLevel, 'CRYPTO')
        });
      }

      return this.createSuccessResponse('CRYPTO_TRANSACTION_ALLOWED', 'Crypto transaction within limits', {
        kycLevel: user.kycLevel,
        transactionType: 'CRYPTO',
        limits: cryptoLimits,
        currentSpending: currentSpending.crypto,
        requestedAmount: amountInUSD,
        originalAmount: amount,
        currency,
        newDailyTotal,
        newMonthlyTotal,
        dailyRemaining: cryptoLimits.daily - newDailyTotal,
        monthlyRemaining: cryptoLimits.monthly - newMonthlyTotal
      });

    } catch (error) {
      logger.error('❌ Crypto validation error:', error);
      return this.createErrorResponse('VALIDATION_ERROR', 'Failed to validate crypto transaction limits', {
        error: error.message
      });
    }
  }

  /**
   * Validate utility/bill payment transaction
   * @param {string} userId - User ID
   * @param {number} amount - Transaction amount in Naira
   * @returns {Object} Validation result
   */
  async validateUtilityTransaction(userId, amount) {
    try {
      logger.info(`🔍 Utility validation started for user ${userId}: ₦${amount.toLocaleString()}`);

      const user = await this.getUser(userId);
      if (!user) {
        return this.createErrorResponse('USER_NOT_FOUND', 'User not found');
      }

      const utilityLimits = user.getUtilityLimits();
      logger.info(`📋 User KYC Level ${user.kycLevel} Utility limits: Daily ₦${utilityLimits.daily.toLocaleString()}, Monthly ₦${utilityLimits.monthly.toLocaleString()}`);

      // Check if user has any utility transaction limits
      if (user.kycLevel === 0) {
        return this.createErrorResponse('KYC_REQUIRED', 'KYC verification required for utility transactions', {
          kycLevel: 0,
          requiredLevel: 1,
          transactionType: 'UTILITY',
          requiredAction: 'Complete KYC Level 1 verification for utility payments',
          amount
        });
      }

      const currentSpending = await this.getCurrentSpending(userId);
      const newDailyTotal = currentSpending.utilities.daily + amount;
      const newMonthlyTotal = currentSpending.utilities.monthly + amount;

      const dailyExceeded = newDailyTotal > utilityLimits.daily;
      const monthlyExceeded = newMonthlyTotal > utilityLimits.monthly;

      if (dailyExceeded || monthlyExceeded) {
        const limitType = dailyExceeded ? 'daily' : 'monthly';
        const currentLimit = dailyExceeded ? utilityLimits.daily : utilityLimits.monthly;
        const currentSpent = dailyExceeded ? currentSpending.utilities.daily : currentSpending.utilities.monthly;
        const availableAmount = Math.max(0, currentLimit - currentSpent);

        return this.createErrorResponse('UTILITY_LIMIT_EXCEEDED', `${limitType.charAt(0).toUpperCase() + limitType.slice(1)} utility transaction limit exceeded`, {
          kycLevel: user.kycLevel,
          transactionType: 'UTILITY',
          limitType,
          requestedAmount: amount,
          currentLimit,
          currentSpent,
          availableAmount,
          newTotal: limitType === 'daily' ? newDailyTotal : newMonthlyTotal,
          upgradeRecommendation: this.getUpgradeRecommendation(user.kycLevel, 'UTILITY')
        });
      }

      return this.createSuccessResponse('UTILITY_TRANSACTION_ALLOWED', 'Utility transaction within limits', {
        kycLevel: user.kycLevel,
        transactionType: 'UTILITY',
        limits: utilityLimits,
        currentSpending: currentSpending.utilities,
        requestedAmount: amount,
        newDailyTotal,
        newMonthlyTotal,
        dailyRemaining: utilityLimits.daily - newDailyTotal,
        monthlyRemaining: utilityLimits.monthly - newMonthlyTotal
      });

    } catch (error) {
      logger.error('❌ Utility validation error:', error);
      return this.createErrorResponse('VALIDATION_ERROR', 'Failed to validate utility transaction limits', {
        error: error.message
      });
    }
  }

  /**
   * Get user by ID
   */
  async getUser(userId) {
    try {
      const user = await User.findById(userId).select('+kycLevel +kyc');
      return user;
    } catch (error) {
      logger.error('Failed to fetch user:', error);
      throw new Error('User lookup failed');
    }
  }

  /**
   * Convert crypto amount to USD using offramp service
   */
  async convertCryptoToUSD(amount, currency) {
    try {
      // For stablecoins and USD, return as-is
      if (currency === 'USD' || currency === 'USDT' || currency === 'USDC') {
        return amount;
      }

      // For cryptocurrencies, first get USD value then use offramp service if needed
      if (['BTC', 'ETH', 'SOL'].includes(currency)) {
        const prices = await this.getCryptoPricesFromCurrencyAPI();
        const cryptoPrice = prices[currency];
        
        if (!cryptoPrice) {
          throw new Error(`Price not available for ${currency}`);
        }

        const usdValue = amount * cryptoPrice;
        logger.info(`💱 Crypto to USD conversion: ${amount} ${currency} @ ${cryptoPrice} = ${usdValue.toLocaleString()}`);
        return usdValue;
      }

      throw new Error(`Unsupported crypto currency: ${currency}`);

    } catch (error) {
      logger.error(`Crypto to USD conversion failed for ${amount} ${currency}:`, error);
      throw new Error(`Failed to convert ${currency} to USD: ${error.message}`);
    }
  }

  /**
   * Convert any currency amount to Naira using offramp service
   */
  async convertToNaira(amount, currency) {
    // NGNB and NGN are 1:1 with Naira
    if (currency === 'NGNB' || currency === 'NGN' || currency === 'NAIRA') {
      return amount;
    }

    try {
      // For stablecoins, convert directly via USD rate using offramp service
      if (currency === 'USDT' || currency === 'USDC') {
        return await offrampService.convertUsdToNaira(amount);
      }

      // For USD, use offramp service
      if (currency === 'USD') {
        return await offrampService.convertUsdToNaira(amount);
      }

      // For cryptocurrencies, convert to USD first, then to Naira via offramp service
      if (['BTC', 'ETH', 'SOL'].includes(currency)) {
        const prices = await this.getCryptoPricesFromCurrencyAPI();
        const cryptoPrice = prices[currency];
        
        if (!cryptoPrice) {
          throw new Error(`Price not available for ${currency}`);
        }

        const usdValue = amount * cryptoPrice;
        const nairaValue = await offrampService.convertUsdToNaira(usdValue);
        
        logger.info(`💱 Crypto conversion via offramp service: ${amount} ${currency} @ ${cryptoPrice} = ${usdValue} = ₦${nairaValue.toLocaleString()}`);
        return nairaValue;
      }

      // Unsupported currency
      throw new Error(`Unsupported currency: ${currency}. Supported: NGNB, NGN, USD, USDT, USDC, BTC, ETH, SOL`);

    } catch (error) {
      logger.error(`Currency conversion failed for ${amount} ${currency}:`, error);
      throw new Error(`Failed to convert ${currency} to Naira: ${error.message}`);
    }
  }

  /**
   * Get conversion rate for a currency to Naira using offramp service
   */
  async getConversionRate(currency) {
    if (currency === 'NGNB' || currency === 'NGN') return 1;
    
    try {
      if (currency === 'USD' || currency === 'USDT' || currency === 'USDC') {
        const rate = await offrampService.getUsdToNgnRate();
        return rate.finalPrice;
      }

      // For cryptocurrencies, calculate conversion rate using CurrencyAPI + offramp service
      if (['BTC', 'ETH', 'SOL'].includes(currency)) {
        const prices = await this.getCryptoPricesFromCurrencyAPI();
        const cryptoPriceUSD = prices[currency];
        
        if (!cryptoPriceUSD) {
          throw new Error(`Price not available for ${currency}`);
        }

        const usdToNairaRate = await offrampService.getUsdToNgnRate();
        return cryptoPriceUSD * usdToNairaRate.finalPrice;
      }

      return null;
    } catch (error) {
      logger.error(`Failed to get conversion rate for ${currency}:`, error);
      return null;
    }
  }

  /**
   * Get crypto prices using CurrencyAPI
   */
  async getCryptoPricesFromCurrencyAPI() {
    try {
      const tokenSymbols = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC'];
      const prices = await getPricesWithCache(tokenSymbols);
      
      if (!prices || Object.keys(prices).length === 0) {
        throw new Error('No prices returned from CurrencyAPI');
      }

      logger.info(`📈 CurrencyAPI prices: ${Object.entries(prices).map(([symbol, price]) => `${symbol}=$${price}`).join(', ')}`);
      return prices;

    } catch (error) {
      logger.error('Failed to get prices from CurrencyAPI:', error);
      throw new Error(`CurrencyAPI price fetch failed: ${error.message}`);
    }
  }

  /**
   * Calculate current spending for all transaction types
   */
  async getCurrentSpending(userId) {
    const cacheKey = `spending_${userId}`;
    
    // Check cache first
    if (this.cache.userSpending.has(cacheKey) && 
        this.cache.cacheExpiry.has(cacheKey) && 
        Date.now() < this.cache.cacheExpiry.get(cacheKey)) {
      return this.cache.userSpending.get(cacheKey);
    }

    try {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      // Get transactions
      const [regularTransactions, billTransactions] = await Promise.all([
        this.getSuccessfulTransactions(userId, startOfMonth),
        this.getSuccessfulBillTransactions(userId, startOfMonth)
      ]);

      // Calculate spending by category and time period
      const spending = {
        ngnb: {
          daily: await this.sumNgnbTransactionsByDate(regularTransactions, startOfDay),
          monthly: await this.sumNgnbTransactionsByDate(regularTransactions, startOfMonth)
        },
        crypto: {
          daily: await this.sumCryptoTransactionsByDate(regularTransactions, startOfDay),
          monthly: await this.sumCryptoTransactionsByDate(regularTransactions, startOfMonth)
        },
        utilities: {
          daily: this.sumBillTransactionsByDate(billTransactions, startOfDay),
          monthly: this.sumBillTransactionsByDate(billTransactions, startOfMonth)
        },
        calculatedAt: now
      };

      // Cache the result
      this.cache.userSpending.set(cacheKey, spending);
      this.cache.cacheExpiry.set(cacheKey, Date.now() + this.cacheTimeout);

      logger.info(`📊 Current spending for user ${userId}:`, {
        ngnb: `Daily ₦${spending.ngnb.daily.toLocaleString()}, Monthly ₦${spending.ngnb.monthly.toLocaleString()}`,
        crypto: `Daily $${spending.crypto.daily.toLocaleString()}, Monthly $${spending.crypto.monthly.toLocaleString()}`,
        utilities: `Daily ₦${spending.utilities.daily.toLocaleString()}, Monthly ₦${spending.utilities.monthly.toLocaleString()}`
      });
      
      return spending;

    } catch (error) {
      logger.error('Failed to calculate current spending:', error);
      throw new Error('Failed to calculate current spending');
    }
  }

  /**
   * Get successful regular transactions
   */
  async getSuccessfulTransactions(userId, sinceDate) {
    return await Transaction.find({
      userId,
      type: 'WITHDRAWAL',
      status: { $in: ['SUCCESSFUL', 'CONFIRMED', 'APPROVED'] },
      createdAt: { $gte: sinceDate }
    }).select('amount currency createdAt').lean();
  }

  /**
   * Get successful bill transactions
   */
  async getSuccessfulBillTransactions(userId, sinceDate) {
    return await BillTransaction.find({
      userId,
      status: 'completed-api',
      createdAt: { $gte: sinceDate }
    }).select('amountNaira amountNGNB createdAt').lean();
  }

  /**
   * Sum NGNB transactions by date
   */
  async sumNgnbTransactionsByDate(transactions, sinceDate) {
    let sum = 0;
    
    for (const tx of transactions) {
      if (tx.createdAt >= sinceDate && (tx.currency === 'NGNB' || tx.currency === 'NGN' || !tx.currency)) {
        sum += tx.amount;
      }
    }
    
    return sum;
  }

  /**
   * Sum crypto transactions by date (converted to USD)
   */
  async sumCryptoTransactionsByDate(transactions, sinceDate) {
    let sum = 0;
    let cryptoPrices = null;
    
    const cryptoCurrencies = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC'];
    
    for (const tx of transactions) {
      if (tx.createdAt >= sinceDate && cryptoCurrencies.includes(tx.currency)) {
        try {
          if (['BTC', 'ETH', 'SOL'].includes(tx.currency) && !cryptoPrices) {
            cryptoPrices = await this.getCryptoPricesFromCurrencyAPI();
          }
          
          const amountInUSD = await this.convertCryptoToUSD(tx.amount, tx.currency);
          sum += amountInUSD;
        } catch (error) {
          logger.warn(`Failed to convert crypto transaction ${tx._id} (${tx.amount} ${tx.currency}):`, error.message);
        }
      }
    }
    
    return sum;
  }

  /**
   * Sum bill transactions by date
   */
  sumBillTransactionsByDate(transactions, sinceDate) {
    return transactions.reduce((sum, tx) => {
      if (tx.createdAt >= sinceDate) {
        const amount = tx.amountNaira || tx.amountNGNB || 0;
        return sum + amount;
      }
      return sum;
    }, 0);
  }

  /**
   * Get upgrade recommendation based on current KYC level and transaction type
   */
  getUpgradeRecommendation(currentLevel, transactionType) {
    const recommendations = {
      NGNB: {
        0: 'Complete KYC Level 2 verification to enable NGNB transactions',
        1: 'Complete KYC Level 2 verification to enable NGNB transactions',
        2: 'Complete KYC Level 3 verification for higher NGNB limits up to ₦50M daily'
      },
      CRYPTO: {
        0: 'Complete KYC Level 2 verification to enable crypto transactions',
        1: 'Complete KYC Level 2 verification to enable crypto transactions',
        2: 'Complete KYC Level 3 verification for higher crypto limits up to $5M'
      },
      UTILITY: {
        0: 'Complete KYC Level 1 verification to enable utility payments',
        1: 'Complete KYC Level 2 verification for higher utility limits up to ₦500K daily',
        2: 'Your utility limits are at maximum level'
      }
    };
    
    return recommendations[transactionType]?.[currentLevel] || 'Your account has maximum verification';
  }

  /**
   * Create standardized success response
   */
  createSuccessResponse(code, message, data = {}) {
    return {
      allowed: true,
      code,
      message,
      data,
      timestamp: new Date()
    };
  }

  /**
   * Create standardized error response
   */
  createErrorResponse(code, message, data = {}) {
    return {
      allowed: false,
      code,
      message,
      data,
      timestamp: new Date()
    };
  }

  /**
   * Check all limits for a user
   */
  async checkAllLimits(userId) {
    try {
      const user = await this.getUser(userId);
      if (!user) return null;

      const currentSpending = await this.getCurrentSpending(userId);
      const ngnbLimits = user.getNgnbLimits();
      const cryptoLimits = user.getCryptoLimits();
      const utilityLimits = user.getUtilityLimits();

      return {
        kycLevel: user.kycLevel,
        limits: {
          ngnb: ngnbLimits,
          crypto: cryptoLimits,
          utilities: utilityLimits
        },
        currentSpending,
        remaining: {
          ngnb: {
            daily: Math.max(0, ngnbLimits.daily - currentSpending.ngnb.daily),
            monthly: Math.max(0, ngnbLimits.monthly - currentSpending.ngnb.monthly)
          },
          crypto: {
            daily: Math.max(0, cryptoLimits.daily - currentSpending.crypto.daily),
            monthly: Math.max(0, cryptoLimits.monthly - currentSpending.crypto.monthly)
          },
          utilities: {
            daily: Math.max(0, utilityLimits.daily - currentSpending.utilities.daily),
            monthly: Math.max(0, utilityLimits.monthly - currentSpending.utilities.monthly)
          }
        }
      };
    } catch (error) {
      logger.error('Failed to check all limits:', error);
      throw error;
    }
  }

  /**
   * Clear cache for a specific user
   */
  clearUserCache(userId) {
    const cacheKey = `spending_${userId}`;
    this.cache.userSpending.delete(cacheKey);
    this.cache.cacheExpiry.delete(cacheKey);
  }

  /**
   * Clear all caches
   */
  clearAllCache() {
    this.cache.userSpending.clear();
    this.cache.cacheExpiry.clear();
  }
}

// Create singleton instance
const kycLimitService = new KYCLimitService();

module.exports = {
  KYCLimitService,
  kycLimitService,
  
  // Main validation methods for different transaction types
  validateNgnbTransaction: (userId, amount) => 
    kycLimitService.validateNgnbTransaction(userId, amount),
  
  validateCryptoTransaction: (userId, amount, currency) => 
    kycLimitService.validateCryptoTransaction(userId, amount, currency),
  
  validateUtilityTransaction: (userId, amount) => 
    kycLimitService.validateUtilityTransaction(userId, amount),
  
  // Utility methods
  checkAllLimits: (userId) => kycLimitService.checkAllLimits(userId),
  clearUserCache: (userId) => kycLimitService.clearUserCache(userId),
  clearAllCache: () => kycLimitService.clearAllCache(),
  
  // Direct access to service
  service: kycLimitService
};