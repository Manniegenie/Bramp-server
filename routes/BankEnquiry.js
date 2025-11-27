const express = require('express');
const axios = require('axios');

const router = express.Router();

// Bank enquiry endpoint
router.post('/account-enquiry', async (req, res) => {
  try {
    const { account_number, bank_code } = req.body;

    // Validate required fields
    if (!account_number || !bank_code) {
      return res.status(400).json({
        status: 400,
        success: false,
        message: 'account_number and bank_code are required fields'
      });
    }

    // Validate environment variables
    if (!process.env.GLYDE_API_KEY || !process.env.GLYDE_API_BASE_URL) {
      return res.status(500).json({
        status: 500,
        success: false,
        message: 'Missing required environment variables: GLYDE_API_KEY or GLYDE_API_BASE_URL'
      });
    }

    // Prepare request to Glyde API
    const glydeApiUrl = `${process.env.GLYDE_API_BASE_URL}/account-enquiry`;
    
    const requestConfig = {
      method: 'POST',
      url: glydeApiUrl,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GLYDE_API_KEY}`
      },
      data: {
        account_number: account_number.toString(),
        bank_code: bank_code.toString()
      }
    };

    // Make request to Glyde API
    const response = await axios(requestConfig);

    // Return successful response
    return res.status(200).json({
      status: 200,
      success: true,
      data: response.data.data || response.data,
      message: 'Account enquiry successful'
    });

  } catch (error) {
    console.error('Bank enquiry error:', error.response?.data || error.message);

    // Handle different types of errors
    if (error.response) {
      // API returned an error response
      const { status, data } = error.response;
      return res.status(status).json({
        status: status,
        success: false,
        message: data.message || 'Bank enquiry failed',
        error: data.error || 'External API error'
      });
    } else if (error.request) {
      // Request was made but no response received
      return res.status(503).json({
        status: 503,
        success: false,
        message: 'Bank service unavailable',
        error: 'No response from bank service'
      });
    } else {
      // Something else happened
      return res.status(500).json({
        status: 500,
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  }
});

router.get('/banks', async (req, res) => {
  try {
    // Validate environment variables
    if (!process.env.GLYDE_API_KEY || !process.env.GLYDE_API_BASE_URL) {
      return res.status(500).json({
        status: 500,
        success: false,
        message: 'Missing required environment variables: GLYDE_API_KEY or GLYDE_API_BASE_URL'
      });
    }

    // Prepare request to Glyde API
    const glydeApiUrl = `${process.env.GLYDE_API_BASE_URL}/banks`;
    
    const requestConfig = {
      method: 'GET',
      url: glydeApiUrl,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GLYDE_API_KEY}`
      }
    };

    // Make request to Glyde API
    const response = await axios(requestConfig);

    // Return successful response
    return res.status(200).json({
      status: 200,
      success: true,
      data: response.data.data || response.data,
      message: 'Banks retrieved successfully'
    });

  } catch (error) {
    console.error('Get banks error:', error.response?.data || error.message);

    // Handle different types of errors
    if (error.response) {
      // API returned an error response
      const { status, data } = error.response;
      return res.status(status).json({
        status: status,
        success: false,
        message: data.message || 'Failed to retrieve banks',
        error: data.error || 'External API error'
      });
    } else if (error.request) {
      // Request was made but no response received
      return res.status(503).json({
        status: 503,
        success: false,
        message: 'Bank service unavailable',
        error: 'No response from bank service'
      });
    } else {
      // Something else happened
      return res.status(500).json({
        status: 500,
        success: false,
        message: 'Internal server error',
        error: error.message
      });
    }
  }
});


module.exports = router;