const OpenAI = require("openai");
const { requireEnv } = require("../utils/validators");
const { logger } = require("../utils/logger");

// Use GPT-5 mini for financial analysis (latest and most efficient)
const DEFAULT_MODEL = process.env.OPENAI_MODEL_PRIMARY || process.env.FINANCIAL_ANALYSIS_MODEL || 'gpt-5-mini';
const MAX_ATTEMPTS = 3;

const SYSTEM_PROMPT = `You are a PRIVATE AUDITOR operating at the HIGHEST LEVEL OF EXPERTISE, serving as an independent financial expert and forensic accountant with unparalleled credentials:

EXPERTISE & CREDENTIALS:
- Master's degree or higher in Accounting, Finance, or Forensic Accounting
- Certified Public Accountant (CPA), Chartered Accountant (CA), or equivalent international certification
- 15+ years of experience in financial auditing, forensic accounting, and fraud detection
- Expert-level knowledge of Nigerian banking regulations (CBN guidelines, IFRS compliance, GAAP)
- Specialized expertise in cryptocurrency trading, blockchain transactions, and digital asset accounting
- Extensive experience in cross-border transactions, currency conversion, and international financial reporting
- Proven track record in financial reconciliation, anomaly detection, and regulatory compliance
- Licensed to perform independent audits and provide expert testimony in legal proceedings

YOUR ROLE AS PRIVATE AUDITOR:
You are engaged as a PRIVATE AUDITOR to conduct a comprehensive, independent financial audit and reconciliation between Nigerian bank statements and cryptocurrency exchange statements. While you maintain the highest professional standards, you can communicate your findings in a clear, accessible manner that makes complex financial information understandable. You operate with complete independence, objectivity, and professional skepticism, but your reporting should be conversational and engaging while remaining thorough and accurate.

AUDIT OBJECTIVES:
1. RECONCILIATION: Match and verify all transactions between bank and crypto statements with forensic precision
2. MISSING FUNDS TRACING: Identify, trace, and document any missing or unaccounted funds with complete traceability
3. FRAUD DETECTION: Flag suspicious transactions, patterns, anomalies, or potential fraud indicators
4. PROFIT/LOSS ANALYSIS: Calculate accurate profit/loss with proper cost basis accounting and tax implications
5. REGULATORY COMPLIANCE: Ensure compliance with Nigerian tax regulations, CBN guidelines, and international reporting standards
6. RISK ASSESSMENT: Identify and assess financial risks, compliance risks, and operational risks
7. AUDIT REPORT: Provide a comprehensive, professional audit report suitable for legal, regulatory, and financial decision-making

AUDIT STANDARDS:
- Follow International Standards on Auditing (ISA) and International Financial Reporting Standards (IFRS)
- Apply Generally Accepted Auditing Standards (GAAS) and Generally Accepted Accounting Principles (GAAP)
- Maintain professional skepticism and independence throughout the audit
- Document all findings, conclusions, and recommendations with supporting evidence
- Provide clear, actionable recommendations for remediation and compliance

REPORTING REQUIREMENTS:
- Executive Summary: High-level overview for senior management and stakeholders
- Detailed Reconciliation: Complete transaction matching and verification
- Missing Funds Analysis: Comprehensive tracing and documentation
- Financial Analysis: Profit/loss, cash flow, and financial performance analysis
- Compliance Assessment: Regulatory compliance and tax obligation analysis
- Risk Assessment: Identification and assessment of financial and compliance risks
- Audit Report: Professional audit findings, conclusions, and recommendations

Always respond with valid JSON only - no markdown, no explanations, no code blocks.

COMMUNICATION STYLE:
While maintaining professional audit standards, write your findings and recommendations in a clear, conversational tone. Make complex financial information accessible and understandable. Use plain language where possible, but don't sacrifice accuracy or detail. Your audit report should be thorough yet readable, professional yet approachable.`.trim();

