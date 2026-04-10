// routes/fetchnetwork.js
const express = require('express');
const router = express.Router();
const CryptoFeeMarkup = require('../models/cryptofee');
const logger = require('../utils/logger');

const SUPPORTED_TOKENS = {
  BTC: { name: 'Bitcoin', symbol: 'BTC', decimals: 8, isStablecoin: false },
  ETH: { name: 'Ethereum', symbol: 'ETH', decimals: 18, isStablecoin: false },
  SOL: { name: 'Solana', symbol: 'SOL', decimals: 9, isStablecoin: false },
  USDT: { name: 'Tether', symbol: 'USDT', decimals: 6, isStablecoin: true },
  USDC: { name: 'USD Coin', symbol: 'USDC', decimals: 6, isStablecoin: true },
  BNB: { name: 'Binance Coin', symbol: 'BNB', decimals: 18, isStablecoin: false },
  MATIC: { name: 'Polygon', symbol: 'MATIC', decimals: 18, isStablecoin: false },
  TRX: { name: 'Tron', symbol: 'TRX', decimals: 6, isStablecoin: false },
  TON: { name: 'Toncoin', symbol: 'TON', decimals: 9, isStablecoin: false }
};

// GET /networks/fetch-network?currency=BTC
router.get('/fetch-network', async (req, res) => {
  try {
    const { currency } = req.query;

    if (!currency || !currency.trim()) {
      return res.status(400).json({ success: false, error: 'MISSING_CURRENCY', message: 'Currency parameter is required' });
    }

    const upperCurrency = currency.toUpperCase();

    if (!SUPPORTED_TOKENS[upperCurrency]) {
      return res.status(400).json({
        success: false,
        error: 'UNSUPPORTED_CURRENCY',
        message: `Currency ${upperCurrency} is not supported. Supported currencies: ${Object.keys(SUPPORTED_TOKENS).join(', ')}`
      });
    }

    logger.info('Fetching networks for currency', { currency: upperCurrency });

    const networkDocs = await CryptoFeeMarkup.find(
      { currency: upperCurrency },
      { network: 1, networkName: 1, feeUsd: 1, _id: 0 }
    ).sort({ network: 1 });

    if (!networkDocs || networkDocs.length === 0) {
      return res.status(404).json({ success: false, error: 'NO_NETWORKS_FOUND', message: `No networks found for currency ${upperCurrency}` });
    }

    const networks = networkDocs.map(doc => ({
      network: doc.network,
      networkName: doc.networkName || doc.network,
      feeUsd: doc.feeUsd
    }));

    res.status(200).json({ success: true, data: { currency: upperCurrency, networks, total: networks.length } });
  } catch (error) {
    logger.error('Error fetching networks for currency', { currency: req.query.currency, error: error.message });
    res.status(500).json({ success: false, error: 'NETWORK_FETCH_ERROR', message: 'Failed to fetch networks for the specified currency' });
  }
});

// GET /networks/currencies
router.get('/currencies', async (req, res) => {
  try {
    const currencies = Object.keys(SUPPORTED_TOKENS).map(currency => ({
      symbol: currency,
      name: SUPPORTED_TOKENS[currency].name || currency,
      decimals: SUPPORTED_TOKENS[currency].decimals || 18,
      isStablecoin: SUPPORTED_TOKENS[currency].isStablecoin || false
    }));

    res.status(200).json({ success: true, data: { currencies, total: currencies.length } });
  } catch (error) {
    logger.error('Error fetching supported currencies:', error);
    res.status(500).json({ success: false, error: 'CURRENCIES_FETCH_ERROR', message: 'Failed to retrieve supported currencies' });
  }
});

// GET /networks/all
router.get('/all', async (req, res) => {
  try {
    const networkDocs = await CryptoFeeMarkup.find({}, { currency: 1, network: 1, networkName: 1, feeUsd: 1, _id: 0 }).sort({ currency: 1, network: 1 });

    if (!networkDocs || networkDocs.length === 0) {
      return res.status(404).json({ success: false, error: 'NO_NETWORKS_FOUND', message: 'No network configurations found' });
    }

    const networksByCurrency = {};
    networkDocs.forEach(doc => {
      if (!networksByCurrency[doc.currency]) networksByCurrency[doc.currency] = [];
      networksByCurrency[doc.currency].push({ network: doc.network, networkName: doc.networkName || doc.network, feeUsd: doc.feeUsd });
    });

    const result = Object.keys(networksByCurrency).map(currency => ({
      currency,
      currencyName: SUPPORTED_TOKENS[currency]?.name || currency,
      isStablecoin: SUPPORTED_TOKENS[currency]?.isStablecoin || false,
      decimals: SUPPORTED_TOKENS[currency]?.decimals || 18,
      networks: networksByCurrency[currency],
      networkCount: networksByCurrency[currency].length
    }));

    res.status(200).json({ success: true, data: { currencies: result, totalCurrencies: result.length, totalNetworks: networkDocs.length } });
  } catch (error) {
    logger.error('Error fetching all networks', { error: error.message });
    res.status(500).json({ success: false, error: 'NETWORKS_FETCH_ERROR', message: 'Failed to fetch network configurations' });
  }
});

module.exports = router;
