const express = require('express');
const router = express.Router();
const axios = require('axios');
const { attachObiexAuth } = require('../utils/obiexAuth');
const config = require('../routes/config');
const NairaMarkdown = require('../models/offramp');
const User = require('../models/user');
const Transaction = require('../models/transaction');
const PnlSnapshot = require('../models/pnlSnapshot');
const { getPricesWithCache } = require('../services/portfolio');
const logger = require('../utils/logger');

const obiexAxios = axios.create({
  baseURL: (config.obiex?.baseURL || process.env.OBIEX_BASE_URL || '').replace(/\/+$/, ''),
  timeout: 30000,
});
obiexAxios.interceptors.request.use(attachObiexAuth);

const CRYPTO_TOKENS = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'];

const FALLBACK_PRICES = {
  BTC: 65000, ETH: 3200, SOL: 200, USDT: 1, USDC: 1,
  BNB: 580, MATIC: 0.85, AVAX: 35,
};

// Obiex may list Bramp's Naira token as 'NGNB' or 'NGNX' - resolve once and cache.
let _nairaTicker = null;

async function resolveNairaTicker() {
  if (_nairaTicker) return _nairaTicker;
  for (const code of ['NGNB', 'NGNX']) {
    try {
      const res = await obiexAxios.get(`/wallets/${code}`);
      if (res.data?.data) {
        _nairaTicker = code;
        logger.info(`PNL: resolved Naira token on Obiex as '${code}'`);
        return code;
      }
    } catch (_) {
      // try next code
    }
  }
  throw new Error('NAIRA_TICKER_NOT_FOUND: Neither NGNB nor NGNX found on Obiex. Check Obiex currency list.');
}

async function fetchProviderWallet(currency) {
  const res = await obiexAxios.get(`/wallets/${currency}`);
  const data = res.data?.data;
  if (!data) return null;
  return {
    availableBalance: Number(data.availableBalance) || 0,
    pendingBalance: Number(data.pendingBalance) || 0,
    lockedBalance: Number(data.lockedBalance) || 0,
    pendingSwapBalance: Number(data.pendingSwapBalance) || 0,
    currency: data.currency?.code || currency,
  };
}

async function getOfframpRate() {
  const doc = await NairaMarkdown.findOne();
  const rate = doc?.offrampRate;
  if (!rate || isNaN(rate) || rate === 0) {
    throw new Error('NGN/USD offramp rate not configured in DB — PnL unavailable until rate is set via admin');
  }
  return rate;
}

async function getPrices() {
  try {
    return (await getPricesWithCache(CRYPTO_TOKENS)) || FALLBACK_PRICES;
  } catch {
    return FALLBACK_PRICES;
  }
}

async function getPlatformBalances() {
  const [result] = await User.aggregate([
    {
      $group: {
        _id: null,
        BTC: { $sum: { $ifNull: ['$btcBalance', 0] } },
        ETH: { $sum: { $ifNull: ['$ethBalance', 0] } },
        SOL: { $sum: { $ifNull: ['$solBalance', 0] } },
        USDT: { $sum: { $ifNull: ['$usdtBalance', 0] } },
        USDC: { $sum: { $ifNull: ['$usdcBalance', 0] } },
        BNB: { $sum: { $ifNull: ['$bnbBalance', 0] } },
        MATIC: { $sum: { $ifNull: ['$maticBalance', 0] } },
        AVAX: { $sum: { $ifNull: ['$avaxBalance', 0] } },
        NGNB: { $sum: { $ifNull: ['$ngnbBalance', 0] } },
        BTC_p: { $sum: { $ifNull: ['$btcPendingBalance', 0] } },
        ETH_p: { $sum: { $ifNull: ['$ethPendingBalance', 0] } },
        SOL_p: { $sum: { $ifNull: ['$solPendingBalance', 0] } },
        USDT_p: { $sum: { $ifNull: ['$usdtPendingBalance', 0] } },
        USDC_p: { $sum: { $ifNull: ['$usdcPendingBalance', 0] } },
        BNB_p: { $sum: { $ifNull: ['$bnbPendingBalance', 0] } },
        MATIC_p: { $sum: { $ifNull: ['$maticPendingBalance', 0] } },
        AVAX_p: { $sum: { $ifNull: ['$avaxPendingBalance', 0] } },
        NGNB_p: { $sum: { $ifNull: ['$ngnbPendingBalance', 0] } },
        userCount: { $sum: 1 },
      },
    },
  ]);
  return result || {};
}

