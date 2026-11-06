// Service-to-service auth for Bramp Storefront. Two ways in, both setting
// req.merchant. Separate from end-user JWT, admin JWT and Metusela's
// partnerAuth.
//
//   Hosted stores — bramp.shop's backend acts for the store with its own key:
//     X-Bramp-Shop-Key: <STOREFRONT_PLATFORM_KEY>
//     X-Storefront-Slug: tolu
//
//   Stores with their own key (Pro server, WhatsApp bot) — one leaked key
//   exposes one store and can be revoked without touching the others:
//     X-Storefront-Key: sfk_<keyId>_<secret>
//
// Only sha256(secret) is stored (models/storefrontMerchant.js). Not
// network-locked like Metusela's port: a Pro trader's storefront-api runs on
// their own server, so these routes have to answer on the public port.
const crypto = require('crypto');
const StorefrontMerchant = require('../models/storefrontMerchant');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

function newKey() {
  const keyId = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(24).toString('base64url');
  return { keyId, keyHash: sha256(secret).toString('hex'), apiKey: `sfk_${keyId}_${secret}` };
}

function platformKeyValid(given) {
  const expected = process.env.STOREFRONT_PLATFORM_KEY;
  return Boolean(expected && expected.length >= 32 && given && crypto.timingSafeEqual(sha256(given), sha256(expected)));
}

async function findMerchant(req) {
  if (req.headers['x-bramp-shop-key'] !== undefined) {
    if (!platformKeyValid(req.headers['x-bramp-shop-key'])) return null;
    const slug = String(req.headers['x-storefront-slug'] || '').toLowerCase().trim();
    return slug ? StorefrontMerchant.findOne({ slug }) : null;
  }
  const match = /^sfk_([a-f0-9]{12})_([A-Za-z0-9_-]{32})$/.exec(req.headers['x-storefront-key'] || '');
  if (!match) return null;
  const merchant = await StorefrontMerchant.findOne({ keyId: match[1] });
  if (!merchant?.keyHash || !crypto.timingSafeEqual(sha256(match[2]), Buffer.from(merchant.keyHash, 'hex'))) return null;
  return merchant;
}

async function storefrontAuth(req, res, next) {
  try {
    const merchant = await findMerchant(req);
    if (!merchant) return res.status(401).json({ success: false, message: 'Invalid or missing storefront credentials.' });
    if (merchant.status === 'closed') return res.status(403).json({ success: false, message: 'This storefront is closed.' });
    req.merchant = merchant;
    req.viaPlatform = req.headers['x-bramp-shop-key'] !== undefined;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = storefrontAuth;
module.exports.newKey = newKey;
module.exports.platformKeyValid = platformKeyValid;
