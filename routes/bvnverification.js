const express = require('express');
const router = express.Router();
const multer = require('multer');

const User = require('../models/user');
const logger = require('../utils/logger');
const { createQoreIdClient } = require('../utils/qoreIDAuth'); // Import the auth utils

// Configure multer for image uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'), false);
    }
  }
});

// BVN Face Match configuration (removed API_KEY since it's handled by auth utils)
const BVN_FACE_MATCH_CONFIG = {
  API_BASE_URL: process.env.QOREID_API_URL || 'https://api.qoreid.com',
  TIMEOUT: 45000, // 45 seconds for face processing
  MATCH_THRESHOLD: 70, // Industry standard for financial services (70%)
  BVN_LENGTH: 11
};

// Create QoreID client instance
const qoreIdClient = createQoreIdClient(BVN_FACE_MATCH_CONFIG.API_BASE_URL);

/**
 * Validates BVN Face Match request parameters
 * @param {string} bvnNumber - BVN from path parameter  
 * @param {Object} file - Uploaded selfie file
 * @returns {Object} Validation result
 */
function validateBvnFaceMatchRequest(bvnNumber, file) {
  const errors = [];

  // BVN number validation
  if (!bvnNumber?.trim()) {
    errors.push('BVN number is required');
  } else {
    const cleanBvn = bvnNumber.trim().replace(/\s/g, '');
    if (!/^\d{11}$/.test(cleanBvn)) {
      errors.push('BVN must be exactly 11 digits');
    }
  }

  // Selfie image validation
  if (!file) {
    errors.push('Selfie image is required');
  } else {
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (file.size > maxSize) {
      errors.push('Selfie image must be less than 10MB');
    }
    
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png'];
    if (!allowedTypes.includes(file.mimetype)) {
      errors.push('Selfie must be JPEG, JPG, or PNG format');
    }
  }

  if (errors.length > 0) {
    return {
      success: false,
      errors,
      message: errors.join('; ')
    };
  }

  return {
    success: true,
    validatedData: {
      bvn: bvnNumber.trim().replace(/\s/g, ''),
      selfieImage: file
    }
  };
}

/**
 * Converts image buffer to base64 string
 * @param {Buffer} imageBuffer - Image buffer from multer
 * @returns {string} Base64 encoded image
 */
function convertImageToBase64(imageBuffer) {
  return imageBuffer.toString('base64');
}

/**
 * Checks if names match between user database and BVN data
 * @param {Object} user - User from database
 * @param {Object} bvnData - BVN data from QoreID
 * @returns {Object} Name match result
 */
function checkNameMatch(user, bvnData) {
  const userFirstName = user.firstname?.toLowerCase().trim();
  const userLastName = user.lastname?.toLowerCase().trim();
  const bvnFirstName = bvnData.firstname?.toLowerCase().trim();
  const bvnLastName = bvnData.lastname?.toLowerCase().trim();
  
  const firstNameMatch = userFirstName === bvnFirstName;
  const lastNameMatch = userLastName === bvnLastName;
  const bothNamesMatch = firstNameMatch && lastNameMatch;
  
  return {
    firstNameMatch,
    lastNameMatch,
    bothNamesMatch,
    userFullName: `${user.firstname} ${user.lastname}`,
    bvnFullName: `${bvnData.firstname} ${bvnData.lastname}`,
    details: {
      userFirstName: user.firstname,
      userLastName: user.lastname,
      bvnFirstName: bvnData.firstname,
      bvnLastName: bvnData.lastname
    }
  };
}

/**
 * Generates appropriate failure message based on what failed
 * @param {Object} faceMatch - Face match results
 * @param {Object} nameMatch - Name match results
 * @returns {string} Failure message
 */
function generateFailureMessage(faceMatch, nameMatch) {
  const faceMatchPassed = faceMatch.passedThreshold;
  const nameMatchPassed = nameMatch.bothNamesMatch;
  
  if (!faceMatchPassed && !nameMatchPassed) {
    return `Verification failed: Face match score (${faceMatch.matchScore.toFixed(1)}%) below ${BVN_FACE_MATCH_CONFIG.MATCH_THRESHOLD}% threshold and names don't match. Please try again with a clearer selfie and ensure your profile names match your BVN exactly.`;
  } else if (!faceMatchPassed) {
    return `Face match score (${faceMatch.matchScore.toFixed(1)}%) below required threshold (${BVN_FACE_MATCH_CONFIG.MATCH_THRESHOLD}%). Please try again with a clearer selfie.`;
  } else if (!nameMatchPassed) {
    return `Names don't match: Your profile shows "${nameMatch.userFullName}" but BVN shows "${nameMatch.bvnFullName}". Please update your profile to match your BVN exactly.`;
  }
  
  return 'Verification failed. Please try again.';
}

