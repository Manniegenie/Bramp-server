// utils/sellQuote.js
const NairaMarkdown = require('../models/offramp');
const { getPricesWithCache } = require('../services/portfolio');
const logger = require('./logger');

/* Constants */
const FALLBACK_OFFRAMP_RATE_NGN_PER_USD = 1554.42;

/**
 * Get effective NGN per USD rate with markup applied
 */
async function getEffectiveNgnPerUsd(log = logger) {
  const doc = await NairaMarkdown.findOne().lean();
  const base = doc?.offrampRate || FALLBACK_OFFRAMP_RATE_NGN_PER_USD;
  const appliedMarkupPct = Number(doc?.markup || 0);
  const effective = base * (appliedMarkupPct > 0 ? (1 - appliedMarkupPct / 100) : 1);
  
  log.info?.('Offramp NGN/USD resolved', { 
    baseRate: base, 
    appliedMarkupPct, 
    effectiveRate: effective 
  });
  
  return { 
    ngnPerUsd: effective, 
    baseNgnPerUsd: base, 
    appliedMarkupPct 
  };
}

/**
 * Get sell quote - calculates NGN receive amount for a given token amount
 * @param {Object} params - Quote parameters
 * @param {string} params.token - Token symbol (e.g., 'BTC', 'USDT')
 * @param {number} params.amount - Amount of token to sell
 * @param {Object} log - Logger instance
 * @returns {Object} Quote with rate, receive amount, and breakdown
 */
async function getSellQuote({ token, amount }, log = logger) {
  const tokenU = String(token).toUpperCase();
  const numericAmount = Number(amount);
  
  if (!isFinite(numericAmount) || numericAmount <= 0) {
    const err = new Error('Invalid amount'); 
    err.status = 400; 
    throw err;
  }

  const { ngnPerUsd, baseNgnPerUsd, appliedMarkupPct } = await getEffectiveNgnPerUsd(log);

  const prices = await getPricesWithCache([tokenU]);
  let usdPerToken = Number(prices[tokenU] || 0);
  
  if (!usdPerToken || !isFinite(usdPerToken) || usdPerToken <= 0) {
    if (tokenU === 'USDT' || tokenU === 'USDC') {
      usdPerToken = 1;
    } else {
      const err = new Error(`Price unavailable for token ${tokenU}`); 
      err.status = 503; 
      throw err;
    }
  }

  const rateNgnPerToken = usdPerToken * ngnPerUsd;  // NGN per 1 token
  const receiveAmount = Math.round(numericAmount * rateNgnPerToken);

  log.info?.('Quote computed', {
    token: tokenU,
    sellAmount: numericAmount,
    usdPerToken,
    ngnPerUsd,
    rateNgnPerToken,
    receiveAmount,
  });

  return {
    rate: rateNgnPerToken,
    receiveAmount,
    breakdown: {
      usdPerToken,
      ngnPerUsdEffective: ngnPerUsd,
      ngnPerUsdBase: baseNgnPerUsd,
      appliedOfframpMarkupPct: appliedMarkupPct,
    },
  };
}

/**
 * Calculate actual receive amount for observed deposit amount
 * @param {number} observedAmount - Actual amount deposited
 * @param {string} token - Token symbol
 * @param {Object} log - Logger instance
 * @returns {Object} Calculation result with actual receive amount and rate
 */
async function calculateActualReceiveAmount(observedAmount, token, log = logger) {
  const tokenU = String(token).toUpperCase();
  const numericAmount = Number(observedAmount);
  
  if (!isFinite(numericAmount) || numericAmount <= 0) {
    throw new Error('Invalid observed amount');
  }

  try {
    // Use the same getSellQuote function for consistency
    const quote = await getSellQuote({ token: tokenU, amount: numericAmount }, log);
    
    log.info?.('Actual receive amount calculated', {
      token: tokenU,
      observedAmount: numericAmount,
      actualReceiveAmount: quote.receiveAmount,
      rate: quote.rate,
      breakdown: quote.breakdown,
      source: 'getSellQuote from utils/sellQuote'
    });

    return {
      actualReceiveAmount: quote.receiveAmount,
      rate: quote.rate,
      breakdown: quote.breakdown
    };
  } catch (error) {
    log.error?.('Failed to calculate actual receive amount', {
      error: error.message,
      token: tokenU,
      observedAmount: numericAmount
    });
    throw error;
  }
}

module.exports = {
  getSellQuote,
  calculateActualReceiveAmount,
  getEffectiveNgnPerUsd
};