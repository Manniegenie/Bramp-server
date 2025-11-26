/**
 * Node.js client for Python-based zero-shot intent classification service
 * Falls back to regex if Python service is unavailable
 */
const axios = require('axios');
const logger = (() => {
  try { return require('../utils/logger'); } 
  catch (e) { return console; }
})();

const INTENT_SERVICE_URL = process.env.INTENT_SERVICE_URL || 'http://localhost:5001';
const INTENT_SERVICE_TIMEOUT = parseInt(process.env.INTENT_SERVICE_TIMEOUT || '2000', 10); // 2s timeout
const USE_PYTHON_CLASSIFIER = process.env.USE_PYTHON_CLASSIFIER !== 'false'; // Default to true

/**
 * Classify intent using Python zero-shot classification service
 * @param {string} message - User message to classify
 * @param {Array} history - Optional conversation history
 * @returns {Promise<Object>} { intent, confidence, all_scores, raw_label }
 */
async function classifyIntentWithPython(message, history = []) {
  if (!USE_PYTHON_CLASSIFIER) {
    throw new Error('Python classifier disabled');
  }

  try {
    const response = await axios.post(
      `${INTENT_SERVICE_URL}/classify`,
      {
        message: message || '',
        history: history || []
      },
      {
        timeout: INTENT_SERVICE_TIMEOUT,
        headers: { 'Content-Type': 'application/json' }
      }
    );

    if (response.data && response.data.intent) {
      return {
        intent: response.data.intent,
        confidence: response.data.confidence || 0,
        all_scores: response.data.all_scores || {},
        raw_label: response.data.raw_label || null,
        source: 'python_zero_shot'
      };
    }

    throw new Error('Invalid response from intent service');
  } catch (error) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      logger.warn(`Intent service unavailable (${error.code}), falling back to regex`);
      throw new Error('SERVICE_UNAVAILABLE');
    }
    logger.error('Intent classification error:', error.message);
    throw error;
  }
}

/**
 * Check if Python intent service is healthy
 * @returns {Promise<boolean>}
 */
async function checkIntentServiceHealth() {
  try {
    const response = await axios.get(`${INTENT_SERVICE_URL}/health`, {
      timeout: 1000
    });
    return response.data && response.data.status === 'healthy';
  } catch (error) {
    return false;
  }
}

module.exports = {
  classifyIntentWithPython,
  checkIntentServiceHealth,
  USE_PYTHON_CLASSIFIER
};

