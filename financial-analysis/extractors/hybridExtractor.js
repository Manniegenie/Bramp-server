const { extractWithGPT4Vision } = require("../extracta/gpt4VisionExtractor");
const { logger } = require("../utils/logger");
const pdf = require("pdf-parse");

/**
 * Extract tables from PDF using text patterns
 * This is a simple rule-based table extractor for Nigerian bank statements
 */
function extractTablesFromText(text, statementType) {
    const transactions = [];
    const lines = text.split("\n").map(line => line.trim()).filter(line => line.length > 0);

    if (statementType === "bank") {
        // Pattern for Nigerian bank statements
        // Date | Value Date | Reference | Debits | Credits | Balance | Remarks
        const datePattern = /\d{2}-[A-Z]{3}-\d{4}/;
        const amountPattern = /[\d,]+\.\d{2}/;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (datePattern.test(line) && amountPattern.test(line)) {
                // Try to parse transaction
                const parts = line.split(/\s+/);
                const dateMatch = line.match(datePattern);
                const amountMatches = line.match(new RegExp(amountPattern, "g"));

                if (dateMatch && amountMatches && amountMatches.length >= 2) {
                    transactions.push({
                        date: dateMatch[0],
                        amount: parseFloat(amountMatches[amountMatches.length - 1].replace(/,/g, "")),
                        balance: parseFloat(amountMatches[amountMatches.length - 1].replace(/,/g, "")),
                        description: parts.slice(3, -2).join(" "),
                    });
                }
            }
        }
    }

    return transactions;
}

/**
 * Validate extracted data
 */
function validateExtractedData(data, statementType) {
    const errors = [];
    const warnings = [];

    if (statementType === "bank") {
        if (!data.account_number || data.account_number.length !== 10) {
            errors.push("Invalid account number");
        }
        if (!data.account_name) {
            errors.push("Missing account name");
        }
        if (!data.bank_name) {
            warnings.push("Missing bank name");
        }
        if (!data.transactions || !Array.isArray(data.transactions)) {
            errors.push("Invalid transactions array");
        } else {
            data.transactions.forEach((tx, idx) => {
                if (!tx.date) warnings.push(`Transaction ${idx}: Missing date`);
                if (!tx.amount && tx.amount !== 0) warnings.push(`Transaction ${idx}: Missing amount`);
                if (!tx.description) warnings.push(`Transaction ${idx}: Missing description`);
            });
        }
    } else if (statementType === "crypto") {
        if (!data.account_id) {
            errors.push("Missing account ID");
        }
        if (!data.transactions || !Array.isArray(data.transactions)) {
            errors.push("Invalid transactions array");
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        warnings,
    };
}

/**
 * Hybrid extraction: Combine GPT-4 Vision with rule-based extraction
 */
async function extractWithHybridApproach(fileBuffer, fileName, statementType) {
    const startTime = Date.now();
    logger.info(`[Hybrid] Starting hybrid extraction for ${statementType} statement: ${fileName}`);

    try {
        // Step 1: Extract text from PDF
        const pdfData = await pdf(fileBuffer);
        const pdfText = pdfData.text;

        // Step 2: Rule-based table extraction (fast, but may miss some data)
        logger.info(`[Hybrid] Step 1: Rule-based table extraction...`);
        const ruleBasedTransactions = extractTablesFromText(pdfText, statementType);
        logger.info(`[Hybrid] Rule-based extraction found ${ruleBasedTransactions.length} transactions`);

        // Step 3: GPT-5 Mini extraction (slower, but more accurate)
        logger.info(`[Hybrid] Step 2: GPT-5 Mini extraction...`);
        let gptData;
        try {
            gptData = await extractWithGPT4Vision(
                { buffer: fileBuffer, originalname: fileName, mimetype: "application/pdf" },
                statementType
            );
            logger.info(`[Hybrid] GPT-5 Mini extraction found ${gptData.transactions?.length || 0} transactions`);
        } catch (error) {
            logger.error(`[Hybrid] GPT-5 Mini extraction failed:`, error);
            // Fallback to rule-based if GPT-5 Mini fails
            if (ruleBasedTransactions.length > 0) {
                logger.warn(`[Hybrid] Falling back to rule-based extraction`);
                gptData = {
                    transactions: ruleBasedTransactions,
                    account_number: "",
                    account_name: "",
                    bank_name: "",
                };
            } else {
                throw error;
            }
        }

        // Step 4: Merge results (prefer GPT-5 Mini, supplement with rule-based)
        logger.info(`[Hybrid] Step 3: Merging extraction results...`);
        const mergedData = {
            ...gptData,
            transactions: gptData.transactions || [],
        };

        // Add rule-based transactions that weren't found by GPT-5 Mini
        if (ruleBasedTransactions.length > 0 && mergedData.transactions.length > 0) {
            const gptDates = new Set(mergedData.transactions.map(tx => tx.date));
            ruleBasedTransactions.forEach(ruleTx => {
                if (!gptDates.has(ruleTx.date)) {
                    mergedData.transactions.push(ruleTx);
                }
            });
        } else if (mergedData.transactions.length === 0 && ruleBasedTransactions.length > 0) {
            mergedData.transactions = ruleBasedTransactions;
        }

        // Step 5: Validate extracted data
        logger.info(`[Hybrid] Step 4: Validating extracted data...`);
        const validation = validateExtractedData(mergedData, statementType);

        if (!validation.valid) {
            logger.error(`[Hybrid] Validation failed:`, validation.errors);
            // Don't throw, but log warnings
        }

        if (validation.warnings.length > 0) {
            logger.warn(`[Hybrid] Validation warnings:`, validation.warnings);
        }

        // Step 6: Calculate confidence score
        const confidenceScore = calculateConfidenceScore(mergedData, validation, ruleBasedTransactions.length, gptData.transactions?.length || 0);
        mergedData.confidenceScore = confidenceScore;

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info(`[Hybrid] Hybrid extraction completed in ${elapsed}s with confidence ${confidenceScore}%`);
        logger.info(`[Hybrid] Final result: ${mergedData.transactions.length} transactions`);

        return mergedData;
    } catch (error) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.error(`[Hybrid] Hybrid extraction failed after ${elapsed}s:`, error);
        throw error;
    }
}

/**
 * Calculate confidence score based on validation and extraction results
 */
function calculateConfidenceScore(data, validation, ruleBasedCount, gptCount) {
    let score = 100;

    // Deduct for validation errors
    score -= validation.errors.length * 10;
    score -= validation.warnings.length * 2;

    // Deduct if transactions are missing
    if (!data.transactions || data.transactions.length === 0) {
        score -= 50;
    }

    // Boost if both methods found similar number of transactions
    if (ruleBasedCount > 0 && gptCount > 0) {
        const difference = Math.abs(ruleBasedCount - gptCount);
        const avgCount = (ruleBasedCount + gptCount) / 2;
        if (avgCount > 0) {
            const similarity = 1 - (difference / avgCount);
            score += similarity * 10;
        }
    }

    return Math.max(0, Math.min(100, Math.round(score)));
}

module.exports = {
    extractWithHybridApproach,
    validateExtractedData,
    calculateConfidenceScore,
};

