// routes/smileid.routes.js
const express = require("express");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const router = express.Router();
const crypto = require("crypto");

const User = require("../models/user");
const config = require("./config");
const logger = require("../utils/logger");

// SmileID configuration
const SMILE_PARTNER_ID = process.env.SMILE_PARTNER_ID;
const SMILE_API_KEY = process.env.SMILE_API_KEY;
const SMILE_BASE_URL = process.env.SMILE_BASE_URL || "https://api.sandbox.usesmileid.com";
const WEBHOOK_URL = process.env.SMILE_WEBHOOK_URL || "https://yourdomain.com/webhooks/smile-id-webhook-kyc";

// JWT secrets validation function
const validateJWTSecrets = () => {
  const jwtSecret = config.jwtSecret || process.env.JWT_SECRET;
  const jwtRefreshSecret = config.jwtRefreshSecret || process.env.REFRESH_JWT_SECRET;

  if (!jwtSecret) throw new Error("JWT_SECRET is not configured. Set JWT_SECRET in environment variables or config.");
  if (!jwtRefreshSecret) throw new Error("REFRESH_JWT_SECRET is not configured. Set REFRESH_JWT_SECRET in environment variables or config.");
  if (jwtSecret.length < 32) throw new Error("JWT_SECRET should be at least 32 characters long for security.");

  return { jwtSecret, jwtRefreshSecret };
};

// SmileID configuration validation
const validateSmileConfig = () => {
  if (!SMILE_PARTNER_ID) throw new Error("SMILE_PARTNER_ID is not configured. Set SMILE_PARTNER_ID in environment variables.");
  if (!SMILE_API_KEY) throw new Error("SMILE_API_KEY is not configured. Set SMILE_API_KEY in environment variables.");

  return { partnerId: SMILE_PARTNER_ID, apiKey: SMILE_API_KEY };
};

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ success: false, message: "Access token required." });
  }

  try {
    const { jwtSecret } = validateJWTSecrets();
    const decoded = jwt.verify(token, jwtSecret);
    req.user = decoded;
    next();
  } catch (jwtError) {
    if (jwtError.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Access token expired." });
    }
    return res.status(403).json({ success: false, message: "Invalid access token." });
  }
};

/**
 * Generate SmileID signature following their exact specification
 * @param {string} partnerId - Partner ID as string (e.g., "085")
 * @param {string} apiKey - API Key for signature
 * @returns {Object} Object containing signature and timestamp
 */
function generateSmileSignature(partnerId, apiKey) {
  // Step 1: Create timestamp in ISO 8601 format
  const timestamp = new Date().toISOString(); // yyyy-MM-dd'T'HH:mm:ss.fffZ
  
  // Step 2: Create HMAC-SHA256 hash function using API Key
  const hmac = crypto.createHmac("sha256", apiKey);
  
  // Step 3: Update the function message with timestamp, partner ID, and "sid_request"
  hmac.update(timestamp);
  hmac.update(partnerId);
  hmac.update("sid_request");
  
  // Step 4: Base64 encode the encrypted hash
  const signature = hmac.digest("base64");
  
  logger.debug("Generated SmileID signature", {
    timestamp,
    partnerId,
    signatureLength: signature.length
  });
  
  return { signature, timestamp };
}

/**
 * Confirm an incoming signature from SmileID webhook
 * @param {string} receivedSignature - Signature received from SmileID
 * @param {string} receivedTimestamp - Timestamp received from SmileID
 * @param {string} partnerId - Your partner ID
 * @param {string} apiKey - Your API key
 * @returns {boolean} True if signature is valid
 */
function confirmSmileSignature(receivedSignature, receivedTimestamp, partnerId, apiKey) {
  const hmac = crypto.createHmac("sha256", apiKey);
  hmac.update(receivedTimestamp);
  hmac.update(partnerId);
  hmac.update("sid_request");
  
  const generatedSignature = hmac.digest("base64");
  
  return receivedSignature === generatedSignature;
}

