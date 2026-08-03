const express = require("express");
const { body, validationResult } = require("express-validator");
const axios = require("axios");
const router = express.Router();

const User = require("../models/user");
const KYC = require("../models/kyc");
const logger = require("../utils/logger");
const { classifyOutcome } = require("../utils/kycHelpers");
const { sendKycEmail, sendKycProvisionalAdminNotify } = require("../services/EmailService");

// Youverify Configuration
const YOUVERIFY_CONFIG = {
  publicMerchantKey: process.env.YOUVERIFY_PUBLIC_MERCHANT_KEY,
  secretKey: process.env.YOUVERIFY_SECRET_KEY,
  callbackUrl: process.env.YOUVERIFY_CALLBACK_URL || 'https://your-domain.com/kyc-webhook/callback',
  apiBaseUrl: process.env.YOUVERIFY_API_URL || 'https://api.youverify.co'
};

// Nigerian ID type mappings for Youverify
const NIGERIAN_ID_TYPES = {
  'passport': 'passport',
  'national_id': 'nin',
  'drivers_license': 'drivers-license',
  'bvn': 'bvn',
  'nin': 'nin',
  'nin_slip': 'nin',
  'voter_id': 'pvc'
};

// ID Format validation patterns
const ID_PATTERNS = {
  'bvn': /^\d{11}$/,
  'nin': /^\d{11}$/,
  'passport': /^[A-Z]\d{8}$/,
  'pvc': /^\d{19}$/,
  'drivers-license': /^[A-Z0-9]{8,20}$/
};

const validateYouverifyConfig = () => {
  if (!YOUVERIFY_CONFIG.publicMerchantKey) {
    throw new Error('YOUVERIFY_PUBLIC_MERCHANT_KEY is not configured');
  }
};

/**
 * Submit verification request to Youverify API
 */
async function submitToYouverify({ idType, idNumber, selfieImage, userId, partnerJobId }) {
  try {
    const endpointMap = {
      'nin': '/v2/api/identity/ng/nin',
      'national_id': '/v2/api/identity/ng/nin',
      'bvn': '/v2/api/identity/ng/bvn',
      'passport': '/v2/api/identity/ng/passport',
      'drivers_license': '/v2/api/identity/ng/drivers-license',
      'drivers-license': '/v2/api/identity/ng/drivers-license'
    };

    const endpointPath = endpointMap[idType.toLowerCase()];
    if (!endpointPath) throw new Error(`Unsupported ID type: ${idType}`);

    const apiUrl = `${YOUVERIFY_CONFIG.apiBaseUrl}${endpointPath}`;

    const payload = {
      id: idNumber,
      isSubjectConsent: true,
      metadata: {
        user_id: userId.toString(),
        partner_job_id: partnerJobId,
        source: 'bramp-mobile-app'
      }
    };

    const validations = {};
    if (selfieImage) {
      let imageUri = selfieImage;
      if (!selfieImage.startsWith('data:image/')) {
        imageUri = `data:image/jpeg;base64,${selfieImage}`;
      }
      validations.selfie = { image: imageUri };
    }

    if (Object.keys(validations).length > 0) {
      payload.validations = validations;
    }

    logger.info('Youverify API request', { endpoint: apiUrl, idType, hasSelfie: !!validations.selfie, jobId: partnerJobId });

    const response = await axios.post(apiUrl, payload, {
      headers: {
        'Content-Type': 'application/json',
        'Token': YOUVERIFY_CONFIG.secretKey || YOUVERIFY_CONFIG.publicMerchantKey
      },
      timeout: 30000
    });

    const youverifyId = response.data?.id || response.data?.data?.id;
    const dataObj = response.data?.data || response.data;
    const validationMessages = dataObj?.validations?.validationMessages || '';

    const verificationResult = {
      allValidationPassed: dataObj?.allValidationPassed,
      status: dataObj?.status,
      firstName: dataObj?.firstName,
      lastName: dataObj?.lastName,
      dateOfBirth: dataObj?.dateOfBirth,
      gender: dataObj?.gender,
      idNumber: dataObj?.idNumber,
      validationMessages,
      selfieMatch: dataObj?.validations?.selfie?.selfieVerification?.match,
      selfieConfidence: dataObj?.validations?.selfie?.selfieVerification?.confidenceLevel
    };

    logger.info('Youverify response', { status: response.status, youverifyId, jobId: partnerJobId });
    // BVN has no document photo to match a selfie against, unlike NIN/passport/
    // drivers-license — its response shape may not include allValidationPassed
    // at all, which is what verificationResult.allValidationPassed is built
    // from. Log the raw response body for BVN specifically until we've
    // confirmed the real success field Youverify sends for that endpoint.
    if (idType === 'bvn') {
      logger.info('Youverify BVN raw response body', { jobId: partnerJobId, dataObj });
    }

    return { success: true, data: response.data, youverifyId, verificationResult };
  } catch (error) {
    logger.error('Youverify API error', { message: error.message, status: error.response?.status, jobId: partnerJobId });
    return { success: false, error: error.response?.data || error.message, status: error.response?.status || 500 };
  }
}

