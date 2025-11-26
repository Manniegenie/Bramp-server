const { Worker } = require("bullmq");
const FinancialAnalysisJob = require("../../models/FinancialAnalysisJob");
const { logger } = require("../utils/logger");
const { extractWithHybridApproach } = require("../extractors/hybridExtractor");
const { extractStatementData } = require("../extracta/processor");
const { analyzeWithOpenAI } = require("../analysis/openai");

// Redis connection configuration (matches queues.js)
const getConnection = () => {
    if (process.env.REDIS_URL) {
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

/**
 * Process extraction job
 */
async function processExtractionJob(job) {
    const { jobId, bankFile, cryptoFile, userId } = job.data;
    logger.info(`[Worker] Processing extraction job ${job.id} for job ${jobId}`);

    try {
        // Update job progress
        await job.updateProgress(10);

        // Find job in database
        let jobRecord = await FinancialAnalysisJob.findOne({ jobId });
        if (!jobRecord) {
            throw new Error(`Job not found: ${jobId}`);
        }

        // Update job status
        jobRecord.status = "extracting";
        jobRecord.extractionStatus = "processing";
        jobRecord.bankStatement.status = "processing";
        jobRecord.cryptoStatement.status = "processing";
        await jobRecord.save();

        await job.updateProgress(20);

        // Convert base64 back to buffer
        const bankBuffer = Buffer.from(bankFile.buffer, "base64");
        const cryptoBuffer = Buffer.from(cryptoFile.buffer, "base64");

        await job.updateProgress(30);

        // Create timeout promises
        const extractionTimeout = 180000; // 3 minutes per extraction
        const createTimeoutPromise = (timeoutMs) => {
            return new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`Extraction timed out after ${timeoutMs / 1000}s`)), timeoutMs);
            });
        };

        // Extract with timeout and fallback (using GPT-5 Mini)
        const { extractWithGPT4Vision } = require("../extracta/gpt4VisionExtractor");
        const extractWithTimeoutAndFallback = async (fileBuffer, fileName, statementType) => {
            try {
                // Try hybrid approach first (uses GPT-5 Mini)
                logger.info(`[Worker] Attempting hybrid extraction with GPT-5 Mini for ${statementType}...`);
                return await Promise.race([
                    extractWithHybridApproach(fileBuffer, fileName, statementType),
                    createTimeoutPromise(extractionTimeout)
                ]);
            } catch (error) {
                logger.warn(`[Worker] Hybrid extraction failed for ${statementType}, falling back to GPT-5 Mini direct extraction:`, error.message);
                // Fallback to GPT-5 Mini direct extraction
                try {
                    return await Promise.race([
                        extractWithGPT4Vision({ buffer: fileBuffer, originalname: fileName, mimetype: "application/pdf" }, statementType),
                        createTimeoutPromise(extractionTimeout)
                    ]);
                } catch (fallbackError) {
                    logger.error(`[Worker] GPT-5 Mini fallback also failed for ${statementType}:`, fallbackError);
                    throw new Error(`${statementType} extraction failed: ${fallbackError.message}`);
                }
            }
        };

        // Extract statements using hybrid approach with GPT-5 Mini (timeout and fallback)
        logger.info(`[Worker] Extracting statements using hybrid approach with GPT-5 Mini...`);
        const [bankData, cryptoData] = await Promise.all([
            extractWithTimeoutAndFallback(bankBuffer, bankFile.originalname, "bank").catch(err => {
                logger.error(`[Worker] Bank extraction failed:`, err);
                throw err;
            }),
            extractWithTimeoutAndFallback(cryptoBuffer, cryptoFile.originalname, "crypto").catch(err => {
                logger.error(`[Worker] Crypto extraction failed:`, err);
                throw err;
            }),
        ]);

        logger.info(`[Worker] Both extractions completed: Bank (${bankData.transactions?.length || 0} transactions), Crypto (${cryptoData.transactions?.length || 0} transactions)`);
        logger.info(`[Worker] Bank confidence: ${bankData.confidenceScore || 'N/A'}%, Crypto confidence: ${cryptoData.confidenceScore || 'N/A'}%`);

        await job.updateProgress(60);

        // Store extraction IDs
        jobRecord.bankStatement.extractionId = `hybrid-${Date.now()}-bank`;
        jobRecord.cryptoStatement.extractionId = `hybrid-${Date.now()}-crypto`;
        await jobRecord.save();

        logger.info(`[Worker] Both extractions completed: Bank (${bankData.transactions?.length || 0} transactions), Crypto (${cryptoData.transactions?.length || 0} transactions)`);

        // Process extracted data
        logger.info(`[Worker] Processing extracted data...`);
        const [bankStatement, cryptoStatement] = await Promise.all([
            extractStatementData(bankData, jobRecord.bankStatement.extractionId, "bank"),
            extractStatementData(cryptoData, jobRecord.cryptoStatement.extractionId, "crypto"),
        ]);

        await job.updateProgress(80);

        // Update job with extracted data
        jobRecord.bankStatement.status = "completed";
        jobRecord.bankStatement.extractedData = bankStatement;
        jobRecord.bankStatement.processedAt = new Date();
        jobRecord.cryptoStatement.status = "completed";
        jobRecord.cryptoStatement.extractedData = cryptoStatement;
        jobRecord.cryptoStatement.processedAt = new Date();
        jobRecord.extractionStatus = "completed";
        jobRecord.status = "extracted";
        await jobRecord.save();

        await job.updateProgress(100);

        logger.info(`[Worker] Extraction complete: Bank (${bankStatement.transactions?.length || 0}), Crypto (${cryptoStatement.transactions?.length || 0})`);

        // Automatically add analysis job to queue after extraction completes
        try {
            const { addAnalysisJob } = require("./queues");
            await addAnalysisJob(jobId);
            logger.info(`[Worker] Analysis job added to queue for job ${jobId}`);
        } catch (analysisError) {
            logger.error(`[Worker] Error adding analysis job to queue:`, analysisError);
            // Fallback to direct processing
            try {
                const { analyzeStatements } = require("../../services/financialAnalysisWorker");
                analyzeStatements(jobId).catch(err => {
                    logger.error(`[Worker] Direct analysis failed:`, err);
                });
            } catch (fallbackError) {
                logger.error(`[Worker] Fallback analysis failed:`, fallbackError);
            }
        }

        return {
            success: true,
            jobId,
            bankTransactions: bankStatement.transactions?.length || 0,
            cryptoTransactions: cryptoStatement.transactions?.length || 0,
        };
    } catch (error) {
        logger.error(`[Worker] Extraction job ${job.id} failed:`, error);

        // Update job status to failed
        try {
            const jobRecord = await FinancialAnalysisJob.findOne({ jobId });
            if (jobRecord) {
                jobRecord.extractionStatus = "failed";
                jobRecord.status = "failed";
                jobRecord.error = error.message || "Unknown error occurred during extraction";
                if (jobRecord.bankStatement.status === "processing") {
                    jobRecord.bankStatement.status = "failed";
                    jobRecord.bankStatement.error = error.message;
                }
                if (jobRecord.cryptoStatement.status === "processing") {
                    jobRecord.cryptoStatement.status = "failed";
                    jobRecord.cryptoStatement.error = error.message;
                }
                await jobRecord.save();
                logger.info(`[Worker] Job ${jobId} marked as failed`);
            }
        } catch (saveError) {
            logger.error("Error saving job failure status:", saveError);
        }

        throw error;
    }
}

