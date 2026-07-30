// routes/VerificationProgress.js
const express = require('express');
const User = require('../models/user');
const router = express.Router();

router.get('/status', async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const fiat = buildFiatProgress(user);
    const kyc = buildKycProgress(user);

    const totalSteps = fiat.total + kyc.total;
    const completedSteps = fiat.completedCount + kyc.completedCount;
    const overallPercentage = totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0;

    const toPercent = (completed, total) =>
      total > 0 ? Math.round((completed / total) * 100) : 0;

    return res.status(200).json({
      fiatVerification: {
        totalSteps: fiat.total,
        completedSteps: fiat.completedCount,
        percentage: toPercent(fiat.completedCount, fiat.total),
        steps: fiat.steps,
        completed: fiat.completedIds
      },
      kycVerification: {
        totalSteps: kyc.total,
        completedSteps: kyc.completedCount,
        percentage: toPercent(kyc.completedCount, kyc.total),
        steps: kyc.steps,
        completed: kyc.completedIds
      },
      overallProgress: {
        totalSteps,
        completedSteps,
        percentage: overallPercentage
      }
    });

  } catch (error) {
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

function buildFiatProgress(user) {
  const recentRecipients = user.recentBankRecipients || [];

  const steps = [
    {
      id: 'bvn',
      label: 'BVN verification',
      completed: !!user.bvnVerified,
      completedAt: user.bvnVerifiedAt || null,
    },
    {
      id: 'bank_account',
      label: 'Send to a bank account',
      completed: recentRecipients.length > 0,
      completedAt: recentRecipients.length > 0 ? recentRecipients[0]?.lastUsedAt || null : null,
    }
  ];

  const completedIds = steps.filter(s => s.completed).map(s => s.id);
  return { total: steps.length, completedCount: completedIds.length, completedIds, steps };
}

function buildKycProgress(user) {
  const lvl2 = user.kyc?.level2 || {};
  const lvl3 = user.kyc?.level3 || {};

  const emailVerified = user.emailVerified || false;
  const identityVerified = lvl2.status === 'approved';
  const addressVerified = lvl3.status === 'approved';

  const steps = [
    {
      id: 'email',
      label: 'Email Verification',
      completed: emailVerified,
      completedAt: user.emailVerifiedAt || null,
      status: emailVerified ? 'approved' : 'not_submitted'
    },
    {
      id: 'identity',
      label: 'Identity Verification',
      completed: identityVerified,
      completedAt: lvl2.approvedAt || null,
      status: lvl2.status || 'not_submitted'
    },
    {
      id: 'address',
      label: 'Address Verification',
      completed: addressVerified,
      completedAt: lvl3.approvedAt || null,
      status: lvl3.status || 'not_submitted'
    }
  ];

  const completedIds = steps.filter(s => s.completed).map(s => s.id);
  return { total: steps.length, completedCount: completedIds.length, completedIds, steps };
}

module.exports = router;
