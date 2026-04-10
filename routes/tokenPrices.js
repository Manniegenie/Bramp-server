// routes/tokenPrices.js
const express = require('express');
const router = express.Router();
const PriceChange = require('../models/pricechange');

const PRICE_MARKDOWN_PERCENT = 0.68;
const PRICE_MULTIPLIER = (100 - PRICE_MARKDOWN_PERCENT) / 100;

const STABLECOINS = ['USDT', 'USDC', 'NGNZ'];

function applyMarkdown(price, symbol) {
  if (STABLECOINS.includes(symbol)) return price;
  return price * PRICE_MULTIPLIER;
}

function getTokenName(symbol) {
  const names = {
    BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', USDT: 'Tether',
    USDC: 'USD Coin', BNB: 'Binance Coin', MATIC: 'Polygon', TRX: 'Tron', NGNZ: 'Naira Token'
  };
  return names[symbol] || symbol;
}

const SUPPORTED_TOKENS = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'TRX'];

// GET /token-prices
router.get('/', async (req, res) => {
  try {
    const { symbols, includeChange } = req.query;
    const shouldIncludeChange = includeChange !== 'false';

    let requestedSymbols = SUPPORTED_TOKENS;
    if (symbols) {
      const symbolsArray = symbols.toUpperCase().split(',').map(s => s.trim());
      requestedSymbols = SUPPORTED_TOKENS.filter(token => symbolsArray.includes(token));
    }

    const priceResults = await Promise.all(
      requestedSymbols.map(symbol =>
        PriceChange.findOne({ symbol }).sort({ timestamp: -1 }).select('symbol price timestamp source')
      )
    );

    const tokenData = [];

    for (let i = 0; i < requestedSymbols.length; i++) {
      const symbol = requestedSymbols[i];
      const priceDoc = priceResults[i];
      if (!priceDoc) continue;

      const adjustedPrice = applyMarkdown(priceDoc.price, symbol);

      const tokenInfo = {
        symbol,
        name: getTokenName(symbol),
        price: adjustedPrice,
        lastUpdated: priceDoc.timestamp,
        source: priceDoc.source || 'binance'
      };

      if (shouldIncludeChange) {
        const historicalPrice = await PriceChange.getHistoricalPrice(symbol, 24);
        const adjustedHistorical = historicalPrice ? applyMarkdown(historicalPrice, symbol) : null;

        if (adjustedHistorical && adjustedHistorical > 0) {
          const change = adjustedPrice - adjustedHistorical;
          const percentChange = (change / adjustedHistorical) * 100;
          tokenInfo.change24h = parseFloat(percentChange.toFixed(2));
          tokenInfo.changeAbsolute24h = parseFloat(change.toFixed(8));
          tokenInfo.price24hAgo = parseFloat(adjustedHistorical.toFixed(8));
        } else {
          tokenInfo.change24h = 0;
          tokenInfo.changeAbsolute24h = 0;
          tokenInfo.price24hAgo = adjustedPrice;
        }
      }

      tokenData.push(tokenInfo);
    }

    res.json({ success: true, data: tokenData, timestamp: new Date().toISOString(), count: tokenData.length });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch token prices', message: error.message });
  }
});

// GET /token-prices/:symbol
router.get('/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();

    if (!SUPPORTED_TOKENS.includes(symbol)) {
      return res.status(400).json({ success: false, error: 'Invalid token symbol', supportedTokens: SUPPORTED_TOKENS });
    }

    const latestPrice = await PriceChange.findOne({ symbol }).sort({ timestamp: -1 }).select('symbol price timestamp source');

    if (!latestPrice) {
      return res.status(404).json({ success: false, error: 'Price data not available for this token' });
    }

    const adjustedPrice = applyMarkdown(latestPrice.price, symbol);
    const historicalPrice = await PriceChange.getHistoricalPrice(symbol, 24);
    const adjustedHistorical = historicalPrice ? applyMarkdown(historicalPrice, symbol) : null;

    let change24h = 0;
    let changeAbsolute24h = 0;
    if (adjustedHistorical && adjustedHistorical > 0) {
      const change = adjustedPrice - adjustedHistorical;
      change24h = parseFloat(((change / adjustedHistorical) * 100).toFixed(2));
      changeAbsolute24h = parseFloat(change.toFixed(8));
    }

    const response = {
      success: true,
      data: {
        symbol,
        name: getTokenName(symbol),
        price: adjustedPrice,
        change24h,
        changeAbsolute24h,
        price24hAgo: adjustedHistorical || adjustedPrice,
        lastUpdated: latestPrice.timestamp,
        source: latestPrice.source || 'binance'
      },
      timestamp: new Date().toISOString()
    };

    if (req.query.includeHistory === 'true') {
      const history = await PriceChange.getPriceHistory(symbol, 24);
      response.data.history24h = history.map(h => ({ price: h.price, timestamp: h.timestamp }));
    }

    res.json(response);
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to fetch token price', message: error.message });
  }
});

module.exports = router;
