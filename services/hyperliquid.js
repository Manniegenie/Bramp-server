'use strict';

/**
 * hyperliquid.js
 *
 * Thin wrapper around @nktkas/hyperliquid ExchangeClient + InfoClient.
 *
 * Env vars required:
 *   HL_PRIVATE_KEY   — hex private key (0x-prefixed) of the platform's HL wallet
 *   HL_TESTNET=true  — optional, uses testnet endpoints
 *
 * Symbol convention: we store symbols like 'BTC', 'ETH'. HL uses the same
 * coin names for perpetuals.
 */

const {
  ExchangeClient,
  InfoClient,
  HttpTransport,
  MAINNET_API_URL,
  TESTNET_API_URL,
} = require('@nktkas/hyperliquid');

const logger = require('../utils/logger');

// ─── Transport / client singletons ───────────────────────────────────────────

const BASE_URL = process.env.HL_TESTNET === 'true' ? TESTNET_API_URL : MAINNET_API_URL;

const _transport = new HttpTransport({ url: BASE_URL });

let _exchange = null;
let _info     = null;

function getInfoClient() {
  if (!_info) _info = new InfoClient({ transport: _transport });
  return _info;
}

function getExchangeClient() {
  if (_exchange) return _exchange;

  const privateKey = process.env.HL_PRIVATE_KEY;
  if (!privateKey) throw new Error('HL_PRIVATE_KEY not set in environment');

  // @nktkas/hyperliquid accepts a plain hex private key string as the wallet param
  _exchange = new ExchangeClient({
    transport: _transport,
    wallet:    privateKey,
  });
  return _exchange;
}

// ─── Address derivation (uses @noble libs bundled with @nktkas/hyperliquid) ───

function privateKeyToAddress(hexKey) {
  const { secp256k1 } = require('@noble/curves/secp256k1');
  const { keccak_256 } = require('@noble/hashes/sha3');

  const key     = hexKey.startsWith('0x') ? hexKey.slice(2) : hexKey;
  const pubKey  = secp256k1.getPublicKey(key, false); // uncompressed, 65 bytes
  // Drop the 0x04 prefix → 64 bytes → keccak256 → last 20 bytes
  const hash    = keccak_256(pubKey.slice(1));
  const addrBytes = hash.slice(-20);
  const hex     = Buffer.from(addrBytes).toString('hex');
  return '0x' + hex;
}

let _platformAddress = null;
function getPlatformAddress() {
  if (_platformAddress) return _platformAddress;
  const key = process.env.HL_PRIVATE_KEY;
  if (!key) throw new Error('HL_PRIVATE_KEY not set');
  _platformAddress = privateKeyToAddress(key);
  return _platformAddress;
}

// ─── Account info ─────────────────────────────────────────────────────────────

/**
 * Returns the USDC balance (cross-margin account value) for the platform wallet.
 * @returns {Promise<number>}
 */
async function getUSDCBalance() {
  const address = getPlatformAddress();
  const info    = getInfoClient();
  const state   = await info.clearinghouseState({ user: address });

  // clearinghouseState returns { marginSummary: { accountValue, ... }, ... }
  const val = parseFloat(state?.marginSummary?.accountValue ?? state?.accountValue ?? 0);
  return Number.isFinite(val) ? val : 0;
}

/**
 * Returns all open perp positions for the platform wallet.
 * @returns {Promise<Array<{coin: string, side: 'long'|'short', size: number, entryPx: number}>>}
 */
async function getOpenPositions() {
  const address = getPlatformAddress();
  const info    = getInfoClient();
  const state   = await info.clearinghouseState({ user: address });

  const positions = state?.assetPositions ?? [];
  return positions
    .filter(p => parseFloat(p?.position?.szi ?? 0) !== 0)
    .map(p => {
      const pos = p.position;
      const szi = parseFloat(pos.szi);
      return {
        coin:    pos.coin,
        side:    szi > 0 ? 'long' : 'short',
        size:    Math.abs(szi),
        entryPx: parseFloat(pos.entryPx ?? 0),
      };
    });
}

// ─── Asset index lookup ───────────────────────────────────────────────────────

let _metaCache     = null;
let _metaCacheTime = 0;
const META_TTL_MS  = 10 * 60 * 1000; // 10 min

async function getCoinIndex(symbol) {
  const now = Date.now();
  if (!_metaCache || now - _metaCacheTime > META_TTL_MS) {
    const info = getInfoClient();
    const meta = await info.meta();
    _metaCache     = meta.universe; // array of { name, szDecimals, ... }
    _metaCacheTime = now;
  }
  const idx = _metaCache.findIndex(u => u.name === symbol.toUpperCase());
  if (idx === -1) throw new Error(`HL: coin '${symbol}' not found in perp universe`);
  return idx;
}

// ─── Order helpers ────────────────────────────────────────────────────────────

