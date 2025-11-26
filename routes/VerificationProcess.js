// GET /verification-status (Simple Version)
// Returns basic verification status matching your requested format

const express = require('express');
const User = require('../models/user');
const router = express.Router();

/**
 * GET /verification-status
 * Simple version returning just the completion counts
 */
router.get('/status', async (req, res) => {
  try {
    const userId = req.user.id;
    
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Calculate Fiat Verification (2 steps total)
    const fiatSteps = calculateFiatSteps(user);
    
    // Calculate KYC Verification (3 steps total)
    const kycSteps = calculateKycSteps(user);

    return res.status(200).json({
      fiatVerification: {
        totalSteps: 2,
        completedSteps: fiatSteps
      },
      kycVerification: {
        totalSteps: 3,
        completedSteps: kycSteps
      }
    });

  } catch (error) {
    console.error('Error fetching verification status:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error'
    });
  }
});

function calculateFiatSteps(user) {
  let completedSteps = 0;
  
  // Step 1: Has bank account
  const activeBankAccounts = user.getActiveBankAccounts();
  if (activeBankAccounts.length > 0) {
    completedSteps++;
  }
  
  // Step 2: BVN verified
  if (user.bvnVerified) {
    completedSteps++;
  }
  
  return completedSteps;
}

function calculateKycSteps(user) {
  let completedSteps = 0;
  
  // Step 1: KYC Level 1 approved
  if (user.kyc?.level1?.status === 'approved') {
    completedSteps++;
    
    // Step 2: KYC Level 2 approved
    if (user.kyc?.level2?.status === 'approved') {
      completedSteps++;
      
      // Step 3: KYC Level 3 approved
      if (user.kyc?.level3?.status === 'approved') {
        completedSteps++;
      }
    }
  }
  
  return completedSteps;
}

module.exports = router;