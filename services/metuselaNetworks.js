// Obiex deposit/withdrawal terms for the coins Metusela uses (USDC, USDT),
// per network, keyed by Obiex's API network code.
//
// Defaults are Obiex's published fee table as of 2026-10-12. Admins can
// override any value (adminRoutes/metusela.js → settings.networkOverrides)
// when Obiex changes its fees, without a deploy.
//
//   minDeposit     — deposits smaller than this aren't credited by Obiex
//   depositFee     — Obiex's fee on deposits (all 0 today)
//   minWithdrawal  — smallest withdrawal Obiex accepts on that network
//   withdrawalFee  — Obiex's flat network fee, taken out of the amount sent
const OBIEX_DEFAULTS = {
  USDC: {
    ETH:      { name: 'Ethereum (ERC20)', minDeposit: 1, depositFee: 0, minWithdrawal: 20, withdrawalFee: 2 },
    BASE:     { name: 'Base',             minDeposit: 0.1, depositFee: 0, minWithdrawal: 11, withdrawalFee: 1.2 },
    AVAXC:    { name: 'Avax C-Chain',     minDeposit: 1, depositFee: 0, minWithdrawal: 0.4, withdrawalFee: 0.2 },
    ARBITRUM: { name: 'Arbitrum One',     minDeposit: 1, depositFee: 0, minWithdrawal: 1, withdrawalFee: 0.5 },
    SOL:      { name: 'Solana',           minDeposit: 1, depositFee: 0, minWithdrawal: 10, withdrawalFee: 3 },
    MATIC:    { name: 'Polygon (MATIC)',  minDeposit: 1, depositFee: 0, minWithdrawal: 10, withdrawalFee: 1 },
    BSC:      { name: 'BSC (BEP20)',      minDeposit: 1, depositFee: 0, minWithdrawal: 10, withdrawalFee: 0.5 },
  },
  USDT: {
    SOL:      { name: 'Solana',           minDeposit: 1, depositFee: 0, minWithdrawal: 12, withdrawalFee: 1 },
    MATIC:    { name: 'Polygon (MATIC)',  minDeposit: 1, depositFee: 0, minWithdrawal: 10.5, withdrawalFee: 1 },
    AVAXC:    { name: 'Avax C-Chain',     minDeposit: 1, depositFee: 0, minWithdrawal: 2, withdrawalFee: 0.5 },
    TRX:      { name: 'Tron (TRC20)',     minDeposit: 1, depositFee: 0, minWithdrawal: 15, withdrawalFee: 2 },
    ARBITRUM: { name: 'Arbitrum One',     minDeposit: 1, depositFee: 0, minWithdrawal: 10.5, withdrawalFee: 0.65 },
    BSC:      { name: 'BSC (BEP20)',      minDeposit: 1, depositFee: 0, minWithdrawal: 10.5, withdrawalFee: 0.5 },
    ETH:      { name: 'Ethereum (ERC20)', minDeposit: 1, depositFee: 0, minWithdrawal: 20, withdrawalFee: 2 },
  },
};

// Common names → Obiex's codes. Obiex calls Polygon "MATIC", so a config of
// "POLYGON" must be translated or it never matches.
const ALIASES = {
  POLYGON: 'MATIC', POL: 'MATIC', MATIC: 'MATIC',
  ETHEREUM: 'ETH', ERC20: 'ETH', ETH: 'ETH',
  AVALANCHE: 'AVAXC', AVAX: 'AVAXC', 'AVAX-C': 'AVAXC', AVAXC: 'AVAXC',
  ARBITRUM: 'ARBITRUM', ARB: 'ARBITRUM', 'ARBITRUM-ONE': 'ARBITRUM',
  SOLANA: 'SOL', SOL: 'SOL',
  BNB: 'BSC', BEP20: 'BSC', BINANCE: 'BSC', BSC: 'BSC',
  TRON: 'TRX', TRC20: 'TRX', TRX: 'TRX',
  BASE: 'BASE',
};

function normalizeNetwork(code) {
  const c = String(code || '').trim().toUpperCase().replace(/\s+/g, '-');
  return ALIASES[c] || c;
}

const FIELDS = ['minDeposit', 'depositFee', 'minWithdrawal', 'withdrawalFee'];

/**
 * Terms for one currency, defaults merged with admin overrides.
 * Returns [{ code, name, minDeposit, depositFee, minWithdrawal, withdrawalFee, enabled }].
 */
function networkTerms(currency, overrides = {}) {
  const cur = String(currency).toUpperCase();
  const base = OBIEX_DEFAULTS[cur] || {};
  const over = overrides?.[cur] || {};
  const codes = [...new Set([...Object.keys(base), ...Object.keys(over)])];
  return codes.map((code) => {
    const merged = { code, name: code, enabled: true, ...base[code], ...over[code] };
    return merged;
  }).filter((t) => FIELDS.every((f) => Number.isFinite(Number(t[f]))));
}

function termsFor(currency, network, overrides) {
  const code = normalizeNetwork(network);
  return networkTerms(currency, overrides).find((t) => t.code === code) || null;
}

module.exports = { OBIEX_DEFAULTS, normalizeNetwork, networkTerms, termsFor, FIELDS };
