// routes/news.js
const express = require('express');
const router = express.Router();
const Parser = require('rss-parser');
const fetch = require('node-fetch'); // node-fetch v2 (works with require)
const crypto = require('crypto');
const logger = require('../utils/logger'); // follows your project style

const rssParser = new Parser({
  // Optional: you can set custom request options here if needed
  requestOptions: {
    timeout: 10000
  }
});

/**
 * Configuration
 */
const NEWS_SOURCES = [
  {
    key: 'coindesk',
    name: 'CoinDesk',
    // CoinDesk RSS
    feed: 'https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml'
  },
  {
    key: 'cointelegraph',
    name: 'Cointelegraph',
    feed: 'https://cointelegraph.com/rss' // cointelegraph RSS
  },
  {
    key: 'beincrypto',
    name: 'BeInCrypto',
    feed: 'https://beincrypto.com/feed/' // BeInCrypto RSS
  },
  {
    key: 'theblock',
    name: 'The Block',
    feed: 'https://www.theblock.co/rss' // The Block RSS
  }
];

// In-memory cache
const CACHE = {
  items: [],       // merged news items
  fetchedAt: 0,    // timestamp (ms)
  ttlMs: 5 * 60 * 1000 // default TTL: 5 minutes
};

/**
 * Helpers
 */
function makeIdFromUrl(url) {
  return crypto.createHash('md5').update(String(url || '')).digest('hex');
}

function mapRssItemToNewsCard(item, sourceName) {
  // item: typical rss-parser item
  const title = item.title || 'Untitled';
  // prefer contentSnippet or content or description
  const description = item.contentSnippet || item.content || item.summary || item.description || '';
  // Try to get iso date, fallback to pubDate string
  const dateIso = item.isoDate || (item.pubDate ? new Date(item.pubDate).toISOString() : new Date().toISOString());
  // url
  const url = item.link || item.enclosure?.url || '';
  return {
    id: makeIdFromUrl(url || title + dateIso),
    title,
    description,
    date: dateIso,
    source: sourceName,
    url
  };
}

/**
 * Fetch and parse single RSS feed
 */
async function fetchFeed(feedUrl) {
  // rss-parser already handles fetching and parsing, but we wrap it for fault tolerance
  try {
    const feed = await rssParser.parseURL(feedUrl);
    return feed.items || [];
  } catch (err) {
    // Fallback: try manual fetch + parse via rss-parser's parseString (in case of redirect issues)
    try {
      const resp = await fetch(feedUrl, { timeout: 10000 });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      const feed = await rssParser.parseString(text);
      return feed.items || [];
    } catch (err2) {
      logger.error('Failed to fetch RSS feed', { feedUrl, error: (err2 || err).message });
      return []; // return empty so other feeds still work
    }
  }
}

/**
 * Fetch all sources, merge, dedupe, sort
 */
async function fetchAllNews({ perSourceLimit = 12 } = {}) {
  const allItems = [];

  // Fetch each feed in parallel
  const fetchedPromises = NEWS_SOURCES.map(async (src) => {
    const rawItems = await fetchFeed(src.feed);
    // Map and limit per source
    const mapped = (rawItems || []).slice(0, perSourceLimit).map((it) => mapRssItemToNewsCard(it, src.name));
    return mapped;
  });

  const results = await Promise.all(fetchedPromises);
  for (const list of results) {
    allItems.push(...list);
  }

  // Deduplicate by url (keep latest by date)
  const byUrl = new Map();
  for (const it of allItems) {
    const key = it.url || (it.title + it.date);
    if (!byUrl.has(key)) byUrl.set(key, it);
    else {
      // replace with newer if exists
      const prev = byUrl.get(key);
      if (new Date(it.date) > new Date(prev.date)) byUrl.set(key, it);
    }
  }

  const merged = Array.from(byUrl.values());

  // sort newest first
  merged.sort((a, b) => new Date(b.date) - new Date(a.date));

  return merged;
}

/**
 * Route: GET /news
 * Query params:
 *  - force=true -> bypass cache and re-fetch
 *  - limit=NUMBER -> limit number of returned items (default 12)
 */
router.get('/news', async (req, res) => {
  try {
    const force = String(req.query.force || '').toLowerCase() === 'true';
    const limit = Number(req.query.limit) || 12;
    const now = Date.now();

    // serve cache if valid
    const cacheValid = !force && (now - CACHE.fetchedAt) < CACHE.ttlMs && Array.isArray(CACHE.items) && CACHE.items.length > 0;
    if (cacheValid) {
      const sliced = CACHE.items.slice(0, limit);
      return res.json({
        success: true,
        source: 'cache',
        cachedAt: new Date(CACHE.fetchedAt).toISOString(),
        data: sliced
      });
    }

    // Otherwise fetch fresh
    const items = await fetchAllNews({ perSourceLimit: 20 }); // fetch up to 20 per source and merge
    // update cache
    CACHE.items = items;
    CACHE.fetchedAt = Date.now();

    return res.json({
      success: true,
      source: 'live',
      fetchedAt: new Date(CACHE.fetchedAt).toISOString(),
      data: items.slice(0, limit)
    });
  } catch (err) {
    logger.error('News route failed', { error: err.message, stack: err.stack });
    return res.status(500).json({ success: false, message: 'Failed to fetch news', error: err.message });
  }
});

module.exports = router;
