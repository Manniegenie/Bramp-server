// services/storefrontBanks.js
// Nigerian banks for storefront payouts: Obiex's bank list (cached), matching
// what a customer types ("gtb", "opay") to a bank, and the account name lookup
// Stella reads back before saving an account.
const axios = require('axios');
const config = require('../routes/config');
const { attachObiexAuth } = require('../utils/obiexAuth');
const logger = require('../utils/logger');

const BANKS_TTL_MS = 12 * 60 * 60 * 1000;
let bankCache = null; // { at, list: [{ name, code }] }

const http = () => axios.create({
  baseURL: String(config.obiex?.baseURL || process.env.OBIEX_BASE_URL || 'https://api.obiex.finance/v1').replace(/\/+$/, ''),
  timeout: 15000,
});

async function obiexGet(url, params) {
  // Query string built here: attachObiexAuth's own `params` handling calls
  // query-string's CommonJS API, which the installed (ESM) version lacks.
  const qs = params ? `?${new URLSearchParams(params).toString()}` : '';
  const req = attachObiexAuth({ method: 'get', url: `${url}${qs}`, headers: {} });
  const res = await http().get(req.url, { headers: req.headers });
  return res.data?.data ?? res.data;
}

/** Obiex's banks: [{ name, code }] where code is the sort code. Cached 12 hours. */
async function listBanks() {
  if (bankCache && Date.now() - bankCache.at < BANKS_TTL_MS) return bankCache.list;
  const raw = await obiexGet('ngn-payments/banks');
  const seen = new Set();
  const list = (Array.isArray(raw) ? raw : [])
    .map((b) => ({ name: String(b?.name ?? '').trim(), code: String(b?.sortCode ?? b?.code ?? '').trim() }))
    .filter((b) => b.name && /^\d+$/.test(b.code) && !seen.has(b.code) && seen.add(b.code));
  if (list.length) bankCache = { at: Date.now(), list };
  return list;
}

// What people type for the banks most used in payouts.
const ALIASES = {
  gtb: 'guaranty trust', gtbank: 'guaranty trust', gt: 'guaranty trust',
  uba: 'united bank for africa', fbn: 'first bank', firstbank: 'first bank',
  fcmb: 'first city monument', stanbic: 'stanbic ibtc', ibtc: 'stanbic ibtc',
  palmpay: 'palmpay', opay: 'opay', moniepoint: 'moniepoint', kuda: 'kuda',
  wema: 'wema', alat: 'wema', zenith: 'zenith', access: 'access', fidelity: 'fidelity',
  sterling: 'sterling', union: 'union bank', polaris: 'polaris', ecobank: 'ecobank',
  keystone: 'keystone', unity: 'unity', providus: 'providus', jaiz: 'jaiz',
};
const norm = (s) => String(s || '').toLowerCase().replace(/\b(plc|limited|ltd|bank|nigeria|mfb|microfinance)\b/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Up to 5 banks matching what the customer typed, best first. */
async function findBanks(query) {
  const q = norm(query);
  if (!q) return [];
  const wanted = norm(ALIASES[q.replace(/\s/g, '')] || q);
  const scored = (await listBanks()).map((b) => {
    const n = norm(b.name);
    let score = 0;
    if (n === wanted) score = 100;
    else if (n.startsWith(wanted)) score = 80;
    else if (n.includes(wanted)) score = 60;
    else {
      const words = wanted.split(' ');
      const hits = words.filter((w) => w.length > 1 && n.includes(w)).length;
      score = hits ? Math.round((hits / words.length) * 50) : 0;
    }
    return { ...b, score };
  }).filter((b) => b.score > 0);
  scored.sort((a, b) => b.score - a.score || a.name.length - b.name.length);
  return scored.slice(0, 5).map(({ name, code }) => ({ name, code }));
}

/** Account name for a NUBAN at a bank (sort code), or null if not found. */
async function resolveAccount(bankCode, accountNumber) {
  if (!/^\d+$/.test(String(bankCode)) || !/^\d{10}$/.test(String(accountNumber))) return null;
  try {
    const data = await obiexGet('ngn-payments/accounts/resolve', { sortCode: bankCode, accountNumber });
    const name = String(data?.accountName || '').trim();
    return name || null;
  } catch (err) {
    const status = err.response?.status;
    if (status === 400 || status === 404 || status === 422) return null;
    logger.warn('Storefront: account lookup failed', { status: status || null, error: err.message });
    throw new Error('Bank account lookup is not available right now.');
  }
}

module.exports = { listBanks, findBanks, resolveAccount, _clearCache: () => { bankCache = null; } };
