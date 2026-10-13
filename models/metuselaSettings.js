const mongoose = require('mongoose');
const { normalizeNetwork, FIELDS } = require('../services/metuselaNetworks');

// Admin-editable Metusela settings (adminRoutes/metusela.js), one document.
// Fees in basis points (100 bps = 1%) or flat USDC. Every change is
// recorded in MetuselaSettingsAudit.
const metuselaSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'global', unique: true },

  depositFeeBps: { type: Number, default: 0, min: 0, max: 10000 },
  depositFeeFlatUsdc: { type: Number, default: 0, min: 0 },
  // Commission on every bet (call, tail, fade): a share of the stake goes to
  // FEES, the rest is the order budget sent to Polymarket. All-in: the user
  // is debited exactly the stake they entered.
  betFeeBps: { type: Number, default: 0, min: 0, max: 10000 },
  // Extra margin on USDT → USDC conversions, on top of Obiex's rate.
  usdtSwapMarkupBps: { type: Number, default: 0, min: 0, max: 10000 },
  // Our flat fee per withdrawal, on top of Obiex's network fee.
  withdrawalFeeFlatUsdc: { type: Number, default: 0, min: 0 },
  // Platform floor; each network's own Obiex minimum applies as well.
  minWithdrawalUsdc: { type: Number, default: 1, min: 0 },
  // Overrides of Obiex's per-network terms (services/metuselaNetworks.js),
  // e.g. { USDC: { MATIC: { withdrawalFee: 1.5 } }, USDT: { TRX: { enabled: false } } }.
  networkOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },

  depositCurrencies: { type: [String], default: ['USDC', 'USDT'] },
  // Empty list = every network Obiex currently offers for that currency.
  depositNetworks: {
    USDC: { type: [String], default: [] },
    USDT: { type: [String], default: [] },
  },


  // Limits on customer money at Polymarket (services/metuselaFloat.js).
  // Worst case if the Polymarket account is locked: floatCap + openBetsCap.
  floatCapUsdc: { type: Number, default: 50, min: 0 },
  openBetsCapUsdc: { type: Number, default: 2000, min: 0 },
  perMarketCapUsdc: { type: Number, default: 200, min: 0 },

  depositsEnabled: { type: Boolean, default: true },
  withdrawalsEnabled: { type: Boolean, default: true },
  betsEnabled: { type: Boolean, default: true },
  // Set when Metusela reports a Polymarket lockout; cleared when an admin
  // turns betting back on.
  betsPausedReason: { type: String, default: null },

  updatedBy: { type: String, default: null },
}, { timestamps: true, minimize: false });

const PATCHABLE = {
  depositFeeBps: 'bps',
  depositFeeFlatUsdc: 'usdc',
  usdtSwapMarkupBps: 'bps',
  betFeeBps: 'bps',
  withdrawalFeeFlatUsdc: 'usdc',
  minWithdrawalUsdc: 'usdc',
  floatCapUsdc: 'usdc',
  openBetsCapUsdc: 'usdc',
  perMarketCapUsdc: 'usdc',
  depositCurrencies: 'currencies',
  'depositNetworks.USDC': 'networks',
  'depositNetworks.USDT': 'networks',
  networkOverrides: 'networkOverrides',
  depositsEnabled: 'bool',
  withdrawalsEnabled: 'bool',
  betsEnabled: 'bool',
};

metuselaSettingsSchema.statics.PATCHABLE = PATCHABLE;

// Labels and input hints for the admin web page, so it can draw the
// settings form without hard-coding it. `type` matches PATCHABLE.
metuselaSettingsSchema.statics.FIELDS = [
  { path: 'depositFeeBps', label: 'Deposit fee', type: 'bps', unit: 'basis points (100 = 1%)', min: 0, max: 10000, help: 'Percentage taken from every crypto deposit.' },
  { path: 'depositFeeFlatUsdc', label: 'Deposit fee (flat)', type: 'usdc', unit: 'USDC', min: 0, help: 'Fixed amount taken from every deposit, on top of the percentage.' },
  { path: 'betFeeBps', label: 'Bet fee', type: 'bps', unit: 'basis points (100 = 1%)', min: 0, max: 10000, help: 'Your commission on every call, tail and fade, taken from the stake.' },
  { path: 'usdtSwapMarkupBps', label: 'USDT → USDC markup', type: 'bps', unit: 'basis points', min: 0, max: 10000, help: 'Margin on USDT deposits, on top of Obiex’s swap rate.' },
  { path: 'withdrawalFeeFlatUsdc', label: 'Withdrawal fee', type: 'usdc', unit: 'USDC', min: 0, help: 'Our fee per withdrawal, on top of Obiex’s network fee.' },
  { path: 'minWithdrawalUsdc', label: 'Minimum withdrawal', type: 'usdc', unit: 'USDC', min: 0, help: 'Platform floor. Each network’s Obiex minimum also applies.' },
  { path: 'floatCapUsdc', label: 'Idle cash cap at Polymarket', type: 'usdc', unit: 'USDC', min: 0, help: 'Most customer money that may sit unused in the Polymarket wallet. Top-ups only refill to this.' },
  { path: 'openBetsCapUsdc', label: 'Open bets cap', type: 'usdc', unit: 'USDC', min: 0, help: 'Most money in live bets at once. New bets are refused above it.' },
  { path: 'perMarketCapUsdc', label: 'Per-market cap', type: 'usdc', unit: 'USDC', min: 0, help: 'Most money in live bets on one market.' },
  { path: 'depositCurrencies', label: 'Deposit coins', type: 'currencies', options: ['USDC', 'USDT'], help: 'Coins users can deposit. Everything is credited as USDC.' },
  { path: 'depositNetworks.USDC', label: 'USDC deposit networks', type: 'networks', help: 'Empty = every network in the fee table that Obiex offers.' },
  { path: 'depositNetworks.USDT', label: 'USDT deposit networks', type: 'networks', help: 'Empty = every network in the fee table that Obiex offers.' },
  { path: 'depositsEnabled', label: 'Deposits on', type: 'bool', help: 'Turn off to stop new deposit addresses being issued.' },
  { path: 'withdrawalsEnabled', label: 'Withdrawals on', type: 'bool', help: 'Kill switch for user withdrawals.' },
  { path: 'betsEnabled', label: 'Betting on', type: 'bool', help: 'Kill switch for new stakes and float top-ups. Also switched off automatically on a Polymarket lockout.' },
];

