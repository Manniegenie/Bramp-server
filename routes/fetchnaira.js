// routes/fetchnaira.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { attachObiexAuth } = require('../utils/obiexAuth');
const logger = require('../utils/logger');

router.get('/naira-accounts', async (_req, res) => {
  logger.info('Get Naira Accounts - Request received');

  // no cache
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  try {
    // prepare provider call
    let cfg = { method: 'get', url: 'ngn-payments/banks', headers: {} };
    cfg = attachObiexAuth(cfg); // should add Authorization and possibly /v1

    const base = (process.env.OBIEX_BASE_URL || 'https://api.obiex.finance').replace(/\/+$/, '');
    const path = String(cfg.url || 'ngn-payments/banks');
    const finalUrl = `${base}${path.startsWith('/') ? path : `/${path}`}`;

    logger.info('Obiex URL', { url: finalUrl });

    const resp = await axios.get(finalUrl, {
      headers: cfg.headers,
      timeout: 15000,
      maxBodyLength: Infinity,
    });

    // Obiex shape: { message: "Ok", data: [ { name, uuid, sortCode }, ... ] }
    const raw = Array.isArray(resp.data?.data) ? resp.data.data : [];

    const seen = new Set();
    const banks = raw
      .map((b) => {
        const name = String(b?.name ?? '').trim();
        // prefer sortCode, then uuid, then any 'code' if they ever add it
        const code = String(b?.sortCode ?? b?.uuid ?? b?.code ?? '').trim();
        return { name, code };
      })
      .filter((b) => b.name && b.code && !seen.has(b.code) && (seen.add(b.code), true))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    logger.info('Banks normalized', { count: banks.length });

    return res.status(200).json({ banks, count: banks.length });
  } catch (err) {
    const obiexStatus = err?.response?.status;
    const obiexData = err?.response?.data;
    logger.error('Banks fetch failed', {
      message: err?.message,
      obiexStatus,
      obiexData,
      code: err?.code,
    });

    if (obiexStatus === 401 || obiexStatus === 403) {
      return res.status(502).json({ banks: [], count: 0, error: 'Obiex auth failed — check API key/secret', detail: obiexStatus });
    }
    if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') {
      return res.status(504).json({ banks: [], count: 0, error: 'Obiex API timed out' });
    }
    if (obiexStatus) {
      return res.status(502).json({ banks: [], count: 0, error: `Obiex returned ${obiexStatus}`, detail: obiexData });
    }
    return res.status(502).json({ banks: [], count: 0, error: 'Failed to fetch banks', detail: err?.message });
  }
});

module.exports = router;
