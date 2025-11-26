// services/obiexService.js
const axios = require('axios');
const logger = require('../utils/logger');
const { attachObiexAuth } = require('../utils/obiexAuth');

const OBIEX_BASE_URL = process.env.OBIEX_BASE_URL || 'https://api.obiex.finance';

class UpstreamError extends Error {
  constructor(message, { status, data } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status || 502;
    this.data = data;
  }
}

// Build a final URL with EXACTLY one /v1 path segment.
// - If input is absolute, keep its origin/path and normalize /v1 duplication.
// - If input is relative, join with base (with base de-duped from /v1).
function buildFinalUrl(inputUrl) {
  const ABS = /^https?:\/\//i;
  const normalizeV1 = (url) => {
    // collapse repeated /v1/… -> one /v1/
    return url
      .replace(/\/v1\/+v1\//gi, '/v1/')
      .replace(/\/v1\/+v1\//gi, '/v1/'); // run twice just in case
  };

  if (ABS.test(inputUrl)) {
    // absolute from attachObiexAuth or elsewhere
    const u = inputUrl.replace(/\/+$/, '');
    return normalizeV1(u);
  }

  // relative path
  const baseNoTrail = (OBIEX_BASE_URL || '').replace(/\/+$/, '');
  // strip trailing /v1 (or /v1/) from base to avoid duplication
  const baseSansV1 = baseNoTrail.replace(/\/v1\/?$/i, '');
  // strip leading slashes from path
  const clean = String(inputUrl || '').replace(/^\/+/, '');
  // strip leading v1/ from path so we add it once
  const pathNoV1 = clean.replace(/^v1\/+/i, '');

  return `${baseSansV1}/v1/${pathNoV1}`;
}

/** Fetch NGN banks directory */
async function getNairaBanks() {
  let config = {
    method: 'get',
    maxBodyLength: Infinity,
    url: 'ngn-payments/banks', // relative by default
    headers: {},
    timeout: 15000,
  };

  // May mutate url to include base and/or /v1
  config = attachObiexAuth(config);

  const finalUrl = buildFinalUrl(config.url);
  const finalConfig = { ...config, url: finalUrl };

  logger.info('Obiex:getNairaBanks - Request', { url: finalUrl });

  try {
    const response = await axios(finalConfig);

    logger.info('Obiex:getNairaBanks - Response', {
      status: response.status,
      dataLength: response.data?.data?.length || 0,
    });

    if (!response.data || !('data' in response.data)) {
      logger.warn('Obiex:getNairaBanks - Invalid structure', { body: response.data });
      throw new UpstreamError('Invalid response from payment provider');
    }

    return response.data; // { data: [...] }
  } catch (error) {
    logger.error('Obiex:getNairaBanks - Error', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    throw new UpstreamError(error.message || 'Payment provider error', {
      status: error.response?.status || 502,
      data: error.response?.data,
    });
  }
}

module.exports = {
  getNairaBanks,
  UpstreamError,
};
