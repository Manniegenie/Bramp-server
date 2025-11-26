const { writeFile } = require("fs/promises");
const path = require("path");
const {
    createExtraction,
    waitForExtraction,
} = require("../extracta/client");
const { extractStatementData } = require("../extracta/processor");
const { analyzeWithOpenAI } = require("./openai");
const { logger } = require("../utils/logger");
const { validateStatementType } = require("../utils/validators");

function formatCurrency(amount, currency) {
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency || "USD",
    }).format(amount);
}

function formatTransactionSummary(transaction, currency) {
    if (!transaction) {
        return "N/A";
    }
    return `${formatCurrency(transaction.amount, currency)} (${transaction.description})`;
}

/**
 * Prints the financial analysis report to stdout and persists a JSON copy.
 *
 * @param {object} statementData - Original statement data used for the analysis.
 * @param {object} analysis - Structured analysis returned by analyzeWithOpenAI.
 * @returns {Promise<void>} Promise that resolves once the report is written to disk.
 * @throws {Error} When saving the report fails.
 */
async function generateReport(statementData, analysis) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.resolve(`financial_audit_report_${timestamp}.json`);

    // Determine reconciliation status
    const reconciliationStatus = analysis?.executiveSummary?.overallReconciliationStatus ||
        (analysis?.reconciliation?.reconciled ? "reconciled" : "unreconciled");
    const statusLabel = reconciliationStatus === "reconciled"
        ? "✓ RECONCILED"
        : reconciliationStatus === "partial"
            ? "⚠ PARTIAL"
            : "✗ UNRECONCILED";

    const report = {
        generatedAt: new Date().toISOString(),
        reportType: "Financial Audit & Reconciliation",
        status: statusLabel,
        statementData,
        analysis,
    };

    await writeFile(reportPath, JSON.stringify(report, null, 2), "utf-8");
    logger.success(`Audit report saved to: ${reportPath}`);

    return report;
}

/**
 * Primary orchestration entry point that runs Extracta.ai extraction followed by
 * OpenAI analysis, then returns results.
 *
 * @param {object} fileOrPath - Multer file object or file path string.
 * @param {string} statementType - Either "bank" or "crypto".
 * @returns {Promise<object>} Promise that resolves with the analysis report.
 * @throws {Error} When any stage of the pipeline fails.
 */
/**
 * Process a single statement (bank or crypto) and return extracted data
 * Used internally by processStatementsWithAnalysis
 */
async function processSingleStatement(fileOrPath, statementType) {
    validateStatementType(statementType);

    logger.info(`Extracting ${statementType} statement with Extracta.ai`);
    const extractionId = await createExtraction(fileOrPath, statementType);

    logger.info(`Waiting for Extracta.ai extraction (extractionId: ${extractionId})`);
    const extractionData = await waitForExtraction(extractionId);

    logger.info(`Parsing ${statementType} statement data`);
    const statementData = await extractStatementData(extractionData, extractionId, statementType);

    return statementData;
}

/**
 * Process both bank and crypto statements, then perform comprehensive reconciliation
 * 
 * @param {object} bankFile - Bank statement file (multer object or path)
 * @param {object} cryptoFile - Crypto statement file (multer object or path)
 * @returns {Promise<object>} Complete audit report with reconciliation
 */
async function processStatementsWithAnalysis(bankFile, cryptoFile) {
    logger.info("Starting financial audit and reconciliation pipeline");

    try {
        // Step 1 & 2: Extract both statements in parallel
        logger.info("Step 1: Extracting bank and crypto statements with Extracta.ai");
        const [bankStatement, cryptoStatement] = await Promise.all([
            processSingleStatement(bankFile, "bank"),
            processSingleStatement(cryptoFile, "crypto")
        ]);

        logger.info(`Step 2: Extraction complete - Bank: ${bankStatement.transactions.length} transactions, Crypto: ${cryptoStatement.transactions.length} transactions`);

        // Step 3: Perform comprehensive reconciliation analysis
        logger.info("Step 3: Performing comprehensive audit and reconciliation with OpenAI");
        const analysis = await analyzeWithOpenAI(bankStatement, cryptoStatement);

        // Step 4: Generate combined report
        logger.info("Step 4: Generating audit report");
        const report = await generateReport({ bank: bankStatement, crypto: cryptoStatement }, analysis);

        logger.success("Financial audit and reconciliation completed successfully");
        return report;
    } catch (error) {
        if (error instanceof Error) {
            logger.error(`Pipeline error: ${error.message}`);
            logger.error(`Error stack: ${error.stack}`);
        } else {
            logger.error("Unexpected error during statement processing", error);
        }
        throw error;
    }
}

/**
 * Legacy function for single statement processing (deprecated - use processStatementsWithAnalysis)
 * @deprecated Use processStatementsWithAnalysis for bank + crypto reconciliation
 */
async function processStatementWithAnalysis(fileOrPath, statementType) {
    validateStatementType(statementType);
    logger.warn("processStatementWithAnalysis is deprecated. Use processStatementsWithAnalysis for reconciliation.");

    const statementData = await processSingleStatement(fileOrPath, statementType);

    // For single statements, create a simplified analysis
    logger.info("Analyzing single statement (limited analysis without reconciliation)");
    const analysis = await analyzeWithOpenAI(statementData, { transactions: [] });

    const report = await generateReport(statementData, analysis);
    return report;
}

module.exports = {
    processStatementWithAnalysis, // Legacy - single statement
    processStatementsWithAnalysis, // New - bank + crypto reconciliation
    processSingleStatement, // Extract single statement (used by worker)
    generateReport,
};

