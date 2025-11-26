# Quick Fix Guide - Immediate Stability & Accuracy Improvements

## Problem
- System crashing inconsistently
- GPT-4 Vision accuracy not good enough
- No error recovery
- Memory issues with large PDFs

## Quick Fixes (No Redis Required)

### Option 1: Hybrid Extractor + Better Error Handling (Recommended for Immediate Use)

**Time**: 2-3 hours
**Complexity**: Low
**Benefits**: Immediate stability and accuracy improvements

#### Step 1: Use Hybrid Extractor

Update `services/financialAnalysisWorker.js`:
```javascript
// Replace:
const { extractWithGPT4Vision } = require("../financial-analysis/extracta/gpt4VisionExtractor");

// With:
const { extractWithHybridApproach } = require("../financial-analysis/extractors/hybridExtractor");
```

Then in `extractStatements`:
```javascript
// Replace:
[bankData, cryptoData] = await Promise.all([
    extractWithGPT4Vision(bankFile, "bank"),
    extractWithGPT4Vision(cryptoFile, "crypto")
]);

// With:
[bankData, cryptoData] = await Promise.all([
    extractWithHybridApproach(bankFile.buffer, bankFile.originalname, "bank"),
    extractWithHybridApproach(cryptoFile.buffer, cryptoFile.originalname, "crypto")
]);
```

#### Step 2: Add Better Error Handling

Wrap all async operations in try-catch:
```javascript
try {
    // ... extraction code ...
} catch (error) {
    logger.error("Extraction failed:", error);
    
    // Update job status
    job.extractionStatus = 'failed';
    job.status = 'failed';
    job.error = error.message;
    await job.save();
    
    // Don't throw - return error response
    return { success: false, error: error.message };
}
```

#### Step 3: Add Timeout Handling

Add timeout to GPT-4 calls:
```javascript
const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Timeout")), 180000); // 3 minutes
});

try {
    const result = await Promise.race([
        extractWithHybridApproach(...),
        timeoutPromise
    ]);
} catch (error) {
    if (error.message === "Timeout") {
        logger.error("Extraction timed out");
        // Handle timeout
    }
}
```

#### Step 4: Add Memory Management

Process PDFs in chunks:
```javascript
// In gpt4VisionExtractor.js, update extractTextFromPDF:
async function extractTextFromPDF(pdfBuffer) {
    try {
        // Limit PDF size
        if (pdfBuffer.length > 500 * 1024) { // 500KB
            throw new Error("PDF too large. Please compress or split.");
        }
        
        const data = await pdf(pdfBuffer);
        
        // Clean up memory
        if (global.gc) {
            global.gc();
        }
        
        return data.text;
    } catch (error) {
        logger.error("Error extracting text from PDF:", error);
        throw error;
    }
}
```

### Option 2: Improve GPT-4 Vision Accuracy

#### Step 1: Use Actual Images (Not Just Text)

Convert PDF to images and use GPT-4 Vision API:
```javascript
const pdf2pic = require("pdf2pic");

async function extractWithVisionImages(pdfBuffer, statementType) {
    // Convert PDF to images
    const converter = pdf2pic.fromBuffer(pdfBuffer, {
        density: 300,
        saveFilename: "page",
        savePath: "./temp",
        format: "png",
    });
    
    // Convert first page (for now)
    const page = await converter(1);
    
    // Use GPT-4 Vision API with image
    const response = await openai.chat.completions.create({
        model: "gpt-4-vision-preview",
        messages: [{
            role: "user",
            content: [
                { type: "text", text: "Extract bank statement data from this image..." },
                { type: "image_url", image_url: { url: `data:image/png;base64,${page.base64}` } }
            ]
        }]
    });
    
    return parseJSONResponse(response.choices[0].message.content);
}
```

**Note**: This requires `pdf2pic` package and more API calls (one per page).

#### Step 2: Improve Prompts

Make prompts more specific:
```javascript
const prompt = `Extract Nigerian bank statement data. Be VERY careful with:
1. Amounts - must be exact numbers
2. Dates - must be in DD-MMM-YYYY format
3. Account numbers - must be exactly 10 digits
4. Transactions - extract ALL transactions, don't miss any

Return ONLY valid JSON with this EXACT structure:
{
  "account_number": "string (10 digits)",
  "account_name": "string",
  "bank_name": "string",
  "statement_period_start": "DD-MMM-YYYY",
  "statement_period_end": "DD-MMM-YYYY",
  "opening_balance": number,
  "closing_balance": number,
  "currency": "NGN",
  "transactions": [
    {
      "date": "DD-MMM-YYYY",
      "amount": number (positive=credit, negative=debit),
      "type": "credit" or "debit",
      "description": "string",
      "balance": number
    }
  ]
}

CRITICAL: Return ONLY valid JSON. No markdown. No explanations.`;
```

### Option 3: Add Validation

Add validation after extraction:
```javascript
function validateExtractedData(data, statementType) {
    const errors = [];
    
    if (statementType === "bank") {
        if (!data.account_number || data.account_number.length !== 10) {
            errors.push("Invalid account number");
        }
        if (!data.transactions || !Array.isArray(data.transactions)) {
            errors.push("Invalid transactions");
        }
        // Check transaction consistency
        if (data.transactions) {
            data.transactions.forEach((tx, idx) => {
                if (!tx.date || !tx.amount) {
                    errors.push(`Transaction ${idx} missing required fields`);
                }
            });
        }
    }
    
    return {
        valid: errors.length === 0,
        errors
    };
}

// After extraction:
const validation = validateExtractedData(bankData, "bank");
if (!validation.valid) {
    logger.warn("Validation errors:", validation.errors);
    // Optionally retry or use fallback
}
```

## Implementation Order

1. **Immediate** (1 hour):
   - Add better error handling
   - Add timeout handling
   - Add memory limits

2. **Short-term** (2-3 hours):
   - Implement hybrid extractor
   - Add validation
   - Improve prompts

3. **Long-term** (1-2 days):
   - Add queue system (if needed)
   - Add image-based extraction
   - Add OCR support

## Testing

After implementing fixes:
1. Test with various PDF sizes
2. Test with different statement formats
3. Test error handling
4. Monitor memory usage
5. Check accuracy of extracted data

## Monitoring

Add logging for:
- Extraction time
- Memory usage
- Error rates
- Accuracy scores

## Next Steps

1. Implement quick fixes first
2. Test thoroughly
3. Monitor performance
4. Add queue system if needed
5. Improve accuracy with image-based extraction