/**
 * Process analysis job
 */
async function processAnalysisJob(job) {
    const { jobId } = job.data;
    logger.info(`[Worker] Processing analysis job ${job.id} for job ${jobId}`);

    try {
        await job.updateProgress(10);

        // Find job in database
        const jobRecord = await FinancialAnalysisJob.findOne({ jobId });
        if (!jobRecord) {
            throw new Error(`Job not found: ${jobId}`);
        }

        if (!jobRecord.bankStatement.extractedData || !jobRecord.cryptoStatement.extractedData) {
            throw new Error("Both statements must be extracted");
        }

        await job.updateProgress(20);

        // Update job status
        jobRecord.status = "analyzing";
        jobRecord.analysisStatus = "processing";
        await jobRecord.save();

        await job.updateProgress(40);

        // Analyze statements
        logger.info(`[Worker] Analyzing statements...`);
        const analysis = await analyzeWithOpenAI(
            jobRecord.bankStatement.extractedData,
            jobRecord.cryptoStatement.extractedData
        );

        await job.updateProgress(80);

        // Update job with analysis results
        jobRecord.status = "completed";
        jobRecord.analysisStatus = "completed";
        jobRecord.report = {
            bank: jobRecord.bankStatement.extractedData,
            crypto: jobRecord.cryptoStatement.extractedData,
            combined: analysis,
        };
        jobRecord.completedAt = new Date();
        await jobRecord.save();

        await job.updateProgress(100);

        logger.info(`[Worker] Analysis complete for job ${jobId}`);

        // Display full report in terminal (same as direct worker)
        logger.info(`\n${'='.repeat(80)}`);
        logger.info(`[Worker] Analysis complete for job ${jobId}`);
        logger.info(`${'='.repeat(80)}\n`);

        // Executive Summary
        if (analysis.executiveSummary) {
            logger.info('📊 EXECUTIVE SUMMARY');
            logger.info(`${'-'.repeat(80)}`);
            logger.info(`Audit Date: ${analysis.executiveSummary.auditDate || 'N/A'}`);
            logger.info(`Period Analyzed: ${analysis.executiveSummary.periodAnalyzed || 'N/A'}`);
            logger.info(`Reconciliation Status: ${analysis.executiveSummary.overallReconciliationStatus || 'N/A'}`);
            logger.info(`Total Discrepancies: ${analysis.executiveSummary.totalDiscrepancies || 0}`);
            if (analysis.executiveSummary.missingFundsAmount > 0) {
                logger.info(`⚠️  Missing Funds: ${analysis.executiveSummary.missingFundsAmount} ${analysis.executiveSummary.missingFundsCurrency || 'NGN'}`);
            }
            if (analysis.executiveSummary.criticalFindings && analysis.executiveSummary.criticalFindings.length > 0) {
                logger.info(`Critical Findings:`);
                analysis.executiveSummary.criticalFindings.forEach((finding, idx) => {
                    logger.info(`  ${idx + 1}. ${finding}`);
                });
            }
            logger.info('');
        }

        // Reconciliation
        if (analysis.reconciliation) {
            logger.info('🔍 RECONCILIATION');
            logger.info(`${'-'.repeat(80)}`);
            logger.info(`Matched Transactions: ${analysis.reconciliation.matchedTransactions || 0}`);
            logger.info(`Unmatched Bank Transactions: ${analysis.reconciliation.unmatchedBankTransactions || 0}`);
            logger.info(`Unmatched Crypto Transactions: ${analysis.reconciliation.unmatchedCryptoTransactions || 0}`);
            logger.info(`Reconciliation Rate: ${analysis.reconciliation.reconciliationRate || 0}%`);
            if (analysis.reconciliation.discrepancies && analysis.reconciliation.discrepancies.length > 0) {
                logger.info(`\nDiscrepancies (${analysis.reconciliation.discrepancies.length}):`);
                analysis.reconciliation.discrepancies.slice(0, 5).forEach((disc, idx) => {
                    logger.info(`  ${idx + 1}. [${disc.type}] ${disc.description}`);
                    logger.info(`     Amount: ${disc.amount} ${disc.currency} | Severity: ${disc.severity || 'N/A'}`);
                });
            }
            logger.info('');
        }

        // Missing Funds
        if (analysis.missingFunds && analysis.missingFunds.totalMissing > 0) {
            logger.info('💰 MISSING FUNDS');
            logger.info(`${'-'.repeat(80)}`);
            logger.info(`Total Missing: ${analysis.missingFunds.totalMissing} ${analysis.missingFunds.currency || 'NGN'}`);
            if (analysis.missingFunds.recommendations && analysis.missingFunds.recommendations.length > 0) {
                logger.info(`\nRecommendations:`);
                analysis.missingFunds.recommendations.slice(0, 3).forEach((rec, idx) => {
                    logger.info(`  ${idx + 1}. ${rec}`);
                });
            }
            logger.info('');
        }

        // Audit Report
        if (analysis.auditReport) {
            logger.info('📋 AUDIT REPORT');
            logger.info(`${'-'.repeat(80)}`);
            if (analysis.auditReport.keyFindings && analysis.auditReport.keyFindings.length > 0) {
                logger.info(`Key Findings:`);
                analysis.auditReport.keyFindings.slice(0, 5).forEach((finding, idx) => {
                    logger.info(`  ${idx + 1}. ${finding}`);
                });
            }
            if (analysis.auditReport.recommendations && analysis.auditReport.recommendations.length > 0) {
                logger.info(`\nRecommendations:`);
                analysis.auditReport.recommendations.slice(0, 5).forEach((rec, idx) => {
                    logger.info(`  ${idx + 1}. ${rec}`);
                });
            }
            logger.info('');
        }

        logger.info(`${'='.repeat(80)}`);
        logger.info(`[Worker] Report ready for frontend. Job ID: ${jobId}`);
        logger.info(`${'='.repeat(80)}\n`);

        return {
            success: true,
            jobId,
            report: analysis,
        };
    } catch (error) {
        logger.error(`[Worker] Analysis job ${job.id} failed:`, error);

        // Update job status to failed
        try {
            const jobRecord = await FinancialAnalysisJob.findOne({ jobId });
            if (jobRecord) {
                jobRecord.analysisStatus = "failed";
                jobRecord.status = "failed";
                jobRecord.error = error.message || "Unknown error occurred during analysis";
                await jobRecord.save();
                logger.info(`[Worker] Job ${jobId} analysis marked as failed`);
            }
        } catch (saveError) {
            logger.error("Error saving job failure status:", saveError);
        }

        throw error;
    }
}

/**
 * Create extraction worker
 */
function createExtractionWorker() {
    const worker = new Worker(
        "financial-analysis",
        async (job) => {
            if (job.name === "extract-statements") {
                return await processExtractionJob(job);
            } else if (job.name === "analyze-statements") {
                return await processAnalysisJob(job);
            } else {
                throw new Error(`Unknown job type: ${job.name}`);
            }
        },
        {
            connection,
            concurrency: 2, // Process 2 jobs concurrently
            limiter: {
                max: 5, // Max 5 jobs
                duration: 1000, // Per second
            },
        }
    );

    worker.on("completed", (job) => {
        logger.info(`Job ${job.id} completed`);
    });

    worker.on("failed", (job, err) => {
        logger.error(`Job ${job.id} failed:`, err);
    });

    worker.on("error", (err) => {
        logger.error("Worker error:", err);
    });

    logger.info("Extraction worker started");

    return worker;
}

module.exports = {
    createExtractionWorker,
    processExtractionJob,
    processAnalysisJob,
};