function buildReconciliationPrompt(bankStatement, cryptoStatement) {
    const bankTxJson = JSON.stringify(bankStatement.transactions || [], null, 2);
    const cryptoTxJson = JSON.stringify(cryptoStatement.transactions || [], null, 2);

    return `PRIVATE AUDIT ENGAGEMENT - FINANCIAL STATEMENT RECONCILIATION

You are conducting an independent financial audit as a PRIVATE AUDITOR at the HIGHEST LEVEL OF EXPERTISE. Perform a comprehensive, forensic-level audit and reconciliation of the following financial statements.

=== NIGERIAN BANK STATEMENT (AUDIT SUBJECT) ===
Account Holder: ${bankStatement.accountName || "Unknown"}
Account Number: ${bankStatement.accountNumber || "N/A"}
Bank: ${bankStatement.bankName || "Unknown"}
Statement Period: ${bankStatement.statementPeriod?.start || "N/A"} to ${bankStatement.statementPeriod?.end || "N/A"}
Currency: ${bankStatement.currency || "NGN"}
Opening Balance: ${bankStatement.openingBalance || 0}
Closing Balance: ${bankStatement.closingBalance || 0}
Total Credits: ${bankStatement.totalCredits || 0}
Total Debits: ${bankStatement.totalDebits || 0}
Transaction Count: ${(bankStatement.transactions || []).length}

Bank Transactions (Full Detail):
${bankTxJson}

=== CRYPTO EXCHANGE STATEMENT (AUDIT SUBJECT) ===
Exchange: ${cryptoStatement.exchangeName || "Unknown"}
Wallet Address: ${cryptoStatement.walletAddress || "N/A"}
Statement Period: ${cryptoStatement.statementPeriod?.start || "N/A"} to ${cryptoStatement.statementPeriod?.end || "N/A"}
Currency: ${cryptoStatement.currency || "USD"}
Transaction Count: ${(cryptoStatement.transactions || []).length}

Crypto Transactions (Full Detail):
${cryptoTxJson}

=== PRIVATE AUDIT REQUIREMENTS (HIGHEST LEVEL EXPERTISE) ===

As a PRIVATE AUDITOR operating at the HIGHEST LEVEL, you must:

1. RECONCILIATION (FORENSIC LEVEL):
   - Match every bank deposit/withdrawal with corresponding crypto purchase/sale/transfer
   - Verify transaction amounts, dates, and descriptions with precision
   - Identify and document any unmatched transactions
   - Calculate reconciliation rate and identify reconciliation gaps

2. MISSING FUNDS TRACING (FORENSIC ACCOUNTING):
   - Identify any unaccounted money flows between bank and crypto accounts
   - Trace missing funds with complete traceability (traceable/partially_traceable/untraceable)
   - Document possible causes for missing funds (fraud, error, timing differences, etc.)
   - Quantify missing funds amounts in both NGN and USD

3. TRANSACTION FLOW MAPPING (FORENSIC TRACING):
   - Map each transaction flow from bank to crypto and vice versa
   - Document transaction chains and relationships
   - Identify circular transactions, round-tripping, or suspicious patterns
   - Verify transaction authenticity and legitimacy

4. DISCREPANCY ANALYSIS (FORENSIC INVESTIGATION):
   - Flag any amounts that don't reconcile with severity levels (critical/high/medium/low)
   - Document discrepancy types (missing_deposit, missing_withdrawal, amount_mismatch, duplicate, suspicious)
   - Provide recommended actions for each discrepancy
   - Assess financial impact of discrepancies

5. REGULATORY COMPLIANCE (EXPERT ASSESSMENT):
   - Check compliance with CBN reporting requirements
   - Assess tax obligations (Nigerian tax regulations)
   - Identify regulatory flags and compliance issues
   - Provide compliance status (compliant/non_compliant/requires_review)

6. RISK ASSESSMENT (EXPERT EVALUATION):
   - Identify suspicious patterns or potential fraud indicators
   - Assess financial risks, compliance risks, and operational risks
   - Evaluate transaction risk levels (high/medium/low)
   - Provide risk mitigation recommendations

7. FINANCIAL ANALYSIS (EXPERT ANALYSIS):
   - Calculate accurate profit/loss with proper cost basis accounting
   - Analyze cash flow and financial performance
   - Assess tax implications and obligations
   - Provide financial insights and recommendations

8. AUDIT REPORT (PROFESSIONAL STANDARDS):
   - Provide comprehensive audit findings suitable for legal and regulatory purposes
   - Include executive summary for senior management
   - Provide detailed audit report with key findings, recommendations, and next steps
   - Document auditor notes and professional judgment

Respond with ONLY valid JSON in this exact format (no markdown, no code blocks):
{
  "executiveSummary": {
    "auditDate": "<ISO date>",
    "periodAnalyzed": "<start date> to <end date>",
    "overallReconciliationStatus": "<reconciled|partial|unreconciled>",
    "totalDiscrepancies": <number>,
    "missingFundsAmount": <number>,
    "missingFundsCurrency": "<NGN|USD>",
    "criticalFindings": [<string array>]
  },
  "reconciliation": {
    "matchedTransactions": <number>,
    "unmatchedBankTransactions": <number>,
    "unmatchedCryptoTransactions": <number>,
    "reconciliationRate": <percentage 0-100>,
    "discrepancies": [
      {
        "type": "<missing_deposit|missing_withdrawal|amount_mismatch|duplicate|suspicious>",
        "description": "<string>",
        "amount": <number>,
        "currency": "<NGN|USD>",
        "date": "<ISO date>",
        "severity": "<critical|high|medium|low>",
        "recommendedAction": "<string>"
      }
    ]
  },
  "missingFunds": {
    "totalMissing": <number>,
    "currency": "<NGN|USD>",
    "breakdown": [
      {
        "period": "<date range>",
        "amount": <number>,
        "description": "<string>",
        "possibleCauses": [<string array>],
        "traceability": "<traceable|partially_traceable|untraceable>"
      }
    ],
    "recommendations": [<string array>]
  },
  "financialAnalysis": {
    "totalBankActivity": {
      "credits": <number>,
      "debits": <number>,
      "netFlow": <number>,
      "currency": "NGN"
    },
    "totalCryptoActivity": {
      "purchases": <number>,
      "sales": <number>,
      "transfers": <number>,
      "fees": <number>,
      "netValue": <number>,
      "currency": "USD"
    },
    "profitLoss": {
      "realizedGains": <number>,
      "realizedLosses": <number>,
      "netProfitLoss": <number>,
      "currency": "USD",
      "ngnEquivalent": <number>,
      "taxImplications": "<string>"
    }
  },
  "compliance": {
    "cbnReportingRequired": <boolean>,
    "taxObligations": [<string array>],
    "regulatoryFlags": [<string array>],
    "complianceStatus": "<compliant|non_compliant|requires_review>"
  },
  "riskAssessment": {
    "suspiciousTransactions": [
      {
        "date": "<ISO date>",
        "type": "<string>",
        "amount": <number>,
        "description": "<string>",
        "riskLevel": "<high|medium|low>",
        "recommendation": "<string>"
      }
    ],
    "anomalies": [<string array>],
    "patterns": [<string array>],
    "overallRiskLevel": "<high|medium|low>"
  },
  "auditReport": {
    "keyFindings": [<string array>],
    "recommendations": [<string array>],
    "nextSteps": [<string array>],
    "auditorNotes": "<string>"
  }
}`.trim();
}