// POST: /kyc/biometric-verification - Verify user identity using Youverify
router.post(
  "/biometric-verification",
  [
    body("idType")
      .trim().notEmpty().withMessage("ID type is required")
      .isIn(['passport', 'national_id', 'drivers_license', 'bvn', 'nin', 'nin_slip', 'voter_id'])
      .withMessage("Invalid ID type"),
    body("idNumber")
      .trim().notEmpty().withMessage("ID number is required")
      .isLength({ min: 8, max: 20 }).withMessage("ID number must be 8-20 characters"),
    body("selfieImage")
      .notEmpty().withMessage("Selfie image is required")
      .custom((value) => {
        if (typeof value === 'string' && (value.startsWith('data:image/') || value.length > 10)) return true;
        throw new Error("Selfie must be a valid base64 image");
      }),
    body("livenessImages").optional().isArray().withMessage("Liveness images must be an array"),
  ],
  async (req, res) => {
    const startTime = Date.now();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: "Validation failed", errors: errors.array() });
    }

    const { idType, idNumber, selfieImage, livenessImages } = req.body;

    try {
      validateYouverifyConfig();

      const user = await User.findById(req.user.id).select('firstname lastname email username phonenumber kycLevel kycStatus bvn bvnVerified kyc kycStatus');
      if (!user) return res.status(404).json({ success: false, message: "User not found" });

      if (!user.firstname || !user.lastname) {
        return res.status(400).json({ success: false, message: "Please complete your profile with first and last name before verifying." });
      }

      const isBvnVerification = idType === 'bvn';

      if (isBvnVerification) {
        const existingBvnUser = await User.findOne({ bvn: idNumber, _id: { $ne: user._id } });
        if (existingBvnUser) {
          return res.status(400).json({ success: false, message: "This BVN is already registered to another account." });
        }

        const existingBvn = await KYC.findOne({
          userId: user._id,
          frontendIdType: 'bvn',
          status: { $in: ['PENDING', 'PROVISIONAL', 'APPROVED'] }
        }).sort({ createdAt: -1 });

        if (existingBvn) {
          return res.status(400).json({
            success: false,
            message: existingBvn.status === 'APPROVED' ? "BVN already verified" : "BVN verification already in progress.",
            data: { kycId: existingBvn._id, status: existingBvn.status }
          });
        }
      } else {
        const existingKyc = await KYC.findOne({
          userId: user._id,
          frontendIdType: { $in: ['national_id', 'passport', 'drivers_license', 'nin', 'nin_slip', 'voter_id'] },
          status: { $in: ['PENDING', 'PROVISIONAL', 'APPROVED'] }
        }).sort({ createdAt: -1 });

        if (existingKyc) {
          return res.status(400).json({
            success: false,
            message: existingKyc.status === 'APPROVED' ? "Identity document already verified" : "KYC verification already in progress.",
            data: { kycId: existingKyc._id, status: existingKyc.status }
          });
        }
      }

      const youverifyIdType = NIGERIAN_ID_TYPES[idType];
      if (!youverifyIdType) return res.status(400).json({ success: false, message: `Unsupported ID type: ${idType}` });

      if (idType !== 'drivers_license') {
        const pattern = ID_PATTERNS[youverifyIdType];
        if (pattern && !pattern.test(idNumber)) {
          return res.status(400).json({ success: false, message: `Invalid ${idType} format. Please check your ID number.` });
        }
      } else {
        if (!/^[A-Z0-9]{8,20}$/i.test(idNumber)) {
          return res.status(400).json({ success: false, message: "Driver's license must be 8-20 alphanumeric characters." });
        }
      }

      const jobId = `${user._id}_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      let kycDoc;
      try {
        kycDoc = await KYC.create({
          userId: user._id,
          provider: 'youverify',
          environment: process.env.NODE_ENV || 'development',
          partnerJobId: jobId,
          jobType: 1,
          status: 'PENDING',
          idType: youverifyIdType,
          frontendIdType: idType,
          idNumber,
          createdAt: new Date(),
          lastUpdated: new Date(),
          imageLinks: { selfie_image: selfieImage, liveness_images: livenessImages || [] }
        });
      } catch (dbError) {
        if (dbError.code === 11000) {
          const existing = await KYC.findOne({
            userId: user._id,
            frontendIdType: idType,
            status: { $in: ['PENDING', 'PROVISIONAL', 'APPROVED'] }
          }).sort({ createdAt: -1 });
          if (existing) {
            return res.status(400).json({ success: false, message: "Verification already submitted.", data: { kycId: existing._id, status: existing.status } });
          }
        }
        throw dbError;
      }

      const youverifyResult = await submitToYouverify({ idType: youverifyIdType, idNumber, selfieImage, userId: user._id, partnerJobId: jobId });

      if (youverifyResult.success && youverifyResult.youverifyId) {
        const verification = youverifyResult.verificationResult || {};
        const kycUpdateData = { youverifyId: youverifyResult.youverifyId, lastUpdated: new Date() };

        if (verification.allValidationPassed !== undefined) {
          if (verification.allValidationPassed === true) {
            kycUpdateData.status = 'APPROVED';
            kycUpdateData.jobSuccess = true;
            kycUpdateData.allValidationPassed = true;
            kycUpdateData.verificationDate = new Date();
            kycUpdateData.resultText = 'Verification successful - all validations passed';
          } else {
            kycUpdateData.status = 'REJECTED';
            kycUpdateData.jobSuccess = false;
            kycUpdateData.allValidationPassed = false;
            kycUpdateData.resultText = 'Verification failed - incorrect data provided';
            if (verification.validationMessages) {
              kycUpdateData.payload = { validationMessages: verification.validationMessages };
            }
          }

          if (verification.firstName) kycUpdateData.firstName = verification.firstName;
          if (verification.lastName) kycUpdateData.lastName = verification.lastName;
          if (verification.dateOfBirth) kycUpdateData.dateOfBirth = verification.dateOfBirth;
          if (verification.gender) kycUpdateData.gender = verification.gender;
          if (verification.idNumber) kycUpdateData.idNumber = verification.idNumber;
        }

        await KYC.findByIdAndUpdate(kycDoc._id, { $set: kycUpdateData });

        if (verification.allValidationPassed !== undefined) {
          try {
            if (verification.allValidationPassed === true) {
              await sendKycEmail(user.email, user.firstname, 'APPROVED', 'Your identity verification has been successfully completed.');
            } else {
              await sendKycEmail(user.email, user.firstname, 'REJECTED', 'Incorrect data provided. Please ensure your selfie clearly shows your face and matches your ID document.');
            }
          } catch (emailErr) {
            logger.error('Failed to send KYC result email', { userId: user._id, error: emailErr.message });
          }
        }
      } else {
        if (youverifyResult.status >= 400) {
          await KYC.findByIdAndUpdate(kycDoc._id, {
            $set: { status: 'PROVISIONAL', errorReason: `Youverify API error: ${JSON.stringify(youverifyResult.error)}`, lastUpdated: new Date() }
          });
          sendKycProvisionalAdminNotify({
            username: user.firstname || user.email,
            userId: String(user._id),
            idType,
            provisionalReason: `Youverify API error: ${JSON.stringify(youverifyResult.error)}`,
            kycId: String(kycDoc._id)
          }).catch(err => logger.error('KYC provisional admin notify failed', { error: err.message }));
        }
      }

      const verification = youverifyResult.verificationResult || {};
      const finalStatus = verification.allValidationPassed === true ? 'approved' :
                         verification.allValidationPassed === false ? 'rejected' : 'pending';

      if (isBvnVerification) {
        try {
          await User.findByIdAndUpdate(user._id, {
            $set: { bvn: idNumber, bvnVerified: verification.allValidationPassed === true, 'kyc.updatedAt': new Date(), 'kyc.latestKycId': kycDoc._id }
          });
        } catch (bvnUpdateError) {
          if (bvnUpdateError.code === 11000) {
            await User.findByIdAndUpdate(user._id, {
              $set: { bvnVerified: false, 'kyc.updatedAt': new Date(), 'kyc.latestKycId': kycDoc._id }
            });
          } else throw bvnUpdateError;
        }
      } else {
        const userUpdate = {
          'kyc.status': finalStatus,
          'kyc.updatedAt': new Date(),
          'kyc.latestKycId': kycDoc._id,
          'kyc.level2.status': finalStatus,
          'kycStatus': finalStatus
        };

        if (verification.allValidationPassed === true) {
          userUpdate['kyc.level2.documentSubmitted'] = true;
          userUpdate['kyc.level2.documentType'] = idType;
          userUpdate['kyc.level2.documentNumber'] = idNumber;
          userUpdate['kyc.level2.approvedAt'] = new Date();
          userUpdate['kyc.level2.rejectionReason'] = null;
        } else if (verification.allValidationPassed === false) {
          userUpdate['kyc.level2.rejectionReason'] = 'Incorrect data provided.';
        }

        await User.findByIdAndUpdate(user._id, { $set: userUpdate });

        if (verification.allValidationPassed === true) {
          try {
            const updatedUser = await User.findById(user._id);
            if (updatedUser.onIdentityDocumentVerified) {
              await updatedUser.onIdentityDocumentVerified(idType, idNumber);
            }
          } catch (upgradeError) {
            logger.warn('Error during KYC upgrade after verification', { error: upgradeError.message, userId: user._id });
          }
        }
      }

      logger.info("KYC submitted", { userId: user._id, kycId: kycDoc._id, type: isBvnVerification ? 'BVN' : idType, time: `${Date.now() - startTime}ms` });

      return res.status(200).json({
        success: true,
        message: isBvnVerification
          ? "BVN verification submitted! Your Bank Verification Number is being verified."
          : "Submission complete! Your ID verification is being processed.",
        data: {
          jobId,
          kycId: kycDoc._id,
          youverifyId: youverifyResult.youverifyId || null,
          status: youverifyResult.status >= 400 ? "provisional" : "pending",
          submittedAt: kycDoc.createdAt,
          idType,
          verificationType: isBvnVerification ? 'bvn' : 'document',
          processingTime: Date.now() - startTime,
          youverifySubmitted: youverifyResult.success
        }
      });

    } catch (error) {
      logger.error("KYC submission error", { userId: req.user.id, error: error.message });

      if (error.code === 11000 || (error.message && error.message.includes('duplicate key'))) {
        const duplicateField = error.message.includes('bvn') ? 'BVN' : error.message.includes('nin') ? 'NIN' : 'ID';
        return res.status(400).json({ success: false, message: `This ${duplicateField} is already registered to another account.` });
      }

      return res.status(500).json({ success: false, message: "Server error during ID verification. Please try again." });
    }
  }
);

module.exports = router;
