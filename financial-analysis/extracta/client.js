/**
 * EXTRACTA.AI CLIENT - COMMENTED OUT TEMPORARILY
 * 
 * This file contains the Extracta.ai integration code.
 * Currently commented out due to insufficient credits.
 * Will be re-enabled when Extracta.ai credits are available.
 * 
 * For now, using GPT-4 Vision extractor (gpt4VisionExtractor.js) instead.
 */

const axios = require("axios");
const FormData = require("form-data");
const { logger } = require("../utils/logger");

const EXTRACTA_BASE_URL = process.env.EXTRACTA_BASE_URL || "https://api.extracta.ai/api/v1";

function requireEnv(key) {
    const value = process.env[key];
    if (!value) throw new Error(`Missing: ${key}`);
    return value;
}

function getExtractaClient() {
    return axios.create({
        baseURL: EXTRACTA_BASE_URL,
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${requireEnv("EXTRACTA_API_KEY")}`,
        },
        timeout: 300000,
    });
}

function formatExtractaError(error) {
    if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const data = error.response?.data;
        const message = data?.message || data?.error || error.message || "Extracta.ai error";

        // Check for credit errors
        if (message.toLowerCase().includes('credit') || message.toLowerCase().includes('not enough')) {
            return `Extracta.ai account has insufficient credits. Please add credits to your Extracta.ai account to process statements.`;
        }

        if (status === 401) return "Extracta.ai authentication failed. Check your API key.";
        if (status === 403) return "Extracta.ai access forbidden. Check your API permissions.";
        if (status === 404) return "Extracta.ai resource not found.";
        if (status === 429) return "Extracta.ai rate limit exceeded. Please try again later.";
        if (status >= 500) return "Extracta.ai server error. Please try again later.";
        return message;
    }
    return error.message || "Unknown error";
}

/**
 * Creates extraction template (NO FILE) - Step 1
 */
async function createExtraction(statementType) {
    const webhookUrl = process.env.EXTRACTA_WEBHOOK_URL || `${process.env.SERVER_URL || process.env.CLIENT_URL || 'https://priscaai.online'}/financial-analysis/extracta-webhook`;

    const extractionDetails = statementType === "bank" ? {
        name: `Bank-Statement-${Date.now()}`,
        language: "English",
        webhookUrl: webhookUrl,
        fields: [
            { key: "account_number", example: "0477996326" },
            { key: "account_name", example: "NWOGBO CHIBUIKE EMMANUEL" },
            { key: "bank_name" },
            { key: "branch_name", example: "E-BRANCH - NAU" },
            { key: "account_type", example: "GTCrea8 eSavers" },
            { key: "internal_reference", example: "R034229695" },
            { key: "statement_period_start", example: "01-Oct-2025" },
            { key: "statement_period_end", example: "31-Oct-2025" },
            { key: "opening_balance", example: "91400.94" },
            { key: "closing_balance" },
            { key: "currency", example: "NIGERIAN NAIRA" },
            { key: "transactions", description: "Transactions with date, value_date, reference, debits, credits, balance, branch, remarks" }
        ]
    } : {
        name: `Crypto-Statement-${Date.now()}`,
        language: "English",
        webhookUrl: webhookUrl,
        fields: [
            { key: "report_date", example: "2025/11/12" },
            { key: "report_period_start", example: "March 01, 2025" },
            { key: "report_period_end", example: "November 10, 2025" },
            { key: "entity_name", example: "Chibuike Nwogbo" },
            { key: "account_id", example: "557660651" },
            { key: "account_type", example: "Master Account" },
            { key: "account_manager" },
            { key: "account_email", example: "manuelwurld@gmail.com" },
            { key: "opening_total_account_value", example: "1.07 USD" },
            { key: "change_value", example: "-1.03 USD" },
            { key: "total_account_value", example: "0.04 USD" },
            { key: "transactions", description: "All crypto transactions with date, type, amount, asset_symbol, price, fee, description" }
        ]
    };

    try {
        const response = await axios.post(`${EXTRACTA_BASE_URL}/createExtraction`, { extractionDetails }, {
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${requireEnv("EXTRACTA_API_KEY")}`,
            },
            timeout: 300000,
        });

        const extractionId = response.data?.extraction_id || response.data?.extractionId || response.data?.id || response.data?.data?.extraction_id || response.data?.data?.id;
        if (!extractionId) throw new Error("No extraction ID: " + JSON.stringify(response.data));

        logger.info(`Extraction created: ${extractionId}`);
        return extractionId;
    } catch (error) {
        throw new Error(formatExtractaError(error));
    }
}

