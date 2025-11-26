const express = require('express');
const User = require('../models/user'); // Adjust path as needed
const router = express.Router();

// GET /tier-details - Fetch user tier/KYC details
router.get('/tier', async (req, res) => {
  try {
    // Assuming you have authentication middleware that sets req.user or req.userId
    const userId = req.user?.id || req.userId;
    
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required'
      });
    }

    // Fetch user data (including emailVerified field)
    const user = await User.findById(userId).select('kycLevel kyc email emailVerified');
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Map KYC status to desired format
    const mapKycStatus = (status) => {
      switch (status) {
        case 'approved':
          return 'verified';
        case 'pending':
        case 'under_review':
          return 'pending';
        case 'not_submitted':
        case 'rejected':
        default:
          return 'unverified';
      }
    };

    // Determine tier level based on highest approved KYC level
    // Since you mentioned all users will always have tier 1 verified, we start from 1
    let tierLevel = "1";
    if (user.kyc?.level3?.status === 'approved') {
      tierLevel = "3";
    } else if (user.kyc?.level2?.status === 'approved') {
      tierLevel = "2";
    }

    // Email verification status from the emailVerified field
    const emailVerification = user.emailVerified ? 'verified' : 'unverified';

    // Document upload status (Level 2 KYC)
    const documentUpload = mapKycStatus(user.kyc?.level2?.status || 'not_submitted');

    // Address verification status (Level 3 KYC)
    const addressVerification = mapKycStatus(user.kyc?.level3?.status || 'not_submitted');

    // Response object
    const tierDetails = {
      tierLevel,
      emailVerification,
      documentUpload,
      addressVerification
    };

    res.status(200).json({
      success: true,
      data: tierDetails
    });

  } catch (error) {
    console.error('Error fetching tier details:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;