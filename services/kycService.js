const User = require('../models/user'); // Updated path for NIN verification integration

class KYCService {
  /**
   * Upgrades a user to KYC Level 2
   * @param {string} userId - The user's MongoDB ObjectId
   * @param {Object} level2Data - Additional data for level 2 KYC
   * @param {string} level2Data.documentType - Type of document submitted
   * @param {string} level2Data.documentNumber - Document number
   * @returns {Promise<Object>} Updated user object
   */
  static async upgradeToLevel2(userId, level2Data = {}) {
    try {
      // Find the user
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Validate current KYC status
      if (user.kycLevel >= 2) {
        throw new Error('User is already at KYC Level 2 or higher');
      }

      // Ensure Level 1 is approved before upgrading to Level 2
      if (user.kyc.level1.status !== 'approved') {
        throw new Error('Level 1 KYC must be approved before upgrading to Level 2');
      }

      // Prepare update object
      const updateData = {
        kycLevel: 2,
        kycStatus: 'approved',
        'kyc.level2.status': 'approved',
        'kyc.level2.approvedAt': new Date(),
        portfolioLastUpdated: new Date()
      };

      // Add level 2 specific data if provided
      if (level2Data.documentType) {
        updateData['kyc.level2.documentType'] = level2Data.documentType;
      }
      if (level2Data.documentNumber) {
        updateData['kyc.level2.documentNumber'] = level2Data.documentNumber;
      }

      // Update the user
      const updatedUser = await User.findByIdAndUpdate(
        userId,
        { $set: updateData },
        { 
          new: true, 
          runValidators: true,
          select: '-password -passwordpin -transactionpin -securitypin -twoFASecret'
        }
      );

      return {
        success: true,
        message: 'User successfully upgraded to KYC Level 2',
        user: updatedUser,
        previousLevel: user.kycLevel,
        newLevel: 2
      };

    } catch (error) {
      throw new Error(`Failed to upgrade user to Level 2: ${error.message}`);
    }
  }

  /**
   * Bulk upgrade multiple users to KYC Level 2
   * @param {Array<string>} userIds - Array of user MongoDB ObjectIds
   * @param {Object} level2Data - Additional data for level 2 KYC
   * @returns {Promise<Object>} Results of bulk upgrade
   */
  static async bulkUpgradeToLevel2(userIds, level2Data = {}) {
    const results = {
      successful: [],
      failed: [],
      totalProcessed: userIds.length
    };

    for (const userId of userIds) {
      try {
        const result = await this.upgradeToLevel2(userId, level2Data);
        results.successful.push({
          userId,
          message: result.message,
          previousLevel: result.previousLevel
        });
      } catch (error) {
        results.failed.push({
          userId,
          error: error.message
        });
      }
    }

    return results;
  }

  /**
   * Submit Level 2 KYC for review (sets status to pending)
   * @param {string} userId - The user's MongoDB ObjectId
   * @param {Object} level2Data - Level 2 KYC submission data
   * @returns {Promise<Object>} Updated user object
   */
  static async submitLevel2ForReview(userId, level2Data) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Validate prerequisites
      if (user.kyc.level1.status !== 'approved') {
        throw new Error('Level 1 KYC must be approved before submitting Level 2');
      }

      if (user.kyc.level2.status === 'approved') {
        throw new Error('Level 2 KYC is already approved');
      }

      if (user.kyc.level2.status === 'pending') {
        throw new Error('Level 2 KYC is already pending review');
      }

