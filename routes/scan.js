require('dotenv').config();
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { attachObiexAuth } = require('../utils/obiexAuth');

// Try to load OpenAI SDK similarly to AI/Chatbot.js
const OpenAI = (() => { try { return require('openai'); } catch (e) { return null; } })();

// Logger fallback
let logger;
try { logger = require('../utils/logger'); } catch (e) { logger = console; }

// Initialize OpenAI if key present
let openai = null;
try {
    const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
    if (OpenAI && OPENAI_API_KEY && OPENAI_API_KEY.startsWith('sk-')) {
        openai = new OpenAI({ apiKey: OPENAI_API_KEY });
        logger.info('Scan route: OpenAI initialized');
    } else {
        logger.warn('Scan route: OPENAI_API_KEY missing or OpenAI SDK not installed; using regex fallback.');
    }
} catch (e) {
    logger.error('Scan route: OpenAI init error:', e?.message || e);
}

function regexExtract(text = '') {
    const out = { accountName: null, accountNumber: null, bankName: null, method: 'regex' };
    const msg = String(text || '');

    // Nigerian account number: exactly 10 digits, allow separators/spaces
    const numMatch = msg.replace(/[^0-9]/g, ' ').match(/\b(\d{10})\b/);
    if (numMatch) out.accountNumber = numMatch[1];

    // Try common labels for name
    const nameLabel = msg.match(/(?:name|account\s*name|acct\s*name|beneficiary)\s*[:\-]\s*([^\n\r]+)/i);
    if (nameLabel) {
        out.accountName = nameLabel[1].trim().replace(/[^A-Za-z .'-]/g, '').replace(/\s{2,}/g, ' ');
    } else {
        // Heuristic: two or three consecutive capitalized words near the account number
        if (out.accountNumber) {
            const idx = msg.indexOf(out.accountNumber);
            const window = msg.slice(Math.max(0, idx - 120), idx + 120);
            const cap = window.match(/([A-Z][a-z]+\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
            if (cap) out.accountName = cap[1];
        }
    }

    // Bank name (optional)
    const bank = msg.match(/(?:bank|bank\s*name)\s*[:\-]\s*([^\n\r]+)/i);
    if (bank) out.bankName = bank[1].trim();
    return out;
}

// Fuzzy match bank name to available banks
function findBestBankMatch(detectedBankName, banks = []) {
    if (!detectedBankName || !Array.isArray(banks) || banks.length === 0) {
        return null;
    }

    const detected = String(detectedBankName).toLowerCase().trim();

    // Remove common suffixes/prefixes for matching
    const normalize = (str) => {
        return str.toLowerCase()
            .replace(/\b(plc|limited|ltd|bank|ng|nigeria)\b/g, '')
            .replace(/\s+/g, ' ')
            .trim();
    };
    const normalizedDetected = normalize(detected);

    let bestMatch = null;
    let bestScore = 0;

    for (const bank of banks) {
        const bankName = String(bank.name || '').toLowerCase().trim();
        const normalizedBank = normalize(bankName);

        // Exact match (after normalization)
        if (normalizedDetected === normalizedBank) {
            return { name: bank.name, code: bank.code, score: 1.0 };
        }

        // Contains match (detected contains bank name or vice versa)
        if (detected.includes(bankName) || bankName.includes(detected)) {
            const score = Math.min(detected.length, bankName.length) / Math.max(detected.length, bankName.length);
            if (score > bestScore) {
                bestScore = score;
                bestMatch = { name: bank.name, code: bank.code, score };
            }
        }

        // Normalized contains match
        if (normalizedDetected.includes(normalizedBank) || normalizedBank.includes(normalizedDetected)) {
            const score = Math.min(normalizedDetected.length, normalizedBank.length) / Math.max(normalizedDetected.length, normalizedBank.length);
            if (score > bestScore) {
                bestScore = score;
                bestMatch = { name: bank.name, code: bank.code, score };
            }
        }

        // Word-by-word similarity (e.g., "GT Bank" vs "GTL Bank")
        const detectedWords = normalizedDetected.split(/\s+/).filter(w => w.length > 1);
        const bankWords = normalizedBank.split(/\s+/).filter(w => w.length > 1);

        if (detectedWords.length > 0 && bankWords.length > 0) {
            let commonWords = 0;
            for (const dw of detectedWords) {
                for (const bw of bankWords) {
                    // Check if words are similar (prefix match or contains)
                    if (dw === bw || dw.startsWith(bw) || bw.startsWith(dw) || dw.includes(bw) || bw.includes(dw)) {
                        commonWords++;
                        break;
                    }
                }
            }
            const wordScore = commonWords / Math.max(detectedWords.length, bankWords.length);
            if (wordScore > 0.5 && wordScore > bestScore) {
                bestScore = wordScore;
                bestMatch = { name: bank.name, code: bank.code, score: wordScore };
            }
        }
    }

    // Only return if we have a reasonable match (score > 0.5)
    return bestScore > 0.5 ? bestMatch : null;
}

// Fetch banks from Obiex API
async function fetchBanks() {
    try {
        let cfg = { method: 'get', url: 'ngn-payments/banks', headers: {} };
        cfg = attachObiexAuth(cfg);

        const base = (process.env.OBIEX_BASE_URL || 'https://api.obiex.finance').replace(/\/+$/, '');
        const path = String(cfg.url || 'ngn-payments/banks');
        const finalUrl = `${base}${path.startsWith('/') ? path : `/${path}`}`;

        const resp = await axios.get(finalUrl, {
            headers: cfg.headers,
            timeout: 10000,
            maxBodyLength: Infinity,
        });

        const raw = Array.isArray(resp.data?.data) ? resp.data.data : [];
        const seen = new Set();
        const banks = raw
            .map((b) => {
                const name = String(b?.name ?? '').trim();
                const code = String(b?.sortCode ?? b?.uuid ?? b?.code ?? '').trim();
                return { name, code };
            })
            .filter((b) => b.name && b.code && !seen.has(b.code) && (seen.add(b.code), true));

        return banks;
    } catch (err) {
        logger.warn('Scan route: Failed to fetch banks for matching', err?.message || err);
        return [];
    }
}

async function aiExtract(text = '') {
    if (!openai) return regexExtract(text);
    const prompt = `You are a precise information extractor. Extract Nigerian bank account details from the text.
Return STRICT JSON only with keys: accountName (string|null), accountNumber (string|null), bankName (string|null), confidence (number 0..1).
Rules:
- accountNumber must be a 10-digit string if present, else null.
- accountName should be the beneficiary name (letters/spaces only), else null.
- bankName optional, else null.
Text:\n\n${text}`.slice(0, 6000);

    try {
        const model = process.env.OPENAI_MODEL_PRIMARY || process.env.SCAN_MODEL || 'gpt-5-mini';
        const isGPT5Mini = model.includes('gpt-5-mini') || model.includes('gpt-5');
        const completion = await openai.chat.completions.create({
            model: model,
            messages: [
                { role: 'system', content: 'You output ONLY compact JSON. No prose.' },
                { role: 'user', content: prompt }
            ],
            max_completion_tokens: 150,
            ...(isGPT5Mini ? {} : { temperature: 0.1 }) // GPT-5-mini only supports default temperature (1)
        });
        const raw = completion.choices?.[0]?.message?.content || '';
        const jsonTextMatch = raw.match(/\{[\s\S]*\}/);
        const jsonText = jsonTextMatch ? jsonTextMatch[0] : raw.trim();
        let parsed = {};
        try { parsed = JSON.parse(jsonText); } catch {
            // Attempt to salvage numbers and name with regex
            const fallback = regexExtract(text);
            return { ...fallback, confidence: fallback.accountNumber ? 0.6 : 0.3, raw };
        }

        const accountNumber = typeof parsed.accountNumber === 'string' && /^(\d{10})$/.test(parsed.accountNumber) ? parsed.accountNumber : null;
        const accountName = typeof parsed.accountName === 'string' ? parsed.accountName.replace(/[^A-Za-z .'-]/g, '').replace(/\s{2,}/g, ' ').trim() : null;
        const bankName = typeof parsed.bankName === 'string' ? String(parsed.bankName).trim() : null;
        const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : (accountNumber && accountName ? 0.9 : 0.6);

        return { accountName: accountName || null, accountNumber, bankName: bankName || null, confidence, raw };
    } catch (e) {
        logger.warn('Scan route: OpenAI extraction failed, using regex fallback', e?.message || e);
        const fallback = regexExtract(text);
        return { ...fallback, confidence: fallback.accountNumber ? 0.6 : 0.3 };
    }
}

router.post('/text', async (req, res) => {
    try {
        const { text } = req.body || {};
        if (!text || typeof text !== 'string' || !text.trim()) {
            return res.status(400).json({ success: false, message: 'Provide text string' });
        }
        const result = await aiExtract(text);
        return res.json({
            success: true, detected: {
                accountName: result.accountName,
                accountNumber: result.accountNumber,
                bankName: result.bankName,
            }, confidence: result.confidence ?? null, raw: result.raw ? String(result.raw).slice(0, 1000) : undefined
        });
    } catch (err) {
        logger.error('Scan route error:', err?.message || err);
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// Accepts a base64/DataURL image and uses OpenAI vision (if configured) to extract details
router.post('/image', async (req, res) => {
    try {
        logger.info('Scan image endpoint called', {
            contentType: req.headers['content-type'],
            contentLength: req.headers['content-length'],
            hasBody: !!req.body,
            bodyKeys: req.body ? Object.keys(req.body) : []
        });

        const { imageDataUrl } = req.body || {};
        if (!imageDataUrl || typeof imageDataUrl !== 'string') {
            logger.warn('Scan image: Missing or invalid imageDataUrl', {
                received: typeof imageDataUrl,
                length: imageDataUrl ? String(imageDataUrl).length : 0
            });
            return res.status(400).json({ success: false, message: 'Provide imageDataUrl (base64 or data URL string)' });
        }

        logger.info('Scan image: Processing image', {
            imageLength: imageDataUrl.length,
            imageSizeKB: Math.round(imageDataUrl.length / 1024),
            startsWithDataUrl: imageDataUrl.startsWith('data:')
        });

        // Prefer OpenAI vision; fallback to failure if not available
        if (!openai) {
            return res.status(503).json({ success: false, message: 'AI not available. Configure OPENAI_API_KEY.' });
        }

        const prompt = `Analyze this image carefully and extract Nigerian bank account details. Look for:

1. BANK NAME: Identify the full name of the Nigerian bank (e.g., "GTBank", "Access Bank", "UBA", "First Bank of Nigeria", etc.). Look for bank logos, letterheads, or text that clearly indicates the bank name.

2. ACCOUNT NUMBER: This is CRITICAL - Find the Nigerian bank account number which MUST be exactly 10 digits. Search for:
   - Numbers near labels like "Account Number", "A/C No", "Account No", "Acct", "ACC", etc.
   - Sequences of 10 consecutive digits (may have spaces, dashes, or other separators)
   - Common patterns: XXXX XXXX XX, XXXXX-XXXXX, or just 10 digits together
   - Even if partially unclear, try to extract any 10-digit sequence you see
   - If you see 9 or 11 digits, try to correct common OCR errors (0 vs O, 1 vs I, etc.)
   - Look near the bank name or in form fields

3. ACCOUNT HOLDER NAME: Extract the full name of the account holder/beneficiary (if visible).

Return STRICT JSON only with these exact keys:
- accountName (string|null): The account holder's full name, or null if not found
- accountNumber (string|null): Exactly 10 digits as a string (e.g., "0123456789"). Remove all spaces, dashes, or other characters. If you see a sequence that looks like an account number but has 9-11 digits, try to normalize it to 10 digits. Return null only if you cannot find any 10-digit sequence.
- bankName (string|null): The complete bank name as it appears (e.g., "GTBank Plc", "Access Bank Nigeria", etc.), or null if not found

CRITICAL for accountNumber:
- Remove all spaces, dashes, slashes, or other non-digit characters
- Must be exactly 10 digits
- If uncertain but see something close, normalize and return it (we will validate)
- If you see text like "Account: 0123 4567 89" extract as "0123456789"

Return only valid JSON, no additional text.`;

        // Support either data URL or raw base64 by normalizing to URL form
        const imageUrl = imageDataUrl.startsWith('data:')
            ? imageDataUrl
            : `data:image/jpeg;base64,${imageDataUrl}`;

        let json = null; let raw = null;
        try {
            const model = process.env.OPENAI_MODEL_PRIMARY || process.env.SCAN_MODEL || 'gpt-5-mini';
            const isGPT5Mini = model.includes('gpt-5-mini') || model.includes('gpt-5');
            const completion = await openai.chat.completions.create({
                model: model,
                messages: [
                    { role: 'system', content: 'You output ONLY compact JSON. No prose.' },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: prompt },
                            { type: 'image_url', image_url: { url: imageUrl } }
                        ]
                    }
                ],
                max_completion_tokens: 200,
                ...(isGPT5Mini ? {} : { temperature: 0.1 }) // GPT-5-mini only supports default temperature (1)
            });
            raw = completion.choices?.[0]?.message?.content || '';
            const jsonTextMatch = raw.match(/\{[\s\S]*\}/);
            const jsonText = jsonTextMatch ? jsonTextMatch[0] : raw.trim();
            try { json = JSON.parse(jsonText); } catch { json = null; }
        } catch (e) {
            logger.warn('Scan image: OpenAI vision failed', e?.message || e);
        }

        let accountNumber = null, accountName = null, bankName = null;

        // Function to extract and normalize 10-digit account number with fuzzy matching
        function extractAccountNumber(text) {
            if (!text) return null;

            // Remove all non-digit characters
            const digitsOnly = String(text).replace(/\D/g, '');

            // If exactly 10 digits, return it
            if (/^\d{10}$/.test(digitsOnly)) {
                return digitsOnly;
            }

            // Try to find 10-digit sequences in the text (with or without separators)
            const patterns = [
                /\d{10}/, // Exactly 10 digits together
                /\d{4}\s+\d{4}\s+\d{2}/, // Format: XXXX XXXX XX
                /\d{3}\s+\d{3}\s+\d{4}/, // Format: XXX XXX XXXX
                /\d{5}\s*-\s*\d{5}/, // Format: XXXXX-XXXXX
                /\d{2}\s+\d{4}\s+\d{4}/, // Format: XX XXXX XXXX
            ];

            for (const pattern of patterns) {
                const match = String(text).match(pattern);
                if (match) {
                    const extracted = match[0].replace(/\D/g, '');
                    if (/^\d{10}$/.test(extracted)) {
                        return extracted;
                    }
                }
            }

            // If we have 9 or 11 digits, try to normalize (common OCR errors)
            if (digitsOnly.length === 9) {
                // Try adding a leading zero (common for accounts starting with 0)
                const withZero = '0' + digitsOnly;
                if (/^\d{10}$/.test(withZero)) {
                    return withZero;
                }
            }

            if (digitsOnly.length === 11) {
                // Try removing the first or last digit (common OCR errors)
                const withoutFirst = digitsOnly.slice(1);
                const withoutLast = digitsOnly.slice(0, 10);
                if (/^\d{10}$/.test(withoutFirst)) return withoutFirst;
                if (/^\d{10}$/.test(withoutLast)) return withoutLast;
            }

            // Look for any 10-digit sequence anywhere in the text
            const longMatch = String(text).match(/\d{10,}/);
            if (longMatch && longMatch[0].length >= 10) {
                return longMatch[0].slice(0, 10); // Take first 10 digits
            }

            return null;
        }

        if (json) {
            // Try to extract account number from JSON field first
            if (json.accountNumber) {
                accountNumber = extractAccountNumber(json.accountNumber);
                if (accountNumber) {
                    logger.info('Scan image: Account number extracted from JSON field', {
                        original: json.accountNumber,
                        extracted: accountNumber
                    });
                }
            }

            // If not found, search in raw text for 10-digit sequences
            if (!accountNumber && raw) {
                accountNumber = extractAccountNumber(raw);
                if (accountNumber) {
                    logger.info('Scan image: Account number extracted from raw text', { extracted: accountNumber });
                }
            }

            accountName = typeof json.accountName === 'string' ? String(json.accountName).replace(/[^A-Za-z .'-]/g, '').replace(/\s{2,}/g, ' ').trim() : null;
            bankName = typeof json.bankName === 'string' ? String(json.bankName).trim() : null;
        } else if (raw) {
            // If JSON parsing failed, try to extract from raw text
            accountNumber = extractAccountNumber(raw);
            if (accountNumber) {
                logger.info('Scan image: Account number extracted from raw text (JSON parse failed)', { extracted: accountNumber });
            }
        }

        // Log if account number was not found
        if (!accountNumber && raw) {
            // Try to find any digit sequences for debugging
            const allDigits = raw.match(/\d+/g);
            logger.warn('Scan image: Account number not found', {
                hasRaw: !!raw,
                rawLength: raw ? raw.length : 0,
                digitSequences: allDigits ? allDigits.slice(0, 10) : null // Log first 10 digit sequences found
            });
        }

        // Fetch banks and try to match the detected bank name
        let matchedBank = null;
        let originalBankName = bankName;
        if (bankName) {
            const banks = await fetchBanks();
            matchedBank = findBestBankMatch(bankName, banks);
            if (matchedBank) {
                bankName = matchedBank.name; // Use the matched bank name
                logger.info('Scan image: Bank matched', {
                    original: originalBankName,
                    matched: matchedBank.name,
                    code: matchedBank.code,
                    score: matchedBank.score
                });
            } else {
                logger.warn('Scan image: Bank name not matched', {
                    detected: originalBankName,
                    banksChecked: banks.length
                });
            }
        }

        const result = {
            success: true,
            detected: {
                accountName: accountName || null,
                accountNumber: accountNumber || null,
                bankName: bankName || null, // This is now the matched bank name if found
            },
            confidence: accountNumber && accountName ? 0.9 : 0.6,
            raw: raw ? String(raw).slice(0, 1000) : undefined,
            bankMatch: matchedBank ? {
                original: originalBankName,
                matched: matchedBank.name,
                code: matchedBank.code,
                score: matchedBank.score
            } : (originalBankName ? { original: originalBankName, matched: null } : null)
        };

        logger.info('Scan image: Success', {
            detectedAccount: !!accountNumber,
            detectedName: !!accountName,
            detectedBank: !!originalBankName,
            matchedBank: matchedBank ? matchedBank.name : null,
            confidence: result.confidence
        });

        return res.json(result);
    } catch (err) {
        logger.error('Scan image route error:', {
            error: err?.message || err,
            stack: err?.stack,
            name: err?.name
        });
        return res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

module.exports = router;


