const OpenAI = require("openai");
const pdf = require("pdf-parse");
const { requireEnv } = require("../utils/validators");
const { logger } = require("../utils/logger");

// Use GPT-5 Mini for extraction (balanced accuracy and efficiency)
const DEFAULT_MODEL = process.env.OPENAI_MODEL_PRIMARY || process.env.EXTRACTION_MODEL || 'gpt-5-mini';
const API_TIMEOUT = 120000; // 120 seconds
const MAX_PDF_CHARS = 15000; // Tuned for GPT-5 Mini's context handling
const MAX_TOKENS = 8000; // Tuned for GPT-5 Mini's response quality

/**
 * Extract text from PDF buffer
 */
async function extractTextFromPDF(pdfBuffer) {
    try {
        const sizeKB = (pdfBuffer.length / 1024).toFixed(2);
        logger.info(`Extracting text from PDF (size: ${sizeKB} KB)...`);

        // Memory limit: Reject PDFs larger than 500KB to prevent memory issues
        const MAX_PDF_SIZE = 500 * 1024; // 500KB
        if (pdfBuffer.length > MAX_PDF_SIZE) {
            throw new Error(`PDF too large (${sizeKB} KB). Maximum size is 500KB. Please compress or split the PDF.`);
        }

        const data = await pdf(pdfBuffer);
        logger.info(`PDF parsed: ${data.numpages} pages, ${data.text.length} characters extracted`);

        // Clean up memory if possible
        if (global.gc && typeof global.gc === 'function') {
            // Only if --expose-gc flag is used
            try {
                global.gc();
            } catch (gcError) {
                // Ignore GC errors
            }
        }

        return data.text;
    } catch (error) {
        logger.error("Error extracting text from PDF:", error);
        throw new Error(`Failed to extract text from PDF: ${error.message}`);
    }
}

/**
 * Create OpenAI client with timeout
 */
function createOpenAIClient() {
    return new OpenAI({
        apiKey: requireEnv("OPENAI_API_KEY"),
        timeout: API_TIMEOUT,
        maxRetries: 1
    });
}

/**
 * Parse JSON response with error recovery
 */
function parseJSONResponse(responseText, statementType) {
    try {
        return JSON.parse(responseText);
    } catch (parseError) {
        logger.warn(`[${statementType}] JSON parse error: ${parseError.message}`);

        // Try to extract JSON from markdown code blocks
        let jsonText = responseText;
        const jsonMatch = responseText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (jsonMatch) {
            jsonText = jsonMatch[1];
            logger.info(`[${statementType}] Extracted JSON from code block`);
        } else {
            const objectMatch = responseText.match(/\{[\s\S]*\}/);
            if (objectMatch) {
                jsonText = objectMatch[0];
                logger.info(`[${statementType}] Extracted JSON object from text`);
            }
        }

        try {
            return JSON.parse(jsonText);
        } catch (secondError) {
            // Try basic JSON repair
            try {
                const repaired = jsonText
                    .replace(/,(\s*[}\]])/g, '$1')
                    .replace(/,\s*,/g, ',')
                    .replace(/,\s*}/g, '}')
                    .replace(/,\s*]/g, ']');

                const parsed = JSON.parse(repaired);
                logger.info(`[${statementType}] JSON repaired successfully`);
                return parsed;
            } catch (repairError) {
                const errorPos = parseInt(parseError.message.match(/position (\d+)/)?.[1] || '0');
                const start = Math.max(0, errorPos - 200);
                const end = Math.min(jsonText.length, errorPos + 200);
                logger.error(`[${statementType}] JSON parse failed. Problematic section:`, jsonText.substring(start, end));
                throw new Error(`Failed to parse GPT-5 Mini response as JSON: ${repairError.message}`);
            }
        }
    }
}

/**
 * Normalize bank transactions
 */
function normalizeBankTransactions(transactions) {
    if (!Array.isArray(transactions)) return transactions;

    return transactions.map(tx => {
        // Convert debits/credits to amount and type
        if (tx.debits !== undefined || tx.credits !== undefined) {
            const debitAmount = tx.debits || 0;
            const creditAmount = tx.credits || 0;
            tx.amount = creditAmount > 0 ? creditAmount : -debitAmount;
            tx.type = creditAmount > 0 ? "credit" : "debit";
            delete tx.debits;
            delete tx.credits;
        }

        // Ensure type is set
        if (!tx.type && tx.amount !== undefined) {
            tx.type = tx.amount >= 0 ? "credit" : "debit";
        }

        // Map narration field
        if (!tx.narration && tx.remarks) {
            tx.narration = tx.remarks;
        }

        return tx;
    });
}

/**
 * Normalize crypto transactions
 */
