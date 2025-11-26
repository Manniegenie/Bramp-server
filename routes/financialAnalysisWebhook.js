const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const FinancialAnalysisJob = require("../models/FinancialAnalysisJob");
const { sendFinancialAnalysisCompleteEmail } = require("../services/EmailService");
const User = require("../models/user");
const { logger } = require("../financial-analysis/utils/logger");
const { extractStatementData } = require("../financial-analysis/extracta/processor");

const router = express.Router();

// More lenient rate limiter for job status polling (read-only, authenticated)
// Allows frequent polling without hitting rate limits
// Frontend polls every 5 seconds = 12 requests per minute
const jobStatusLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute window
    max: 60, // 60 requests per minute (allows polling every 1 second if needed, but frontend uses 5s)
    message: {
        success: false,
        error: "Too many status check requests. Please slow down."
    },
    standardHeaders: true,
    legacyHeaders: false
});

// Extracta.ai webhook rate limiter
const extractaWebhookLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // 100 webhook requests per minute
    message: {
        success: false,
        error: "Too many webhook requests"
    },
    standardHeaders: true,
    legacyHeaders: false
});

// Authentication middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ success: false, error: "Unauthorized: No token provided." });
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ success: false, error: "Forbidden: Invalid token." });
        req.user = user;
        next();
    });
};

/**
 * Validate Extracta.ai webhook signature
 */
function validateExtractaWebhookSignature(req, res, next) {
    try {
        const signatureRequest = req.headers["x-webhook-signature"];
        const secret = process.env.EXTRACTA_WEBHOOK_SECRET || process.env.EXTRACTA_API_KEY;

        if (!signatureRequest) {
            logger.warn("Extracta.ai webhook received without signature");
            return res.status(401).json({
                success: false,
                message: "Webhook is not properly signed - missing signature header"
            });
        }

        if (!secret) {
            logger.error("Extracta.ai webhook secret not configured");
            return res.status(500).json({
                success: false,
                message: "Webhook secret not configured"
            });
        }

        // Extracta.ai signs the result array
        const resultString = JSON.stringify(req.body.result || []);
        const secretKey = secret.replace('E_AI_K_', ''); // Remove prefix if present
        const signature = crypto
            .createHmac('sha256', secretKey)
            .update(resultString)
            .digest('base64');

        if (signature !== signatureRequest) {
            logger.warn("Extracta.ai webhook signature validation failed", {
                received: signatureRequest,
                computed: signature
            });
            return res.status(401).json({
                success: false,
                message: "Webhook is not properly signed - signature mismatch"
            });
        }

        logger.info("Extracta.ai webhook signature validated successfully");
        next();
    } catch (error) {
        logger.error("Error validating Extracta.ai webhook signature:", error);
        return res.status(500).json({
            success: false,
            message: "Error validating webhook signature",
            error: error.message
        });
    }
}

/**
 * POST /financial-analysis/extracta-webhook
 * Extracta.ai webhook endpoint for real-time extraction notifications
 * No authentication required (validated by signature instead)
 */
