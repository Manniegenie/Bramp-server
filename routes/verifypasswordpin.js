const express = require("express");
const { body, validationResult } = require("express-validator");
const bcrypt = require("bcryptjs");
const router = express.Router();

const User = require("../models/user");
const logger = require("../utils/logger");

// POST /verify-pin - Verify user's password PIN
router.post(
  "/verify-pin",
  [
    body("passwordpin")
      .trim()
      .notEmpty()
      .withMessage("Password pin is required.")
      .isLength({ min: 4, max: 6 })
      .withMessage("Password pin must be between 4 and 6 digits.")
      .isNumeric()
      .withMessage("Password pin must contain only numbers."),
  ],
  async (req, res) => {
    // Validation check
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      logger.warn("PIN verification validation errors", {
        errors: errors.array(),
        userId: req.user?.id
      });
      return res.status(400).json({ 
        success: false,
        message: "Validation failed.",
        errors: errors.array()
      });
    }

    const { passwordpin } = req.body;
    const userId = req.user.id; // From global JWT middleware

    try {
      // Find user by ID from JWT
      const user = await User.findById(userId);

      if (!user) {
        logger.warn("User not found during PIN verification", { userId });
        return res.status(404).json({ 
          success: false,
          message: "User not found." 
        });
      }

      // Check if user has a PIN set
      if (!user.passwordpin) {
        logger.warn("PIN verification attempted but no PIN set", { userId });
        return res.status(400).json({ 
          success: false,
          message: "Password pin not set for this account." 
        });
      }

      // Compare the provided PIN with stored hash
      const isValidPin = await bcrypt.compare(passwordpin, user.passwordpin);

      if (!isValidPin) {
        logger.warn("Invalid PIN provided during verification", { 
          userId,
          providedPinLength: passwordpin.length
        });
        return res.status(401).json({
          success: false,
          message: "Invalid password pin."
        });
      }

      // PIN is valid
      logger.info("PIN verification successful", { userId });
      
      res.status(200).json({
        success: true,
        message: "Password pin verified successfully.",
        verified: true
      });

    } catch (error) {
      logger.error("Error during PIN verification", {
        error: error.message,
        stack: error.stack,
        userId
      });
      res.status(500).json({ 
        success: false,
        message: "Server error during PIN verification." 
      });
    }
  }
);

module.exports = router;