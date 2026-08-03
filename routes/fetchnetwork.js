// routes/fetchnetwork.js
const express = require('express');
const router = express.Router();
const TokenNetwork = require('../models/tokenNetwork');
const logger = require('../utils/logger');

const TOKEN_META = {
  BTC: { name: 'Bitcoin', decimals: 8, isStablecoin: false },
  ETH: { name: 'Ethereum', decimals: 18, isStablecoin: false },
  SOL: { name: 'Solana', decimals: 9, isStablecoin: false },
  USDT: { name: 'Tether', decimals: 6, isStablecoin: true },
  USDC: { name: 'USD Coin', decimals: 6, isStablecoin: true },
  BNB: { name: 'Binance Coin', decimals: 18, isStablecoin: false },
  MATIC: { name: 'Polygon', decimals: 18, isStablecoin: false },
  AVAX: { name: 'Avalanche', decimals: 18, isStablecoin: false },
  NGNB: { name: 'Naira', decimals: 2, isStablecoin: true },
};

// GET /networks/fetch-network?currency=BTC — enabled networks for one token
router.get('/fetch-network', async (req, res) => {
  try {
    const { currency } = req.query;

    if (!currency || !currency.trim()) {
      return res.status(400).json({ success: false, error: 'MISSING_CURRENCY', message: 'Currency parameter is required' });
    }

    const upperCurrency = currency.toUpperCase();

    const networkDocs = await TokenNetwork.find(
      { token: upperCurrency, enabled: true },
      { networkId: 1, networkName: 1, order: 1, _id: 0 }
    ).sort({ order: 1 });

    if (!networkDocs || networkDocs.length === 0) {
      return res.status(404).json({ success: false, error: 'NO_NETWORKS_FOUND', message: `No enabled networks found for currency ${upperCurrency}` });
    }

    const networks = networkDocs.map((doc) => ({
      network: doc.networkId,
      networkName: doc.networkName,
    }));

    res.status(200).json({ success: true, data: { currency: upperCurrency, networks, total: networks.length } });
  } catch (error) {
    logger.error('Error fetching networks for currency', { currency: req.query.currency, error: error.message });
    res.status(500).json({ success: false, error: 'NETWORK_FETCH_ERROR', message: 'Failed to fetch networks for the specified currency' });
  }
});

// GET /networks/currencies — token metadata only, no network breakdown
router.get('/currencies', async (req, res) => {
  try {
    const tokens = await TokenNetwork.distinct('token', { enabled: true });
    const currencies = tokens.sort().map((symbol) => ({
      symbol,
      name: TOKEN_META[symbol]?.name || symbol,
      decimals: TOKEN_META[symbol]?.decimals ?? 18,
      isStablecoin: TOKEN_META[symbol]?.isStablecoin || false,
    }));

    res.status(200).json({ success: true, data: { currencies, total: currencies.length } });
  } catch (error) {
    logger.error('Error fetching supported currencies:', error);
    res.status(500).json({ success: false, error: 'CURRENCIES_FETCH_ERROR', message: 'Failed to retrieve supported currencies' });
  }
});

// GET /networks/all — every token with its enabled networks, in display order.
// This is what the app's deposit/withdraw token+network pickers consume.
router.get('/all', async (req, res) => {
  try {
    const networkDocs = await TokenNetwork.find({ enabled: true }).sort({ token: 1, order: 1 });

    if (!networkDocs || networkDocs.length === 0) {
      return res.status(404).json({ success: false, error: 'NO_NETWORKS_FOUND', message: 'No network configurations found' });
    }

    const networksByToken = {};
    networkDocs.forEach((doc) => {
      if (!networksByToken[doc.token]) networksByToken[doc.token] = [];
      networksByToken[doc.token].push({ network: doc.networkId, networkName: doc.networkName });
    });

    const result = Object.keys(networksByToken).map((token) => ({
      currency: token,
      currencyName: TOKEN_META[token]?.name || token,
      isStablecoin: TOKEN_META[token]?.isStablecoin || false,
      decimals: TOKEN_META[token]?.decimals ?? 18,
      networks: networksByToken[token],
      networkCount: networksByToken[token].length,
    }));

    res.status(200).json({ success: true, data: { currencies: result, totalCurrencies: result.length, totalNetworks: networkDocs.length } });
  } catch (error) {
    logger.error('Error fetching all networks', { error: error.message });
    res.status(500).json({ success: false, error: 'NETWORKS_FETCH_ERROR', message: 'Failed to fetch network configurations' });
  }
});

module.exports = router;
