const mongoose = require('mongoose');

// Admin-editable Metusela settings (adminRoutes/metusela.js), one document.
// Fees in basis points (100 bps = 1%) or flat USDC. Every change is
// recorded in MetuselaSettingsAudit.
const metuselaSettingsSchema = new mongoose.Schema({
  key: { type: String, default: 'global', unique: true },

  depositFeeBps: { type: Number, default: 0, min: 0, max: 10000 },
  depositFeeFlatUsdc: { type: Number, default: 0, min: 0 },
  // Extra margin on USDT → USDC conversions, on top of Obiex's rate.
  usdtSwapMarkupBps: { type: Number, default: 0, min: 0, max: 10000 },
  withdrawalFeeFlatUsdc: { type: Number, default: 0, min: 0 },
  minWithdrawalUsdc: { type: Number, default: 10, min: 0 },

  depositCurrencies: { type: [String], default: ['USDC', 'USDT'] },
  // Empty list = every network Obiex currently offers for that currency.
  depositNetworks: {
    USDC: { type: [String], default: [] },
    USDT: { type: [String], default: [] },
  },

  depositsEnabled: { type: Boolean, default: true },
  withdrawalsEnabled: { type: Boolean, default: true },
  betsEnabled: { type: Boolean, default: true },

  updatedBy: { type: String, default: null },
}, { timestamps: true, minimize: false });

const PATCHABLE = {
  depositFeeBps: 'bps',
  depositFeeFlatUsdc: 'usdc',
  usdtSwapMarkupBps: 'bps',
  withdrawalFeeFlatUsdc: 'usdc',
  minWithdrawalUsdc: 'usdc',
  depositCurrencies: 'currencies',
  'depositNetworks.USDC': 'networks',
  'depositNetworks.USDT': 'networks',
  depositsEnabled: 'bool',
  withdrawalsEnabled: 'bool',
  betsEnabled: 'bool',
};

metuselaSettingsSchema.statics.PATCHABLE = PATCHABLE;

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
      const list = Array.isArray(value) ? value.map((v) => String(v).trim().toUpperCase()).filter(Boolean) : null;
      if (!list || !list.every((n) => /^[A-Z0-9_]{2,20}$/.test(n))) errors.push(`${path} must be a list of network codes (empty = all)`);
      else clean[path] = [...new Set(list)];
    }
  }
  return { errors, clean };
};

const auditSchema = new mongoose.Schema({
  adminId: { type: String, default: null },
  adminEmail: { type: String, default: null },
  changes: { type: [mongoose.Schema.Types.Mixed], default: [] }, // [{ path, from, to }]
}, { timestamps: true });

const MetuselaSettings = mongoose.models.MetuselaSettings || mongoose.model('MetuselaSettings', metuselaSettingsSchema);
const MetuselaSettingsAudit = mongoose.models.MetuselaSettingsAudit || mongoose.model('MetuselaSettingsAudit', auditSchema);
module.exports = { MetuselaSettings, MetuselaSettingsAudit };
