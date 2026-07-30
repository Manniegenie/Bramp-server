// services/nomba/client.js
//
// Single module owning all HTTP communication with Nomba (virtual accounts / bank
// transfer deposits). Mirrors this repo's existing third-party client conventions
// (auth/webhookauth.js style error handling, no raw provider errors leaked upward).
//
// NEVER log BVN, full account payloads containing BVN, or API credentials.
//
// Env required (see server.js boot validation):
//   NOMBA_BASE_URL, NOMBA_CLIENT_ID, NOMBA_CLIENT_SECRET, NOMBA_ACCOUNT_ID,
//   NOMBA_WEBHOOK_SECRET, NOMBA_ENV

const axios = require('axios');
const logger = require('../../utils/logger');

const TOKEN_REFRESH_MARGIN_MS = 60 * 1000; // refresh ~60s before expiry
const REQUEST_TIMEOUT_MS = 15000;
const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRIES = 3;

class NombaError extends Error {
  constructor(message, { status = null, code = null, requestId = null, details = null } = {}) {
    super(message);
    this.name = 'NombaError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    // Raw provider error response body, when present — used to recover from
    // "accountRef already exists" without a dedicated lookup-by-ref endpoint.
    // Nomba's create-VA error response is not expected to echo the BVN back
    // (BVN is input-only), but callers must still never log `details` wholesale.
    this.details = details;
  }
}