function parseAnalysisResponse(text) {
    // Remove markdown code blocks if present
    let cleaned = text.trim();
    if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
    } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
    }

    // Extract JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
        throw new Error("Error: Could not parse OpenAI response as JSON");
    }

    try {
        const parsed = JSON.parse(jsonMatch[0]);

        // Validate required top-level fields
        if (typeof parsed !== "object" || parsed === null) {
            throw new Error("Error: OpenAI response is not a valid object");
        }

        if (!parsed.executiveSummary || !parsed.reconciliation || !parsed.auditReport) {
            throw new Error("Error: OpenAI response missing required fields (executiveSummary, reconciliation, auditReport)");
        }

        return parsed;
    } catch (parseError) {
        logger.error("JSON parse error:", parseError.message);
        logger.error("Response text:", cleaned.substring(0, 500));
        throw new Error(`Error: Failed to parse OpenAI response as JSON: ${parseError.message}`);
    }
}

/**
 * Analyzes and reconciles bank and crypto statements using GPT-5.
 * 
 * @param {object} bankStatement - Bank statement data from extraction
 * @param {object} cryptoStatement - Crypto statement data from extraction
 * @returns {Promise<object>} Comprehensive audit and reconciliation report
 * @throws {Error} When the OpenAI API fails or returns invalid JSON
 */
async function analyzeWithOpenAI(bankStatement, cryptoStatement) {
    const apiKey = requireEnv("OPENAI_API_KEY");
    const client = new OpenAI({ apiKey });
    const model = DEFAULT_MODEL;
    const userPrompt = buildReconciliationPrompt(bankStatement, cryptoStatement);

    logger.info(`Analyzing statements with GPT-5 Mini (${model})...`);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            // GPT-5-mini only supports default temperature (1), so we omit it
            const isGPT5Mini = model.includes('gpt-5-mini') || model.includes('gpt-5');
            const response = await client.chat.completions.create({
                model: model,
                messages: [
                    { role: "system", content: SYSTEM_PROMPT },
                    { role: "user", content: userPrompt },
                ],
                ...(isGPT5Mini ? {} : { temperature: 0.1 }), // GPT-5-mini only supports default temperature (1)
                max_completion_tokens: 6000, // Increased for GPT-5 Mini's comprehensive audit reports
                response_format: { type: "json_object" }, // Force JSON response
            });

            const responseText = response.choices[0]?.message?.content;
            if (!responseText) {
                throw new Error("Error: OpenAI response was empty");
            }

            const analysis = parseAnalysisResponse(responseText);
            logger.success(`OpenAI analysis completed successfully (${model}, ${response.usage?.total_tokens || 'N/A'} tokens)`);
            return analysis;
        } catch (error) {
            if (attempt === MAX_ATTEMPTS) {
                logger.error(`OpenAI analysis failed after ${MAX_ATTEMPTS} attempts:`, error.message);
                throw error instanceof Error
                    ? error
                    : new Error("Error: OpenAI analysis failed");
            }

            const delayMs = Math.min(2 ** attempt * 1000, 10000); // Max 10s delay
            logger.warn(
                `OpenAI analysis attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying in ${delayMs}ms: ${error.message}`
            );
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    throw new Error("Error: OpenAI analysis failed after all retries");
}

module.exports = {
    analyzeWithOpenAI,
};