// ─── GET /pnl/provider-wallets ───────────────────────────────────────────────
// Raw Obiex operator wallet balances for all supported currencies.
router.get('/provider-wallets', async (req, res) => {
  try {
    const nairaTicker = await resolveNairaTicker().catch(() => 'NGNX');
    const allTickers = [...CRYPTO_TOKENS, nairaTicker];
    const results = await Promise.allSettled(
      allTickers.map(currency => fetchProviderWallet(currency).then(w => ({ currency, wallet: w })))
    );

    const wallets = {};
    results.forEach((r, i) => {
      const currency = allTickers[i];
      if (r.status === 'fulfilled') {
        wallets[currency] = r.value.wallet || { availableBalance: 0, pendingBalance: 0, error: 'Empty response' };
      } else {
        wallets[currency] = { availableBalance: 0, pendingBalance: 0, error: r.reason?.message || 'Fetch failed' };
      }
    });

    res.json({ success: true, data: { wallets, fetchedAt: new Date().toISOString() } });
  } catch (err) {
    logger.error('PNL /provider-wallets error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /pnl/snapshot ───────────────────────────────────────────────────────
// Full PNL snapshot:
//   providerBalance (Obiex) – platformBalance (sum of all users) = PNL
// All figures returned in native token, USD, and NGN.
router.get('/snapshot', async (req, res) => {
  try {
    const [offrampRate, prices, platformRaw, providerResults, nairaTicker] = await Promise.all([
      getOfframpRate(),
      getPrices(),
      getPlatformBalances(),
      Promise.allSettled(
        CRYPTO_TOKENS.map(currency => fetchProviderWallet(currency).then(w => ({ currency, wallet: w })))
      ),
      resolveNairaTicker().catch(() => null),
    ]);

    const nairaWallet = nairaTicker ? await fetchProviderWallet(nairaTicker).catch(() => null) : null;
    const ngnbPriceUsd = 1 / offrampRate;

    // Build provider map
    const providerMap = {};
    providerResults.forEach((r, i) => {
      const currency = CRYPTO_TOKENS[i];
      providerMap[currency] = r.status === 'fulfilled' && r.value.wallet
        ? r.value.wallet
        : { availableBalance: 0, pendingBalance: 0, error: r.reason?.message || 'Fetch failed' };
    });

    const breakdown = {};
    let providerTotalUsd = 0;
    let platformTotalUsd = 0;

    for (const currency of CRYPTO_TOKENS) {
      const price = prices[currency] ?? FALLBACK_PRICES[currency] ?? 0;
      const providerAvailable = providerMap[currency]?.availableBalance ?? 0;
      const providerPending = providerMap[currency]?.pendingBalance ?? 0;
      const platformAvailable = platformRaw[currency] ?? 0;
      const platformPending = platformRaw[`${currency}_p`] ?? 0;

      // PNL = what we hold on Obiex minus what users collectively own on our platform
      const pnlAmount = providerAvailable - platformAvailable;

      breakdown[currency] = {
        providerAvailable,
        providerPending,
        platformAvailable,
        platformPending,
        pnlAmount,
        priceUsd: price,
        providerAvailableUsd: +(providerAvailable * price).toFixed(4),
        providerPendingUsd: +(providerPending * price).toFixed(4),
        platformAvailableUsd: +(platformAvailable * price).toFixed(4),
        platformPendingUsd: +(platformPending * price).toFixed(4),
        pnlUsd: +(pnlAmount * price).toFixed(4),
        providerAvailableNgn: +(providerAvailable * price * offrampRate).toFixed(2),
        platformAvailableNgn: +(platformAvailable * price * offrampRate).toFixed(2),
        pnlNgn: +(pnlAmount * price * offrampRate).toFixed(2),
        ...(providerMap[currency]?.error && { fetchError: providerMap[currency].error }),
      };

      providerTotalUsd += providerAvailable * price;
      platformTotalUsd += platformAvailable * price;
    }

    // NGNB (platform) = NGNB/NGNX (Obiex) — same stablecoin, ticker resolved dynamically
    const ngnbAvailable = platformRaw['NGNB'] ?? 0;
    const ngnbPending = platformRaw['NGNB_p'] ?? 0;
    const providerNairaAvailable = nairaWallet?.availableBalance ?? 0;
    const providerNairaPending = nairaWallet?.pendingBalance ?? 0;
    const ngnbPnlAmount = providerNairaAvailable - ngnbAvailable;
    breakdown['NGNB'] = {
      providerAvailable: providerNairaAvailable,
      providerPending: providerNairaPending,
      platformAvailable: ngnbAvailable,
      platformPending: ngnbPending,
      pnlAmount: ngnbPnlAmount,
      priceUsd: ngnbPriceUsd,
      providerAvailableUsd: +(providerNairaAvailable * ngnbPriceUsd).toFixed(4),
      providerPendingUsd: +(providerNairaPending * ngnbPriceUsd).toFixed(4),
      platformAvailableUsd: +(ngnbAvailable * ngnbPriceUsd).toFixed(4),
      platformPendingUsd: +(ngnbPending * ngnbPriceUsd).toFixed(4),
      pnlUsd: +(ngnbPnlAmount * ngnbPriceUsd).toFixed(4),
      providerAvailableNgn: +providerNairaAvailable.toFixed(2),
      platformAvailableNgn: +ngnbAvailable.toFixed(2),
      pnlNgn: +ngnbPnlAmount.toFixed(2),
      note: `NGNB on platform = ${nairaTicker || 'NGNX'} on Obiex`,
      ...(nairaWallet === null && { fetchError: 'Failed to fetch Naira wallet from Obiex' }),
    };
    providerTotalUsd += providerNairaAvailable * ngnbPriceUsd;
    platformTotalUsd += ngnbAvailable * ngnbPriceUsd;

    const pnlTotalUsd = providerTotalUsd - platformTotalUsd;

    const summary = {
      providerTotalUsd: +providerTotalUsd.toFixed(2),
      providerTotalNgn: +(providerTotalUsd * offrampRate).toFixed(2),
      platformTotalUsd: +platformTotalUsd.toFixed(2),
      platformTotalNgn: +(platformTotalUsd * offrampRate).toFixed(2),
      pnlTotalUsd: +pnlTotalUsd.toFixed(2),
      pnlTotalNgn: +(pnlTotalUsd * offrampRate).toFixed(2),
    };

    // Save snapshot and fetch yesterday's in parallel
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [, prevSnapshot] = await Promise.all([
      PnlSnapshot.create({
        ...summary,
        offrampRate,
        userCount: platformRaw.userCount || 0,
      }),
      PnlSnapshot.findOne({ createdAt: { $lte: yesterday } }).sort({ createdAt: -1 }).lean(),
    ]);

    res.json({
      success: true,
      data: {
        fetchedAt: new Date().toISOString(),
        offrampRate,
        userCount: platformRaw.userCount || 0,
        summary,
        previousDay: prevSnapshot ? {
          providerTotalUsd: prevSnapshot.providerTotalUsd,
          providerTotalNgn: prevSnapshot.providerTotalNgn,
          platformTotalUsd: prevSnapshot.platformTotalUsd,
          platformTotalNgn: prevSnapshot.platformTotalNgn,
          pnlTotalUsd:      prevSnapshot.pnlTotalUsd,
          pnlTotalNgn:      prevSnapshot.pnlTotalNgn,
          recordedAt:       prevSnapshot.createdAt,
        } : null,
        breakdown,
      },
    });
  } catch (err) {
    logger.error('PNL /snapshot error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── GET /pnl/revenue ────────────────────────────────────────────────────────
// Fee revenue earned (withdrawal fees) over a date range.
// Query params: dateFrom, dateTo (ISO date strings)
router.get('/revenue', async (req, res) => {
  try {
    const { dateFrom, dateTo } = req.query;
    const dateFilter = {};
    if (dateFrom) {
      const d = new Date(dateFrom);
      if (!isNaN(d)) dateFilter.$gte = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0));
    }
    if (dateTo) {
      const d = new Date(dateTo);
      if (!isNaN(d)) dateFilter.$lte = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999));
    }
    const createdAtFilter = Object.keys(dateFilter).length ? dateFilter : undefined;

    const [offrampRate, prices] = await Promise.all([getOfframpRate(), getPrices()]);

    // Withdrawal fees collected
    const withdrawalFeeAgg = await Transaction.aggregate([
      {
        $match: {
          type: 'WITHDRAWAL',
          status: { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] },
          fee: { $gt: 0 },
          ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
        },
      },
      {
        $group: {
          _id: { $toUpper: '$currency' },
          totalFee: { $sum: { $abs: '$fee' } },
          count: { $sum: 1 },
        },
      },
    ]);

    let totalFeeUsd = 0;
    const feeBreakdown = {};
    for (const row of withdrawalFeeAgg) {
      const currency = row._id;
      const price = prices[currency] ?? FALLBACK_PRICES[currency] ?? 0;
      const usd = row.totalFee * price;
      feeBreakdown[currency] = {
        totalFee: +row.totalFee.toFixed(8),
        count: row.count,
        feeUsd: +usd.toFixed(4),
        feeNgn: +(usd * offrampRate).toFixed(2),
      };
      totalFeeUsd += usd;
    }

    // Withdrawal count summary
    const withdrawalCount = await Transaction.countDocuments({
      type: 'WITHDRAWAL',
      status: { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] },
      ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
    });

    const depositCount = await Transaction.countDocuments({
      type: 'DEPOSIT',
      status: { $in: ['SUCCESSFUL', 'COMPLETED', 'CONFIRMED'] },
      ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
    });

    res.json({
      success: true,
      data: {
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        offrampRate,
        withdrawalFees: {
          totalUsd: +totalFeeUsd.toFixed(2),
          totalNgn: +(totalFeeUsd * offrampRate).toFixed(2),
          breakdown: feeBreakdown,
        },
        activitySummary: {
          withdrawalCount,
          depositCount,
        },
      },
    });
  } catch (err) {
    logger.error('PNL /revenue error:', err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
