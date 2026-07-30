const express = require('express');
const { payBetaAuth } = require('../auth/paybetaAuth');
const logger = require('../utils/logger');

const router = express.Router();

const VALID_SERVICE_IDS = ['mtn', 'airtel', 'glo', '9mobile'];
const DATA_SERVICE_MAP = { mtn: 'mtn_data', airtel: 'airtel_data', glo: 'glo_data', '9mobile': '9mobile_data' };

function mapPayBetaPlans(packages, service_id) {
  return packages.map(pkg => ({
    variation_id: pkg.code,
    service_name: service_id.toUpperCase(),
    service_id,
    data_plan: pkg.description,
    price: parseFloat(pkg.price),
    price_formatted: `₦${parseFloat(pkg.price).toLocaleString()}`,
    availability: 'Available'
  }));
}

async function fetchPlansForService(service_id) {
  const payBetaService = DATA_SERVICE_MAP[service_id];
  const response = await payBetaAuth.makeRequest('POST', '/v2/data-bundle/list', { service: payBetaService }, { timeout: 15000 });
  if (response.status !== 'successful') throw new Error(response.message || 'Failed to fetch data plans');
  return mapPayBetaPlans(response.data?.packages || [], service_id);
}

/**
 * POST /plans - Get data plans, optionally filtered by service_id
 */
router.post('/plans', async (req, res) => {
  try {
    const { service_id } = req.body;
    if (service_id && !VALID_SERVICE_IDS.includes(service_id.toLowerCase())) {
      return res.status(400).json({ success: false, error: 'INVALID_SERVICE_ID', message: `Invalid service ID. Must be one of: ${VALID_SERVICE_IDS.join(', ')}`, validServiceIds: VALID_SERVICE_IDS });
    }

    const servicesToFetch = service_id ? [service_id.toLowerCase()] : VALID_SERVICE_IDS;
    const results = await Promise.all(servicesToFetch.map(async (sid) => ({ sid, plans: await fetchPlansForService(sid) })));

    const plansByProvider = {};
    let totalPlans = 0;
    for (const { sid, plans } of results) {
      plansByProvider[sid] = plans;
      totalPlans += plans.length;
    }

    return res.status(200).json({
      success: true,
      message: service_id ? `${service_id.toUpperCase()} data plans retrieved successfully` : 'All data plans retrieved successfully',
      data: {
        plans_by_provider: plansByProvider,
        total_available_plans: totalPlans,
        total_all_plans: totalPlans,
        filter_applied: service_id || null,
        providers_available: Object.keys(plansByProvider)
      }
    });
  } catch (error) {
    logger.error('Fetch data plans error:', { error: error.message, service_id: req.body?.service_id });
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred while fetching data plans' });
  }
});

/**
 * GET /plans?service_id=mtn - Get data plans, optionally filtered by service_id
 */
router.get('/plans', async (req, res) => {
  try {
    const { service_id } = req.query;
    if (service_id && !VALID_SERVICE_IDS.includes(service_id.toLowerCase())) {
      return res.status(400).json({ success: false, error: 'INVALID_SERVICE_ID', message: `Invalid service ID. Must be one of: ${VALID_SERVICE_IDS.join(', ')}`, validServiceIds: VALID_SERVICE_IDS });
    }

    const servicesToFetch = service_id ? [service_id.toLowerCase()] : VALID_SERVICE_IDS;
    const results = await Promise.all(servicesToFetch.map(sid => fetchPlansForService(sid)));
    const plans = results.flat();

    return res.status(200).json({
      success: true,
      message: service_id ? `${service_id.toUpperCase()} data plans retrieved successfully` : 'All data plans retrieved successfully',
      data: {
        plans,
        total_available_plans: plans.length,
        total_all_plans: plans.length,
        filter_applied: service_id || null
      }
    });
  } catch (error) {
    logger.error('Fetch data plans error (GET):', { error: error.message, service_id: req.query?.service_id });
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred while fetching data plans' });
  }
});

/**
 * Get available network providers for data plans
 * GET /data/providers - Get list of available network providers
 */
router.get('/providers', (req, res) => {
  const providers = [
    {
      service_id: 'mtn',
      service_name: 'MTN',
      description: 'MTN Nigeria data plans'
    },
    {
      service_id: 'airtel',
      service_name: 'Airtel',
      description: 'Airtel Nigeria data plans'
    },
    {
      service_id: 'glo',
      service_name: 'Glo',
      description: 'Globacom Nigeria data plans'
    },
    {
      service_id: '9mobile',
      service_name: '9mobile',
      description: '9mobile Nigeria data plans'
    }
  ];
  
  return res.status(200).json({
    success: true,
    message: 'Available network providers retrieved successfully',
    data: {
      providers,
      total_providers: providers.length
    }
  });
});

/**
 * Health check endpoint for data plans service
 */
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'Data Plans API',
    timestamp: new Date().toISOString(),
    provider: 'PayBeta',
    version: '2.0.0'
  });
});

module.exports = router;