/**
 * Calls QoreID BVN Face Match API using the auth utils
 * @param {string} bvn - BVN number
 * @param {string} photoBase64 - Base64 encoded selfie
 * @returns {Promise<Object>} API response
 */
async function callQoreIdBvnFaceMatchApi(bvn, photoBase64) {
  try {
    const requestBody = {
      idNumber: bvn,
      photobase64: photoBase64
    };

    logger.info('Calling QoreID BVN Face Match API', {
      bvn: `***${bvn.slice(-4)}`,
      requestBodySize: JSON.stringify(requestBody).length
    });

    // Use the authenticated client - authentication is handled automatically
    const response = await qoreIdClient.post('/v1/ng/identities/face-verification/bvn', requestBody, {
      timeout: BVN_FACE_MATCH_CONFIG.TIMEOUT
    });

    logger.info('QoreID BVN Face Match API call successful', {
      bvn: `***${bvn.slice(-4)}`,
      status: response.status
    });

    return {
      success: true,
      data: response.data
    };
  } catch (error) {
    logger.error('QoreID BVN Face Match API call failed', {
      bvn: `***${bvn.slice(-4)}`,
      error: error.response?.data || error.message,
      status: error.response?.status,
      code: error.code
    });

    // Handle specific error cases
    if (error.response?.status === 400) {
      return {
        success: false,
        message: 'Invalid BVN or selfie image',
        details: error.response.data
      };
    } else if (error.response?.status === 401) {
      return {
        success: false,
        message: 'Authentication failed. Please try again.',
        details: 'Token may have expired and refresh failed'
      };
    } else if (error.response?.status === 404) {
      return {
        success: false,
        message: 'BVN not found in database'
      };
    } else if (error.response?.status === 403) {
      return {
        success: false,
        message: 'Access denied. Please check your API permissions.',
        details: error.response.data
      };
    } else if (error.code === 'ECONNABORTED') {
      return {
        success: false,
        message: 'Face verification request timed out. Please try again.'
      };
    } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return {
        success: false,
        message: 'Unable to connect to verification service. Please try again later.'
      };
    }

    return {
      success: false,
      message: 'Face verification service is currently unavailable. Please try again later.'
    };
  }
}

/**
 * Processes BVN Face Match verification response
 * @param {Object} qoreIdResponse - Response from QoreID API
 * @returns {Object} Processed verification result
 */
function processBvnFaceMatchResult(qoreIdResponse) {
  const { id, summary, status, face_verification } = qoreIdResponse;
  
  const faceVerificationCheck = summary?.face_verification_check || {};
  const matchScore = faceVerificationCheck.match_score || 0;
  const isMatch = faceVerificationCheck.match === true;
  const matchingThreshold = faceVerificationCheck.matching_threshold || BVN_FACE_MATCH_CONFIG.MATCH_THRESHOLD;
  
  const verificationResult = {
    verificationId: id,
    verificationStatus: status?.status,
    verificationState: status?.state,
    faceMatch: {
      isMatch,
      matchScore,
      matchingThreshold,
      passedThreshold: matchScore >= BVN_FACE_MATCH_CONFIG.MATCH_THRESHOLD
    },
    bvnData: {
      bvn: face_verification?.bvn,
      firstname: face_verification?.firstname,
      lastname: face_verification?.lastname,
      birthdate: face_verification?.birthdate,
      gender: face_verification?.gender,
      phone: face_verification?.phone,
      email: face_verification?.email,
      nationality: face_verification?.nationality,
      maritalStatus: face_verification?.marital_status,
      residentialAddress: face_verification?.residential_address,
      lgaOfResidence: face_verification?.lga_of_residence,
      stateOfResidence: face_verification?.state_of_residence,
      enrollmentBank: face_verification?.enrollment_bank,
      watchListed: face_verification?.watch_listed === 'YES',
      photo: face_verification?.photo, // Base64 photo (for response only, not stored)
      hasPhoto: !!face_verification?.photo
    }
  };

  return verificationResult;
}

/**
 * BVN Face Match verification endpoint
 * Only requires BVN number and selfie - gets user details from JWT
 */
