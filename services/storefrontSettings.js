// services/storefrontSettings.js
// Storefront platform controls (models/storefrontSettings.js): the kill
// switch, coin/network toggles, and fee, limit and alert values. Cached for
// a few seconds so Stella doesn't read Mongo on every message; get() refreshes
// the cache, peek() returns it for synchronous callers (fee maths).
const StorefrontSettings = require('../models/storefrontSettings');

const TTL_MS = 15 * 1000;

/** The env defaults; a setting left null in bramp-admin uses these. */
const DEFAULTS = () => ({
  selfFeePct: Number(process.env.STOREFRONT_SELF_FEE_PCT ?? 0.2),
  selfFeeMinNgn: Number(process.env.STOREFRONT_SELF_FEE_MIN_NGN ?? 100),
  selfFeeMaxNgn: Number(process.env.STOREFRONT_SELF_FEE_MAX_NGN ?? 50000),
  selfMinCoverNgn: Number(process.env.STOREFRONT_SELF_MIN_COVER_NGN || 5000),
  maxMarkdownNgnPerUsd: Number(process.env.STOREFRONT_MAX_MARKDOWN_NGN_PER_USD || 100),
  newDeskPerTradeMaxNgn: Number(process.env.STOREFRONT_NEW_DESK_PER_TRADE_MAX_NGN || 500000),
  newDeskDailyMaxNgn: Number(process.env.STOREFRONT_NEW_DESK_DAILY_MAX_NGN || 2000000),
  largeTradeNgn: Number(process.env.STOREFRONT_ALERT_LARGE_TRADE_NGN || 5000000),
  velocityCount: Number(process.env.STOREFRONT_ALERT_VELOCITY_COUNT || 5),
  velocityWindowMinutes: Number(process.env.STOREFRONT_ALERT_VELOCITY_MINUTES || 60),
});
const KEYS = Object.keys(DEFAULTS());

let cached = null;
let loadedAt = 0;

function shape(doc) {
  const defaults = DEFAULTS();
  const overrides = Object.fromEntries(KEYS.map((k) => [k, doc?.values?.[k] ?? null]));
  const ks = doc?.killSwitch || {};
  return {
    killSwitch: { selling: !!ks.selling, payouts: !!ks.payouts, message: ks.message || null, by: ks.by || null, at: ks.at || null },
    disabledPairs: [...(doc?.disabledPairs || [])],
    overrides,
    defaults,
    values: Object.fromEntries(KEYS.map((k) => [k, overrides[k] ?? defaults[k]])),
    updatedAt: doc?.updatedAt || null,
  };
}

async function get({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - loadedAt < TTL_MS) return cached;
  cached = shape(await StorefrontSettings.findOne({ key: 'global' }).lean());
  loadedAt = Date.now();
  return cached;
}

/** The last settings read (or the defaults before any), without waiting. */
const peek = () => cached || shape(null);

const pairCode = (coin, network) => `${coin}:${network}`;

/** Selling paused platform-wide: the message Stella gives, else null. */
async function sellingPaused() {
  const s = await get();
  return s.killSwitch.selling ? (s.killSwitch.message || 'Selling is paused for a short while. Please try again soon.') : null;
}
const payoutsHeld = async () => (await get()).killSwitch.payouts;
const pairDisabled = async (coin, network) => (await get()).disabledPairs.includes(pairCode(coin, network));

class SettingsError extends Error {
  constructor(message) { super(message); this.statusCode = 400; }
}

/**
 * Apply an admin's change: { killSwitch?: { selling?, payouts?, message? },
 * disabledPairs?: ['USDT:ETH'], values?: { key: number | null } }. Returns
 * the new settings and what changed.
 */
async function update(patch = {}, by) {
  const { PAIRS } = require('./storefrontSell');
  const set = {};
  const changes = {};

  if (patch.killSwitch) {
    for (const k of ['selling', 'payouts']) {
      if (patch.killSwitch[k] !== undefined) { set[`killSwitch.${k}`] = !!patch.killSwitch[k]; changes[`killSwitch.${k}`] = !!patch.killSwitch[k]; }
    }
    if (patch.killSwitch.message !== undefined) {
      const m = patch.killSwitch.message ? String(patch.killSwitch.message).trim().slice(0, 300) : null;
      set['killSwitch.message'] = m; changes['killSwitch.message'] = m;
    }
    if (Object.keys(set).length) { set['killSwitch.by'] = by; set['killSwitch.at'] = new Date(); }
  }

  if (patch.disabledPairs !== undefined) {
    if (!Array.isArray(patch.disabledPairs)) throw new SettingsError('disabledPairs must be a list like ["USDT:ETH"].');
    const valid = Object.entries(PAIRS).flatMap(([coin, nets]) => nets.map((n) => pairCode(coin, n)));
    const pairs = [...new Set(patch.disabledPairs.map((p) => String(p).toUpperCase()))];
    const bad = pairs.filter((p) => !valid.includes(p));
    if (bad.length) throw new SettingsError(`Unknown pair: ${bad.join(', ')}. Pairs: ${valid.join(', ')}.`);
    set.disabledPairs = pairs; changes.disabledPairs = pairs;
  }

  if (patch.values) {
    for (const [k, v] of Object.entries(patch.values)) {
      if (!KEYS.includes(k)) throw new SettingsError(`Unknown setting: ${k}.`);
      if (v === null || v === '') { set[`values.${k}`] = null; changes[k] = null; continue; }
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new SettingsError(`${k} must be a number of 0 or more.`);
      if (k === 'selfFeePct' && n > 5) throw new SettingsError('selfFeePct can be at most 5.');
      if (k === 'velocityWindowMinutes' && n < 1) throw new SettingsError('velocityWindowMinutes must be at least 1.');
      set[`values.${k}`] = n; changes[k] = n;
    }
  }

  if (!Object.keys(set).length) throw new SettingsError('Nothing to change.');
  await StorefrontSettings.updateOne({ key: 'global' }, { $set: set, $setOnInsert: { key: 'global' } }, { upsert: true });
  const fresh = await get({ fresh: true });
  const v = fresh.values;
  if (v.selfFeeMaxNgn > 0 && v.selfFeeMinNgn > v.selfFeeMaxNgn) {
    throw new SettingsError('Saved, but the Self rate fee minimum is above the maximum: fix one of them.');
  }
  return { settings: fresh, changes };
}

module.exports = { get, peek, update, sellingPaused, payoutsHeld, pairDisabled, pairCode, DEFAULTS, KEYS, SettingsError, _reset: () => { cached = null; loadedAt = 0; } };
