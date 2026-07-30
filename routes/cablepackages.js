const express = require('express');
const { payBetaAuth } = require('../auth/paybetaAuth');
const logger = require('../utils/logger');

const router = express.Router();

const VALID_SERVICE_IDS = ['dstv', 'gotv', 'startimes', 'showmax'];

function mapPayBetaPackages(packages, service_id) {
  return packages.map(pkg => ({
    variation_id: pkg.code,
    service_name: service_id.toUpperCase(),
    service_id,
    package_bouquet: pkg.description,
    price: parseFloat(pkg.price),
    price_formatted: `₦${parseFloat(pkg.price).toLocaleString()}`,
    availability: 'Available'
  }));
}

async function fetchPackagesForService(service_id) {
  const isShowmax = service_id === 'showmax';
  const response = isShowmax
    ? await payBetaAuth.makeRequest('GET', '/v2/showmax/bouquet', null, { timeout: 15000 })
    : await payBetaAuth.makeRequest('POST', '/v2/cable/bouquet', { service: service_id }, { timeout: 15000 });
  if (response.status !== 'successful') throw new Error(response.message || 'Failed to fetch cable TV packages');
  return mapPayBetaPackages(response.data?.packages || [], service_id);
}

/**
 * POST /packages - Get cable TV packages, optionally filtered by service_id
 */
router.post('/packages', async (req, res) => {
  try {
    const { service_id } = req.body;
    if (service_id && !VALID_SERVICE_IDS.includes(service_id.toLowerCase())) {
      return res.status(400).json({ success: false, error: 'INVALID_SERVICE_ID', message: `Invalid service ID. Must be one of: ${VALID_SERVICE_IDS.join(', ')}`, validServiceIds: VALID_SERVICE_IDS });
    }

    const servicesToFetch = service_id ? [service_id.toLowerCase()] : VALID_SERVICE_IDS;
    const results = await Promise.all(servicesToFetch.map(async (sid) => ({ sid, packages: await fetchPackagesForService(sid) })));

    const packagesByProvider = {};
    let totalPackages = 0;
    for (const { sid, packages } of results) {
      packagesByProvider[sid] = packages;
      totalPackages += packages.length;
    }

    return res.status(200).json({
      success: true,
      message: service_id ? `${service_id.toUpperCase()} cable TV packages retrieved successfully` : 'All cable TV packages retrieved successfully',
      data: {
        packages_by_provider: packagesByProvider,
        total_available_packages: totalPackages,
        total_all_packages: totalPackages,
        filter_applied: service_id || null,
        providers_available: Object.keys(packagesByProvider)
      }
    });
  } catch (error) {
    logger.error('Fetch cable TV packages error:', { error: error.message, service_id: req.body?.service_id });
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred while fetching cable TV packages' });
  }
});

/**
 * GET /packages?service_id=dstv - Get cable TV packages, optionally filtered by service_id
 */
router.get('/packages', async (req, res) => {
  try {
    const { service_id } = req.query;
    if (service_id && !VALID_SERVICE_IDS.includes(service_id.toLowerCase())) {
      return res.status(400).json({ success: false, error: 'INVALID_SERVICE_ID', message: `Invalid service ID. Must be one of: ${VALID_SERVICE_IDS.join(', ')}`, validServiceIds: VALID_SERVICE_IDS });
    }

    const servicesToFetch = service_id ? [service_id.toLowerCase()] : VALID_SERVICE_IDS;
    const results = await Promise.all(servicesToFetch.map(sid => fetchPackagesForService(sid)));
    const packages = results.flat();

    return res.status(200).json({
      success: true,
      message: service_id ? `${service_id.toUpperCase()} cable TV packages retrieved successfully` : 'All cable TV packages retrieved successfully',
      data: {
        packages,
        total_available_packages: packages.length,
        total_all_packages: packages.length,
        filter_applied: service_id || null
      }
    });
  } catch (error) {
    logger.error('Fetch cable TV packages error (GET):', { error: error.message, service_id: req.query?.service_id });
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred while fetching cable TV packages' });
  }
});

/**
 * GET /providers - Get list of available cable TV providers
 */
router.get('/providers', (req, res) => {
  const providers = [
    { service_id: 'dstv', service_name: 'DStv', description: 'DStv Nigeria cable TV packages' },
    { service_id: 'gotv', service_name: 'GOtv', description: 'GOtv Nigeria cable TV packages' },
    { service_id: 'startimes', service_name: 'Startimes', description: 'Startimes Nigeria cable TV packages' },
    { service_id: 'showmax', service_name: 'Showmax', description: 'Showmax Nigeria streaming packages' }
  ];

  return res.status(200).json({
    success: true,
    message: 'Available cable TV providers retrieved successfully',
    data: { providers, total_providers: providers.length }
  });
});

/**
 * Health check endpoint for cable TV service
 */
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'Cable TV API',
    timestamp: new Date().toISOString(),
    provider: 'PayBeta',
    version: '2.0.0'
  });
});

module.exports = router;