router.post('/verify-bvn-face/:bvnNumber', upload.single('selfie'), async (req, res) => {
  const startTime = Date.now();
  
  try {
    const userId = req.user.id;
    const { bvnNumber } = req.params;
    const selfieFile = req.file;
    
    logger.info('BVN Face Match verification request initiated', {
      userId,
      bvn: `***${bvnNumber?.slice(-4)}`,
      hasFile: !!selfieFile,
      fileSize: selfieFile?.size
    });

    // Validate request parameters
    const validation = validateBvnFaceMatchRequest(bvnNumber, selfieFile);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: validation.message,
        errors: validation.errors
      });
    }

    const { bvn, selfieImage } = validation.validatedData;

    // Get user information from database using JWT user ID
    const user = await User.findById(userId).select('firstname lastname bvn kyc');
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    // Check if user has firstname and lastname
    if (!user.firstname || !user.lastname) {
      return res.status(400).json({
        success: false,
        error: 'INCOMPLETE_PROFILE',
        message: 'Please complete your profile with first name and last name before BVN verification'
      });
    }

    // Check if BVN is already verified for this user
    if (user.isBvnVerified()) {
      logger.info('BVN already verified for user', { 
        userId, 
        bvn: `***${bvn.slice(-4)}` 
      });
      
      return res.status(200).json({
        success: true,
        message: 'BVN is already verified for this account',
        data: {
          status: 'already_verified',
          matchScore: user.bvnVerification.matchScore,
          verifiedAt: user.bvnVerification.verifiedAt,
          faceMatchPassed: user.bvnVerification.faceMatchPassed,
          nameMatchPassed: user.bvnVerification.nameMatchPassed,
          bvnData: user.bvnVerification.bvnData,
          bvn: `***${bvn.slice(-4)}`
        }
      });
    }

    // Convert selfie to base64
    const photoBase64 = convertImageToBase64(selfieImage.buffer);

    // Call QoreID BVN Face Match API using auth utils
    const qoreIdResult = await callQoreIdBvnFaceMatchApi(bvn, photoBase64);
    
    if (!qoreIdResult.success) {
      return res.status(400).json({
        success: false,
        error: 'BVN_FACE_MATCH_FAILED',
        message: qoreIdResult.message,
        details: qoreIdResult.details
      });
    }

    // Process verification result
    const verificationResult = processBvnFaceMatchResult(qoreIdResult.data);
    
    // Check if person is watchlisted - BLOCK verification if true
    if (verificationResult.bvnData.watchListed) {
      logger.warn('BVN verification blocked - user is watchlisted', {
        userId,
        bvn: `***${bvn.slice(-4)}`,
        verificationId: verificationResult.verificationId
      });

      return res.status(403).json({
        success: false,
        error: 'WATCHLISTED_USER',
        message: 'This BVN is associated with a watchlisted individual. Verification cannot be completed.',
        data: {
          verificationId: verificationResult.verificationId,
          status: 'blocked',
          reason: 'watchlisted',
          bvn: `***${bvn.slice(-4)}`
        }
      });
    }
    
    // Check name matching between user database and BVN data
    const nameMatchResult = checkNameMatch(user, verificationResult.bvnData);
    
    // Update user's BVN information if verification was successful
    let bvnVerificationUpdated = false;
    if (verificationResult.verificationStatus === 'verified' || 
        verificationResult.verificationState === 'complete') {
      
      // Update BVN field if not already set
      if (!user.bvn) {
        user.bvn = bvn;
      }

      // Update BVN verification status (requires both face match AND name match)
      bvnVerificationUpdated = user.updateBvnVerification(
        verificationResult.faceMatch.matchScore,
        verificationResult.verificationId,
        nameMatchResult.bothNamesMatch
      );

      await user.save();
      
      logger.info('BVN verification completed and user updated', {
        userId,
        bvn: `***${bvn.slice(-4)}`,
        faceMatchScore: verificationResult.faceMatch.matchScore,
        faceMatchPassed: verificationResult.faceMatch.passedThreshold,
        nameMatchPassed: nameMatchResult.bothNamesMatch,
        verified: bvnVerificationUpdated,
        threshold: BVN_FACE_MATCH_CONFIG.MATCH_THRESHOLD,
        verificationId: verificationResult.verificationId
      });
    }

    const processingTime = Date.now() - startTime;
    
    res.status(200).json({
      success: true,
      message: 'BVN Face Match verification completed',
      data: {
        verificationId: verificationResult.verificationId,
        status: verificationResult.verificationStatus,
        state: verificationResult.verificationState,
        faceMatch: {
          matchScore: verificationResult.faceMatch.matchScore,
          threshold: BVN_FACE_MATCH_CONFIG.MATCH_THRESHOLD,
          passed: verificationResult.faceMatch.passedThreshold,
          verified: bvnVerificationUpdated
        },
        nameMatch: {
          firstNameMatch: nameMatchResult.firstNameMatch,
          lastNameMatch: nameMatchResult.lastNameMatch,
          bothNamesMatch: nameMatchResult.bothNamesMatch,
          userFullName: nameMatchResult.userFullName,
          bvnFullName: nameMatchResult.bvnFullName
        },
        bvnData: {
          firstname: verificationResult.bvnData.firstname,
          lastname: verificationResult.bvnData.lastname,
          birthdate: verificationResult.bvnData.birthdate,
          gender: verificationResult.bvnData.gender,
          phone: verificationResult.bvnData.phone,
          email: verificationResult.bvnData.email,
          nationality: verificationResult.bvnData.nationality,
          maritalStatus: verificationResult.bvnData.maritalStatus,
          residentialAddress: verificationResult.bvnData.residentialAddress,
          lgaOfResidence: verificationResult.bvnData.lgaOfResidence,
          stateOfResidence: verificationResult.bvnData.stateOfResidence,
          enrollmentBank: verificationResult.bvnData.enrollmentBank,
          watchListed: verificationResult.bvnData.watchListed,
          hasPhoto: verificationResult.bvnData.hasPhoto,
          bvn: `***${verificationResult.bvnData.bvn?.slice(-4)}`
        },
        kycImpact: {
          bvnVerified: bvnVerificationUpdated,
          canApplyForLevel2: bvnVerificationUpdated,
          canApplyForLevel3: bvnVerificationUpdated,
          currentKycLevel: user.kycLevel,
          identityConfidence: bvnVerificationUpdated ? 'HIGH' : 'LOW',
          nextSteps: bvnVerificationUpdated ? 
            'BVN verification complete. Both face match and name match passed. You can now apply for Level 2 or Level 3 KYC.' :
            generateFailureMessage(verificationResult.faceMatch, nameMatchResult)
        },
        processingTime
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    logger.error('BVN Face Match verification process failed', {
      userId: req.user?.id,
      bvn: `***${req.params.bvnNumber?.slice(-4)}`,
      error: error.message,
      stack: error.stack,
      processingTime
    });

    res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'BVN Face Match verification process failed. Please try again or contact support.'
    });
  }
});

