// Service-to-service auth for external-partner endpoints (currently just
// Metusela) — a plain shared API key, deliberately separate from both
// end-user JWT (authenticateToken) and admin JWT (authenticateAdminToken).
// Not a signed-request scheme like Obiex's, since this is Bramp acting as
// the server being called, not the caller.
//
// Network lock: with METUSELA_INTERNAL_PORT set, server.js also listens on
// 127.0.0.1:<that port>, and partner routes answer only on it. nginx proxies
// public traffic to PORT, so the internet can't reach these routes even with
// the key. (A "from 127.0.0.1" check wouldn't do: behind nginx every public
// request arrives from 127.0.0.1.)
const crypto = require('crypto');

function sameKey(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

module.exports = function partnerAuth(req, res, next) {
  const internalPort = Number(process.env.METUSELA_INTERNAL_PORT) || null;
  if (internalPort && req.socket.localPort !== internalPort) {
    return res.status(404).json({ success: false, message: 'Not found.' });
  }

  const key = req.headers['x-partner-key'];
  const expected = process.env.METUSELA_PARTNER_API_KEY;

  if (!expected) {
    console.error('partnerAuth - METUSELA_PARTNER_API_KEY is not configured');
    return res.status(503).json({ success: false, message: 'Partner API is not configured.' });
  }
  if (!key || !sameKey(key, expected)) {
    return res.status(401).json({ success: false, message: 'Invalid or missing partner key.' });
  }

  req.partner = 'metusela';
  next();
};
