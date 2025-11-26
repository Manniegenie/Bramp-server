const mongoose = require("mongoose");
const { logger } = require("./logger");
const OpenAI = require("openai");

// Optional Redis check (only if Redis is available)
let checkRedisHealth = null;
try {
    const redis = require("../queue/redis");
    checkRedisHealth = redis.checkRedisHealth;
} catch (error) {
    // Redis not available, skip health check
    checkRedisHealth = async () => ({ healthy: false, message: "Redis not configured" });
}

/**
 * Check database health
 */
async function checkDatabaseHealth() {
    try {
        const state = mongoose.connection.readyState;
        if (state === 1) {
            // Test query
            await mongoose.connection.db.admin().ping();
            return { healthy: true, message: "Database is healthy" };
        } else {
            return { healthy: false, message: `Database connection state: ${state}` };
        }
    } catch (error) {
        logger.error("Database health check failed:", error);
        return { healthy: false, message: error.message };
    }
}

/**
 * Check OpenAI API health
 */
async function checkOpenAIHealth() {
    try {
        const openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY,
            timeout: 5000,
        });

        // Simple test request
        await openai.models.list();
        return { healthy: true, message: "OpenAI API is healthy" };
    } catch (error) {
        logger.error("OpenAI API health check failed:", error);
        return { healthy: false, message: error.message };
    }
}

/**
 * Check system resources
 */
function checkSystemResources() {
    try {
        const usage = process.memoryUsage();
        const heapUsed = usage.heapUsed / 1024 / 1024;
        const heapTotal = usage.heapTotal / 1024 / 1024;
        const rss = usage.rss / 1024 / 1024;

        const heapPercentage = (heapUsed / heapTotal) * 100;
        const isHealthy = heapPercentage < 90; // Consider unhealthy if heap usage > 90%

        return {
            healthy: isHealthy,
            message: isHealthy ? "System resources are healthy" : "High memory usage detected",
            details: {
                heapUsed: `${heapUsed.toFixed(2)} MB`,
                heapTotal: `${heapTotal.toFixed(2)} MB`,
                rss: `${rss.toFixed(2)} MB`,
                heapPercentage: `${heapPercentage.toFixed(2)}%`,
            },
        };
    } catch (error) {
        logger.error("System resources health check failed:", error);
        return { healthy: false, message: error.message };
    }
}

/**
 * Comprehensive health check
 */
async function performHealthCheck() {
    const checks = {
        database: await checkDatabaseHealth(),
        redis: await checkRedisHealth(),
        openai: await checkOpenAIHealth(),
        system: checkSystemResources(),
    };

    const allHealthy = Object.values(checks).every(check => check.healthy);

    return {
        healthy: allHealthy,
        checks,
        timestamp: new Date().toISOString(),
    };
}

module.exports = {
    checkDatabaseHealth,
    checkRedisHealth,
    checkOpenAIHealth,
    checkSystemResources,
    performHealthCheck,
};

