// routes/ChatbotKYC.js
const express = require("express");
const { body, validationResult } = require("express-validator");
const smileIdentityCore = require("smile-identity-core");
const jwt = require("jsonwebtoken");
const router = express.Router();

const User = require("../models/user");
const config = require("./config");
const logger = require("../utils/logger");

// Initialize Smile Identity WebAPI
const WebApi = smileIdentityCore.WebApi;

// Smile ID Configuration
const SMILE_ID_CONFIG = {
  partner_id: process.env.SMILE_ID_PARTNER_ID || config.smileId?.partnerId,
  api_key: process.env.SMILE_ID_API_KEY || config.smileId?.apiKey,
  sid_server: process.env.SMILE_ID_SERVER || config.smileId?.server || "0", // 0 sandbox, 1 production
  callback_url:
    process.env.SMILE_ID_CALLBACK_URL ||
    config.smileId?.callbackUrl ||
    "https://your-domain.com/api/smile-id/callback",
};

// Nigerian ID type mappings based on Smile ID documentation
const NIGERIAN_ID_TYPES = {
  passport: "PASSPORT",
  national_id: "NIN_V2",
  drivers_license: "NIN_V2",
  bvn: "BVN",
  nin: "NIN_V2",
  nin_slip: "NIN_SLIP",
  voter_id: "VOTER_ID",
};

// ID Format validation patterns
const ID_PATTERNS = {
  BVN: /^\d{11}$/, // 11 digits
  NIN_V2: /^\d{11}$/, // 11 digits
  NIN_SLIP: /^\d{11}$/,
  PASSPORT: /^[A-Z]\d{8}$/, // Letter + 8 digits (assumed)
  VOTER_ID: /^\d{19}$/,
  V_NIN: /^\d{16}$/,
};

// Middleware to authenticate JWT token (keeps local behavior safe)
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({ success: false, message: "Access token required" });
  }

  const jwtSecret = config.jwtSecret || process.env.JWT_SECRET;
  jwt.verify(token, jwtSecret, (err, decoded) => {
    if (err) {
      return res.status(403).json({ success: false, message: "Invalid or expired token" });
    }
    req.user = decoded;
    next();
  });
};

// Validate Smile ID configuration
const validateSmileIdConfig = () => {
  if (!SMILE_ID_CONFIG.partner_id) {
    throw new Error("SMILE_ID_PARTNER_ID is not configured");
  }
  if (!SMILE_ID_CONFIG.api_key) {
    throw new Error("SMILE_ID_API_KEY is not configured");
  }
  if (!SMILE_ID_CONFIG.callback_url) {
    throw new Error("SMILE_ID_CALLBACK_URL is not configured");
  }
};

