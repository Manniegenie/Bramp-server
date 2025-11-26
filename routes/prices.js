// routes/prices.js
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');

const {
  getPricesWithCache,
  getOriginalPricesWithCache,
  getHourlyPriceChanges,
  getGlobalMarkdownPercentage,
  SUPPORTED_TOKENS,
  isTokenSupported
} = require('../services/portfolio');

// Import offramp price service (NGNB rate)
const { getCurrentRate } = require('../services/offramppriceservice');

// Helper: parse symbols query param into an array of validated tokens
function parseSymbolsParam(symbolsParam) {
  if (!symbolsParam) return Object.keys(SUPPORTED_TOKENS);
  const raw = String(symbolsParam || '');
  const tokens = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  // Validate tokens and dedupe
  const unique = [...new Set(tokens)];
  const valid = unique.filter(t => SUPPORTED_TOKENS.hasOwnProperty(t));
  return valid.length ? valid : [];
}

// GET /api/prices?symbols=BTC,ETH&original=true&changes=true&limit=10
router.get('/prices', async (req, res) => {
  const start = Date.now();
  try {
    // parse query params
    const symbolsParam = req.query.symbols;
    let symbols = parseSymbolsParam(symbolsParam);

    // default: all supported tokens
    if (!symbols || symbols.length === 0) {
      symbols = Object.keys(SUPPORTED_TOKENS);
    }

    // enforce limit
    const requestedLimit = parseInt(req.query.limit || '0', 10);
    const LIMIT = Number.isInteger(requestedLimit) && requestedLimit > 0 ? Math.min(requestedLimit, 50) : Math.min(symbols.length, 50);
    symbols = symbols.slice(0, LIMIT);

    const wantOriginal = String(req.query.original || 'false').toLowerCase() === 'true';
    const wantChanges = String(req.query.changes || 'false').toLowerCase() === 'true';

    logger.info('Price endpoint requested', { symbols, wantOriginal, wantChanges });

    // Fetch prices with markdown applied
    const pricesPromise = getPricesWithCache(symbols);

    // Optionally fetch original (pre-markdown) prices
    const originalPromise = wantOriginal ? getOriginalPricesWithCache(symbols) : Promise.resolve({});

    // Optionally fetch hourly changes (job-populated)
    const changesPromise = wantChanges ? getHourlyPriceChanges(symbols) : Promise.resolve({});

    // Also fetch markdown info for meta
    const markdownPromise = getGlobalMarkdownPercentage();

    // Also fetch NGNB rate from offramp service (we'll attach to prices if present)
    const ngnbPromise = getCurrentRate();

    const [pricesSettled, originalSettled, changesSettled, markdownSettled, ngnbSettled] = await Promise.allSettled([
      pricesPromise,
      originalPromise,
      changesPromise,
      markdownPromise,
      ngnbPromise
    ]);

    // unwrap results
    const pricesVal = pricesSettled.status === 'fulfilled' ? pricesSettled.value : {};
    const originalVal = originalSettled.status === 'fulfilled' ? originalSettled.value : {};
    const changesVal = changesSettled.status === 'fulfilled' ? changesSettled.value : {};
    const markdownVal = markdownSettled.status === 'fulfilled' ? markdownSettled.value : { hasMarkdown: false, percentage: 0 };
    const ngnbVal = ngnbSettled.status === 'fulfilled' ? ngnbSettled.value : null;

    // Attach NGNB price if we have an offramp rate and the client requested NGNB (or asked for all tokens)
    // Ensure we always include NGNB in the returned prices object if supported in requested symbols OR if symbols param was omitted.
    const shouldIncludeNGNB = symbols.includes('NGNB') || (!req.query.symbols);
    if (shouldIncludeNGNB && ngnbVal && typeof ngnbVal.finalPrice === 'number') {
      // Add NGNB to both prices and originalPrices where applicable
      pricesVal.NGNB = ngnbVal.finalPrice;
      if (wantOriginal) originalVal.NGNB = ngnbVal.finalPrice;
      logger.info('Attached NGNB offramp price to response', { ngnb: ngnbVal.finalPrice, source: ngnbVal.source });
    } else {
      // If NGNB requested but offramp rate unavailable, log a warning
      if (symbols.includes('NGNB') && (!ngnbVal || typeof ngnbVal.finalPrice !== 'number')) {
        logger.warn('NGNB requested but offramp rate unavailable; NGNB omitted from prices');
      }
    }

    const response = {
      success: true,
      data: {
        prices: pricesVal,
        ...(wantOriginal ? { originalPrices: originalVal } : {}),
        ...(wantChanges ? { hourlyChanges: changesVal } : {}),
        markdown: {
          hasMarkdown: !!markdownVal.hasMarkdown,
          percentage: markdownVal.percentage || 0,
          formattedPercentage: markdownVal.formattedPercentage || null
        },
        ngnbExchangeRate: ngnbVal ? {
          rate: ngnbVal.finalPrice,
          lastUpdated: ngnbVal.lastUpdated || null,
          source: ngnbVal.source || null
        } : null,
        timestamp: new Date().toISOString()
      },
      meta: {
        requestedSymbols: symbols,
        usingPriceChangeModel: true,
        durationMs: Date.now() - start
      }
    };

    // Set cache-control header (short caching; frontend can decide)
    // Note: we do not cache server-side here — this just hints clients
    res.set('Cache-Control', 'public, max-age=10'); // 10 seconds

    return res.status(200).json(response);
  } catch (err) {
    logger.error('Prices endpoint failed', { error: err.message, stack: err.stack });
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch prices',
      error: err.message
    });
  }
});

module.exports = router;