router.post("/extracta-webhook", extractaWebhookLimiter, validateExtractaWebhookSignature, async (req, res) => {
    try {
        const { event, result } = req.body;

        if (!event) {
            return res.status(400).json({
                success: false,
                error: "Missing required field: event"
            });
        }

        if (!result || !Array.isArray(result) || result.length === 0) {
            return res.status(400).json({
                success: false,
                error: "Missing or invalid result array"
            });
        }

        logger.info(`Extracta.ai webhook received: ${event}`, {
            event,
            resultCount: result.length,
            extractionIds: result.map(r => r.extractionId || r.id || r.extraction_id)
        });

        // Log full webhook payload for debugging
        logger.info(`Extracta.ai webhook full payload:`, JSON.stringify({ event, result }, null, 2));

        // Process each result in the webhook
        // Extracta.ai webhook format: { event: "extraction.processed", result: [{ extractionId, status, result: extractedData, ... }] }
        for (const extractionResult of result) {
            // Extracta.ai may use different field names for extraction ID
            const extractionId = extractionResult.extractionId ||
                extractionResult.extraction_id ||
                extractionResult.id ||
                extractionResult.extraction?.id ||
                extractionResult.extraction?.extraction_id;
            const { batchId, fileId, fileName, status: extractionStatus, result: extractedData, url } = extractionResult;

            if (!extractionId) {
                logger.warn("Extracta.ai webhook result missing extractionId", {
                    extractionResult,
                    availableFields: Object.keys(extractionResult)
                });
                continue;
            }

            logger.info(`Processing webhook for extractionId: ${extractionId}`, {
                extractionId,
                batchId,
                fileId,
                fileName,
                extractionStatus,
                hasExtractedData: !!extractedData
            });

            try {
                // Find the job by extractionId (stored in bankStatement or cryptoStatement)
                let job = await FinancialAnalysisJob.findOne({
                    $or: [
                        { "bankStatement.extractionId": extractionId },
                        { "cryptoStatement.extractionId": extractionId }
                    ]
                });

                // If not found by extractionId, try to find by batchId or fileId
                if (!job && batchId) {
                    logger.info(`Job not found by extractionId ${extractionId}, trying batchId ${batchId}`);
                    job = await FinancialAnalysisJob.findOne({
                        $or: [
                            { "bankStatement.extractionId": batchId },
                            { "cryptoStatement.extractionId": batchId }
                        ]
                    });
                }

                // If still not found, try to match by fileName (fallback)
                if (!job && fileName) {
                    logger.info(`Job not found by extractionId ${extractionId}, trying fileName ${fileName}`);
                    const matchingJobs = await FinancialAnalysisJob.find({
                        $or: [
                            { "bankStatement.fileName": fileName, "bankStatement.status": "processing" },
                            { "cryptoStatement.fileName": fileName, "cryptoStatement.status": "processing" }
                        ]
                    }).limit(5);

                    if (matchingJobs.length > 0) {
                        // Use the most recent matching job
                        job = matchingJobs[0];
                        logger.info(`Found job ${job.jobId} by fileName ${fileName}. Updating extractionId from ${job.bankStatement.extractionId || job.cryptoStatement.extractionId} to ${extractionId}`);

                        // Update the extractionId to match the webhook
                        if (job.bankStatement.fileName === fileName && job.bankStatement.status === "processing") {
                            job.bankStatement.extractionId = extractionId;
                        } else if (job.cryptoStatement.fileName === fileName && job.cryptoStatement.status === "processing") {
                            job.cryptoStatement.extractionId = extractionId;
                        }
                        await job.save();
                    }
                }

                // If still not found, search all pending/processing jobs for debugging
                if (!job) {
                    logger.warn(`Extracta.ai webhook: No job found for extractionId ${extractionId}, fileName: ${fileName}`);

                    // Try to find jobs with processing status that might match
                    const processingJobs = await FinancialAnalysisJob.find({
                        $or: [
                            { "bankStatement.status": "processing" },
                            { "cryptoStatement.status": "processing" }
                        ]
                    })
                        .sort({ createdAt: -1 })
                        .limit(10);

                    logger.info(`Found ${processingJobs.length} processing jobs. Current extractionIds:`, {
                        extractionIdFromWebhook: extractionId,
                        processingJobs: processingJobs.map(j => ({
                            jobId: j.jobId,
                            bankExtractionId: j.bankStatement.extractionId,
                            cryptoExtractionId: j.cryptoStatement.extractionId,
                            bankFileName: j.bankStatement.fileName,
                            cryptoFileName: j.cryptoStatement.fileName,
                            bankStatus: j.bankStatement.status,
                            cryptoStatus: j.cryptoStatement.status
                        }))
                    });

                    continue;
                }

                // Determine which statement this is
                const isBankStatement = job.bankStatement.extractionId === extractionId;
                const statementField = isBankStatement ? "bankStatement" : "cryptoStatement";
                const statementType = isBankStatement ? "bank" : "crypto";

                logger.info(`Processing ${statementType} statement webhook for job ${job.jobId}`, {
                    extractionId,
                    event,
                    extractionStatus,
                    hasExtractedData: !!extractedData
                });

                // Handle different events
                switch (event) {
                    case "extraction.processed":
                        if (extractionStatus === "processed" && extractedData) {
                            // Extracta.ai returns extracted data in result.result field
                            // The extracted data is the actual extracted fields
                            try {
                                logger.info(`Extracting ${statementType} statement data from webhook result for job ${job.jobId}`);
                                const statementData = await extractStatementData(extractedData, extractionId, statementType);

                                job[statementField].status = "completed";
                                job[statementField].extractedData = statementData;
                                job[statementField].processedAt = new Date();
                                job[statementField].error = null;

                                // Update extraction status if both are done
                                if (job.bankStatement.status === "completed" && job.cryptoStatement.status === "completed") {
                                    job.extractionStatus = "completed";
                                    job.status = "extracted";
                                    logger.info(`Both statements extracted for job ${job.jobId}. Ready for analysis.`);
                                } else {
                                    // Update extraction status based on current state
                                    if (job.extractionStatus === "processing") {
                                        // Still waiting for the other statement
                                        logger.info(`Waiting for ${isBankStatement ? "crypto" : "bank"} statement to complete for job ${job.jobId}`);
                                    }
                                }

                                await job.save();
                                logger.info(`Successfully processed ${statementType} statement for job ${job.jobId} (${statementData.transactions?.length || 0} transactions)`);
                            } catch (extractionError) {
                                logger.error(`Error extracting ${statementType} statement data:`, extractionError);
                                job[statementField].status = "failed";
                                job[statementField].error = extractionError.message;
                                job.extractionStatus = "failed";
                                job.status = "failed";
                                await job.save();
                            }
                        } else {
                            logger.warn(`Extracta.ai webhook: extraction.processed but status is ${extractionStatus} or no extracted data for extractionId ${extractionId}`);
                        }
                        break;

                    case "extraction.failed":
                        job[statementField].status = "failed";
                        job[statementField].error = extractedData?.error || extractionResult.error || "Extraction failed";
                        job.extractionStatus = "failed";
                        job.status = "failed";
                        await job.save();
                        logger.error(`Extraction failed for ${statementType} statement in job ${job.jobId}: ${job[statementField].error}`);
                        break;

                    case "extraction.edited":
                    case "extraction.confirmed":
                        // These events indicate manual edits/confirmation in Extracta.ai UI
                        // Update the extracted data if provided
                        if (extractedData) {
                            try {
                                const statementData = await extractStatementData(extractedData, extractionId, statementType);
                                job[statementField].extractedData = statementData;
                                job[statementField].processedAt = new Date();
                                await job.save();
                                logger.info(`Updated ${statementType} statement data from ${event} event for job ${job.jobId}`);
                            } catch (extractionError) {
                                logger.error(`Error updating ${statementType} statement data:`, extractionError);
                            }
                        }
                        break;

                    default:
                        logger.warn(`Unknown Extracta.ai webhook event: ${event} for extractionId ${extractionId}`);
                        break;
                }
            } catch (error) {
                logger.error(`Error processing Extracta.ai webhook for extractionId ${extractionId}:`, error);
                // Continue processing other results
            }
        }

        // Send success response
        res.json({
            success: true,
            event: event,
            message: "Webhook received and processed",
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        logger.error("Error processing Extracta.ai webhook:", error);
        res.status(500).json({
            success: false,
            message: "Error processing webhook",
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * POST /financial-analysis/webhook
 * Webhook endpoint called when financial analysis processing is complete
 * This is called internally by the processing service
 */
router.post("/webhook", async (req, res) => {
    try {
        const { jobId, statementType, status, docId, report, error } = req.body;

        if (!jobId) {
            return res.status(400).json({
                success: false,
                error: "Missing required field: jobId"
            });
        }

        if (!statementType || !['bank', 'crypto'].includes(statementType)) {
            return res.status(400).json({
                success: false,
                error: "Missing or invalid statementType. Must be 'bank' or 'crypto'"
            });
        }

        // Find the job
        const job = await FinancialAnalysisJob.findOne({ jobId });
        if (!job) {
            logger.error(`Financial analysis webhook: Job not found: ${jobId}`);
            return res.status(404).json({
                success: false,
                error: "Job not found"
            });
        }

        // Update the appropriate statement status
        const statementField = `${statementType}Statement`;
        job[statementField].status = status;
        job[statementField].processedAt = new Date();

        if (docId || report?.extractionId) {
            job[statementField].extractionId = docId || report?.extractionId;
        }

        if (error) {
            job[statementField].error = error;
        }

        // Store extracted data if available
        if (report?.statementData) {
            job[statementField].extractedData = report.statementData;
        }

        // Update extraction status when both statements are processed
        const bothExtracted = job.bankStatement.status === 'completed' && job.cryptoStatement.status === 'completed';
        const oneFailed = job.bankStatement.status === 'failed' || job.cryptoStatement.status === 'failed';

        if (status === 'completed' || status === 'failed') {
            if (bothExtracted && job.extractionStatus === 'processing') {
                job.extractionStatus = 'completed';
                job.status = 'extracted';
            } else if (oneFailed && job.extractionStatus === 'processing') {
                job.extractionStatus = 'failed';
                job.status = 'failed';
                job.error = error || `Failed to extract ${statementType} statement`;
            }
        }

        await job.save();

        logger.info(`Financial analysis webhook processed: jobId=${jobId}, statementType=${statementType}, status=${status}`);

        res.json({
            success: true,
            message: "Webhook processed successfully",
            jobStatus: job.status
        });
    } catch (error) {
        logger.error("Financial analysis webhook error:", error);
        res.status(500).json({
            success: false,
            error: error.message || "Internal server error processing webhook"
        });
    }
});

/**
 * GET /financial-analysis/job/:jobId
 * Get the status and results of a financial analysis job
 * Requires authentication
 * Uses lenient rate limiter to allow frequent polling
 */
// Health check endpoint (no auth required for monitoring)
router.get("/health", async (req, res) => {
    try {
        const { performHealthCheck } = require("../financial-analysis/utils/healthCheck");
        const health = await performHealthCheck();
        res.status(health.healthy ? 200 : 503).json(health);
    } catch (error) {
        logger.error("Health check error:", error);
        res.status(500).json({
            healthy: false,
            error: error.message || "Health check failed",
            timestamp: new Date().toISOString()
        });
    }
});

router.get("/job/:jobId", jobStatusLimiter, authenticateToken, async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await FinancialAnalysisJob.findOne({ jobId });

        if (!job) {
            return res.status(404).json({
                success: false,
                error: "Job not found"
            });
        }

        // Verify user owns this job
        if (job.userId.toString() !== req.user.id) {
            return res.status(403).json({
                success: false,
                error: "Access denied"
            });
        }

        // Build response data
        const responseData = {
            jobId: job.jobId,
            status: job.status,
            extractionStatus: job.extractionStatus,
            analysisStatus: job.analysisStatus,
            bankStatement: {
                status: job.bankStatement.status,
                fileName: job.bankStatement.fileName,
                fileSize: job.bankStatement.fileSize,
                processedAt: job.bankStatement.processedAt,
                error: job.bankStatement.error
            },
            cryptoStatement: {
                status: job.cryptoStatement.status,
                fileName: job.cryptoStatement.fileName,
                fileSize: job.cryptoStatement.fileSize,
                processedAt: job.cryptoStatement.processedAt,
                error: job.cryptoStatement.error
            },
            report: job.status === 'completed' && job.report ? job.report : null,
            error: job.error,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            completedAt: job.completedAt
        };

        // Log for debugging
        if (job.status === 'completed') {
            logger.info(`[Job Status] Job ${jobId} is completed. Has report: ${!!job.report}, Analysis status: ${job.analysisStatus}`);
        }

        res.json({
            success: true,
            data: responseData
        });
    } catch (error) {
        logger.error("Error fetching financial analysis job:", error);
        res.status(500).json({
            success: false,
            error: error.message || "Internal server error"
        });
    }
});

module.exports = router;
