// routes/fetchnaira.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { attachObiexAuth } = require('../utils/obiexAuth');
const logger = require('../utils/logger');

router.get('/naira-accounts', async (_req, res) => {
  logger.info('Get Naira Accounts - Request received');

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  try {
    let config = {
      method: 'get',
      maxBodyLength: Infinity,
      url: 'ngn-payments/banks',
      headers: {}
    };

    config = attachObiexAuth(config);

    const baseURL = process.env.OBIEX_BASE_URL || 'https://api.obiex.finance/';
    config.url = `${baseURL}${config.url}`;

    logger.info('Making request to Obiex API:', { url: config.url });

    const response = await axios(config);

    logger.info('Obiex API response received:', {
      status: response.status,
      dataLength: response.data?.data?.length || 0
    });

    if (!response.data || !response.data.data) {
      logger.warn('Invalid response structure from Obiex API');
      return res.status(502).json({ error: 'Invalid response from payment provider' });
    }

    return res.status(200).json({
      success: true,
      data: response.data
    });

  } catch (error) {
    logger.error('Get Naira Accounts - Error occurred:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
