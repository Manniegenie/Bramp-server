const { Queue, QueueEvents } = require("bullmq");
const { getRedisClient } = require("./redis");
const { logger } = require("../utils/logger");

// Redis connection configuration
// Use REDIS_URL if available, otherwise construct from components
const getConnection = () => {
    if (process.env.REDIS_URL) {
        // Parse REDIS_URL (e.g., redis://localhost:6379 or redis://:password@localhost:6379)
        try {
            const url = new URL(process.env.REDIS_URL);
            return {
                host: url.hostname,
                port: parseInt(url.port || "6379"),
                password: url.password || process.env.REDIS_PASSWORD || undefined,
            };
        } catch (error) {
            logger.warn("Invalid REDIS_URL, using defaults:", error.message);
        }
    }

    return {
        host: process.env.REDIS_HOST || "localhost",
        port: parseInt(process.env.REDIS_PORT || "6379"),
        password: process.env.REDIS_PASSWORD || undefined,
    };
};

const connection = getConnection();

// Financial Analysis Job Queue
const financialAnalysisQueue = new Queue("financial-analysis", {
    connection,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: "exponential",
            delay: 2000, // Start with 2 seconds
        },
        removeOnComplete: {
            age: 24 * 3600, // Keep completed jobs for 24 hours
            count: 1000, // Keep last 1000 completed jobs
        },
        removeOnFail: {
            age: 7 * 24 * 3600, // Keep failed jobs for 7 days
        },
    },
});

// Queue Events for monitoring
const queueEvents = new QueueEvents("financial-analysis", { connection });

queueEvents.on("completed", ({ jobId }) => {
    logger.info(`Job ${jobId} completed`);
});

queueEvents.on("failed", ({ jobId, failedReason }) => {
    logger.error(`Job ${jobId} failed:`, failedReason);
});

queueEvents.on("progress", ({ jobId, data }) => {
    logger.info(`Job ${jobId} progress:`, data);
});

/**
 * Add extraction job to queue
 */
async function addExtractionJob(jobId, bankFile, cryptoFile, userId) {
    try {
        const job = await financialAnalysisQueue.add(
            "extract-statements",
            {
                jobId,
                bankFile: {
                    buffer: bankFile.buffer.toString("base64"),
                    originalname: bankFile.originalname,
                    mimetype: bankFile.mimetype,
                    size: bankFile.size,
                },
                cryptoFile: {
                    buffer: cryptoFile.buffer.toString("base64"),
                    originalname: cryptoFile.originalname,
                    mimetype: cryptoFile.mimetype,
                    size: cryptoFile.size,
                },
                userId,
            },
            {
                jobId: `extraction-${jobId}`,
                priority: 1,
            }
        );

        logger.info(`Extraction job ${job.id} added to queue for job ${jobId}`);
        return job;
    } catch (error) {
        logger.error("Error adding extraction job to queue:", error);
        throw error;
    }
}

/**
 * Add analysis job to queue
 */
async function addAnalysisJob(jobId) {
    try {
        const job = await financialAnalysisQueue.add(
            "analyze-statements",
            { jobId },
            {
                jobId: `analysis-${jobId}`,
                priority: 2,
            }
        );

        logger.info(`Analysis job ${job.id} added to queue for job ${jobId}`);
        return job;
    } catch (error) {
        logger.error("Error adding analysis job to queue:", error);
        throw error;
    }
}

/**
 * Get job status
 */
async function getJobStatus(jobId) {
    try {
        const job = await financialAnalysisQueue.getJob(jobId);
        if (!job) {
            return null;
        }

        const state = await job.getState();
        const progress = job.progress;
        const returnvalue = job.returnvalue;
        const failedReason = job.failedReason;

        return {
            id: job.id,
            name: job.name,
            state,
            progress,
            returnvalue,
            failedReason,
            timestamp: job.timestamp,
        };
    } catch (error) {
        logger.error("Error getting job status:", error);
        return null;
    }
}

/**
 * Cleanup queue
 */
async function cleanupQueue() {
    try {
        await financialAnalysisQueue.clean(0, 1000, "completed");
        await financialAnalysisQueue.clean(0, 100, "failed");
        logger.info("Queue cleaned up");
    } catch (error) {
        logger.error("Error cleaning up queue:", error);
    }
}

module.exports = {
    financialAnalysisQueue,
    queueEvents,
    addExtractionJob,
    addAnalysisJob,
    getJobStatus,
    cleanupQueue,
};

