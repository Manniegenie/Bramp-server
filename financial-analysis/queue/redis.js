const Redis = require("ioredis");
const { logger } = require("../utils/logger");

let redisClient = null;
let redisSubscriber = null;

/**
 * Initialize Redis connection
 */
function initializeRedis() {
    try {
        // Use REDIS_URL if available, otherwise construct from REDIS_HOST/PORT
        const redisUrl = process.env.REDIS_URL ||
            `redis://${process.env.REDIS_HOST || "localhost"}:${process.env.REDIS_PORT || "6379"}`;

        const redisOptions = {
            maxRetriesPerRequest: 3,
            retryStrategy: (times) => {
                const delay = Math.min(times * 50, 2000);
                logger.warn(`Redis retry attempt ${times}, delay: ${delay}ms`);
                return delay;
            },
            reconnectOnError: (err) => {
                const targetError = "READONLY";
                if (err.message.includes(targetError)) {
                    logger.error("Redis READONLY error, reconnecting...");
                    return true;
                }
                return false;
            },
            // ioredis connects automatically, no need for lazyConnect
        };

        // Add password if provided
        if (process.env.REDIS_PASSWORD) {
            redisOptions.password = process.env.REDIS_PASSWORD;
        }

        redisClient = new Redis(redisUrl, redisOptions);
        redisSubscriber = redisClient.duplicate();

        redisClient.on("connect", () => {
            logger.info("✅ Redis client connected");
        });

        redisClient.on("error", (err) => {
            logger.error("Redis client error:", err);
        });

        redisClient.on("close", () => {
            logger.warn("Redis client closed");
        });

        redisSubscriber.on("connect", () => {
            logger.info("✅ Redis subscriber connected");
        });

        redisSubscriber.on("error", (err) => {
            logger.error("Redis subscriber error:", err);
        });

        // Test connection with ping (ioredis connects automatically)
        return redisClient.ping().then(() => {
            logger.info("✅ Redis initialized successfully");
            return { redisClient, redisSubscriber };
        }).catch((error) => {
            logger.error("Redis connection test failed:", error);
            throw error;
        });
    } catch (error) {
        logger.error("Failed to initialize Redis:", error);
        throw error;
    }
}

/**
 * Get Redis client
 */
function getRedisClient() {
    if (!redisClient) {
        initializeRedis();
    }
    return redisClient;
}

/**
 * Get Redis subscriber
 */
function getRedisSubscriber() {
    if (!redisSubscriber) {
        initializeRedis();
    }
    return redisSubscriber;
}

/**
 * Health check for Redis
 */
async function checkRedisHealth() {
    try {
        if (!redisClient) {
            return { healthy: false, message: "Redis not initialized" };
        }
        await redisClient.ping();
        return { healthy: true, message: "Redis is healthy" };
    } catch (error) {
        logger.error("Redis health check failed:", error);
        return { healthy: false, message: error.message };
    }
}

/**
 * Close Redis connections
 */
async function closeRedis() {
    try {
        if (redisClient) {
            await redisClient.quit();
            redisClient = null;
        }
        if (redisSubscriber) {
            await redisSubscriber.quit();
            redisSubscriber = null;
        }
        logger.info("✅ Redis connections closed");
    } catch (error) {
        logger.error("Error closing Redis connections:", error);
        // Force disconnect if quit fails
        try {
            if (redisClient) redisClient.disconnect();
            if (redisSubscriber) redisSubscriber.disconnect();
        } catch (disconnectError) {
            // Ignore disconnect errors
        }
    }
}

module.exports = {
    initializeRedis,
    getRedisClient,
    getRedisSubscriber,
    checkRedisHealth,
    closeRedis
};

