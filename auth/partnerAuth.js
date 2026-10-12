// Service-to-service auth for external-partner endpoints (currently just
// Metusela) — a plain shared API key, deliberately separate from both
// end-user JWT (authenticateToken) and admin JWT (authenticateAdminToken).
// Not a signed-request scheme like Obiex's, since this is Bramp acting as
// the server being called, not the caller.
module.exports = function partnerAuth(req, res, next) {
  const key = req.headers['x-partner-key'];
  const expected = process.env.METUSELA_PARTNER_API_KEY;

  if (!expected) {
    console.error('partnerAuth - METUSELA_PARTNER_API_KEY is not configured');
    return res.status(503).json({ success: false, message: 'Partner API is not configured.' });
  }
  if (!key || key !== expected) {
    return res.status(401).json({ success: false, message: 'Invalid or missing partner key.' });
  }

  req.partner = 'metusela';
  next();
};
