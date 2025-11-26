const express = require('express');
const router = express.Router();
const ObiexRate = require('../models/obiexRate');
const logger = require('../utils/logger');

// POST /obiex-rate/rate - Set the Obiex rate directly
router.post('/rate', async (req, res) => {
  const { rate } = req.body;

  if (typeof rate !== 'number' || rate <= 0) {
    return res.status(400).json({ 
      success: false,
      message: 'Invalid rate. Must be a positive number.' 
    });
  }

  try {
    let rateDoc = await ObiexRate.findOne();
    if (!rateDoc) {
      rateDoc = new ObiexRate({ 
        rate: rate,
        rateSource: 'manual'
      });
    } else {
      rateDoc.rate = rate;
      rateDoc.rateSource = 'manual';
    }

    await rateDoc.save();
    
    logger.info('Obiex rate updated successfully', {
      newRate: rate,
      updatedAt: rateDoc.updatedAt
    });

    res.status(200).json({ 
      success: true,
      message: 'Obiex rate updated successfully', 
      data: {
        rate: rate,
        updatedAt: rateDoc.updatedAt
      }
    });
  } catch (err) {
    logger.error('Failed to update Obiex rate', {
      error: err.message,
      requestedRate: rate
    });
    
    res.status(500).json({ 
      success: false,
      message: 'Failed to update Obiex rate'
    });
  }
});

// GET /obiex-rate/rate - Get current Obiex rate
router.get('/rate', async (req, res) => {
  try {
    const rateDoc = await ObiexRate.findOne();
    
    if (!rateDoc || !rateDoc.rate) {
      return res.status(404).json({ 
        success: false,
        message: 'No Obiex rate configured'
      });
    }
    
    res.status(200).json({ 
      success: true,
      data: {
        rate: rateDoc.rate,
        lastUpdated: rateDoc.updatedAt
      }
    });
  } catch (err) {
    logger.error('Failed to get Obiex rate', {
      error: err.message
    });
    
    res.status(500).json({ 
      success: false,
      message: 'Failed to get Obiex rate'
    });
  }
});

module.exports = router;