function normalizeCryptoTransactions(transactions) {
    if (!Array.isArray(transactions)) return transactions;

    return transactions.map(tx => {
        if (tx.type) {
            const typeLower = tx.type.toLowerCase();
            if (typeLower.includes("buy") || typeLower.includes("purchase")) {
                tx.type = "buy";
            } else if (typeLower.includes("sell") || typeLower.includes("sale")) {
                tx.type = "sell";
            } else if (typeLower.includes("transfer")) {
                tx.type = "transfer";
            } else if (typeLower.includes("deposit")) {
                tx.type = "deposit";
            } else if (typeLower.includes("withdrawal") || typeLower.includes("withdraw")) {
                tx.type = "withdrawal";
            } else if (typeLower.includes("fee")) {
                tx.type = "fee";
            }
        }
        return tx;
    });
}

/**
 * Extract bank statement data using GPT-5 Mini
 */
async function extractBankStatement(pdfBuffer, fileName) {
    const startTime = Date.now();
    logger.info(`Extracting bank statement from ${fileName}...`);

    // Extract text from PDF
    const pdfText = await extractTextFromPDF(pdfBuffer);
    if (!pdfText || pdfText.trim().length === 0) {
        throw new Error("PDF text extraction returned empty text. PDF may be image-based or corrupted.");
    }

    // Truncate PDF text
    const truncatedPdfText = pdfText.length > MAX_PDF_CHARS
        ? pdfText.substring(0, MAX_PDF_CHARS) + '\n\n[Note: Content truncated. Extract all visible transactions.]'
        : pdfText;

    const prompt = `Extract Nigerian bank statement data. Return ONLY valid JSON.

REQUIRED FIELDS:
- account_number (10 digits)
- account_name
- bank_name
- statement_period_start (DD-MMM-YYYY)
- statement_period_end (DD-MMM-YYYY)
- opening_balance (number)
- closing_balance (number)
- currency ("NGN")
- transactions (array): date, amount (negative=debit, positive=credit), type ("debit" or "credit"), description, balance

JSON FORMAT:
{"account_number":"","account_name":"","bank_name":"","statement_period_start":"","statement_period_end":"","opening_balance":0,"closing_balance":0,"currency":"NGN","transactions":[]}

CRITICAL: Valid JSON only. No markdown. No trailing commas. Properly escape strings.

STATEMENT TEXT:
${truncatedPdfText}`;

    try {
        const client = createOpenAIClient();
        const promptTokens = Math.ceil(prompt.length / 4);
        logger.info(`[Bank] Calling GPT-5 Mini API (model: ${DEFAULT_MODEL}, prompt: ${prompt.length} chars, ~${promptTokens} tokens)...`);

        // GPT-5-mini only supports default temperature (1), so we omit it
        const isGPT5Mini = DEFAULT_MODEL.includes('gpt-5-mini') || DEFAULT_MODEL.includes('gpt-5');
        const completion = await client.chat.completions.create({
            model: DEFAULT_MODEL,
            messages: [
                {
                    role: "system",
                    content: "Extract bank statement data. Return ONLY valid JSON. No markdown. No explanations."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            ...(isGPT5Mini ? {} : { temperature: 0.0 }), // GPT-5-mini only supports default temperature (1)
            max_completion_tokens: MAX_TOKENS,
            response_format: { type: "json_object" }
        });

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info(`[Bank] GPT-5 Mini API response received (${elapsed}s, tokens: ${completion.usage?.total_tokens || 'N/A'})`);

        const responseText = completion.choices[0]?.message?.content;
        if (!responseText) {
            throw new Error("GPT-5 Mini returned empty response");
        }

        logger.info(`[Bank] GPT-5 Mini response length: ${responseText.length} characters`);

        // Parse JSON
        const parsed = parseJSONResponse(responseText, "Bank");

        // Normalize transactions
        if (parsed.transactions) {
            parsed.transactions = normalizeBankTransactions(parsed.transactions);
        }

        logger.success(`[Bank] Statement extracted: ${parsed.transactions?.length || 0} transactions`);
        return parsed;

    } catch (error) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.error(`[Bank] Extraction failed after ${elapsed}s:`, {
            message: error.message,
            code: error.code,
            status: error.response?.status
        });

        if (error.message.includes('timeout') || error.message.includes('timed out')) {
            throw new Error(`Bank statement extraction timed out after ${elapsed}s. The statement may be too large.`);
        } else if (error.response?.status === 429) {
            throw new Error(`Rate limit exceeded. Please wait a moment and try again.`);
        } else if (error.response?.status === 401) {
            throw new Error(`OpenAI API authentication failed. Please check your API key.`);
        } else {
            throw new Error(`Bank statement extraction failed: ${error.message}`);
        }
    }
}

/**
 * Extract crypto statement data using GPT-5 Mini
 */
async function extractCryptoStatement(pdfBuffer, fileName) {
    const startTime = Date.now();
    logger.info(`Extracting crypto statement from ${fileName}...`);

    // Extract text from PDF
    const pdfText = await extractTextFromPDF(pdfBuffer);
    if (!pdfText || pdfText.trim().length === 0) {
        throw new Error("PDF text extraction returned empty text. PDF may be image-based or corrupted.");
    }

    // Truncate PDF text
    const truncatedPdfText = pdfText.length > MAX_PDF_CHARS
        ? pdfText.substring(0, MAX_PDF_CHARS) + '\n\n[Note: Content truncated. Extract all visible transactions.]'
        : pdfText;

    const prompt = `Extract cryptocurrency exchange statement data. Return ONLY valid JSON.

REQUIRED FIELDS:
- report_date (YYYY/MM/DD)
- report_period_start
- report_period_end
- entity_name
- account_id
- opening_total_account_value
- total_account_value
- transactions (array): date, type (buy/sell/transfer), amount, asset_symbol, description

JSON FORMAT:
{"report_date":"","report_period_start":"","report_period_end":"","entity_name":"","account_id":"","opening_total_account_value":"","total_account_value":"","transactions":[]}

CRITICAL: Valid JSON only. No markdown. No trailing commas. Properly escape strings.

STATEMENT TEXT:
${truncatedPdfText}`;

    try {
        const client = createOpenAIClient();
        const promptTokens = Math.ceil(prompt.length / 4);
        logger.info(`[Crypto] Calling GPT-5 Mini API (model: ${DEFAULT_MODEL}, prompt: ${prompt.length} chars, ~${promptTokens} tokens)...`);

        // GPT-5-mini only supports default temperature (1), so we omit it
        const isGPT5Mini = DEFAULT_MODEL.includes('gpt-5-mini') || DEFAULT_MODEL.includes('gpt-5');
        const completion = await client.chat.completions.create({
            model: DEFAULT_MODEL,
            messages: [
                {
                    role: "system",
                    content: "Extract crypto statement data. Return ONLY valid JSON. No markdown. No explanations."
                },
                {
                    role: "user",
                    content: prompt
                }
            ],
            ...(isGPT5Mini ? {} : { temperature: 0.0 }), // GPT-5-mini only supports default temperature (1)
            max_completion_tokens: MAX_TOKENS,
            response_format: { type: "json_object" }
        });

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info(`[Crypto] GPT-5 Mini API response received (${elapsed}s, tokens: ${completion.usage?.total_tokens || 'N/A'})`);

        const responseText = completion.choices[0]?.message?.content;
        if (!responseText) {
            throw new Error("GPT-5 Mini returned empty response");
        }

        logger.info(`[Crypto] GPT-5 Mini response length: ${responseText.length} characters`);

        // Parse JSON
        const parsed = parseJSONResponse(responseText, "Crypto");

        // Normalize transactions
        if (parsed.transactions) {
            parsed.transactions = normalizeCryptoTransactions(parsed.transactions);
        }

        logger.success(`[Crypto] Statement extracted: ${parsed.transactions?.length || 0} transactions`);
        return parsed;

    } catch (error) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.error(`[Crypto] Extraction failed after ${elapsed}s:`, {
            message: error.message,
            code: error.code,
            status: error.response?.status
        });

        if (error.message.includes('timeout') || error.message.includes('timed out')) {
            throw new Error(`Crypto statement extraction timed out after ${elapsed}s. The statement may be too large.`);
        } else if (error.response?.status === 429) {
            throw new Error(`Rate limit exceeded. Please wait a moment and try again.`);
        } else if (error.response?.status === 401) {
            throw new Error(`OpenAI API authentication failed. Please check your API key.`);
        } else {
            throw new Error(`Crypto statement extraction failed: ${error.message}`);
        }
    }
}

/**
 * Main extraction function
 */
async function extractWithGPT4Vision(fileOrPath, statementType) {
    const fileName = typeof fileOrPath === "object"
        ? fileOrPath.originalname || "statement.pdf"
        : require("path").basename(fileOrPath);

    const fileBuffer = typeof fileOrPath === "object" && fileOrPath.buffer
        ? fileOrPath.buffer
        : require("fs").readFileSync(fileOrPath);

    logger.info(`Extracting ${statementType} statement: ${fileName}`);

    if (statementType === "bank") {
        return await extractBankStatement(fileBuffer, fileName);
    } else if (statementType === "crypto") {
        return await extractCryptoStatement(fileBuffer, fileName);
    } else {
        throw new Error(`Unknown statement type: ${statementType}`);
    }
}

module.exports = {
    extractWithGPT4Vision,
    extractBankStatement,
    extractCryptoStatement
};
