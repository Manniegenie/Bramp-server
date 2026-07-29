// auth/nombaWebhookAuth.js
//
// Signature verification for Nomba webhooks. Reads req.rawBody (captured by the
// raw-body whitelist middleware in server.js — the route path MUST be added to
// that whitelist or req.rawBody will be undefined here).
//
// Unlike auth/webhookauth.js (which short-circuits with a response on failure),
// this middleware never sends a response itself — Phase 5 of the spec requires
// persisting a NombaWebhookEvent row even when the signature is invalid, and
// only the route handler (routes/Nombadeposit.js) has access to the DB models.
// So this middleware just verifies and annotates the request:
//   req.nombaSignatureValid : boolean
//   req.body                : parsed JSON (best-effort; {} if unparsable)
//   req.rawBody              : the exact bytes received (unchanged, for logging)
// The route handler decides what to persist and what status code to send.
//
// ⚠️ CONFIRM AGAINST NOMBA DOCS/DASHBOARD BEFORE GOING LIVE:
//   - Exact header name Nomba sends the signature in.
//   - Exact HMAC algorithm (assumed sha256, hex digest, per Nomba's public docs).
//   - Fire a real sandbox test event and diff against what's implemented here.
// Until confirmed, set NOMBA_WEBHOOK_SIGNATURE_HEADER in env if the header name
// differs from the default candidates below — no code change needed for that case.

const crypto = require('crypto');
const logger = require('../utils/logger');

const DEFAULT_HEADER_CANDIDATES = [
  process.env.NOMBA_WEBHOOK_SIGNATURE_HEADER,
  'x-nomba-signature',
  'nomba-signature',
].filter(Boolean);

function findSignatureHeader(req) {
  for (const name of DEFAULT_HEADER_CANDIDATES) {
    const value = req.headers[name.toLowerCase()];
    if (value) return { header: name, value };
  }
  return null;
}

/**
 * Constant-time-safe HMAC comparison. Returns false (never throws) on any
 * length mismatch or malformed hex, so callers can treat every failure the
 * same way without a try/catch at the call site.
 */
function safeCompareHex(a, b) {
  try {
    const bufA = Buffer.from(String(a), 'hex');
    const bufB = Buffer.from(String(b), 'hex');
    if (bufA.length !== bufB.length || bufA.length === 0) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

module.exports = function nombaWebhookAuth(req, res, next) {
  const rawBody = req.rawBody;
  const secret = process.env.NOMBA_WEBHOOK_SECRET;

  if (typeof rawBody !== 'string') {
    // Wiring bug (path not in server.js's raw-body whitelist), not a webhook-processing
    // case — nothing meaningful to persist since we have no bytes at all.
    logger.error('Nomba webhook: req.rawBody missing — is this path registered in the raw-body whitelist in server.js?');
    return res.status(500).json({ error: 'Webhook raw body capture not configured' });
  }

  if (!secret) {
    logger.error('Nomba webhook: NOMBA_WEBHOOK_SECRET not configured');
    return res.status(500).json({ error: 'Webhook signature validation not configured' });
  }

  let signatureValid = false;
  const found = findSignatureHeader(req);
  if (found) {
    const computed = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const provided = String(found.value).replace(/^sha256=/i, '').trim();
    signatureValid = safeCompareHex(provided, computed);
    if (!signatureValid) {
      logger.warn('Nomba webhook: invalid signature', { header: found.header });
    }
  } else {
    logger.warn('Nomba webhook: missing signature header', { checked: DEFAULT_HEADER_CANDIDATES });
  }

  try {
    req.body = JSON.parse(rawBody);
  } catch (error) {
    logger.error('Nomba webhook: raw body is not valid JSON', { error: error.message });
    req.body = {};
    req.nombaBodyParseFailed = true;
  }

  req.nombaSignatureValid = signatureValid;
  next();
};
