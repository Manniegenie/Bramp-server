// services/kycImageStorage.js
// KYC images (selfies, liveness frames, the government ID photo returned by
// the provider) go to Cloudinary as `authenticated` assets: they are not
// reachable by their plain URL, only through a short-lived signed download
// link generated server-side for admin review. MongoDB keeps just the
// public_id, so KYC records stay small and well under the 16MB BSON limit.
const { v2: cloudinary } = require('cloudinary');
const logger = require('../utils/logger');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const SIGNED_URL_TTL_SECONDS = 60 * 60;

function isConfigured() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

function toDataUri(image) {
  if (typeof image !== 'string' || !image) return null;
  return image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`;
}

/**
 * Upload one KYC image. Never throws - returns null on failure so a storage
 * outage can't block verification; callers fall back to keeping the
 * (compressed) image inline.
 * @param {string} image - base64, with or without a data: URI prefix
 * @param {Object} opts
 * @param {string} opts.userId
 * @param {string} opts.kind - e.g. 'selfie', 'id_photo', 'liveness_0'
 * @param {string} [opts.jobId]
 * @returns {Promise<{publicId: string}|null>}
 */
async function uploadKycImage(image, { userId, kind, jobId }) {
  const dataUri = toDataUri(image);
  if (!dataUri) return null;
  if (!isConfigured()) {
    logger.warn('KYC image not uploaded - Cloudinary is not configured', { userId: String(userId), kind });
    return null;
  }

  try {
    const result = await cloudinary.uploader.upload(dataUri, {
      folder: `kyc/${userId}`,
      public_id: `${kind}_${jobId || Date.now()}`,
      type: 'authenticated',
      resource_type: 'image',
      overwrite: false,
    });
    return { publicId: result.public_id, format: result.format || 'jpg' };
  } catch (error) {
    logger.error('KYC image upload to Cloudinary failed', { userId: String(userId), kind, error: error.message });
    return null;
  }
}

/**
 * Short-lived link an admin's browser can load directly in an <img>.
 */
function signedUrl(publicId, format = 'jpg') {
  if (!publicId) return null;
  return cloudinary.utils.private_download_url(publicId, format, {
    type: 'authenticated',
    resource_type: 'image',
    expires_at: Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS,
  });
}

/**
 * Replace stored public_ids on a KYC document's imageLinks with signed URLs
 * in the fields the admin UI already renders (selfie_image, document_image,
 * liveness_images). Older records that still hold inline base64 pass
 * through unchanged.
 * @param {Object} kyc - plain object (e.g. from doc.toObject())
 */
function withSignedImageUrls(kyc) {
  const links = kyc && kyc.imageLinks;
  if (!links) return kyc;

  const out = { ...links };
  if (links.selfie_public_id) out.selfie_image = signedUrl(links.selfie_public_id);
  if (links.document_public_id) out.document_image = signedUrl(links.document_public_id);
  if (Array.isArray(links.liveness_public_ids) && links.liveness_public_ids.length) {
    out.liveness_images = links.liveness_public_ids.map((id) => signedUrl(id));
  }
  return { ...kyc, imageLinks: out };
}

module.exports = {
  isConfigured,
  uploadKycImage,
  signedUrl,
  withSignedImageUrls,
};
