const express = require('express');
const router = express.Router();
const axios = require('axios');

const User = require('../models/user');
const logger = require('../utils/logger');

// Address Verification configuration
const ADDRESS_VERIFICATION_CONFIG = {
  API_BASE_URL: process.env.QOREID_API_URL || 'https://api.qoreid.com',
  API_KEY: process.env.QOREID_API_KEY,
  TIMEOUT: 30000, // 30 seconds
};

/**
 * Validates address verification request parameters
 * @param {Object} addressData - Address data from request body
 * @param {Object} user - User object
 * @returns {Object} Validation result
 */
function validateAddressVerificationRequest(addressData, user) {
  const errors = [];

  // Required fields validation
  const requiredFields = ['street', 'lgaName', 'stateName', 'city'];
  requiredFields.forEach(field => {
    if (!addressData[field]?.trim()) {
      errors.push(`${field} is required`);
    }
  });

  // User profile validation
  if (!user.firstname?.trim()) {
    errors.push('First name is required in your profile');
  }
  
  if (!user.lastname?.trim()) {
    errors.push('Last name is required in your profile');
  }

  if (!user.phonenumber?.trim()) {
    errors.push('Phone number is required in your profile');
  }

  if (!user.DoB?.trim()) {
    errors.push('Date of birth is required in your profile');
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
      street: addressData.street.trim(),
      lgaName: addressData.lgaName.trim(),
      stateName: addressData.stateName.trim(),
      city: addressData.city.trim(),
      landmark: addressData.landmark?.trim() || null
    }
  };
}

/**
 * Calls QoreID Address Verification API
 * @param {Object} addressData - Address data
 * @param {Object} user - User data
 * @returns {Promise<Object>} API response
 */