// POST: /chatbot-kyc - Verify user identity using Smile ID
router.post(
  "/chatbot-kyc",
  authenticateToken,
  [
    body("idType")
      .trim()
      .notEmpty()
      .withMessage("ID type is required")
      .isIn(["passport", "national_id", "drivers_license", "bvn", "nin", "nin_slip", "voter_id"])
      .withMessage("Invalid ID type. Supported: passport, national_id, drivers_license, bvn, nin, nin_slip, voter_id"),
    body("idNumber")
      .trim()
      .notEmpty()
      .withMessage("ID number is required")
      .isLength({ min: 8, max: 19 })
      .withMessage("ID number must be between 8-19 characters"),
    body("selfieImage")
      .notEmpty()
      .withMessage("Selfie image is required")
      .custom((value) => {
        if (typeof value === "string" && value.startsWith("data:image/")) return true;
        if (typeof value === "string" && value.length > 10) return true;
        throw new Error("Selfie must be a valid base64 image or file path");
      }),
    body("dob").optional().isISO8601().withMessage("Date of birth must be in YYYY-MM-DD format"),
  ],
  async (req, res) => {
    const startTime = Date.now();
    const userId = req.user?.id;
    logger.info("Biometric verification request initiated", {
      userId,
      idType: req.body.idType,
    });

    // Validate input
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: errors.array(),
      });
    }

    const { idType, idNumber, selfieImage, dob } = req.body;

    try {
      // Validate Smile ID configuration
      validateSmileIdConfig();

      // Get user from database
      const user = await User.findById(userId).select(
        "firstname lastname email username phonenumber kycLevel kycStatus kyc"
      );
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      // Check if user has required fields
      if (!user.firstname || !user.lastname) {
        return res.status(400).json({
          success: false,
          message: "User profile incomplete. First name and last name are required for ID verification.",
        });
      }

      // Map frontend ID type to Smile ID format
      const smileIdType = NIGERIAN_ID_TYPES[idType];
      if (!smileIdType) {
        return res.status(400).json({
          success: false,
          message: `Unsupported ID type: ${idType}`,
        });
      }

      // Validate ID number format
      const pattern = ID_PATTERNS[smileIdType];
      if (pattern && !pattern.test(idNumber)) {
        return res.status(400).json({
          success: false,
          message: `Invalid ${idType} format. Please check your ID number.`,
        });
      }

      // Initialize Smile ID connection
      const connection = new WebApi(
        SMILE_ID_CONFIG.partner_id,
        SMILE_ID_CONFIG.callback_url,
        SMILE_ID_CONFIG.api_key,
        SMILE_ID_CONFIG.sid_server
      );

      // Generate unique job ID
      const jobId = `${user._id}_${Date.now()}`;

      // Create partner parameters
      const partner_params = {
        job_id: jobId,
        user_id: user._id.toString(),
        job_type: 1, // Biometric KYC
      };

      // Prepare image details
      const image_details = [];

      // Add selfie image
      if (typeof selfieImage === "string" && selfieImage.startsWith("data:image/")) {
        const base64Data = selfieImage.split(",")[1] || "";
        image_details.push({
          image_type_id: 2, // Base64 selfie
          image: base64Data,
        });
      } else {
        image_details.push({
          image_type_id: 0, // File path selfie
          image: selfieImage,
        });
      }

      // Create ID information object
      const id_info = {
        first_name: user.firstname,
        last_name: user.lastname,
        country: "NG",
        id_type: smileIdType,
        id_number: idNumber,
        dob: dob || "",
        entered: "true",
      };

      // Set job options
      const options = {
        return_job_status: true,
        return_history: false,
        return_image_links: true,
        signature: true,
      };

      logger.info("Submitting Smile ID job", {
        jobId,
        userId: user._id,
        idType: smileIdType,
        imageCount: image_details.length,
      });

      // Submit job to Smile ID
      const response = await connection.submit_job(partner_params, image_details, id_info, options);

      logger.info("Smile ID response received", {
        jobId,
        success: response.job_success,
        resultCode: response.result?.ResultCode,
        processingTime: Date.now() - startTime,
      });

      // Process response
      if (response.job_success) {
        const result = response.result || {};
        const isApproved = ["0810", "0820", "0830", "1210", "1220", "1230"].includes(result.ResultCode);

        // Update user KYC status if verification successful
        if (isApproved) {
          // Ensure kyc object exists
          user.kyc = user.kyc || {};
          user.kyc.level2 = user.kyc.level2 || {};

          if ((user.kycLevel || 0) < 2) {
            user.kycLevel = 2;
            user.kycStatus = "approved";
            user.kyc.level2.status = "approved";
            user.kyc.level2.documentType = idType;
            user.kyc.level2.documentNumber = idNumber;
            user.kyc.level2.documentSubmitted = true;
            user.kyc.level2.approvedAt = new Date();
            await user.save();

            logger.info("User KYC upgraded to level 2", {
              userId: user._id,
              idType,
              smileJobId: result.SmileJobID,
            });
          }
        }

        return res.status(200).json({
          success: true,
          message: isApproved ? "ID verification successful" : "ID verification completed with issues",
          data: {
            jobId,
            smileJobId: result.SmileJobID,
            resultCode: result.ResultCode,
            resultText: result.ResultText,
            confidenceValue: result.ConfidenceValue,
            isApproved,
            actions: result.Actions,
            kycLevel: user.kycLevel,
            kycStatus: user.kycStatus,
            processingTime: Date.now() - startTime,
          },
        });
      } else {
        logger.error("Smile ID job failed", {
          jobId,
          userId: user._id,
          error: response.code || "Unknown error",
        });

        return res.status(400).json({
          success: false,
          message: "ID verification failed",
          error: response.code || "Unknown error occurred during verification",
        });
      }
    } catch (error) {
      logger.error("Critical error during biometric verification", {
        userId: req.user?.id,
        error: error?.message,
        stack: error?.stack,
        processingTime: Date.now() - startTime,
      });

      if (String(error?.message || "").includes("SMILE_ID")) {
        return res.status(500).json({
          success: false,
          message: "ID verification service configuration error. Please contact support.",
        });
      }

      return res.status(500).json({
        success: false,
        message: "Server error during ID verification. Please try again.",
      });
    }
  }
);

// Export router so server can mount it
module.exports = router;
