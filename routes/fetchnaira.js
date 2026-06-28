// routes/fetchnaira.js
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { getNairaBanks, UpstreamError } = require('../services/bankaccounts');

router.get('/naira-accounts', async (_req, res) => {
  logger.info('Get Naira Accounts - Request received');

  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  try {
    const result = await getNairaBanks();

    // Obiex wraps in { data: [...] }; unwrap and normalize fields for all app versions
    const raw = result?.data || result;
    const list = Array.isArray(raw) ? raw : [];
    const data = list.map(b => {
      const sortCode = b.sortCode || b.code || b.bank_code || b.sort_code || '';
      return {
        name:      b.name || b.bank_name || '',
        code:      sortCode,
        bank_code: sortCode,
        sortCode:  sortCode,
        uuid:      b.uuid || b.id || '',
      };
    }).filter(b => b.name && b.code);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    logger.error('Get Naira Accounts - Error occurred:', {
      message: error.message,
      status: error.status,
    });

    return res.status(502).json({ error: 'Failed to fetch banks' });
  }
});

module.exports = router;