async function callQoreIdAddressVerificationApi(addressData, user) {
  try {
    const url = `${ADDRESS_VERIFICATION_CONFIG.API_BASE_URL}/v1/addresses`;
    
    const requestBody = {
      customerReference: `addr_${user.id}_${Date.now()}`,
      street: addressData.street,
      lgaName: addressData.lgaName,
      stateName: addressData.stateName,
      city: addressData.city,
      ...(addressData.landmark && { landmark: addressData.landmark }),
      applicant: {
        firstname: user.firstname,
        lastname: user.lastname,
        middlename: user.middlename || '',
        gender: user.gender || '',
        phone: user.phonenumber,
        dob: user.DoB
      }
    };

    logger.info('Calling QoreID Address Verification API', {
      userId: user.id,
      customerReference: requestBody.customerReference,
      stateName: addressData.stateName,
      lgaName: addressData.lgaName
    });

    const response = await axios.post(url, requestBody, {
      headers: {
        'Authorization': `Bearer ${ADDRESS_VERIFICATION_CONFIG.API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: ADDRESS_VERIFICATION_CONFIG.TIMEOUT
    });

    return {
      success: true,
      data: response.data
    };
  } catch (error) {
    logger.error('QoreID Address Verification API call failed', {
      userId: user.id,
      error: error.response?.data || error.message,
      status: error.response?.status
    });

    if (error.response?.status === 400) {
      return {
        success: false,
        message: 'Invalid address data provided',
        details: error.response.data
      };
    } else if (error.code === 'ECONNABORTED') {
      return {
        success: false,
        message: 'Address verification request timed out. Please try again.'
      };
    }

    return {
      success: false,
      message: 'Address verification service is currently unavailable'
    };
  }
}

/**
 * Checks address verification status from QoreID
 * @param {string} verificationId - QoreID verification ID
 * @returns {Promise<Object>} Verification status
 */
async function checkAddressVerificationStatus(verificationId) {
  try {
    const url = `${ADDRESS_VERIFICATION_CONFIG.API_BASE_URL}/v1/addresses/${verificationId}`;
    
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${ADDRESS_VERIFICATION_CONFIG.API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: ADDRESS_VERIFICATION_CONFIG.TIMEOUT
    });

    return {
      success: true,
      data: response.data
    };
  } catch (error) {
    logger.error('QoreID Address Status Check failed', {
      verificationId,
      error: error.response?.data || error.message,
      status: error.response?.status
    });

    return {
      success: false,
      message: 'Unable to check address verification status'
    };
  }
}

/**
 * Submit Address Verification for KYC Level 3
 * Initiates address verification process required for KYC Level 3
 */
router.post('/verify-address', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const userId = req.user.id;
    const addressData = req.body;
    
    logger.info('Address verification request initiated', {
      userId,
      stateName: addressData.stateName,
      lgaName: addressData.lgaName
    });

    // Get user information from database using JWT user ID
    const user = await User.findById(userId).select('firstname lastname middlename phonenumber DoB gender addressVerification kycLevel kycStatus kyc');
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    // Check if user has BVN verification (required for Level 3)
    if (!user.isBvnVerified()) {
      return res.status(400).json({
        success: false,
        error: 'BVN_VERIFICATION_REQUIRED',
        message: 'BVN verification is required before address verification. Please complete BVN verification first.'
      });
    }

    // Check if KYC Level 3 is already approved
    if (user.kycLevel >= 3 && user.kycStatus === 'approved') {
      logger.info('KYC Level 3 already approved for user', { 
        userId,
        currentKycLevel: user.kycLevel 
      });
      
      return res.status(200).json({
        success: true,
        message: 'KYC Level 3 is already approved for this account',
        data: {
          status: 'kyc_already_approved',
          currentKycLevel: user.kycLevel,
          kycStatus: user.kycStatus,
          approvedAt: user.kyc?.level3?.approvedAt,
          addressVerified: user.kyc?.level3?.addressVerified,
          message: `KYC Level ${user.kycLevel} is already approved. No further verification needed.`
        }
      });
    }

    // Check if address verification is already in progress or completed
    if (user.addressVerification?.status === 'in_progress') {
      return res.status(200).json({
        success: true,
        message: 'Address verification is already in progress',
        data: {
          status: 'in_progress',
          verificationId: user.addressVerification.qoreIdVerificationId,
          submittedAt: user.addressVerification.submittedAt,
          message: 'Address verification is currently being processed. Please check back later.'
        }
      });
    }

    if (user.addressVerification?.status === 'verified') {
      return res.status(200).json({
        success: true,
        message: 'Address is already verified',
        data: {
          status: 'already_verified',
          verifiedAt: user.addressVerification.verifiedAt,
          verificationId: user.addressVerification.qoreIdVerificationId,
          addressData: user.addressVerification.addressData
        }
      });
    }

    // Validate request parameters
    const validation = validateAddressVerificationRequest(addressData, user);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        error: 'VALIDATION_ERROR',
        message: validation.message,
        errors: validation.errors
      });
    }

    const validatedAddressData = validation.validatedData;

    // Call QoreID Address Verification API
    const qoreIdResult = await callQoreIdAddressVerificationApi(validatedAddressData, user);
    
    if (!qoreIdResult.success) {
      return res.status(400).json({
        success: false,
        error: 'ADDRESS_VERIFICATION_FAILED',
        message: qoreIdResult.message,
        details: qoreIdResult.details
      });
    }

    // Update user's address verification information
    if (!user.addressVerification) {
      user.addressVerification = {};
    }
    
    user.addressVerification = {
      status: 'in_progress',
      submittedAt: new Date(),
      qoreIdVerificationId: qoreIdResult.data.id,
      customerReference: qoreIdResult.data.customerReference,
      addressData: validatedAddressData,
      qoreIdStatus: qoreIdResult.data.status,
      verificationCount: (user.addressVerification?.verificationCount || 0) + 1
    };

    await user.save();
    
    logger.info('Address verification submitted successfully', {
      userId,
      verificationId: qoreIdResult.data.id,
      customerReference: qoreIdResult.data.customerReference,
      stateName: validatedAddressData.stateName,
      lgaName: validatedAddressData.lgaName
    });

    const processingTime = Date.now() - startTime;
    
    res.status(200).json({
      success: true,
      message: 'Address verification submitted successfully',
      data: {
        verificationId: qoreIdResult.data.id,
        customerReference: qoreIdResult.data.customerReference,
        status: 'in_progress',
        submittedAt: user.addressVerification.submittedAt,
        addressData: {
          street: validatedAddressData.street,
          lgaName: validatedAddressData.lgaName,
          stateName: validatedAddressData.stateName,
          city: validatedAddressData.city,
          landmark: validatedAddressData.landmark
        },
        estimatedCompletionTime: '24-72 hours',
        nextSteps: [
          'Address verification agents will visit the provided address',
          'Verification typically takes 24-72 hours to complete',
          'You will receive a notification when verification is complete',
          'Check verification status using the /address-verification-status endpoint'
        ],
        webhookInfo: {
          recommended: true,
          reason: 'Address verification is asynchronous and can take 24-72 hours',
          alternativeMethod: 'Poll the status endpoint periodically'
        },
        processingTime
      }
    });

  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    logger.error('Address verification process failed', {
      userId: req.user?.id,
      error: error.message,
      stack: error.stack,
      processingTime
    });

    res.status(500).json({
      success: false,
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Address verification process failed. Please try again or contact support.'
    });
  }
});

/**
 * Get Address Verification Status
 * Checks current status of address verification and updates user record
 */
router.get('/address-verification-status', async (req, res) => {
  try {
    const userId = req.user.id;
    
    const user = await User.findById(userId).select('firstname lastname addressVerification kycLevel kycStatus kyc');
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    // If no address verification has been submitted
    if (!user.addressVerification?.qoreIdVerificationId) {
      return res.status(200).json({
        success: true,
        data: {
          status: 'not_submitted',
          hasProfile: !!(user.firstname && user.lastname),
          addressVerification: {
            status: 'not_submitted',
            message: 'No address verification has been submitted yet'
          },
          kycImpact: {
            currentKycLevel: user.kycLevel,
            kycStatus: user.kycStatus,
            canApplyForLevel3: false,
            requirements: 'Address verification required for KYC Level 3'
          }
        }
      });
    }

    // If verification is in progress, check current status from QoreID
    if (user.addressVerification.status === 'in_progress') {
      const statusCheck = await checkAddressVerificationStatus(user.addressVerification.qoreIdVerificationId);
      
      if (statusCheck.success) {
        const qoreIdData = statusCheck.data;
        const currentStatus = qoreIdData.status?.status?.toLowerCase();
        const currentState = qoreIdData.status?.state?.toLowerCase();
        
        // Update user record if status has changed
        if (currentState === 'complete') {
          let newStatus = 'failed';
          let addressVerified = false;
          let kycLevel3Approved = false;
          
          if (currentStatus === 'verified') {
            newStatus = 'verified';
            addressVerified = true;
            
            // Auto-approve KYC Level 3
            if (user.kycLevel < 3) {
              user.kycLevel = 3;
              user.kycStatus = 'approved';
              
              // Update level 3 KYC status
              user.kyc.level3.status = 'approved';
              user.kyc.level3.approvedAt = new Date();
              user.kyc.level3.addressVerified = true;
              
              kycLevel3Approved = true;
            }
          }
          
          user.addressVerification.status = newStatus;
          user.addressVerification.verifiedAt = newStatus === 'verified' ? new Date() : null;
          user.addressVerification.qoreIdStatus = qoreIdData.status;
          user.addressVerification.failureReason = newStatus === 'failed' ? currentStatus : null;
          
          await user.save();
          
          logger.info('Address verification status updated', {
            userId,
            verificationId: user.addressVerification.qoreIdVerificationId,
            oldStatus: 'in_progress',
            newStatus,
            addressVerified,
            kycLevel3Approved
          });
        }
      }
    }

    const addressStatus = {
      hasProfile: !!(user.firstname && user.lastname),
      addressVerification: {
        status: user.addressVerification?.status || 'not_submitted',
        verificationId: user.addressVerification?.qoreIdVerificationId,
        customerReference: user.addressVerification?.customerReference,
        submittedAt: user.addressVerification?.submittedAt,
        verifiedAt: user.addressVerification?.verifiedAt,
        addressData: user.addressVerification?.addressData,
        failureReason: user.addressVerification?.failureReason,
        verificationCount: user.addressVerification?.verificationCount || 0,
        qoreIdStatus: user.addressVerification?.qoreIdStatus
      },
      kycImpact: {
        currentKycLevel: user.kycLevel,
        kycStatus: user.kycStatus,
        addressVerified: user.kyc?.level3?.addressVerified || false,
        level3ApprovedAt: user.kyc?.level3?.approvedAt,
        canApplyForLevel3: user.addressVerification?.status === 'verified' && user.kycLevel < 3
      },
      requirements: {
        profileComplete: !!(user.firstname && user.lastname),
        bvnVerified: user.isBvnVerified(),
        addressSubmitted: !!user.addressVerification?.qoreIdVerificationId,
        addressVerified: user.addressVerification?.status === 'verified'
      }
    };

    res.status(200).json({
      success: true,
      data: addressStatus
    });

  } catch (error) {
    logger.error('Error fetching address verification status', {
      userId: req.user?.id,
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'STATUS_FETCH_ERROR',
      message: 'Failed to fetch address verification status'
    });
  }
});

/**
 * Webhook endpoint for QoreID address verification updates
 * This endpoint should be configured in QoreID dashboard
 */
router.post('/webhook/address-verification', async (req, res) => {
  try {
    const webhookData = req.body;
    
    logger.info('Address verification webhook received', {
      verificationId: webhookData.id,
      status: webhookData.status,
      customerReference: webhookData.customerReference
    });

    // Find user by customer reference or verification ID
    const user = await User.findOne({
      $or: [
        { 'addressVerification.qoreIdVerificationId': webhookData.id },
        { 'addressVerification.customerReference': webhookData.customerReference }
      ]
    });

    if (!user) {
      logger.warn('User not found for address verification webhook', {
        verificationId: webhookData.id,
        customerReference: webhookData.customerReference
      });
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const currentStatus = webhookData.status?.status?.toLowerCase();
    const currentState = webhookData.status?.state?.toLowerCase();
    
    // Update user record if verification is complete
    if (currentState === 'complete') {
      let newStatus = 'failed';
      let addressVerified = false;
      let kycLevel3Approved = false;
      
      if (currentStatus === 'verified') {
        newStatus = 'verified';
        addressVerified = true;
        
        // Auto-approve KYC Level 3
        if (user.kycLevel < 3) {
          user.kycLevel = 3;
          user.kycStatus = 'approved';
          
          // Update level 3 KYC status
          user.kyc.level3.status = 'approved';
          user.kyc.level3.approvedAt = new Date();
          user.kyc.level3.addressVerified = true;
          
          kycLevel3Approved = true;
        }
      }
      
      user.addressVerification.status = newStatus;
      user.addressVerification.verifiedAt = newStatus === 'verified' ? new Date() : null;
      user.addressVerification.qoreIdStatus = webhookData.status;
      user.addressVerification.failureReason = newStatus === 'failed' ? currentStatus : null;
      
      await user.save();
      
      logger.info('Address verification webhook processed', {
        userId: user.id,
        verificationId: webhookData.id,
        newStatus,
        addressVerified,
        kycLevel3Approved
      });

      // Here you could send notifications to the user
      // await sendAddressVerificationNotification(user, newStatus, kycLevel3Approved);
    }

    res.status(200).json({ success: true, message: 'Webhook processed successfully' });

  } catch (error) {
    logger.error('Address verification webhook processing failed', {
      error: error.message,
      webhookData: req.body
    });

    res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
});

module.exports = router;