const { logger } = require("../utils/logger");

/**
 * Converts Extracta.ai extraction result into the normalised StatementData structure.
 * 
 * @param {object} extractionData - Extraction data returned by Extracta.ai
 * @param {string} extractionId - Extracta.ai extraction identifier for traceability
 * @param {string} statementType - "bank" or "crypto"
 * @returns {Promise<object>} Normalised StatementData ready for analysis
 */
async function extractStatementData(extractionData, extractionId, statementType) {
    if (!extractionData || typeof extractionData !== "object") {
        throw new Error("Error: Extracta.ai extraction response was not a valid object");
    }

    // Extracta.ai returns data in a structured format
    // We need to map it to our standard format
    // The data might be nested in different ways depending on Extracta.ai's response format

    let data = extractionData;

    // Try to find the actual extraction data in various possible locations
    if (extractionData.data) {
        data = extractionData.data;
    } else if (extractionData.extraction_data) {
        data = extractionData.extraction_data;
    } else if (extractionData.result) {
        data = extractionData.result;
    } else if (extractionData.extracted_data) {
        data = extractionData.extracted_data;
    }

    // If data is still the whole object, try to find fields directly
    if (!data || (typeof data === "object" && Object.keys(data).length === 0)) {
        data = extractionData;
    }

    // Parse transactions
    const transactions = parseTransactions(data, statementType);

    // Extract account details - try multiple field name variations
    const accountNumber = data.account_number ||
        data.accountNumber ||
        data.account_number_text ||
        data.account?.number ||
        undefined;
    const accountName = data.account_name ||
        data.accountName ||
        data.account_name_text ||
        data.account?.name ||
        data.account_holder ||
        undefined;
    const bankName = statementType === "bank"
        ? (data.bank_name ||
            data.bankName ||
            data.bank_name_text ||
            data.institution ||
            data.financial_institution ||
            undefined)
        : undefined;
    const exchangeName = statementType === "crypto"
        ? (data.exchange_name ||
            data.exchangeName ||
            data.platform ||
            data.exchange ||
            undefined)
        : undefined;
    const walletAddress = statementType === "crypto"
        ? (data.wallet_address ||
            data.walletAddress ||
            data.wallet ||
            data.address ||
            undefined)
        : undefined;

    // Extract period - try multiple formats
    const period = data.statement_period ||
        data.statementPeriod ||
        data.period ||
        data.date_range ||
        {};
    const periodStart = period.start_date ||
        period.startDate ||
        period.start ||
        period.from ||
        data.period_start ||
        data.periodStart;
    const periodEnd = period.end_date ||
        period.endDate ||
        period.end ||
        period.to ||
        data.period_end ||
        data.periodEnd;

    // Extract balances - try multiple field names
    const openingBalance = coerceNumber(
        data.opening_balance ||
        data.openingBalance ||
        data.balance_opening ||
        data.initial_balance ||
        data.starting_balance
    );
    const closingBalance = coerceNumber(
        data.closing_balance ||
        data.closingBalance ||
        data.balance_closing ||
        data.final_balance ||
        data.ending_balance
    );
    const currency = data.currency ||
        data.currency_code ||
        data.currencyCode ||
        (statementType === "bank" ? "NGN" : "USD");

    // Calculate totals from transactions
    const totals = calculateTotals(transactions, statementType);

    const statementData = {
        extractionId,
        statementType,
        accountNumber: coerceString(accountNumber),
        accountName: coerceString(accountName),
        bankName: coerceString(bankName),
        exchangeName: coerceString(exchangeName),
        walletAddress: coerceString(walletAddress),
        statementPeriod: {
            start: coerceDate(periodStart),
            end: coerceDate(periodEnd),
        },
        openingBalance,
        closingBalance,
        currency,
        transactions,
        totalCredits: totals.totalCredits,
        totalDebits: totals.totalDebits,
        metadata: extractionData,
    };

    logger.success(
        `Extracted ${statementData.transactions.length} transactions for extraction ${extractionId}`
    );

    return statementData;
}

