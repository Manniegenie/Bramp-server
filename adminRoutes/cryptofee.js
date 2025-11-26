const express = require('express');
const router = express.Router();
const CryptoFeeMarkup = require('../models/cryptofee'); // Adjust path as needed
const logger = require('../utils/logger'); // Add logger if available

/**
 * @route   GET /crypto-fee
 * @desc    Get all crypto fees
 * @access  Admin
 */
router.get('/crypto-fee', async (req, res) => {
  try {
    const fees = await CryptoFeeMarkup.find({}).sort({ currency: 1 });
    
    res.status(200).json({
      success: true,
      message: `Found ${fees.length} crypto fee configurations`,
      data: fees
    });

  } catch (error) {
    logger?.error('Error fetching crypto fees:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch crypto fees',
      details: error.message
    });
  }
});

/**
 * @route   GET /crypto-fee/:currency
 * @desc    Get crypto fee for specific currency
 * @access  Admin
 */
router.get('/crypto-fee/:currency', async (req, res) => {
  try {
    const { currency } = req.params;
    
    if (!currency) {
      return res.status(400).json({
        success: false,
        error: 'Currency parameter is required'
      });
    }

    const fee = await CryptoFeeMarkup.findOne({ 
      currency: currency.toUpperCase() 
    });
    
    if (!fee) {
      return res.status(404).json({
        success: false,
        error: `No fee configuration found for ${currency.toUpperCase()}`,
        data: {
          currency: currency.toUpperCase(),
          feeUsd: 0,
          configured: false
        }
      });
    }

    res.status(200).json({
      success: true,
      message: `Fee configuration for ${currency.toUpperCase()}`,
      data: {
        currency: fee.currency,
        feeUsd: fee.feeUsd,
        configured: true,
        createdAt: fee.createdAt,
        updatedAt: fee.updatedAt,
        _id: fee._id
      }
    });

  } catch (error) {
    logger?.error('Error fetching crypto fee:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch crypto fee',
      details: error.message
    });
  }
});

/**
 * @route   PUT /crypto-fee
 * @desc    Update feeUsd for a currency
 * @access  Admin
 */
router.put('/crypto-fee', async (req, res) => {
  try {
    const { currency, feeUsd } = req.body;

    // Validation
    if (!currency || feeUsd === undefined) {
      return res.status(400).json({
        success: false,
        error: 'currency and feeUsd are required'
      });
    }

    if (typeof feeUsd !== 'number' || feeUsd < 0) {
      return res.status(400).json({
        success: false,
        error: 'feeUsd must be a non-negative number'
      });
    }

    const normalizedCurrency = currency.toUpperCase();

    // Get current value for logging
    const currentFee = await CryptoFeeMarkup.findOne({ 
      currency: normalizedCurrency 
    });
    const previousValue = currentFee?.feeUsd || 0;

    // Find by currency and update feeUsd, or create new if not found
    const updatedFee = await CryptoFeeMarkup.findOneAndUpdate(
      { currency: normalizedCurrency },
      { feeUsd },
      { 
        new: true, 
        upsert: true, 
        setDefaultsOnInsert: true,
        runValidators: true
      }
    );

    // Log the admin action
    logger?.info(`Crypto fee updated by admin`, {
      currency: normalizedCurrency,
      previousValue,
      newValue: feeUsd,
      change: feeUsd - previousValue,
      adminAction: true,
      timestamp: new Date().toISOString()
    });

    res.status(200).json({
      success: true,
      message: `Crypto fee for ${normalizedCurrency} updated successfully`,
      data: {
        currency: updatedFee.currency,
        feeUsd: updatedFee.feeUsd,
        previousValue,
        change: feeUsd - previousValue,
        createdAt: updatedFee.createdAt,
        updatedAt: updatedFee.updatedAt,
        _id: updatedFee._id
      }
    });

  } catch (error) {
    logger?.error('Error updating crypto fee:', error);
    
    // Handle validation errors specifically
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: Object.values(error.errors).map(err => err.message)
      });
    }

    res.status(500).json({
      success: false,
      error: 'Failed to update crypto fee',
      details: error.message
    });
  }
});

/**
 * @route   DELETE /crypto-fee/:currency
 * @desc    Delete crypto fee configuration for a currency (reset to default)
 * @access  Admin
 */
router.delete('/crypto-fee/:currency', async (req, res) => {
  try {
    const { currency } = req.params;
    
    if (!currency) {
      return res.status(400).json({
        success: false,
        error: 'Currency parameter is required'
      });
    }

    const normalizedCurrency = currency.toUpperCase();
    
    const deletedFee = await CryptoFeeMarkup.findOneAndDelete({ 
      currency: normalizedCurrency 
    });
    
    if (!deletedFee) {
      return res.status(404).json({
        success: false,
        error: `No fee configuration found for ${normalizedCurrency}`
      });
    }

    // Log the admin action
    logger?.info(`Crypto fee configuration deleted by admin`, {
      currency: normalizedCurrency,
      deletedValue: deletedFee.feeUsd,
      adminAction: true,
      timestamp: new Date().toISOString()
    });

    res.status(200).json({
      success: true,
      message: `Crypto fee configuration for ${normalizedCurrency} deleted`,
      data: {
        currency: deletedFee.currency,
        deletedFeeUsd: deletedFee.feeUsd
      }
    });

  } catch (error) {
    logger?.error('Error deleting crypto fee:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete crypto fee configuration',
      details: error.message
    });
  }
});

/**
 * @route   GET /crypto-fee/summary/all
 * @desc    Get summary of all crypto fees with statistics
 * @access  Admin
 */
router.get('/crypto-fee/summary/all', async (req, res) => {
  try {
    const fees = await CryptoFeeMarkup.find({});
    
    const summary = {
      totalConfigurations: fees.length,
      currencies: fees.map(f => f.currency),
      totalFeesUsd: fees.reduce((sum, f) => sum + f.feeUsd, 0),
      averageFeeUsd: fees.length > 0 ? fees.reduce((sum, f) => sum + f.feeUsd, 0) / fees.length : 0,
      highestFee: fees.length > 0 ? Math.max(...fees.map(f => f.feeUsd)) : 0,
      lowestFee: fees.length > 0 ? Math.min(...fees.map(f => f.feeUsd)) : 0,
      lastUpdated: fees.length > 0 ? Math.max(...fees.map(f => new Date(f.updatedAt).getTime())) : null
    };

    res.status(200).json({
      success: true,
      message: 'Crypto fee summary',
      data: {
        summary,
        configurations: fees
      }
    });

  } catch (error) {
    logger?.error('Error fetching crypto fee summary:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch crypto fee summary',
      details: error.message
    });
  }
});

module.exports = router;