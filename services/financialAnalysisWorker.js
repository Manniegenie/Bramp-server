const { analyzeWithOpenAI } = require("../financial-analysis/analysis/openai");
const { generateReport } = require("../financial-analysis/analysis/analyzer");
const FinancialAnalysisJob = require("../models/FinancialAnalysisJob");
const { logger } = require("../financial-analysis/utils/logger");

// Hybrid extractor (rules + GPT-5 with validation)
const { extractWithHybridApproach } = require("../financial-analysis/extractors/hybridExtractor");
// Fallback to GPT-5 if hybrid fails
const { extractWithGPT4Vision } = require("../financial-analysis/extracta/gpt4VisionExtractor");
const { extractStatementData } = require("../financial-analysis/extracta/processor");

// Extracta.ai code commented out (will add back later when credits available)
// const { createExtractionWithFile, waitForExtraction } = require("../financial-analysis/extracta/client");

/**
 * Extract statements in PARALLEL - FAST
 */
async function extractStatements(jobId) {
    let job = await FinancialAnalysisJob.findOne({ jobId });
    if (!job) throw new Error(`Job not found: ${jobId}`);

    try {
        job.status = 'extracting';
        job.extractionStatus = 'processing';
        job.bankStatement.status = 'processing';
        job.cryptoStatement.status = 'processing';
        await job.save();

        const bankFile = {
            buffer: job.bankStatement.fileBuffer,
            originalname: job.bankStatement.fileName,
            mimetype: 'application/pdf'
        };

        const cryptoFile = {
            buffer: job.cryptoStatement.fileBuffer,
            originalname: job.cryptoStatement.fileName,
            mimetype: 'application/pdf'
        };

        // STEP 1: Extract statements using Hybrid Approach (rules + GPT-5) in PARALLEL
        logger.info(`[Worker] Extracting statements using hybrid approach with GPT-5 in parallel for job ${jobId}`);

        // Hybrid extraction with fallback to GPT-4 Vision
        let bankData, cryptoData;
        const extractionTimeout = 180000; // 3 minutes per extraction

        try {
            logger.info(`[Worker] Starting parallel extraction: Bank (${bankFile.originalname}), Crypto (${cryptoFile.originalname})`);

            // Create timeout promises
            const createTimeoutPromise = (timeoutMs) => {
                return new Promise((_, reject) => {
                    setTimeout(() => reject(new Error(`Extraction timed out after ${timeoutMs / 1000}s`)), timeoutMs);
                });
            };

            // Extract with timeout and fallback
            const extractWithTimeoutAndFallback = async (fileBuffer, fileName, statementType) => {
                try {
                    // Try hybrid approach first
                    logger.info(`[Worker] Attempting hybrid extraction for ${statementType}...`);
                    return await Promise.race([
                        extractWithHybridApproach(fileBuffer, fileName, statementType),
                        createTimeoutPromise(extractionTimeout)
                    ]);
                } catch (error) {
                    logger.warn(`[Worker] Hybrid extraction failed for ${statementType}, falling back to GPT-5:`, error.message);
                    // Fallback to GPT-5
                    try {
                        return await Promise.race([
                            extractWithGPT4Vision({ buffer: fileBuffer, originalname: fileName, mimetype: "application/pdf" }, statementType),
                            createTimeoutPromise(extractionTimeout)
                        ]);
                    } catch (fallbackError) {
                        logger.error(`[Worker] GPT-5 fallback also failed for ${statementType}:`, fallbackError);
                        throw new Error(`${statementType} extraction failed: ${fallbackError.message}`);
                    }
                }
            };

            // Extract both statements in parallel
            [bankData, cryptoData] = await Promise.all([
                extractWithTimeoutAndFallback(bankFile.buffer, bankFile.originalname, "bank").catch(err => {
                    logger.error(`[Worker] Bank extraction failed:`, err);
                    throw err;
                }),
                extractWithTimeoutAndFallback(cryptoFile.buffer, cryptoFile.originalname, "crypto").catch(err => {
                    logger.error(`[Worker] Crypto extraction failed:`, err);
                    throw err;
                })
            ]);

            logger.info(`[Worker] Both extractions completed successfully`);
            logger.info(`[Worker] Bank confidence: ${bankData.confidenceScore || 'N/A'}%, Crypto confidence: ${cryptoData.confidenceScore || 'N/A'}%`);
        } catch (error) {
            logger.error(`[Worker] Extraction error:`, error);
            throw error;
        }

        // Store extraction IDs (using hybrid as identifier)
        job.bankStatement.extractionId = `hybrid-${Date.now()}-bank`;
        job.cryptoStatement.extractionId = `hybrid-${Date.now()}-crypto`;
        await job.save();

        logger.info(`[Worker] Both extractions completed: Bank (${bankData.transactions?.length || 0} transactions), Crypto (${cryptoData.transactions?.length || 0} transactions)`);

        // STEP 2: Process extracted data (GPT-5 returns data in similar format to Extracta.ai)
        logger.info(`[Worker] Processing extracted data...`);
        const [bankStatement, cryptoStatement] = await Promise.all([
            extractStatementData(bankData, job.bankStatement.extractionId, "bank"),
            extractStatementData(cryptoData, job.cryptoStatement.extractionId, "crypto")
        ]);

        // Extracta.ai code commented out (will add back later when credits available)
        /*
        // STEP 1: Create extractions and upload files in PARALLEL - FAST
        logger.info(`[Worker] Creating extractions and uploading files in parallel for job ${jobId}`);
        const [bankExtractionId, cryptoExtractionId] = await Promise.all([
            createExtractionWithFile(bankFile, "bank"),
            createExtractionWithFile(cryptoFile, "crypto")
        ]);

        job.bankStatement.extractionId = bankExtractionId;
        job.cryptoStatement.extractionId = cryptoExtractionId;
        await job.save();

        logger.info(`[Worker] Both extractions created: Bank ${bankExtractionId}, Crypto ${cryptoExtractionId}`);

        // STEP 2: Poll both in PARALLEL - FAST (1s intervals, 10min timeout)
        logger.info(`[Worker] Polling Extracta.ai in parallel...`);
        const [bankData, cryptoData] = await Promise.all([
            waitForExtraction(bankExtractionId, 600000), // 10 min max
            waitForExtraction(cryptoExtractionId, 600000)
        ]);

        // STEP 3: Process both results in PARALLEL - FAST
        logger.info(`[Worker] Processing extracted data in parallel...`);
        const [bankStatement, cryptoStatement] = await Promise.all([
            extractStatementData(bankData, bankExtractionId, "bank"),
            extractStatementData(cryptoData, cryptoExtractionId, "crypto")
        ]);
        */

        // STEP 4: Update job - single save
        job.bankStatement.status = 'completed';
        job.bankStatement.extractedData = bankStatement;
        job.bankStatement.processedAt = new Date();
        job.cryptoStatement.status = 'completed';
        job.cryptoStatement.extractedData = cryptoStatement;
        job.cryptoStatement.processedAt = new Date();
        job.extractionStatus = 'completed';
        job.status = 'extracted';
        await job.save();

        logger.info(`[Worker] Extraction complete: Bank (${bankStatement.transactions?.length || 0}), Crypto (${cryptoStatement.transactions?.length || 0})`);

        // STEP 5: Automatically start analysis after extraction completes
        logger.info(`[Worker] Starting analysis automatically for job ${jobId}...`);

        // Start analysis with error handling
        analyzeStatements(jobId).catch(err => {
            logger.error(`[Worker] Auto-analysis failed for job ${jobId}:`, err);
            // Update job status if analysis fails
            FinancialAnalysisJob.findOne({ jobId }).then(job => {
                if (job) {
                    job.analysisStatus = 'failed';
                    job.status = 'failed';
                    job.error = `Analysis failed: ${err.message}`;
                    return job.save();
                }
            }).catch(saveErr => {
                logger.error(`[Worker] Error saving analysis failure:`, saveErr);
            });
        });

    } catch (error) {
        logger.error(`[Worker] Extraction failed:`, error);

        // Ensure we have the latest job state
        try {
            job = await FinancialAnalysisJob.findOne({ jobId });
            if (job) {
                job.extractionStatus = 'failed';
                job.status = 'failed';
                job.error = error.message || 'Unknown error occurred during extraction';
                if (job.bankStatement.status === 'processing') {
                    job.bankStatement.status = 'failed';
                    job.bankStatement.error = error.message;
                }
                if (job.cryptoStatement.status === 'processing') {
                    job.cryptoStatement.status = 'failed';
                    job.cryptoStatement.error = error.message;
                }
                await job.save();
                logger.info(`[Worker] Job ${jobId} marked as failed`);
            } else {
                logger.error(`[Worker] Job ${jobId} not found when trying to mark as failed`);
            }
        } catch (saveError) {
            logger.error(`[Worker] Error saving job failure status:`, saveError);
        }

        // Don't throw - let the error be handled by the caller
        // This prevents unhandled promise rejections
        return { success: false, error: error.message };
    }
}