function parseTransactions(data, statementType) {
    // Try multiple possible locations for transactions
    let transactionsArray = data.transactions ||
        data.transaction_list ||
        data.transactionList ||
        data.entries ||
        data.items ||
        [];

    // If transactions is an object with nested array, try to extract it
    if (transactionsArray && typeof transactionsArray === "object" && !Array.isArray(transactionsArray)) {
        transactionsArray = transactionsArray.items ||
            transactionsArray.list ||
            transactionsArray.data ||
            [];
    }

    if (!Array.isArray(transactionsArray)) {
        logger.warn("Extracta.ai did not return a transactions array; returning empty list");
        logger.warn("Available data keys:", Object.keys(data));
        return [];
    }

    if (transactionsArray.length === 0) {
        logger.warn("Extracta.ai returned an empty transactions array");
    }

    return transactionsArray
        .map((entry) => mapTransaction(entry, statementType))
        .filter((tx) => tx !== undefined);
}

function mapTransaction(raw, statementType) {
    if (!raw || typeof raw !== "object") {
        return undefined;
    }

    const amount = coerceNumber(raw.amount);
    const balance = coerceNumber(raw.balance || raw.running_balance || raw.runningBalance);
    const description = coerceString(raw.description || raw.details || raw.narration || raw.memo)
        ?? (statementType === "bank" ? "Bank transaction" : "Crypto transaction");
    const date = coerceDate(raw.date || raw.transaction_date || raw.transactionDate || raw.timestamp);

    if (statementType === "crypto") {
        const typeValue = coerceString(raw.type || raw.transaction_type || raw.transactionType || raw.side) ?? "transfer";
        const type = (() => {
            const normalised = typeValue.toLowerCase();
            if (normalised.includes("buy")) return "buy";
            if (normalised.includes("sell")) return "sell";
            if (normalised.includes("transfer")) return "transfer";
            return "transfer";
        })();

        const price = coerceNumber(raw.price || raw.unit_price || raw.unitPrice || raw.rate);
        const fee = coerceNumber(raw.fee || raw.fees || raw.commission);
        const assetSymbol = coerceString(raw.asset || raw.symbol || raw.coin || raw.token) ?? "UNKNOWN";
        const counterCurrency = coerceString(raw.counter_currency || raw.counterCurrency || raw.quote_asset || raw.quoteAsset);

        return {
            date,
            description,
            amount,
            type,
            balance,
            price,
            fee,
            assetSymbol,
            counterCurrency,
        };
    }

    // Bank statement transaction
    const rawType = coerceString(raw.type || raw.transaction_type || raw.transactionType || raw.direction)
        ?? (amount >= 0 ? "credit" : "debit");
    const type = rawType.toLowerCase().includes("debit") || amount < 0 ? "debit" : "credit";

    return {
        date,
        description,
        amount,
        type,
        balance,
    };
}

function calculateTotals(transactions, statementType) {
    if (statementType === "crypto") {
        const totalVolume = transactions.reduce(
            (acc, tx) => acc + Math.abs(tx.amount),
            0
        );
        return { totalCredits: totalVolume, totalDebits: totalVolume };
    }

    return transactions.reduce(
        (acc, tx) => {
            if (tx.type === "credit") {
                return { ...acc, totalCredits: acc.totalCredits + Math.abs(tx.amount) };
            }
            if (tx.type === "debit") {
                return { ...acc, totalDebits: acc.totalDebits + Math.abs(tx.amount) };
            }
            return acc;
        },
        { totalCredits: 0, totalDebits: 0 }
    );
}

function coerceNumber(value) {
    if (typeof value === "number") {
        return value;
    }
    if (typeof value === "string") {
        const cleaned = value.replace(/[^0-9.-]/g, "");
        const parsed = Number.parseFloat(cleaned);
        return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
}

function coerceDate(value) {
    if (typeof value === "string") {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString().slice(0, 10);
        }
    }
    return new Date().toISOString().slice(0, 10);
}

function coerceString(value) {
    if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
    }
    return undefined;
}

module.exports = {
    extractStatementData,
};

