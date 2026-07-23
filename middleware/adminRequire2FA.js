const speakeasy = require('speakeasy');
const AdminUser = require('../models/admin');

// Requires the admin to present a valid TOTP in the X-2FA-Token header for
// sensitive actions (fund, delete, clear pending, update address, unlock).
// Mirrors ZeusODX-server's admin 2FA gate.
module.exports = async function adminRequire2FA(req, res, next) {
  try {
    const token2FA = req.headers['x-2fa-token'];

    if (!token2FA) {
      return res.status(403).json({
        success: false,
        error: '2FA verification required for this action.',
        requires2FA: true,
      });
    }

    const adminId = req.admin && (req.admin.id || req.admin._id);
    const admin = await AdminUser.findById(adminId).select('twoFASecret is2FAEnabled is2FASetupCompleted');

    if (!admin) {
      return res.status(403).json({ success: false, error: 'Admin not found.' });
    }

    if (!admin.is2FAEnabled || !admin.twoFASecret) {
      return res.status(403).json({
        success: false,
        error: '2FA must be enabled to perform this action. Please set up 2FA in your account settings.',
      });
    }

    const verified = speakeasy.totp.verify({
      secret: admin.twoFASecret,
      encoding: 'base32',
      token: String(token2FA).trim(),
      window: 2,
    });

    if (!verified) {
      return res.status(403).json({
        success: false,
        error: 'Invalid 2FA token. Please check your authenticator app.',
        requires2FA: true,
      });
    }

    next();
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: 'Internal server error during 2FA verification.',
    });
  }
};