/**
 * Analyze extracted statements with GPT - FAST
 */
async function analyzeStatements(jobId) {
    const job = await FinancialAnalysisJob.findOne({ jobId });
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (!job.bankStatement.extractedData || !job.cryptoStatement.extractedData) {
        throw new Error("Both statements must be extracted");
    }

    try {
        job.status = 'analyzing';
        job.analysisStatus = 'processing';
        await job.save();

        const analysis = await analyzeWithOpenAI(
            job.bankStatement.extractedData,
            job.cryptoStatement.extractedData
        );

        job.status = 'completed';
        job.analysisStatus = 'completed';
        job.report = {
            bank: job.bankStatement.extractedData,
            crypto: job.cryptoStatement.extractedData,
            combined: analysis
        };
        job.completedAt = new Date();
        await job.save();

        // Display full report in terminal
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
                analysis.reconciliation.discrepancies.forEach((disc, idx) => {
                    logger.info(`  ${idx + 1}. [${disc.type}] ${disc.description}`);
                    logger.info(`     Amount: ${disc.amount} ${disc.currency} | Severity: ${disc.severity || 'N/A'}`);
                    if (disc.recommendedAction) {
                        logger.info(`     Recommendation: ${disc.recommendedAction}`);
                    }
                });
            }
            logger.info('');
        }

        // Missing Funds
        if (analysis.missingFunds && analysis.missingFunds.totalMissing > 0) {
            logger.info('💰 MISSING FUNDS');
            logger.info(`${'-'.repeat(80)}`);
            logger.info(`Total Missing: ${analysis.missingFunds.totalMissing} ${analysis.missingFunds.currency || 'NGN'}`);
            if (analysis.missingFunds.breakdown && analysis.missingFunds.breakdown.length > 0) {
                logger.info(`\nBreakdown:`);
                analysis.missingFunds.breakdown.forEach((item, idx) => {
                    logger.info(`  ${idx + 1}. Period: ${item.period}`);
                    logger.info(`     Amount: ${item.amount} | Traceability: ${item.traceability || 'N/A'}`);
                    logger.info(`     Description: ${item.description || 'N/A'}`);
                    if (item.possibleCauses && item.possibleCauses.length > 0) {
                        logger.info(`     Possible Causes: ${item.possibleCauses.join(', ')}`);
                    }
                });
            }
            if (analysis.missingFunds.recommendations && analysis.missingFunds.recommendations.length > 0) {
                logger.info(`\nRecommendations:`);
                analysis.missingFunds.recommendations.forEach((rec, idx) => {
                    logger.info(`  ${idx + 1}. ${rec}`);
                });
            }
            logger.info('');
        }

        // Financial Analysis
        if (analysis.financialAnalysis) {
            logger.info('💵 FINANCIAL ANALYSIS');
            logger.info(`${'-'.repeat(80)}`);
            if (analysis.financialAnalysis.totalBankActivity) {
                logger.info(`Bank Activity:`);
                logger.info(`  Credits: ${analysis.financialAnalysis.totalBankActivity.credits || 0} ${analysis.financialAnalysis.totalBankActivity.currency || 'NGN'}`);
                logger.info(`  Debits: ${analysis.financialAnalysis.totalBankActivity.debits || 0} ${analysis.financialAnalysis.totalBankActivity.currency || 'NGN'}`);
                logger.info(`  Net Flow: ${analysis.financialAnalysis.totalBankActivity.netFlow || 0} ${analysis.financialAnalysis.totalBankActivity.currency || 'NGN'}`);
            }
            if (analysis.financialAnalysis.totalCryptoActivity) {
                logger.info(`Crypto Activity:`);
                logger.info(`  Purchases: ${analysis.financialAnalysis.totalCryptoActivity.purchases || 0} ${analysis.financialAnalysis.totalCryptoActivity.currency || 'USD'}`);
                logger.info(`  Sales: ${analysis.financialAnalysis.totalCryptoActivity.sales || 0} ${analysis.financialAnalysis.totalCryptoActivity.currency || 'USD'}`);
                logger.info(`  Transfers: ${analysis.financialAnalysis.totalCryptoActivity.transfers || 0}`);
                logger.info(`  Fees: ${analysis.financialAnalysis.totalCryptoActivity.fees || 0} ${analysis.financialAnalysis.totalCryptoActivity.currency || 'USD'}`);
                logger.info(`  Net Value: ${analysis.financialAnalysis.totalCryptoActivity.netValue || 0} ${analysis.financialAnalysis.totalCryptoActivity.currency || 'USD'}`);
            }
            if (analysis.financialAnalysis.profitLoss) {
                logger.info(`Profit/Loss:`);
                logger.info(`  Realized Gains: ${analysis.financialAnalysis.profitLoss.realizedGains || 0} ${analysis.financialAnalysis.profitLoss.currency || 'USD'}`);
                logger.info(`  Realized Losses: ${analysis.financialAnalysis.profitLoss.realizedLosses || 0} ${analysis.financialAnalysis.profitLoss.currency || 'USD'}`);
                logger.info(`  Net P/L: ${analysis.financialAnalysis.profitLoss.netProfitLoss || 0} ${analysis.financialAnalysis.profitLoss.currency || 'USD'}`);
                if (analysis.financialAnalysis.profitLoss.ngnEquivalent) {
                    logger.info(`  NGN Equivalent: ${analysis.financialAnalysis.profitLoss.ngnEquivalent} NGN`);
                }
                if (analysis.financialAnalysis.profitLoss.taxImplications) {
                    logger.info(`  Tax Implications: ${analysis.financialAnalysis.profitLoss.taxImplications}`);
                }
            }
            logger.info('');
        }

        // Compliance
        if (analysis.compliance) {
            logger.info('⚖️  COMPLIANCE');
            logger.info(`${'-'.repeat(80)}`);
            logger.info(`Status: ${analysis.compliance.complianceStatus || 'N/A'}`);
            logger.info(`CBN Reporting Required: ${analysis.compliance.cbnReportingRequired ? 'Yes' : 'No'}`);
            if (analysis.compliance.taxObligations && analysis.compliance.taxObligations.length > 0) {
                logger.info(`\nTax Obligations:`);
                analysis.compliance.taxObligations.forEach((obligation, idx) => {
                    logger.info(`  ${idx + 1}. ${obligation}`);
                });
            }
            if (analysis.compliance.regulatoryFlags && analysis.compliance.regulatoryFlags.length > 0) {
                logger.info(`\nRegulatory Flags:`);
                analysis.compliance.regulatoryFlags.forEach((flag, idx) => {
                    logger.info(`  ${idx + 1}. ${flag}`);
                });
            }
            logger.info('');
        }

        // Risk Assessment
        if (analysis.riskAssessment) {
            logger.info('⚠️  RISK ASSESSMENT');
            logger.info(`${'-'.repeat(80)}`);
            logger.info(`Overall Risk Level: ${analysis.riskAssessment.overallRiskLevel || 'N/A'}`);
            if (analysis.riskAssessment.suspiciousTransactions && analysis.riskAssessment.suspiciousTransactions.length > 0) {
                logger.info(`\nSuspicious Transactions (${analysis.riskAssessment.suspiciousTransactions.length}):`);
                analysis.riskAssessment.suspiciousTransactions.forEach((tx, idx) => {
                    logger.info(`  ${idx + 1}. [${tx.type}] ${tx.description}`);
                    logger.info(`     Date: ${tx.date || 'N/A'} | Amount: ${tx.amount} | Risk Level: ${tx.riskLevel || 'N/A'}`);
                    if (tx.recommendation) {
                        logger.info(`     Recommendation: ${tx.recommendation}`);
                    }
                });
            }
            if (analysis.riskAssessment.anomalies && analysis.riskAssessment.anomalies.length > 0) {
                logger.info(`\nAnomalies:`);
                analysis.riskAssessment.anomalies.forEach((anomaly, idx) => {
                    logger.info(`  ${idx + 1}. ${anomaly}`);
                });
            }
            if (analysis.riskAssessment.patterns && analysis.riskAssessment.patterns.length > 0) {
                logger.info(`\nPatterns:`);
                analysis.riskAssessment.patterns.forEach((pattern, idx) => {
                    logger.info(`  ${idx + 1}. ${pattern}`);
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
                analysis.auditReport.keyFindings.forEach((finding, idx) => {
                    logger.info(`  ${idx + 1}. ${finding}`);
                });
            }
            if (analysis.auditReport.recommendations && analysis.auditReport.recommendations.length > 0) {
                logger.info(`\nRecommendations:`);
                analysis.auditReport.recommendations.forEach((rec, idx) => {
                    logger.info(`  ${idx + 1}. ${rec}`);
                });
            }
            if (analysis.auditReport.nextSteps && analysis.auditReport.nextSteps.length > 0) {
                logger.info(`\nNext Steps:`);
                analysis.auditReport.nextSteps.forEach((step, idx) => {
                    logger.info(`  ${idx + 1}. ${step}`);
                });
            }
            if (analysis.auditReport.auditorNotes) {
                logger.info(`\nAuditor Notes: ${analysis.auditReport.auditorNotes}`);
            }
            logger.info('');
        }

        logger.info(`${'='.repeat(80)}`);
        logger.info(`[Worker] Report ready for frontend. Job ID: ${jobId}`);
        logger.info(`${'='.repeat(80)}\n`);
    } catch (error) {
        logger.error(`[Worker] Analysis failed:`, error);

        try {
            // Ensure we have the latest job state
            const jobRecord = await FinancialAnalysisJob.findOne({ jobId });
            if (jobRecord) {
                jobRecord.analysisStatus = 'failed';
                jobRecord.status = 'failed';
                jobRecord.error = error.message || 'Unknown error occurred during analysis';
                await jobRecord.save();
                logger.info(`[Worker] Job ${jobId} analysis marked as failed`);
            } else {
                logger.error(`[Worker] Job ${jobId} not found when trying to mark analysis as failed`);
            }
        } catch (saveError) {
            logger.error(`[Worker] Error saving analysis failure status:`, saveError);
        }

        // Don't throw - let the error be handled by the caller
        return { success: false, error: error.message };
    }
}

/**
 * Process extraction with comprehensive error handling
 */
async function processExtraction(jobId) {
    try {
        await extractStatements(jobId);
    } catch (error) {
        logger.error(`[Worker] processExtraction failed for job ${jobId}:`, error);
        // Error already handled in extractStatements
    }
}

/**
 * Process analysis with comprehensive error handling
 */
async function processAnalysis(jobId) {
    try {
        await analyzeStatements(jobId);
    } catch (error) {
        logger.error(`[Worker] processAnalysis failed for job ${jobId}:`, error);
        // Error already handled in analyzeStatements
    }
}

module.exports = {
    processExtraction,
    processAnalysis,
    extractStatements,
    analyzeStatements
};
