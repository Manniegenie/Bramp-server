// AI/cache.js
// Simple in-memory cache for common queries to reduce latency

const logger = require('../utils/logger');

class SimpleCache {
  constructor() {
    this.cache = new Map();
    this.defaultTTL = {
      'get_naira_rates': 30000,      // 30 seconds - rates change frequently
      'get_token_price': 10000,      // 10 seconds - prices change frequently
      'get_dashboard': 5000,         // 5 seconds - balance changes
      'get_transaction_history': 60000, // 1 minute - history doesn't change often
    };
  }

  /**
   * Generate cache key from function name and parameters
   */
  getKey(functionName, parameters, authCtx) {
    const userId = authCtx.userId || 'anon';
    const params = JSON.stringify(parameters || {});
    return `${functionName}:${userId}:${params}`;
  }

  /**
   * Get cached value
   */
  get(functionName, parameters, authCtx) {
    const key = this.getKey(functionName, parameters, authCtx);
    const cached = this.cache.get(key);
    
    if (!cached) return null;
    
    const ttl = this.defaultTTL[functionName] || 10000;
    const age = Date.now() - cached.timestamp;
    
    if (age > ttl) {
      this.cache.delete(key);
      return null;
    }
    
    logger.debug('Cache hit', { functionName, key, age });
    return cached.data;
  }

  /**
   * Set cached value
   */
  set(functionName, parameters, authCtx, data) {
    const key = this.getKey(functionName, parameters, authCtx);
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });
    
    // Clean up old entries periodically (keep cache size manageable)
    if (this.cache.size > 1000) {
      this.cleanup();
    }
  }

  /**
   * Clean up expired entries
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [key, value] of this.cache.entries()) {
      const functionName = key.split(':')[0];
      const ttl = this.defaultTTL[functionName] || 10000;
      const age = now - value.timestamp;
      
      if (age > ttl) {
        this.cache.delete(key);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug('Cache cleanup', { cleaned, remaining: this.cache.size });
    }
  }

  /**
   * Clear cache for a specific function or all
   */
  clear(functionName = null) {
    if (functionName) {
      for (const key of this.cache.keys()) {
        if (key.startsWith(`${functionName}:`)) {
          this.cache.delete(key);
        }
      }
    } else {
      this.cache.clear();
    }
  }
}

// Singleton instance
const cache = new SimpleCache();

// Periodic cleanup every 5 minutes
setInterval(() => cache.cleanup(), 5 * 60 * 1000);

module.exports = cache;

