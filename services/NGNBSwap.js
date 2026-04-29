'use strict';

/**
 * NGNBSwap.js
 *
 * Converts NGNB stakes to USDC at the platform level via Obiex.
 *
 * Architecture note:
 *   - NGNB is Bramp's internal Naira-pegged token (1 NGNB ≈ 1 NGN).
 *   - On Obiex, the Naira-pegged token is listed as NGNB (or NGNX as fallback).
 *   - This service calls the Obiex API using platform credentials (not user-level).
 *   - The resulting USDC lives in the platform's Obiex account and will be used
 *     to open Hyperliquid perp positions on behalf of the pooled bets.
 *
 * Obiex swap flow:
 *   createQuote(NGNB → USDC, side=SELL)  →  acceptQuote(quoteId)
 */

const logger              = require('../utils/logger');
const { getCurrencyIdByCode, createQuote, acceptQuote } = require('./ObiexSwap');

// ─── NGNB currency code resolution ───────────────────────────────────────────
// Obiex may list Bramp's Naira token as 'NGNB' or 'NGNX'.
// We try NGNB first and fall back to NGNX if not found.

let _ngnbCurrencyCode = null; // cached after first successful resolution

async function resolveNGNBCode() {
  if (_ngnbCurrencyCode) return _ngnbCurrencyCode;

  for (const code of ['NGNB', 'NGNX']) {
    try {
      await getCurrencyIdByCode(code);
      _ngnbCurrencyCode = code;
      logger.info(`NGNBSwap: resolved Naira token on Obiex as '${code}'`);
      return code;
    } catch (_) {
      // try next code
    }
  }

  throw new Error('NGNB_CODE_NOT_FOUND: Neither NGNB nor NGNX found on Obiex. Check Obiex currency list.');
}

// ─── USDC amount extraction ───────────────────────────────────────────────────
// Obiex doesn't publish a strict response schema in our codebase; we probe
// common field names in order of likelihood.

function extractUSDCAmount(quoteData, acceptData) {
  const candidates = [
    acceptData?.destinationAmount,
    acceptData?.toAmount,
    acceptData?.receivedAmount,
    acceptData?.targetAmount,
    acceptData?.data?.destinationAmount,
    acceptData?.data?.toAmount,
    quoteData?.destinationAmount,
    quoteData?.toAmount,
    quoteData?.rate ? null : undefined, // rate alone isn't enough
  ];

  for (const v of candidates) {
    const n = parseFloat(v);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Converts a NGNB amount to USDC using the platform's Obiex account.
 *
 * @param {number} ngnbAmount   - The NGNB stake amount (already debited from user)
 * @returns {Promise<{
 *   success: boolean,
 *   usdcAmount: number|null,
 *   quoteId: string|null,
 *   ngnbCode: string,
 *   error?: string
 * }>}
 */
async function swapNGNBtoUSDC(ngnbAmount) {
  if (!Number.isFinite(ngnbAmount) || ngnbAmount <= 0) {
    return { success: false, usdcAmount: null, quoteId: null, ngnbCode: null, error: 'INVALID_AMOUNT' };
  }

  let ngnbCode;

  try {
    ngnbCode = await resolveNGNBCode();

    const [ngnbId, usdcId] = await Promise.all([
      getCurrencyIdByCode(ngnbCode),
      getCurrencyIdByCode('USDC'),
    ]);

    // ── Step 1: Create quote ─────────────────────────────────────────────────
    const quoteResult = await createQuote({
      sourceId: ngnbId,
      targetId: usdcId,
      amount:   ngnbAmount,
      side:     'SELL', // we are selling NGNB to receive USDC
    });

    if (!quoteResult.success) {
      logger.error('NGNBSwap: quote creation failed', {
        ngnbCode, ngnbAmount,
        statusCode: quoteResult.statusCode,
        error:      quoteResult.error,
      });
      return {
        success:    false,
        usdcAmount: null,
        quoteId:    null,
        ngnbCode,
        error:      `Quote failed (${quoteResult.statusCode}): ${JSON.stringify(quoteResult.error)}`,
      };
    }

    const quoteId   = quoteResult.quoteId;
    const quoteData = quoteResult.data;

    logger.info('NGNBSwap: quote received', {
      ngnbCode, ngnbAmount, quoteId,
      rate:               quoteData?.rate || quoteData?.price,
      destinationAmount:  quoteData?.destinationAmount || quoteData?.toAmount,
    });

    // ── Step 2: Accept quote ─────────────────────────────────────────────────
    const acceptResult = await acceptQuote(quoteId);

    if (!acceptResult.success) {
      logger.error('NGNBSwap: quote acceptance failed', {
        ngnbCode, ngnbAmount, quoteId,
        statusCode: acceptResult.statusCode,
        error:      acceptResult.error,
      });
      return {
        success:    false,
        usdcAmount: null,
        quoteId,
        ngnbCode,
        error:      `Accept failed (${acceptResult.statusCode}): ${JSON.stringify(acceptResult.error)}`,
      };
    }

    const usdcAmount = extractUSDCAmount(quoteData, acceptResult.data);

    if (!usdcAmount) {
      // The trade executed but we couldn't parse the USDC amount from the response.
      // Log the full response so we can fix the parser; treat as success since
      // the funds have moved on Obiex's side.
      logger.warn('NGNBSwap: trade accepted but USDC amount unclear — needs parser update', {
        ngnbCode, ngnbAmount, quoteId,
        acceptData: JSON.stringify(acceptResult.data).slice(0, 500),
      });
    }

    logger.info('NGNBSwap: NGNB→USDC swap completed', {
      ngnbCode, ngnbAmount, usdcAmount, quoteId,
    });

    return {
      success:    true,
      usdcAmount: usdcAmount ?? null,
      quoteId,
      ngnbCode,
    };

  } catch (err) {
    logger.error('NGNBSwap: unexpected error during NGNB→USDC conversion', {
      ngnbCode: ngnbCode ?? 'unknown',
      ngnbAmount,
      error: err.message,
    });
    return {
      success:    false,
      usdcAmount: null,
      quoteId:    null,
      ngnbCode:   ngnbCode ?? null,
      error:      err.message,
    };
  }
}

module.exports = { swapNGNBtoUSDC };
