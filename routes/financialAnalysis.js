const express = require("express");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { processStatementWithAnalysis } = require("../financial-analysis/analysis/analyzer");
const { validateStatementType } = require("../financial-analysis/utils/validators");
const { logger } = require("../financial-analysis/utils/logger");
const FinancialAnalysisJob = require("../models/FinancialAnalysisJob");
// Queue system (with fallback to direct processing)
let addExtractionJob, addAnalysisJob;
let useQueue = false;
try {
    const queue = require("../financial-analysis/queue/queues");
    addExtractionJob = queue.addExtractionJob;
    addAnalysisJob = queue.addAnalysisJob;
    useQueue = true;
    logger.info("Financial analysis queue system: ACTIVE");
} catch (error) {
    // Fallback to direct processing
    const worker = require("../services/financialAnalysisWorker");
    addExtractionJob = async (jobId, bankFile, cryptoFile, userId) => {
        logger.warn("Queue system not available, using direct processing");
        worker.processExtraction(jobId);
        return { id: jobId };
    };
    addAnalysisJob = async (jobId) => {
        logger.warn("Queue system not available, using direct processing");
        worker.processAnalysis(jobId);
        return { id: jobId };
    };
    logger.warn("Financial analysis queue system: FALLBACK (direct processing)");
}
const crypto = require("crypto");

const router = express.Router();

// CORS handler - set headers on ALL requests for this router
const corsHandler = (req, res, next) => {
    const origin = req.headers.origin;
    const allowedOrigins = [
        'https://www.chatbramp.com',
        'https://chatbramp.com',
        'http://localhost:3000',
        'http://localhost:5173'
    ];

    if (origin && allowedOrigins.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Credentials', 'false');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Type');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }

    next();
};

// Apply CORS to all routes in this router
router.use(corsHandler);

// Rate limiter for financial analysis (resource-intensive endpoint)
const financialAnalysisLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5, // 5 requests per hour per IP
    message: {
        success: false,
        error: "Too many financial analysis requests. Please try again later."
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        // Skip rate limiting for health checks
        return req.path === '/health';
    }
});

// Authentication middleware (matches server.js pattern)
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (!token) return res.status(401).json({ success: false, error: "Unauthorized: No token provided." });
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ success: false, error: "Forbidden: Invalid token." });
        req.user = user;
        next();
    });
};

// Configure multer for file uploads
// Note: 200KB limit as per requirements (statements should be optimized/compressed)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 200 * 1024, // 200KB max file size (as per requirements)
    },
    fileFilter: (req, file, cb) => {
        // Accept PDF, DOCX, DOC, TXT, HTML, and image files
        const allowedMimes = [
            "application/pdf",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "application/msword",
            "text/plain",
            "text/html",
            "image/png",
            "image/jpeg",
            "image/jpg",
        ];

        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(
                new Error(
                    `Invalid file type. Allowed types: PDF, DOCX, DOC, TXT, HTML, PNG, JPEG`
                ),
                false
            );
        }
    },
});


// Multer error handler - CORS headers already set by router middleware
const handleMulterError = (err, req, res, next) => {
    if (err instanceof multer.MulterError || err) {
        return res.status(400).json({
            success: false,
            error: err.message || 'File upload error'
        });
    }
    next();
};

/**
 * POST /financial-analysis/submit
 * Submit both bank and crypto statements for async processing
 * Requires authentication token in Authorization header
 *
 * Body (multipart/form-data):
 * - bankFile: Bank statement file
 * - cryptoFile: Crypto statement file
 *
 * Response:
 * - success: boolean
 * - jobId: Job ID to track processing status
 * - message: Status message
 */
router.post("/submit", financialAnalysisLimiter, authenticateToken, upload.fields([
    { name: 'bankFile', maxCount: 1 },
    { name: 'cryptoFile', maxCount: 1 }
]), handleMulterError, async (req, res) => {
    try {
        if (!req.files || !req.files.bankFile || !req.files.cryptoFile) {
            return res.status(400).json({
                success: false,
                error: "Both bankFile and cryptoFile are required."
            });
        }

        const bankFile = req.files.bankFile[0];
        const cryptoFile = req.files.cryptoFile[0];

        // Generate unique job ID
        const jobId = crypto.randomBytes(16).toString('hex');

        // Create job record
        const job = new FinancialAnalysisJob({
            userId: req.user.id,
            jobId,
            status: 'pending',
            bankStatement: {
                fileName: bankFile.originalname,
                fileSize: bankFile.size,
                fileBuffer: bankFile.buffer,
                status: 'pending'
            },
            cryptoStatement: {
                fileName: cryptoFile.originalname,
                fileSize: cryptoFile.size,
                fileBuffer: cryptoFile.buffer,
                status: 'pending'
            }
        });

        await job.save();

        logger.info(`Financial analysis job created: ${jobId} for user ${req.user.id}`);

        // Validate file sizes (200KB limit)
        const bankFileSizeKB = (bankFile.size / 1024).toFixed(2);
        const cryptoFileSizeKB = (cryptoFile.size / 1024).toFixed(2);
        const maxFileSize = 200 * 1024; // 200KB

        if (bankFile.size > maxFileSize || cryptoFile.size > maxFileSize) {
            return res.status(400).json({
                success: false,
                error: `File size exceeds 200KB limit. Bank: ${bankFileSizeKB}KB, Crypto: ${cryptoFileSizeKB}KB. Please compress your files.`,
                warning: "Only statements covering 1 month or less are allowed. Please ensure your statements are within the 1-month period."
            });
        }

        // Add extraction job to queue (or process directly if queue unavailable)
        try {
            await addExtractionJob(jobId, bankFile, cryptoFile, req.user.id);
            logger.info(`Extraction job added to queue for job ${jobId}`);
        } catch (error) {
            logger.error(`Error adding extraction job to queue:`, error);
            // Fallback to direct processing if queue fails
            const { processExtraction } = require("../services/financialAnalysisWorker");
            processExtraction(jobId);
        }

        res.json({
            success: true,
            jobId,
            message: "Statements uploaded successfully. Extraction started automatically.",
            status: "processing",
            warning: "Note: Only statements covering 1 month or less are allowed. Please ensure your statements are within the 1-month period.",
            queueEnabled: useQueue
        });
    } catch (error) {
        logger.error("Financial analysis submit error:", error);
        res.status(500).json({
            success: false,
            error: error.message || "Internal server error during statement submission"
        });
    }
});