metuselaSettingsSchema.statics.get = async function get() {
  return (await this.findOne({ key: 'global' })) || this.create({ key: 'global' });
};

/** Validate a flat patch ({ "depositFeeBps": 50, … }). Never throws. */
metuselaSettingsSchema.statics.validatePatch = function validatePatch(patch) {
  const errors = [];
  const clean = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { errors: ['Body must be an object of setting → value.'], clean };
  for (const [path, value] of Object.entries(patch)) {
    const type = PATCHABLE[path];
    if (!type) { errors.push(`Unknown or non-editable setting: ${path}`); continue; }
    if (type === 'bps') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 10000) errors.push(`${path} must be a whole number of basis points, 0–10000`);
      else clean[path] = n;
    } else if (type === 'usdc') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) errors.push(`${path} must be a non-negative number`);
      else clean[path] = Math.round(n * 100) / 100;
    } else if (type === 'bool') {
      if (typeof value !== 'boolean') errors.push(`${path} must be true or false`);
      else clean[path] = value;
    } else if (type === 'currencies') {
      const list = Array.isArray(value) ? value.map((v) => String(v).toUpperCase()) : null;
      if (!list || !list.every((c) => ['USDC', 'USDT'].includes(c))) errors.push(`${path} must be a list of USDC and/or USDT`);
      else clean[path] = [...new Set(list)];
    } else if (type === 'networks') {
      const list = Array.isArray(value) ? value.map((v) => normalizeNetwork(v)).filter(Boolean) : null;
      if (!list || !list.every((n) => /^[A-Z0-9_-]{2,20}$/.test(n))) errors.push(`${path} must be a list of network codes (empty = all)`);
      else clean[path] = [...new Set(list)];
    } else if (type === 'networkOverrides') {
      // { USDC|USDT: { <network>: { minDeposit?, depositFee?, minWithdrawal?, withdrawalFee?, enabled?, name? } } }
      const out = {};
      let ok = value && typeof value === 'object' && !Array.isArray(value);
      for (const [cur, nets] of Object.entries(ok ? value : {})) {
        const C = String(cur).toUpperCase();
        if (!['USDC', 'USDT'].includes(C) || !nets || typeof nets !== 'object') { ok = false; break; }
        out[C] = {};
        for (const [net, terms] of Object.entries(nets)) {
          const code = normalizeNetwork(net);
          if (!/^[A-Z0-9_-]{2,20}$/.test(code) || !terms || typeof terms !== 'object') { ok = false; break; }
          const t = {};
          for (const [k, v] of Object.entries(terms)) {
            if (FIELDS.includes(k) && Number.isFinite(Number(v)) && Number(v) >= 0) t[k] = Number(v);
            else if (k === 'enabled' && typeof v === 'boolean') t.enabled = v;
            else if (k === 'name' && typeof v === 'string' && v.length <= 40) t.name = v;
            else { ok = false; break; }
          }
          out[C][code] = t;
        }
        if (!ok) break;
      }
      if (!ok) errors.push(`${path} must be { USDC|USDT: { <network>: { minDeposit, depositFee, minWithdrawal, withdrawalFee (numbers ≥ 0), enabled (true/false) } } }`);
      else clean[path] = out;
    }
  }
  return { errors, clean };
};

// Every Metusela admin action: settings changes, fee-table edits, balance
// adjustments, resolved deposits, manual float top-ups.
const auditSchema = new mongoose.Schema({
  adminId: { type: String, default: null },
  adminEmail: { type: String, default: null },
  action: { type: String, default: 'SETTINGS_UPDATE' },
  target: { type: String, default: null }, // e.g. "USDC/MATIC", a partnerUserId, a deposit id
  changes: { type: [mongoose.Schema.Types.Mixed], default: [] }, // [{ path, from, to }]
  note: { type: String, default: null },
}, { timestamps: true });

const MetuselaSettings = mongoose.models.MetuselaSettings || mongoose.model('MetuselaSettings', metuselaSettingsSchema);
const MetuselaSettingsAudit = mongoose.models.MetuselaSettingsAudit || mongoose.model('MetuselaSettingsAudit', auditSchema);
module.exports = { MetuselaSettings, MetuselaSettingsAudit };