/** Redact BVN and secrets from any object before logging. */
function redactForLog(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clone = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const key of Object.keys(clone)) {
    const lower = key.toLowerCase();
    if (lower.includes('bvn') || lower.includes('secret') || lower.includes('password') || lower.includes('token') || lower.includes('key')) {
      clone[key] = '[REDACTED]';
    } else if (clone[key] && typeof clone[key] === 'object') {
      clone[key] = redactForLog(clone[key]);
    }
  }
  return clone;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class NombaClient {
  constructor() {
    this.baseURL = process.env.NOMBA_BASE_URL;
    this.clientId = process.env.NOMBA_CLIENT_ID;
    this.clientSecret = process.env.NOMBA_CLIENT_SECRET;
    this.accountId = process.env.NOMBA_ACCOUNT_ID;

    this._accessToken = null;
    this._tokenExpiresAt = 0; // epoch ms
    this._refreshPromise = null; // single-flight guard
  }

  /**
   * Get a cached access token, refreshing ~60s before expiry.
   * Concurrent callers share a single in-flight refresh.
   */
  async getAccessToken() {
    const now = Date.now();
    if (this._accessToken && now < this._tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS) {
      return this._accessToken;
    }

    if (this._refreshPromise) {
      return this._refreshPromise;
    }

    this._refreshPromise = this._fetchAccessToken()
      .finally(() => {
        this._refreshPromise = null;
      });

    return this._refreshPromise;
  }

  async _fetchAccessToken() {
    try {
      const response = await axios({
        method: 'POST',
        url: `${this.baseURL}/v1/auth/token/issue`,
        headers: {
          'Content-Type': 'application/json',
          'accountId': this.accountId,
        },
        data: {
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret,
        },
        timeout: REQUEST_TIMEOUT_MS,
      });

      const data = response.data?.data || response.data;
      const accessToken = data?.access_token || data?.accessToken;
      const expiresIn = Number(data?.expires_in || data?.expiresIn || 3600); // seconds

      if (!accessToken) {
        throw new NombaError('Nomba token response missing access_token', { status: response.status });
      }

      this._accessToken = accessToken;
      this._tokenExpiresAt = Date.now() + expiresIn * 1000;

      logger.info('Nomba: access token refreshed', { expiresInSeconds: expiresIn });
      return this._accessToken;
    } catch (error) {
      this._accessToken = null;
      this._tokenExpiresAt = 0;
      logger.error('Nomba: token issue failed', {
        status: error.response?.status,
        message: error.response?.data?.description || error.message,
      });
      throw new NombaError('Failed to authenticate with Nomba', {
        status: error.response?.status || 500,
        code: 'TOKEN_ISSUE_FAILED',
      });
    }
  }

  /**
   * Internal request wrapper. Attaches auth + accountId headers, retries idempotent
   * operations on network error / 5xx, refreshes token once on 401 and retries once.
   *
   * @param {'GET'|'POST'|'PUT'} method
   * @param {string} path
   * @param {object} [body]
   * @param {{ idempotent?: boolean, retriedAfter401?: boolean, attempt?: number }} [opts]
   */
  async request(method, path, body = null, opts = {}) {
    const { idempotent = method === 'GET', retriedAfter401 = false, attempt = 1 } = opts;

    const token = await this.getAccessToken();

    try {
      const response = await axios({
        method,
        url: `${this.baseURL}${path}`,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          accountId: this.accountId,
        },
        data: body || undefined,
        timeout: REQUEST_TIMEOUT_MS,
      });

      logger.debug('Nomba: request succeeded', {
        method,
        path,
        status: response.status,
        body: redactForLog(body),
      });

      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const providerMessage = error.response?.data?.description || error.response?.data?.message;
      const requestId = error.response?.headers?.['x-request-id'] || error.response?.data?.requestId || null;

      logger.error('Nomba: request failed', {
        method,
        path,
        status,
        message: providerMessage || error.message,
        code: error.code,
        requestId,
      });

      // 401 → refresh once and retry once
      if (status === 401 && !retriedAfter401) {
        this._accessToken = null;
        this._tokenExpiresAt = 0;
        return this.request(method, path, body, { idempotent, retriedAfter401: true, attempt });
      }

      // Retry idempotent ops on network error or 5xx, up to MAX_RETRIES
      const isNetworkError = !status && (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' || error.code === 'ECONNRESET' || error.code === 'ENOTFOUND');
      const isServerError = status >= 500;
      if (idempotent && (isNetworkError || isServerError) && attempt < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250);
        logger.warn('Nomba: retrying idempotent request', { method, path, attempt: attempt + 1, delayMs: delay });
        await sleep(delay);
        return this.request(method, path, body, { idempotent, retriedAfter401, attempt: attempt + 1 });
      }

      throw new NombaError(providerMessage || 'Nomba request failed', {
        status: status || 502,
        code: error.response?.data?.code || error.code || 'REQUEST_FAILED',
        requestId,
        details: error.response?.data || null,
      });
    }
  }

  /**
   * Create a static (no expiry, no expected amount) NGN virtual account.
   * accountRef must be deterministic per user (e.g. `bramp-va-{userId}`) so this
   * call is safe to retry — Nomba treats a duplicate accountRef as idempotent
   * on their side per their docs; callers should also treat "already exists"
   * responses as success (see routes/Nombadeposit.js).
   */
  async createVirtualAccount({ accountRef, accountName, bvn }) {
    if (!accountRef || !accountName || !bvn) {
      throw new NombaError('accountRef, accountName and bvn are required', { code: 'INVALID_INPUT' });
    }

    const result = await this.request('POST', '/v1/accounts/virtual', {
      accountRef,
      accountName,
      currency: 'NGN',
      bvn,
    }, { idempotent: false }); // POST is not blind-retried; caller handles duplicate-ref case

    logger.info('Nomba: virtual account created', { accountRef }); // never log bvn/accountName payload as a whole
    return result;
  }

  /** Look up a virtual account by its account number. */
  async lookupVirtualAccount(virtualAcctNumber) {
    if (!virtualAcctNumber) {
      throw new NombaError('virtualAcctNumber is required', { code: 'INVALID_INPUT' });
    }
    return this.request('GET', `/v1/accounts/virtual/${encodeURIComponent(virtualAcctNumber)}`, null, { idempotent: true });
  }

  /** Suspend a virtual account by Nomba's internal account id. */
  async suspendVirtualAccount(accountId) {
    if (!accountId) {
      throw new NombaError('accountId is required', { code: 'INVALID_INPUT' });
    }
    const result = await this.request('PUT', `/v1/accounts/suspend/${encodeURIComponent(accountId)}`, null, { idempotent: false });
    logger.info('Nomba: virtual account suspended', { accountId });
    return result;
  }

  /**
   * List transactions for the parent account within a date range — used by the
   * daily reconciliation job. Path/params per Nomba's transactions-listing endpoint;
   * confirm exact query param names against sandbox before relying on this in prod.
   */
  async listTransactions({ startDate, endDate, page = 1, pageSize = 100 } = {}) {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));

    return this.request('GET', `/v1/transactions?${params.toString()}`, null, { idempotent: true });
  }
}

// Singleton, matches this repo's third-party client convention (e.g. auth/billauth.js)
const nombaClient = new NombaClient();

module.exports = {
  NombaClient,
  NombaError,
  nombaClient,
};
