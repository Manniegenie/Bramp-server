const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const User = require('../models/user');
const Transaction = require('../models/transaction');
const { updateUserBalance } = require('../services/portfolio');
const { creditGlydeDepositIfNeeded } = require('../services/glydeDepositCrediting');
const logger = require('../utils/logger');

/**
 * Middleware to validate Glyde webhook signature using API key
 * Note: Glyde uses the same API key for both API authentication and webhook signing
 */
const validateGlydeSignature = (req, res, next) => {
  try {
    const signature = req.headers['x-signature-hash'] || req.headers['http-x-signature-hash'];
    const glydeApiKey = process.env.GLYDE_API_KEY;

    if (!signature) {
      logger.warn('Glyde webhook: Missing signature header');
      return res.status(400).json({ error: 'Missing signature header' });
    }

    if (!glydeApiKey) {
      logger.error('Glyde webhook: GLYDE_API_KEY not configured');
      return res.status(500).json({ error: 'Webhook signature validation not configured' });
    }

    // Get raw body for signature validation
    const rawBody = req.rawBody || JSON.stringify(req.body);
    const calculatedHash = crypto
      .createHmac('sha256', glydeApiKey)
      .update(rawBody)
      .digest('hex');

    if (signature !== calculatedHash) {
      logger.warn('Glyde webhook: Invalid signature', {
        received: signature,
        calculated: calculatedHash
      });
      return res.status(401).json({ error: 'Invalid signature' });
    }

    logger.info('Glyde webhook: Signature validated successfully');
    next();
  } catch (error) {
    logger.error('Glyde webhook signature validation error:', error);
    return res.status(500).json({ error: 'Signature validation failed' });
  }
};

/**
 * @route   POST /webhook/glyde/ngnb
 * @desc    Handle Glyde NGNB withdrawal webhook notifications
 * @access  Webhook (signature validated)
 */