/**
 * Opens a perp position.
 *
 * Uses cross-margin, 2× leverage, limit IOC order priced 0.5% through mid
 * to behave like a market order without paying the market taker premium.
 *
 * @param {string} symbol     — e.g. 'BTC'
 * @param {'long'|'short'} direction
 * @param {number} usdcSize   — notional in USDC
 * @returns {Promise<{orderId: string|null, status: string}>}
 */
async function openPosition(symbol, direction, usdcSize) {
  if (!Number.isFinite(usdcSize) || usdcSize <= 0) {
    throw new Error(`openPosition: invalid usdcSize ${usdcSize}`);
  }

  const info  = getInfoClient();
  const mids  = await info.allMids();
  const mid   = parseFloat(mids[symbol.toUpperCase()]);
  if (!mid) throw new Error(`openPosition: no mid price for ${symbol}`);

  const isBuy = direction === 'long';
  // Slippage: buy slightly above mid, sell slightly below
  const slippage = 0.005; // 0.5 %
  const limitPx  = isBuy ? mid * (1 + slippage) : mid * (1 - slippage);
  const coinIdx  = await getCoinIndex(symbol);

  // HL size is in coin units; usdcSize / price gives us coin qty
  // Rounding: HL requires sz to match szDecimals for that coin
  const szDecimals = _metaCache[coinIdx].szDecimals ?? 3;
  const sz         = parseFloat((usdcSize / mid).toFixed(szDecimals));

  if (sz <= 0) throw new Error(`openPosition: computed size too small (${sz}) for ${symbol}`);

  // Ensure 2× cross-margin leverage is set (idempotent)
  const exchange = getExchangeClient();
  try {
    await exchange.updateLeverage({
      coin:         symbol.toUpperCase(),
      isCross:      true,
      leverage:     2,
    });
  } catch (lvErr) {
    logger.warn(`HL: leverage update skipped for ${symbol}`, { error: lvErr.message });
  }

  const result = await exchange.order({
    orders: [{
      a:     coinIdx,           // asset index
      b:     isBuy,             // isBuy
      p:     limitPx.toFixed(2),
      s:     sz.toString(),
      r:     false,             // reduceOnly = false
      t:     { limit: { tif: 'Ioc' } },
    }],
    grouping: 'na',
  });

  const fill   = result?.response?.data?.statuses?.[0];
  const filled = fill?.filled;
  const orderId = filled?.oid?.toString() ?? null;

  logger.info(`HL: opened ${direction} ${sz} ${symbol} @ ~${limitPx.toFixed(2)}`, {
    usdcSize, orderId, status: fill?.error ?? (filled ? 'filled' : 'unknown'),
  });

  return {
    orderId,
    status: fill?.error ?? (filled ? 'filled' : 'resting'),
  };
}

/**
 * Closes an open perp position using a reduceOnly IOC order.
 *
 * @param {string} symbol — e.g. 'BTC'
 * @returns {Promise<{orderId: string|null, status: string}>}
 */
async function closePosition(symbol) {
  const positions = await getOpenPositions();
  const pos = positions.find(p => p.coin === symbol.toUpperCase());

  if (!pos || pos.size === 0) {
    logger.info(`HL: closePosition called for ${symbol} but no open position found`);
    return { orderId: null, status: 'no_position' };
  }

  const info   = getInfoClient();
  const mids   = await info.allMids();
  const mid    = parseFloat(mids[symbol.toUpperCase()]);
  if (!mid) throw new Error(`closePosition: no mid price for ${symbol}`);

  const isBuy     = pos.side === 'short'; // closing short = buy
  const slippage  = 0.005;
  const limitPx   = isBuy ? mid * (1 + slippage) : mid * (1 - slippage);
  const coinIdx   = await getCoinIndex(symbol);
  const szDecimals = _metaCache[coinIdx].szDecimals ?? 3;
  const sz        = pos.size.toFixed(szDecimals);

  const exchange = getExchangeClient();
  const result   = await exchange.order({
    orders: [{
      a:  coinIdx,
      b:  isBuy,
      p:  limitPx.toFixed(2),
      s:  sz,
      r:  true,              // reduceOnly = true
      t:  { limit: { tif: 'Ioc' } },
    }],
    grouping: 'na',
  });

  const fill    = result?.response?.data?.statuses?.[0];
  const filled  = fill?.filled;
  const orderId = filled?.oid?.toString() ?? null;

  logger.info(`HL: closed ${pos.side} ${sz} ${symbol} @ ~${limitPx.toFixed(2)}`, {
    orderId, status: fill?.error ?? (filled ? 'filled' : 'unknown'),
  });

  return {
    orderId,
    status: fill?.error ?? (filled ? 'filled' : 'resting'),
  };
}

module.exports = {
  getPlatformAddress,
  getUSDCBalance,
  getOpenPositions,
  openPosition,
  closePosition,
};