// POST: /kyc-url - Generate user-specific KYC URL
router.post(
  "/kyc-url",
  authenticateToken,
  [
    body("userId").trim().notEmpty().withMessage("User ID is required.").isMongoId().withMessage("Invalid user ID format."),
    body("jobId").optional().trim().isLength({ min: 1, max: 100 }).withMessage("Job ID must be 1-100 characters if provided."),
    body("jobType").optional().trim().isIn(["identity_verification", "enhanced_kyc", "basic_kyc", "biometric_kyc"]).withMessage("Invalid job type.")
  ],
  async (req, res) => {
    const startTime = Date.now();
    const requester = req.user?.id || "unknown";
    logger.info("KYC URL generation request initiated", {
      userId: req.body.userId,
      requestedBy: requester
    });

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: "Validation failed.",
        errors: errors.array()
      });
    }

    const { userId, jobId, jobType = "biometric_kyc" } = req.body;

    // Ensure user can only generate KYC URL for themselves (or admin override)
    if (req.user.id !== userId && req.user.role !== "admin") {
      return res.status(403).json({
        success: false,
        message: "You can only generate KYC URLs for your own account."
      });
    }

    try {
      // Validate SmileID configuration
      let smileConfig;
      try {
        smileConfig = validateSmileConfig();
      } catch (configError) {
        logger.error("SmileID configuration error", { error: configError.message });
        return res.status(500).json({
          success: false,
          message: "KYC service configuration error. Please contact support."
        });
      }

      // Verify user exists and get details
      const user = await User.findById(userId).lean();
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found." });
      }

      // If already approved, bail out
      if (user.kyc?.status === "APPROVED") {
        logger.info("User already has approved KYC", { userId });
        return res.status(400).json({
          success: false,
          message: "KYC already completed and approved for this user."
        });
      }

      // Generate unique job ID if not provided
      const finalJobId = jobId || `job_${userId}_${Date.now()}`;

      // Generate signature and timestamp
      const { signature, timestamp } = generateSmileSignature(smileConfig.partnerId, smileConfig.apiKey);

      // Prepare SmileID verification request payload
      // Include signature and timestamp in the body as per SmileID docs
      const verificationPayload = {
        source_sdk: "rest_api",
        source_sdk_version: "1.0.0",
        partner_id: smileConfig.partnerId,
        timestamp: timestamp,
        signature: signature,
        partner_params: {
          user_id: userId,
          job_id: finalJobId,
          job_type: jobType
        },
        callback_url: WEBHOOK_URL,
        // For web-based verification flow
        return_url: `${req.protocol}://${req.get("host")}/kyc-complete`,
        user_info: {
          first_name: user.firstname || user.firstName || "",
          last_name: user.lastname || user.lastName || "",
          email: user.email || "",
          phone_number: user.phonenumber || user.phone || "",
          country: user.country || "NG" // Default to Nigeria if not specified
        }
      };

      logger.info("Sending request to SmileID API", {
        userId,
        jobId: finalJobId,
        jobType,
        smileEndpoint: `${SMILE_BASE_URL}/v1/services`,
        partnerId: smileConfig.partnerId
      });

      // Make request to SmileID
      // Note: Using the correct endpoint and headers as per SmileID documentation
      const smileResponse = await fetch(`${SMILE_BASE_URL}/v1/services`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Remove Bearer token - SmileID uses signature authentication
          // Some SmileID implementations may still require these headers:
          "SmileID-Partner-ID": smileConfig.partnerId,
          "SmileID-Timestamp": timestamp,
          "SmileID-Signature": signature
        },
        body: JSON.stringify(verificationPayload)
      });

      const responseText = await smileResponse.text();
      let smileData;
      
      try {
        smileData = JSON.parse(responseText);
      } catch (parseError) {
        logger.error("Failed to parse SmileID response", {
          status: smileResponse.status,
          responseText: responseText.substring(0, 500),
          userId
        });
        
        return res.status(502).json({
          success: false,
          message: "Invalid response format from KYC service. Please try again later."
        });
      }

      if (!smileResponse.ok) {
        logger.error("SmileID API request failed", {
          status: smileResponse.status,
          statusText: smileResponse.statusText,
          error: smileData,
          userId
        });

        // Handle specific error cases
        if (smileResponse.status === 403) {
          return res.status(502).json({
            success: false,
            message: "Authentication failed with KYC service. Please contact support.",
            details: process.env.NODE_ENV === "development" ? smileData : undefined
          });
        }

        return res.status(502).json({
          success: false,
          message: smileData?.message || "Failed to generate KYC verification URL. Please try again later.",
          details: process.env.NODE_ENV === "development" ? smileData : undefined
        });
      }

      // Check for various possible response formats from SmileID
      const verificationUrl = smileData.verification_url || 
                            smileData.upload_url || 
                            smileData.redirect_url ||
                            smileData.result?.UploadUrl;
                            
      const smileJobId = smileData.smile_job_id || 
                        smileData.SmileJobID || 
                        smileData.result?.SmileJobID;

      if (!verificationUrl && !smileJobId) {
        logger.error("SmileID returned success but no verification URL or job ID", {
          smileData,
          userId
        });
        return res.status(502).json({
          success: false,
          message: "Invalid response from KYC service - no verification URL provided. Please contact support."
        });
      }

      // Update user record with pending KYC info
      try {
        await User.findByIdAndUpdate(userId, {
          $set: {
            "kyc.status": "PENDING",
            "kyc.provider": "smile-id",
            "kyc.jobId": finalJobId,
            "kyc.smileJobId": smileJobId,
            "kyc.initiatedAt": new Date(),
            "kyc.updatedAt": new Date()
          }
        });
      } catch (updateError) {
        logger.error("Failed to update user KYC status", {
          userId,
          error: updateError.message
        });
        // Don't fail the request if DB update fails
      }

      const processingTime = Date.now() - startTime;
      logger.info("KYC URL generated successfully", {
        userId,
        jobId: finalJobId,
        smileJobId: smileJobId,
        processingTimeMs: processingTime
      });

      return res.status(200).json({
        success: true,
        message: "KYC verification URL generated successfully",
        data: {
          kycUrl: verificationUrl,
          jobId: finalJobId,
          smileJobId: smileJobId,
          expiresAt: smileData.expires_at || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
          instructions: "Complete your identity verification by clicking the provided URL. You'll need a valid government-issued ID."
        }
      });
    } catch (error) {
      const processingTime = Date.now() - startTime;
      logger.error("Critical error during KYC URL generation", {
        error: error.message,
        stack: error.stack,
        requestedBy: req.user?.id,
        processingTimeMs: processingTime
      });

      return res.status(500).json({
        success: false,
        message: "Server error during KYC URL generation. Please try again."
      });
    }
  }
);