router.post('/glyde', validateGlydeSignature, async (req, res) => {
  const body = req.body;

  logger.info('Glyde NGNB Webhook - Received:', {
    event: body.event,
    reference: body.data?.reference,
    merchant_reference: body.data?.merchant_reference,
    status: body.data?.status,
    amount: body.data?.amount,
    timestamp: new Date().toISOString()
  });

  try {
    const { event, data } = body;

    // Validate webhook payload structure
    if (!event || !data) {
      logger.warn('Glyde webhook: Invalid payload structure', body);
      return res.status(400).json({ error: 'Invalid payload structure' });
    }

    const {
      reference,           // Glyde's transaction reference
      merchant_reference,  // Our withdrawal reference
      type,
      amount,
      status,
      fee,
      created_at
    } = data;

    // Validate required fields
    if (!reference || !merchant_reference || !amount || !status) {
      logger.warn('Glyde webhook: Missing required fields', {
        reference: !!reference,
        merchant_reference: !!merchant_reference,
        amount: !!amount,
        status: !!status
      });
      return res.status(400).json({ error: 'Missing required fields in webhook data' });
    }

    // Find transaction by our reference (merchant_reference in Glyde's webhook)
    const transaction = await Transaction.findOne({
      reference: merchant_reference,
      type: 'WITHDRAWAL',
      currency: 'NGNB'
    });

    if (!transaction) {
      logger.warn(`Glyde webhook: No NGNB withdrawal transaction found for reference: ${merchant_reference}`, {
        glydeReference: reference,
        merchantReference: merchant_reference,
        searchedFields: {
          reference: merchant_reference,
          type: 'WITHDRAWAL',
          currency: 'NGNB'
        }
      });
      return res.status(404).json({ error: 'Transaction not found' });
    }

    logger.info(`Found NGNB withdrawal transaction: ${transaction._id}`, {
      transactionReference: transaction.reference,
      currentStatus: transaction.status,
      userId: transaction.userId,
      amount: transaction.amount
    });

    // Get user
    const user = await User.findById(transaction.userId);
    if (!user) {
      logger.error(`User not found for transaction: ${transaction._id}`);
      return res.status(404).json({ error: 'User not found' });
    }

    // Update transaction with Glyde webhook data
    transaction.metadata = {
      ...transaction.metadata,
      glyde_reference: reference,
      glyde_status: status,
      glyde_fee: fee || 0,
      glyde_amount: amount,
      webhook_received_at: new Date(),
      webhook_event: event,
      glyde_created_at: created_at ? new Date(created_at) : null
    };

    // Handle different webhook events
    if (event === 'transfer.successful') {
      await handleSuccessfulTransfer(transaction, user, amount, fee);
    } else if (event === 'transfer.failed') {
      await handleFailedTransfer(transaction, user, amount, fee);
    } else {
      logger.warn(`Glyde webhook: Unknown event type: ${event}`, {
        transactionId: transaction._id,
        reference: merchant_reference
      });
      return res.status(400).json({ error: `Unknown event type: ${event}` });
    }

    // Save transaction with updated metadata and status
    transaction.updatedAt = new Date();
    await transaction.save();

    logger.info(`Glyde NGNB webhook processed successfully`, {
      event,
      transactionId: transaction._id,
      reference: merchant_reference,
      finalStatus: transaction.status,
      userId: user._id
    });

    return res.status(200).json({ 
      success: true, 
      message: 'Webhook processed successfully',
      transactionId: transaction._id,
      status: transaction.status
    });

  } catch (error) {
    logger.error('Glyde NGNB webhook processing failed:', {
      error: error.message,
      stack: error.stack,
      body,
      timestamp: new Date().toISOString()
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Handle successful transfer webhook.
 * Balance was already deducted at withdrawal initiation (no reserve); just confirm.
 */
async function handleSuccessfulTransfer(transaction, user, amount, fee) {
  try {
    logger.info(`Processing successful NGNB transfer for transaction: ${transaction._id}`, {
      userId: user._id,
      amount: transaction.amount,
      previousStatus: transaction.status
    });

    // Update transaction status and metadata (balance already deducted at initiation)
    transaction.status = 'CONFIRMED';
    transaction.metadata.confirmed_at = new Date();
    transaction.metadata.final_amount = amount;
    transaction.metadata.final_fee = fee || 0;

    logger.info(`NGNB transfer confirmed for user: ${user._id}`, {
      transactionId: transaction._id,
      amount: transaction.amount
    });

  } catch (error) {
    logger.error(`Error handling successful transfer for transaction: ${transaction._id}`, {
      error: error.message,
      stack: error.stack,
      userId: user._id,
      amount: transaction.amount
    });
    throw error;
  }
}

/**
 * Handle failed transfer webhook.
 * Balance was already deducted at withdrawal initiation; refund the user.
 */
async function handleFailedTransfer(transaction, user, amount, fee) {
  try {
    logger.info(`Processing failed NGNB transfer for transaction: ${transaction._id}`, {
      userId: user._id,
      amount: transaction.amount,
      previousStatus: transaction.status
    });

    // Update transaction status and metadata
    transaction.status = 'FAILED';
    transaction.metadata.failed_at = new Date();
    transaction.metadata.failure_reason = 'Transfer failed via Glyde webhook';
    transaction.metadata.glyde_failure_details = {
      amount: amount,
      fee: fee,
      timestamp: new Date()
    };

    // Refund: balance was deducted at initiation
    await updateUserBalance(user._id, 'NGNB', transaction.amount);
    logger.info(`Refunded ${transaction.amount} NGNB to user: ${user._id}`, {
      transactionId: transaction._id,
      refundedAmount: transaction.amount
    });

  } catch (error) {
    logger.error(`Error handling failed transfer for transaction: ${transaction._id}`, {
      error: error.message,
      stack: error.stack,
      userId: user._id,
      amount: transaction.amount
    });
    throw error;
  }
}

/**
 * Verify Glyde webhook signature per the official docs: HMAC-SHA256 of the
 * raw body using a DEDICATED webhook signing key (Settings -> API Keys &
 * Webhook in the Glyde dashboard), sent as header X-Glyde-Signature.
 *
 * This is deliberately a separate function from validateGlydeSignature
 * above, which predates this spec and checks a different header
 * (x-signature-hash) against GLYDE_API_KEY instead of a dedicated signing
 * key - left untouched since it's live production code for withdrawal
 * confirmations and changing it needs its own careful pass.
 */
const validateGlydeWebhookSignature = (req, res, next) => {
  try {
    const signature = req.headers['x-glyde-signature'];
    const signingKey = process.env.GLYDE_WEBHOOK_SIGNING_KEY;

    if (!signature) {
      logger.warn('Glyde collection webhook: Missing X-Glyde-Signature header');
      return res.status(400).json({ error: 'Missing signature header' });
    }

    if (!signingKey) {
      logger.error('Glyde collection webhook: GLYDE_WEBHOOK_SIGNING_KEY not configured');
      return res.status(500).json({ error: 'Webhook signature validation not configured' });
    }

    const rawBody = req.rawBody || JSON.stringify(req.body);
    const expected = crypto.createHmac('sha256', signingKey).update(rawBody).digest('hex');

    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    const valid = sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);

    if (!valid) {
      logger.warn('Glyde collection webhook: Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    next();
  } catch (error) {
    logger.error('Glyde collection webhook signature validation error:', error);
    return res.status(500).json({ error: 'Signature validation failed' });
  }
};

/**
 * @route   POST /ngnbwebhook/glyde/collection
 * @desc    Money arriving on a Glyde virtual account: a Metusela on-ramp
 *          order, or a Bramp user's dedicated account (credited to NGNB via
 *          services/glydeDepositCrediting.js, same rules as ZeusODX).
 * @access  Webhook (signature validated)
 */
router.post('/glyde/collection', validateGlydeWebhookSignature, async (req, res) => {
  // Parse the exact bytes the signature was checked against rather than
  // relying on express.json, which runs after the raw-body capture above.
  let body;
  try {
    body = req.rawBody ? JSON.parse(req.rawBody) : req.body;
  } catch (parseErr) {
    logger.warn('Glyde collection webhook: invalid JSON payload', { error: parseErr.message });
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  // Summary only - the full payload carries the depositor's bank account
  // number/email; creditGlydeDepositIfNeeded logs full detail where it matters.
  logger.info('Glyde collection webhook - received', {
    event: body?.event,
    uid: body?.data?.uid,
    amount: body?.data?.amount,
    payerAccountName: body?.data?.payer?.account_name,
    payeeReference: body?.data?.payee?.reference,
  });

  // Respond immediately per Glyde's documented best practice, then process -
  // everything below is idempotent, so a retry (Glyde retries on any non-2xx)
  // is safe even if this instance restarts mid-way.
  res.status(200).json({ success: true });

  try {
    const { event, data } = body || {};
    if (!event || !data) {
      logger.warn('Glyde collection webhook: invalid payload structure', { event });
      return;
    }

    // Metusela on-ramp orders first (matched by reference, uid or account number).
    if (await require('../services/metuselaOnramp').handleGlydeEvent(event, data)) {
      return;
    }

    // Storefront buy orders (one-time accounts, matched the same way).
    if (await require('../services/storefrontBuy').handleGlydeEvent(event, data)) {
      return;
    }

    // virtual_account.funded is the real event for a VA deposit (confirmed
    // against ZeusODX production payloads); collection.success is kept in
    // case Glyde also sends it.
    if (event !== 'virtual_account.funded' && event !== 'collection.success') {
      logger.info('Glyde collection webhook: ignoring unhandled event', { event });
      return;
    }

    const result = await creditGlydeDepositIfNeeded(data);
    logger.info('Glyde collection webhook: processed', { event, outcome: result.outcome });
  } catch (error) {
    logger.error('Glyde collection webhook processing failed:', { error: error.message, stack: error.stack });
  }
});

/**
 * @route   GET /webhook/glyde/ngnb/test
 * @desc    Test endpoint to verify webhook setup
 * @access  Public (for testing only)
 */
router.get('/glyde/ngnb/test', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Glyde NGNB webhook endpoint is active',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

/**
 * @route   POST /webhook/glyde/ngnb/test
 * @desc    Test webhook with sample data (development only)
 * @access  Development only
 */
router.post('/glyde/ngnb/test', (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ error: 'Test endpoint not available in production' });
  }

  logger.info('Test webhook called with body:', req.body);
  
  res.status(200).json({
    success: true,
    message: 'Test webhook received',
    receivedData: req.body,
    timestamp: new Date().toISOString()
  });
});

module.exports = router;