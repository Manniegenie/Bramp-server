// bramp.shop's own backend (not a trader's storefront-api) calling us to
// onboard traders, before they have a store.
//
//   X-Bramp-Shop-Key: <STOREFRONT_PLATFORM_KEY>
//
// One shared secret, kept server-side on bramp.shop (a Vercel env var), never
// in the browser. The same key lets bramp.shop act for hosted stores
// (auth/storefrontAuth.js).
const { platformKeyValid } = require('./storefrontAuth');

function storefrontPlatformAuth(req, res, next) {
  if (!process.env.STOREFRONT_PLATFORM_KEY || process.env.STOREFRONT_PLATFORM_KEY.length < 32) {
    return res.status(503).json({ success: false, message: 'Bramp Shop onboarding is not configured.' });
  }
  if (!platformKeyValid(req.headers['x-bramp-shop-key'])) {
    return res.status(401).json({ success: false, message: 'Invalid or missing Bramp Shop key.' });
  }
  next();
}

module.exports = storefrontPlatformAuth;
