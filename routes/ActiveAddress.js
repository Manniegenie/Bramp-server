const express = require('express');
const axios = require('axios');
const { attachObiexAuth, validateObiexConfig } = require('../utils/obiexAuth');
const router = express.Router();

// GET /addressplan/active
router.get('/active', async (req, res) => {
  try {
    validateObiexConfig();

    const axiosClient = axios.create({
      baseURL: `${(process.env.OBIEX_BASE_URL || 'https://api.obiex.finance').replace(/\/+$/, '')}/v1`,
      headers: { 'Content-Type': 'application/json' },
    });

    axiosClient.interceptors.request.use(attachObiexAuth);

    const response = await axiosClient.get('/currencies/networks/active');

    res.status(200).json({
      success: true,
      message: 'Fetched active networks from Obiex',
      data: response.data.data,
    });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      message: 'Failed to fetch active networks',
      error: error.response?.data || error.message,
    });
  }
});

module.exports = router;
