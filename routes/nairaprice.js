const express = require('express');
const router = express.Router();
const NairaMarkup = require('../models/onramp');
const NairaMarkdown = require('../models/offramp');
const logger = require('../utils/logger');

/**
 * GET /naira/onramp-rate
 * Get current onramp rate from database
 */
router.get('/onramp-rate', async (req, res) => {
  try {
    const record = await NairaMarkup.findOne({});
    
    if (!record || !record.onrampRate) {
      return res.status(404).json({
        success: false,
        message: 'No onramp rate configured'
      });
    }
    
    res.status(200).json({
      success: true,
      data: {
        rate: record.onrampRate,
        lastUpdated: record.updatedAt
      }
    });
    
  } catch (error) {
    logger.error('Error fetching onramp rate:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch onramp rate'
    });
  }
});

/**
 * GET /naira/offramp-rate
 * Get current offramp rate from database
 */
router.get('/offramp-rate', async (req, res) => {
  try {
    const record = await NairaMarkdown.findOne({});
    
    if (!record || !record.offrampRate) {
      return res.status(404).json({
        success: false,
        message: 'No offramp rate configured'
      });
    }
    
    res.status(200).json({
      success: true,
      data: {
        rate: record.offrampRate,
        lastUpdated: record.updatedAt
      }
    });
    
  } catch (error) {
    logger.error('Error fetching offramp rate:', error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch offramp rate'
    });
  }
});

module.exports = router;