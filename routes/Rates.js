// routes/rates.js
const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');

const NairaMarkup = require('../models/onramp');   // on-ramp
const NairaMarkdown = require('../models/offramp'); // off-ramp

// GET /fx/naira (or mount where you like)
// Returns both onramp & offramp NGN/USD rates with metadata.
router.get('/naira', async (req, res) => {
  try {
    // Grab the most recent docs from each collection
    const [markupDoc, markdownDoc] = await Promise.all([
      NairaMarkup.findOne({}).sort({ updatedAt: -1 }).lean(),
      NairaMarkdown.findOne({}).sort({ updatedAt: -1 }).lean(),
    ]);

    // Helper: choose freshest base (lastCurrencyAPIRate) if any
    function pickBase() {
      const cands = []
        .concat(markupDoc ? [{ rate: markupDoc.lastCurrencyAPIRate, at: markupDoc.updatedAt, src: markupDoc.rateSource }] : [])
        .concat(markdownDoc ? [{ rate: markdownDoc.lastCurrencyAPIRate, at: markdownDoc.updatedAt, src: markdownDoc.rateSource }] : [])
        .filter(x => typeof x.rate === 'number' && !Number.isNaN(x.rate));

      if (!cands.length) return { baseRate: null, baseRateSource: null, baseRateUpdatedAt: null };

      // pick latest by updatedAt
      cands.sort((a, b) => new Date(b.at) - new Date(a.at));
      const latest = cands[0];
      return {
        baseRate: Number(latest.rate),
        baseRateSource: latest.src || null,
        baseRateUpdatedAt: latest.at || null,
      };
    }

    const { baseRate, baseRateSource, baseRateUpdatedAt } = pickBase();

    // Compute ONRAMP
    let onramp = {
      effectiveRate: null,
      source: null,
      appliedMarkupPct: null,
      manualRate: null,
      updatedAt: markupDoc?.updatedAt || null,
    };

    if (markupDoc) {
      const manual = (typeof markupDoc.onrampRate === 'number') ? Number(markupDoc.onrampRate) : null;
      if (manual && manual > 0) {
        onramp = {
          effectiveRate: manual,
          source: 'manual',
          appliedMarkupPct: null,
          manualRate: manual,
          updatedAt: markupDoc.updatedAt || null,
        };
      } else if (typeof baseRate === 'number' && baseRate > 0) {
        const pct = typeof markupDoc.markup === 'number' ? Number(markupDoc.markup) : 0;
        const eff = baseRate * (1 + (pct / 100));
        onramp = {
          effectiveRate: Number(eff),
          source: 'computed',
          appliedMarkupPct: pct,
          manualRate: null,
          updatedAt: markupDoc.updatedAt || baseRateUpdatedAt || null,
        };
      } else {
        onramp.source = 'unavailable';
      }
    }

    // Compute OFFRAMP
    let offramp = {
      effectiveRate: null,
      source: null,
      appliedMarkdownPct: null, // we keep the field name explicit for clarity
      manualRate: null,
      updatedAt: markdownDoc?.updatedAt || null,
    };

    if (markdownDoc) {
      const manual = (typeof markdownDoc.offrampRate === 'number') ? Number(markdownDoc.offrampRate) : null;
      if (manual && manual > 0) {
        offramp = {
          effectiveRate: manual,
          source: 'manual',
          appliedMarkdownPct: null,
          manualRate: manual,
          updatedAt: markdownDoc.updatedAt || null,
        };
      } else if (typeof baseRate === 'number' && baseRate > 0) {
        const pct = typeof markdownDoc.markup === 'number' ? Number(markdownDoc.markup) : 0;
        const eff = baseRate * (1 - (pct / 100));
        offramp = {
          effectiveRate: Number(eff),
          source: 'computed',
          appliedMarkdownPct: pct,
          manualRate: null,
          updatedAt: markdownDoc.updatedAt || baseRateUpdatedAt || null,
        };
      } else {
        offramp.source = 'unavailable';
      }
    }

    // Compose response
    const data = {
      // Base reference (NGN per USD)
      baseRate: (typeof baseRate === 'number' ? Number(baseRate) : null),
      baseRateSource: baseRateSource,           // 'manual' | 'currencyapi' | null
      baseRateUpdatedAt: baseRateUpdatedAt,     // Date or null

      // On-ramp (USD->NGN for deposit/buy)
      onramp: {
        effectiveRate: onramp.effectiveRate,    // NGN per USD
        source: onramp.source,                  // 'manual' | 'computed' | 'unavailable'
        appliedMarkupPct: onramp.appliedMarkupPct, // % used when computed
        manualRate: onramp.manualRate,          // if present
        updatedAt: onramp.updatedAt,
      },

      // Off-ramp (USD->NGN for sell/payout)
      offramp: {
        effectiveRate: offramp.effectiveRate,   // NGN per USD
        source: offramp.source,                 // 'manual' | 'computed' | 'unavailable'
        appliedMarkdownPct: offramp.appliedMarkdownPct, // % used when computed
        manualRate: offramp.manualRate,         // if present
        updatedAt: offramp.updatedAt,
      },
    };

    // Slightly cache: these move slowly but protect the DB
    res.set('Cache-Control', 'public, max-age=10');
    return res.json({ success: true, data });
  } catch (err) {
    logger?.error?.('Failed to fetch NGN rates', { error: err.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch NGN rates',
      details: err.message,
    });
  }
});

module.exports = router;
