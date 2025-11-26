// services/bankDirectory.js
// In-memory cache mapping paymentId -> (bank name -> code). Use Redis in production.

const TTL_MS = 60 * 60 * 1000; // 1 hour
const store = new Map(); // paymentId -> { byName: Map<string,string>, ts: number }

function normalizeName(name = '') {
  return String(name).trim().toLowerCase();
}

/**
 * Save mapping for a paymentId
 * @param {string} paymentId
 * @param {{name: string, code: string}[]} banks
 */
function set(paymentId, banks = []) {
  const byName = new Map();
  for (const b of banks) {
    if (b?.name && b?.code) {
      byName.set(normalizeName(b.name), String(b.code));
    }
  }
  store.set(paymentId, { byName, ts: Date.now() });
}

/**
 * Resolve bank code from paymentId + bankName
 * @param {string} paymentId
 * @param {string} bankName
 * @returns {string|null}
 */
function getCode(paymentId, bankName) {
  const rec = store.get(paymentId);
  if (!rec) return null;

  if (Date.now() - rec.ts > TTL_MS) {
    store.delete(paymentId);
    return null;
  }
  return rec.byName.get(normalizeName(bankName)) || null;
}

module.exports = { set, getCode };