      // Update to pending status
      const updateData = {
        kycStatus: 'pending',
        'kyc.level2.status': 'pending',
        'kyc.level2.submittedAt': new Date(),
        'kyc.level2.documentType': level2Data.documentType,
        'kyc.level2.documentNumber': level2Data.documentNumber,
        // Clear any previous rejection data
        'kyc.level2.rejectedAt': null,
        'kyc.level2.rejectionReason': null
      };

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        { $set: updateData },
        { 
          new: true, 
          runValidators: true,
          select: '-password -passwordpin -transactionpin -securitypin -twoFASecret'
        }
      );

      return {
        success: true,
        message: 'Level 2 KYC submitted for review',
        user: updatedUser
      };

    } catch (error) {
      throw new Error(`Failed to submit Level 2 KYC: ${error.message}`);
    }
  }

  /**
   * Reject Level 2 KYC application
   * @param {string} userId - The user's MongoDB ObjectId
   * @param {string} rejectionReason - Reason for rejection
   * @returns {Promise<Object>} Updated user object
   */
  static async rejectLevel2(userId, rejectionReason) {
    try {
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      if (user.kyc.level2.status !== 'pending') {
        throw new Error('Can only reject pending Level 2 KYC applications');
      }

      const updateData = {
        kycStatus: 'rejected',
        'kyc.level2.status': 'rejected',
        'kyc.level2.rejectedAt': new Date(),
        'kyc.level2.rejectionReason': rejectionReason
      };

      const updatedUser = await User.findByIdAndUpdate(
        userId,
        { $set: updateData },
        { 
          new: true, 
          runValidators: true,
          select: '-password -passwordpin -transactionpin -securitypin -twoFASecret'
        }
      );

      return {
        success: true,
        message: 'Level 2 KYC rejected',
        user: updatedUser,
        rejectionReason
      };

    } catch (error) {
      throw new Error(`Failed to reject Level 2 KYC: ${error.message}`);
    }
  }

  /**
   * Get users by KYC level and status
   * @param {number} level - KYC level to filter by
   * @param {string} status - KYC status to filter by (optional)
   * @returns {Promise<Array>} Array of users
   */
  static async getUsersByKYCLevel(level, status = null) {
    try {
      const query = { kycLevel: level };
      if (status) {
        query.kycStatus = status;
      }

      const users = await User.find(query)
        .select('-password -passwordpin -transactionpin -securitypin -twoFASecret -refreshTokens')
        .sort({ updatedAt: -1 });

      return users;
    } catch (error) {
      throw new Error(`Failed to get users by KYC level: ${error.message}`);
    }
  }

  /**
   * Get KYC statistics
   * @returns {Promise<Object>} KYC statistics
   */
  static async getKYCStatistics() {
    try {
      const stats = await User.aggregate([
        {
          $group: {
            _id: '$kycLevel',
            count: { $sum: 1 },
            statuses: { $push: '$kycStatus' }
          }
        },
        {
          $project: {
            level: '$_id',
            count: 1,
            statusBreakdown: {
              $reduce: {
                input: '$statuses',
                initialValue: {},
                in: {
                  $mergeObjects: [
                    '$$value',
                    {
                      $switch: {
                        branches: [
                          { case: { $eq: ['$$this', 'not_verified'] }, then: { not_verified: { $add: [{ $ifNull: ['$$value.not_verified', 0] }, 1] } } },
                          { case: { $eq: ['$$this', 'pending'] }, then: { pending: { $add: [{ $ifNull: ['$$value.pending', 0] }, 1] } } },
                          { case: { $eq: ['$$this', 'approved'] }, then: { approved: { $add: [{ $ifNull: ['$$value.approved', 0] }, 1] } } },
                          { case: { $eq: ['$$this', 'rejected'] }, then: { rejected: { $add: [{ $ifNull: ['$$value.rejected', 0] }, 1] } } },
                          { case: { $eq: ['$$this', 'under_review'] }, then: { under_review: { $add: [{ $ifNull: ['$$value.under_review', 0] }, 1] } } }
                        ],
                        default: {}
                      }
                    }
                  ]
                }
              }
            }
          }
        },
        { $sort: { level: 1 } }
      ]);

      return {
        success: true,
        statistics: stats
      };
    } catch (error) {
      throw new Error(`Failed to get KYC statistics: ${error.message}`);
    }
  }
}

module.exports = KYCService;