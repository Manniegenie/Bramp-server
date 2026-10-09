// routes/ChatbotKYC.js
// Legacy chatbot entry point. Previously submitted to Smile ID directly and
// could approve KYC without the Dojah/Youverify checks; it now runs the exact
// same handler as /kyc/biometric-verification (same body: idType, idNumber,
// selfieImage). Auth is applied where this router is mounted in server.js.
const express = require("express");
const router = express.Router();
const kycRoutes = require("./KYC");

router.post("/chatbot-kyc", ...kycRoutes.biometricVerification);

module.exports = router;
