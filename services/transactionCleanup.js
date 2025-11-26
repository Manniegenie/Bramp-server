// services/transactionCleanup.js
const ChatbotTransaction = require('../models/ChatbotTransaction');
const logger = require('../utils/logger');

/**
 * Mark expired transactions as EXPIRED status instead of deleting them
 * This preserves data for analytics while maintaining security
 */
async function markExpiredTransactions() {
  try {
    const now = new Date();
    
    // Find transactions that are expired but not yet marked as EXPIRED
    const expiredTransactions = await ChatbotTransaction.find({
      expiresAt: { $lte: now },
      status: { $ne: 'EXPIRED' }
    });

    if (expiredTransactions.length === 0) {
      logger.info('No expired transactions to mark');
      return { marked: 0 };
    }

    // Mark them as EXPIRED
    const result = await ChatbotTransaction.updateMany(
      {
        expiresAt: { $lte: now },
        status: { $ne: 'EXPIRED' }
      },
      {
        $set: {
          status: 'EXPIRED',
          updatedAt: now
        }
      }
    );

    logger.info(`Marked ${result.modifiedCount} transactions as EXPIRED`);
    
    return {
      marked: result.modifiedCount,
      totalExpired: expiredTransactions.length
    };

  } catch (error) {
    logger.error('Error marking expired transactions:', error);
    throw error;
  }
}

/**
 * Get statistics about expired vs active transactions
 */
async function getExpirationStats() {
  try {
    const now = new Date();
    
    const [activeCount, expiredCount, totalCount] = await Promise.all([
      ChatbotTransaction.countDocuments({
        $or: [
          { expiresAt: { $exists: false } },
          { expiresAt: null },
          { expiresAt: { $gt: now } }
        ]
      }),
      ChatbotTransaction.countDocuments({
        expiresAt: { $lte: now }
      }),
      ChatbotTransaction.countDocuments({})
    ]);

    return {
      active: activeCount,
      expired: expiredCount,
      total: totalCount,
      expiredPercentage: totalCount > 0 ? ((expiredCount / totalCount) * 100).toFixed(2) : 0
    };

  } catch (error) {
    logger.error('Error getting expiration stats:', error);
    throw error;
  }
}

module.exports = {
  markExpiredTransactions,
  getExpirationStats
};