/**
 * Upload files to extraction - Step 2 (creates batches)
 */
async function uploadFiles(extractionId, fileOrPath) {
    const fileName = typeof fileOrPath === "object" ? fileOrPath.originalname || "statement.pdf" : require("path").basename(fileOrPath);
    const fileBuffer = typeof fileOrPath === "object" && fileOrPath.buffer ? fileOrPath.buffer : require("fs").readFileSync(fileOrPath);
    const fileMimeType = typeof fileOrPath === "object" && fileOrPath.mimetype ? fileOrPath.mimetype : 'application/pdf';

    try {
        // Use FormData for multipart/form-data upload
        const formData = new FormData();
        formData.append('extractionId', extractionId);

        // Try 'files' field (plural for multiple files, but works for single file too)
        formData.append('files', fileBuffer, {
            filename: fileName,
            contentType: fileMimeType
        });

        logger.info(`Uploading file ${fileName} to extraction ${extractionId}...`);

        const response = await axios.post(`${EXTRACTA_BASE_URL}/uploadFiles`, formData, {
            headers: {
                ...formData.getHeaders(),
                Authorization: `Bearer ${requireEnv("EXTRACTA_API_KEY")}`,
            },
            timeout: 300000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        const uploadResponse = response.data;
        logger.info(`Files uploaded successfully. Response:`, JSON.stringify(uploadResponse, null, 2).substring(0, 500));

        // Check for credit errors in response
        if (uploadResponse?.status === 'error' && uploadResponse?.message?.toLowerCase().includes('credit')) {
            throw new Error(`Extracta.ai account has insufficient credits. Please add credits to your Extracta.ai account.`);
        }

        return uploadResponse;
    } catch (error) {
        const errorMessage = error.response?.data?.message || error.message;

        // Check for credit errors
        if (errorMessage?.toLowerCase().includes('credit') || errorMessage?.toLowerCase().includes('not enough')) {
            logger.error(`Extracta.ai credit error:`, errorMessage);
            throw new Error(`Extracta.ai account has insufficient credits. Please add credits to your Extracta.ai account to process statements.`);
        }

        logger.error(`Error uploading files:`, {
            status: error.response?.status,
            statusText: error.response?.statusText,
            data: error.response?.data,
            message: error.message
        });
        throw new Error(formatExtractaError(error));
    }
}

/**
 * Create extraction and upload file - Combined workflow
 */
async function createExtractionWithFile(fileOrPath, statementType) {
    // Step 1: Create extraction template
    const extractionId = await createExtraction(statementType);

    // Step 2: Upload file (creates batch)
    await uploadFiles(extractionId, fileOrPath);

    // Step 3: Brief wait for batch creation (Extracta.ai needs a moment to create batch)
    await new Promise(resolve => setTimeout(resolve, 2000));

    logger.info(`Extraction ${extractionId} created and file uploaded - batch should be created`);
    return extractionId;
}

/**
 * Get batch results from Extracta.ai
 */
async function getBatchResults(extractionId, batchId) {
    const client = getExtractaClient();
    try {
        const response = await client.post('/getBatchResults', {
            extractionId: extractionId,
            batchId: batchId
        });
        return response.data;
    } catch (error) {
        logger.error(`Error getting batch results:`, error);
        throw new Error(formatExtractaError(error));
    }
}

/**
 * Polls Extracta.ai - Checks batches and gets results when complete
 */
async function waitForExtraction(extractionId, maxWaitMs = 600000) {
    const client = getExtractaClient();
    const start = Date.now();
    let pollCount = 0;
    let lastResponse = null;

    while (Date.now() - start < maxWaitMs) {
        try {
            const response = await client.post('/viewExtraction', { extractionId });
            const data = response.data;
            lastResponse = data;

            // Extracta.ai response structure:
            // {
            //   "extractionId": "...",
            //   "extractionDetails": {
            //     "status": "has batches",
            //     "batches": {
            //       "batchId": {
            //         "status": "finished",
            //         "filesNo": 1,
            //         "origin": "api"
            //       }
            //     }
            //   }
            // }

            const extractionDetails = data?.extractionDetails || data?.extraction || data;
            const batches = extractionDetails?.batches || {};
            const batchStatus = extractionDetails?.status || extractionDetails?.extraction_status || "processing";

            // Log every 30 polls (~30 seconds) OR on first few polls for debugging
            if (pollCount < 3 || pollCount % 30 === 0) {
                const elapsed = Math.round((Date.now() - start) / 1000);
                logger.info(`Status: ${batchStatus} (${elapsed}s) - Batches: ${Object.keys(batches).length}`);

                // Log full response structure on first 3 polls
                if (pollCount < 3) {
                    logger.info(`Extracta.ai response (poll ${pollCount + 1}):`, JSON.stringify(data, null, 2).substring(0, 1500));
                }

                // Log batch statuses
                if (Object.keys(batches).length > 0) {
                    for (const [batchId, batch] of Object.entries(batches)) {
                        logger.info(`  Batch ${batchId}: ${batch.status || 'unknown'} (${batch.filesNo || 0} files)`);
                    }
                } else if (pollCount < 5) {
                    logger.info(`  No batches yet - waiting for batch creation...`);
                }
            }

            // Check if we have batches with finished status
            const batchIds = Object.keys(batches);
            if (batchIds.length > 0) {
                // Find finished batches
                const finishedBatches = batchIds.filter(batchId => {
                    const batch = batches[batchId];
                    return batch.status === "finished" || batch.status === "completed" || batch.status === "done";
                });

                if (finishedBatches.length > 0) {
                    // Get results from first finished batch
                    const batchId = finishedBatches[0];
                    logger.info(`✅ Batch ${batchId} finished - fetching results...`);

                    try {
                        const batchResults = await getBatchResults(extractionId, batchId);
                        const elapsed = Math.round((Date.now() - start) / 1000);
                        logger.info(`✅ Extraction complete: ${extractionId} (${elapsed}s)`);

                        // Extracta.ai returns results in batchResults.result or batchResults.data
                        const result = batchResults?.result || batchResults?.data || batchResults?.results || batchResults;

                        // If result is an array, get first item (single file)
                        if (Array.isArray(result) && result.length > 0) {
                            return result[0];
                        }

                        return result;
                    } catch (batchError) {
                        logger.error(`Error fetching batch results:`, batchError);
                        // Continue polling if batch results fail
                    }
                }

                // Check for failed batches
                const failedBatches = batchIds.filter(batchId => {
                    const batch = batches[batchId];
                    return batch.status === "failed" || batch.status === "error";
                });

                if (failedBatches.length > 0) {
                    throw new Error(`Batch ${failedBatches[0]} failed: ${batches[failedBatches[0]].error || "Unknown error"}`);
                }
            }

            // Also check for direct status (fallback for non-batch mode)
            const status = data?.status || batchStatus;
            const statusLower = String(status).toLowerCase();

            if (statusLower === "completed" || statusLower === "success" || statusLower === "done" || statusLower === "processed") {
                // Try to get results from data directly
                const result = data?.result || data?.data || data?.extraction_data || data;
                if (result && typeof result === 'object' && (result.account_number || result.transactions || result.report_date || result.entity_name)) {
                    const elapsed = Math.round((Date.now() - start) / 1000);
                    logger.info(`✅ Extraction complete: ${extractionId} (${elapsed}s)`);
                    return result;
                }
            }

            pollCount++;
            await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
            if (axios.isAxiosError(error) && error.response?.status === 404 && Date.now() - start < 15000) {
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue;
            }
            throw new Error(formatExtractaError(error));
        }
    }

    // Log last response before timeout
    logger.error(`Timeout after ${Math.round(maxWaitMs / 1000)}s. Last response:`, JSON.stringify(lastResponse, null, 2).substring(0, 2000));
    throw new Error(`Extraction timeout after ${Math.round(maxWaitMs / 1000)}s`);
}

module.exports = {
    createExtraction,
    uploadFiles,
    createExtractionWithFile,  // Combined workflow
    waitForExtraction,
    getBatchResults
};