/**
 * Get BVN verification status endpoint (separate from KYC levels)
 */
router.get('/bvn-verification-status', async (req, res) => {
  try {
    const userId = req.user.id;
    
    const user = await User.findById(userId).select('firstname lastname bvn bvnVerification kyc kycLevel');
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    const bvnStatus = {
      hasProfile: !!(user.firstname && user.lastname),
      hasBvn: !!user.bvn,
      bvn: user.bvn ? `***${user.bvn.slice(-4)}` : null,
      bvnVerification: {
        status: user.bvnVerification?.status || 'not_verified',
        matchScore: user.bvnVerification?.matchScore,
        verifiedAt: user.bvnVerification?.verifiedAt,
        faceMatchPassed: user.bvnVerification?.faceMatchPassed || false,
        nameMatchPassed: user.bvnVerification?.nameMatchPassed || false,
        isValid: user.isBvnVerified(),
        verificationCount: user.bvnVerification?.verificationCount || 0,
        bvnData: user.bvnVerification?.bvnData || null
      },
      kycEligibility: {
        level1: user.canApplyForKycLevel(1),
        level2: user.canApplyForKycLevel(2),
        level3: user.canApplyForKycLevel(3)
      },
      currentKycLevel: user.kycLevel,
      requirements: {
        profileComplete: !!(user.firstname && user.lastname),
        bvnProvided: !!user.bvn,
        bvnVerified: user.isBvnVerified()
      }
    };

    res.status(200).json({
      success: true,
      data: bvnStatus
    });

  } catch (error) {
    logger.error('Error fetching BVN verification status', {
      userId: req.user?.id,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'STATUS_FETCH_ERROR',
      message: 'Failed to fetch BVN verification status'
    });
  }
});

module.exports = router;