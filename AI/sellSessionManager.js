// AI/sellSessionManager.js
// Manages sell intent sessions with 2-minute timeout
// After timeout, session ends and conversation restarts

const logger = require('../utils/logger');

// In-memory storage for sell sessions
// Format: { sessionId: { userId, createdAt, expiresAt, paymentId, intent: 'sell' } }
const sellSessions = new Map();

// Session timeout: 2 minutes (120,000 ms)
const SELL_SESSION_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/**
 * Create a new sell session
 * @param {string} sessionId - Unique session identifier
 * @param {string} userId - User ID
 * @param {string} paymentId - Payment ID from sell transaction
 * @returns {object} Session data
 */
function createSellSession(sessionId, userId, paymentId) {
  const now = Date.now();
  const expiresAt = now + SELL_SESSION_TIMEOUT_MS;

  const session = {
    sessionId,
    userId,
    paymentId,
    intent: 'sell',
    createdAt: now,
    expiresAt,
    active: true
  };

  sellSessions.set(sessionId, session);
  
  // Auto-cleanup after expiration
  setTimeout(() => {
    const current = sellSessions.get(sessionId);
    if (current && current.expiresAt <= Date.now()) {
      endSellSession(sessionId);
      logger.info('Sell session auto-expired', { sessionId, userId, paymentId });
    }
  }, SELL_SESSION_TIMEOUT_MS);

  logger.info('Sell session created', {
    sessionId,
    userId,
    paymentId,
    expiresAt: new Date(expiresAt).toISOString(),
    timeoutMs: SELL_SESSION_TIMEOUT_MS
  });

  return session;
}

/**
 * Get an active sell session
 * @param {string} sessionId - Session identifier
 * @returns {object|null} Session data or null if not found/expired
 */
function getSellSession(sessionId) {
  const session = sellSessions.get(sessionId);
  
  if (!session) {
    return null;
  }

  // Check if expired
  if (session.expiresAt <= Date.now()) {
    endSellSession(sessionId);
    return null;
  }

  return session;
}

/**
 * Check if a sell session is active
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if active sell session exists
 */
function hasActiveSellSession(sessionId) {
  const session = getSellSession(sessionId);
  return !!session && session.active;
}

/**
 * End a sell session (manually or on timeout)
 * @param {string} sessionId - Session identifier
 * @returns {boolean} True if session was ended
 */
function endSellSession(sessionId) {
  const session = sellSessions.get(sessionId);
  if (!session) {
    return false;
  }

  session.active = false;
  sellSessions.delete(sessionId);

  logger.info('Sell session ended', {
    sessionId,
    userId: session.userId,
    paymentId: session.paymentId,
    duration: Date.now() - session.createdAt
  });

  return true;
}

/**
 * Get remaining time for a sell session
 * @param {string} sessionId - Session identifier
 * @returns {number} Remaining milliseconds, or 0 if expired/not found
 */
function getSessionTimeRemaining(sessionId) {
  const session = getSellSession(sessionId);
  if (!session) {
    return 0;
  }

  const remaining = session.expiresAt - Date.now();
  return Math.max(0, remaining);
}

/**
 * Extend a sell session (optional - not used for 2-minute strict timeout)
 * @param {string} sessionId - Session identifier
 * @param {number} additionalMs - Additional milliseconds to add
 * @returns {boolean} True if extended
 */
function extendSellSession(sessionId, additionalMs = 0) {
  // For strict 2-minute timeout, we don't extend
  // But function exists for future flexibility
  const session = getSellSession(sessionId);
  if (!session) {
    return false;
  }

  // Only extend if explicitly allowed
  if (additionalMs > 0 && process.env.ALLOW_SELL_SESSION_EXTENSION === 'true') {
    session.expiresAt += additionalMs;
    logger.info('Sell session extended', {
      sessionId,
      newExpiresAt: new Date(session.expiresAt).toISOString()
    });
    return true;
  }

  return false;
}

/**
 * Cleanup expired sessions (maintenance)
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  let cleaned = 0;

  for (const [sessionId, session] of sellSessions.entries()) {
    if (session.expiresAt <= now) {
      sellSessions.delete(sessionId);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.info('Cleaned up expired sell sessions', { count: cleaned });
  }

  return cleaned;
}

/**
 * Get all active sessions (for monitoring)
 * @returns {Array} Array of active session data
 */
function getAllActiveSessions() {
  const now = Date.now();
  const active = [];

  for (const session of sellSessions.values()) {
    if (session.expiresAt > now && session.active) {
      active.push({
        sessionId: session.sessionId,
        userId: session.userId,
        paymentId: session.paymentId,
        createdAt: new Date(session.createdAt).toISOString(),
        expiresAt: new Date(session.expiresAt).toISOString(),
        timeRemaining: session.expiresAt - now
      });
    }
  }

  return active;
}

// Periodic cleanup (every 5 minutes)
setInterval(() => {
  cleanupExpiredSessions();
}, 5 * 60 * 1000);

module.exports = {
  createSellSession,
  getSellSession,
  hasActiveSellSession,
  endSellSession,
  getSessionTimeRemaining,
  extendSellSession,
  cleanupExpiredSessions,
  getAllActiveSessions,
  SELL_SESSION_TIMEOUT_MS
};



