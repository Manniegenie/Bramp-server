// routes/migration.js
const express = require('express');
const router = express.Router();
const User = require('../models/user'); // Adjust path as needed

// KYC Migration Endpoint
router.post('/kyc-level1', async (req, res) => {
  try {
    // Optional: Add authentication check
    // if (!req.user || req.user.role !== 'admin') {
    //   return res.status(403).json({
    //     success: false,
    //     message: 'Admin access required'
    //   });
    // }

    console.log('Starting KYC Level 1 migration...');

    // Check how many users will be affected
    const count = await User.countDocuments({ kycLevel: 0 });
    console.log(`About to update ${count} users`);

    if (count === 0) {
      return res.json({
        success: true,
        message: 'No users need to be updated',
        usersAffected: 0
      });
    }

    // Update all users with kycLevel 0 to level 1
    const result = await User.updateMany(
      { kycLevel: 0 }, // Find users with kycLevel 0
      {
        $set: {
          kycLevel: 1,
          kycStatus: 'approved',
          'kyc.level1.status': 'approved',
          'kyc.level1.approvedAt': new Date()
        }
      }
    );

    console.log(`Updated ${result.modifiedCount} users to KYC Level 1`);

    res.json({
      success: true,
      message: 'KYC migration completed successfully',
      usersFound: count,
      usersUpdated: result.modifiedCount,
      details: {
        matched: result.matchedCount,
        modified: result.modifiedCount,
        acknowledged: result.acknowledged
      }
    });

  } catch (error) {
    console.error('KYC migration failed:', error);
    
    res.status(500).json({
      success: false,
      message: 'Migration failed',
      error: error.message
    });
  }
});

// Check migration status endpoint
router.get('/kyc-status', async (req, res) => {
  try {
    const stats = await User.aggregate([
      {
        $group: {
          _id: '$kycLevel',
          count: { $sum: 1 }
        }
      },
      {
        $sort: { _id: 1 }
      }
    ]);

    const statusStats = await User.aggregate([
      {
        $group: {
          _id: '$kycStatus',
          count: { $sum: 1 }
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        kycLevels: stats,
        kycStatuses: statusStats,
        totalUsers: await User.countDocuments()
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to get KYC status',
      error: error.message
    });
  }
});

module.exports = router;