// GET: /kyc-status/:userId - Check KYC status for a user
router.get("/kyc-status/:userId", authenticateToken, async (req, res) => {
  const { userId } = req.params;

  // Ensure user can only check their own KYC status (or admin override)
  if (req.user.id !== userId && req.user.role !== "admin") {
    return res.status(403).json({
      success: false,
      message: "You can only check your own KYC status."
    });
  }

  try {
    const user = await User.findById(userId).select("kyc firstname lastname email").lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found." });
    }

    // If we have a SmileID job ID, we could optionally query SmileID for real-time status
    // This would require another API call with signature

    return res.status(200).json({
      success: true,
      message: "KYC status retrieved successfully",
      data: {
        status: user.kyc?.status || "NOT_STARTED",
        provider: user.kyc?.provider || null,
        jobId: user.kyc?.jobId || null,
        smileJobId: user.kyc?.smileJobId || null,
        lastUpdated: user.kyc?.updatedAt || null,
        resultCode: user.kyc?.resultCode || null,
        resultText: user.kyc?.resultText || null
      }
    });
  } catch (error) {
    logger.error("Error fetching KYC status", {
      error: error.message,
      userId
    });

    return res.status(500).json({
      success: false,
      message: "Server error while fetching KYC status."
    });
  }
});

// POST: /kyc-webhook - Handle SmileID webhook callbacks
router.post("/kyc-webhook", async (req, res) => {
  const startTime = Date.now();
  
  try {
    const { signature: receivedSignature, timestamp: receivedTimestamp } = req.body;
    
    // Validate webhook signature if provided
    if (receivedSignature && receivedTimestamp) {
      const { partnerId, apiKey } = validateSmileConfig();
      const isValid = confirmSmileSignature(receivedSignature, receivedTimestamp, partnerId, apiKey);
      
      if (!isValid) {
        logger.warn("Invalid webhook signature received", {
          timestamp: receivedTimestamp
        });
        return res.status(401).json({ success: false, message: "Invalid signature" });
      }
    }
    
    // Process webhook data
    const { 
      partner_params,
      result_code,
      result_text,
      smile_job_id,
      job_success,
      job_complete
    } = req.body;
    
    if (!partner_params?.user_id) {
      logger.error("Webhook missing user_id in partner_params", { body: req.body });
      return res.status(400).json({ success: false, message: "Invalid webhook data" });
    }
    
    const userId = partner_params.user_id;
    const jobId = partner_params.job_id;
    
    // Determine KYC status based on result
    let kycStatus = "PENDING";
    if (job_complete) {
      if (job_success === true) {
        kycStatus = "APPROVED";
      } else {
        kycStatus = "REJECTED";
      }
    }
    
    // Update user KYC status
    await User.findByIdAndUpdate(userId, {
      $set: {
        "kyc.status": kycStatus,
        "kyc.resultCode": result_code,
        "kyc.resultText": result_text,
        "kyc.smileJobId": smile_job_id,
        "kyc.completedAt": job_complete ? new Date() : undefined,
        "kyc.updatedAt": new Date()
      }
    });
    
    const processingTime = Date.now() - startTime;
    logger.info("KYC webhook processed successfully", {
      userId,
      jobId,
      smileJobId: smile_job_id,
      status: kycStatus,
      processingTimeMs: processingTime
    });
    
    // Return success to SmileID
    return res.status(200).json({ success: true });
    
  } catch (error) {
    logger.error("Error processing KYC webhook", {
      error: error.message,
      body: req.body
    });
    
    // Return success to avoid retries for processing errors
    return res.status(200).json({ success: true });
  }
});

module.exports = router;