/**
 * POST /financial-analysis/process
 * Process a financial statement (bank or crypto) and return analysis
 * DEPRECATED: Use /submit for async processing with both statements
 * Requires authentication token in Authorization header
 *
 * Body (multipart/form-data):
 * - file: Multipart file upload (PDF, DOCX, DOC, TXT, HTML, PNG, JPEG)
 * - statementType: "bank" or "crypto"
 *
 * Response:
 * - success: boolean
 * - data: Analysis report object
 * - error: Error message if failed
 */
router.post("/process", financialAnalysisLimiter, authenticateToken, upload.single("file"), async (req, res) => {
    // Set longer timeout for financial analysis (10 minutes)
    req.setTimeout(10 * 60 * 1000);
    res.setTimeout(10 * 60 * 1000);

    // Keep connection alive
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering if using nginx

    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: "No file uploaded. Please provide a file in the 'file' field.",
            });
        }

        const { statementType } = req.body;

        if (!statementType) {
            return res.status(400).json({
                success: false,
                error: "Missing required field: statementType. Must be 'bank' or 'crypto'.",
            });
        }

        // Validate statement type
        try {
            validateStatementType(statementType);
        } catch (error) {
            return res.status(400).json({
                success: false,
                error: error.message,
            });
        }

        logger.info(
            `Processing ${statementType} statement: ${req.file.originalname} (${(
                req.file.size / (1024 * 1024)
            ).toFixed(2)} MB)`
        );

        // Process the statement (this can take several minutes)
        const report = await processStatementWithAnalysis(
            req.file,
            statementType
        );

        res.json({
            success: true,
            data: report,
        });
    } catch (error) {
        logger.error("Financial analysis error:", error);
        console.error("Full error details:", {
            message: error?.message,
            stack: error?.stack,
            name: error?.name,
            response: error?.response?.data,
            status: error?.response?.status,
        });

        // Ensure CORS headers are set even on error
        const errorMessage = error.message || "Internal server error during statement processing";

        // Don't expose internal error details in production
        const safeError = process.env.NODE_ENV === 'production'
            ? "Internal server error during statement processing. Please try again later."
            : errorMessage;

        res.status(500).json({
            success: false,
            error: safeError,
        });
    }
});

/**
 * GET /financial-analysis/health
 * Health check endpoint for the financial analysis service (public, no auth required)
 */
/**
 * POST /financial-analysis/extract
 * Start extraction for uploaded statements
 * Requires authentication token and jobId
 */
router.post("/extract", financialAnalysisLimiter, authenticateToken, async (req, res) => {
    try {
        const { jobId } = req.body;

        if (!jobId) {
            return res.status(400).json({
                success: false,
                error: "jobId is required"
            });
        }

        const job = await FinancialAnalysisJob.findOne({ jobId, userId: req.user.id });
        if (!job) {
            return res.status(404).json({
                success: false,
                error: "Job not found"
            });
        }

        if (job.extractionStatus === 'completed') {
            return res.json({ success: true, status: "extracted" });
        }
        if (job.extractionStatus === 'processing') {
            return res.json({ success: true, status: "processing" });
        }

        // Start extraction - FAST parallel processing
        processExtraction(jobId);
        res.json({ success: true, jobId, status: "processing" });
    } catch (error) {
        logger.error("Financial analysis extract error:", error);
        res.status(500).json({
            success: false,
            error: error.message || "Internal server error during extraction"
        });
    }
});

/**
 * POST /financial-analysis/analyze
 * Start GPT analysis for extracted statements
 * Requires authentication token and jobId
 */
router.post("/analyze", financialAnalysisLimiter, authenticateToken, async (req, res) => {
    try {
        const { jobId } = req.body;

        if (!jobId) {
            return res.status(400).json({
                success: false,
                error: "jobId is required"
            });
        }

        const job = await FinancialAnalysisJob.findOne({ jobId, userId: req.user.id });
        if (!job) {
            return res.status(404).json({
                success: false,
                error: "Job not found"
            });
        }

        if (job.extractionStatus !== 'completed') {
            return res.status(400).json({
                success: false,
                error: "Extraction must be completed before analysis"
            });
        }

        if (job.analysisStatus === 'completed') {
            return res.json({ success: true, status: "completed", report: job.report });
        }
        if (job.analysisStatus === 'processing') {
            return res.json({ success: true, status: "analyzing" });
        }

        // Start analysis - FAST
        processAnalysis(jobId);
        res.json({ success: true, jobId, status: "analyzing" });
    } catch (error) {
        logger.error("Financial analysis analyze error:", error);
        res.status(500).json({
            success: false,
            error: error.message || "Internal server error during analysis"
        });
    }
});

router.get("/health", (req, res) => {
    res.json({
        success: true,
        message: "Financial analysis service is running",
        timestamp: new Date().toISOString(),
    });
});

module.exports = router;

