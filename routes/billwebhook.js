/**
 * eBills Webhook Handler - FIXED LOGIC
 * 
 * NEW Balance Flow:
 * 1. Airtime Endpoint:
 *    - completed-api: updateUserBalance() directly (transaction complete)
 *    - initiated-api/processing-api: reserveUserBalance() (transaction pending)
 * 
 * 2. Webhook Handler:
 *    - completed-api: releaseReservedBalance() + updateUserPortfolioBalance() (for previously pending transactions)
 *    - refunded: releaseReservedBalance() + refund to user balance
 *    - failed: releaseReservedBalance() (return reserved funds)
 * 
 * This handler only processes transactions that were previously pending (balanceReserved = true)
 */

const express = require('express');
const crypto = require('crypto');
const BillTransaction = require('../models/billstransaction');
const { 
  releaseReservedBalance, 
  updateUserBalance,
  updateUserPortfolioBalance,
  isTokenSupported 
} = require('../services/portfolio');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * Verify eBills webhook signature using canonical JSON serialization
 */
function verifyWebhookSignature(payload, signature, userPin) {
  try {
    const parsedPayload = JSON.parse(payload);
    const canonicalPayload = JSON.stringify(parsedPayload, null, 0);
    
    const expectedSignature = crypto
      .createHmac('sha256', userPin)
      .update(canonicalPayload, 'utf8')
      .digest('hex');
    
    const cleanSignature = signature.replace(/^sha256=/, '');
    
    return crypto.timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(cleanSignature, 'hex')
    );
  } catch (error) {
    logger.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Add processing error to transaction
 */
function addProcessingError(transaction, error, phase) {
  if (!transaction.processingErrors) {
    transaction.processingErrors = [];
  }
  transaction.processingErrors.push({
    error,
    timestamp: new Date(),
    phase
  });
}

/**
 * eBills Webhook Handler - HANDLES PENDING TO COMPLETED TRANSITIONS
 */
router.post('/ebills', express.raw({ type: 'application/json' }), async (req, res) => {
  const startTime = Date.now();
  let webhookData;
  let transaction;
  
  try {
    const rawPayload = req.body.toString('utf8');
    const signature = req.headers['x-signature'];
    
    if (!signature) {
      logger.warn('eBills webhook received without signature');
      return res.status(400).json({
        success: false,
        error: 'missing_signature',
        message: 'X-Signature header required'
      });
    }
    
    // Parse JSON payload
    try {
      webhookData = JSON.parse(rawPayload);
    } catch (parseError) {
      logger.error('Invalid JSON in eBills webhook:', parseError);
      return res.status(400).json({
        success: false,
        error: 'invalid_json',
        message: 'Invalid JSON payload'
      });
    }
    
    logger.info('eBills webhook received:', {
      order_id: webhookData.order_id,
      status: webhookData.status,
      request_id: webhookData.request_id,
      product_name: webhookData.product_name,
      amount: webhookData.amount,
      amount_charged: webhookData.amount_charged
    });
    
    // Validate required webhook fields
    const requiredFields = ['order_id', 'status', 'request_id'];
    const missingFields = requiredFields.filter(field => !webhookData[field]);
    
    if (missingFields.length > 0) {
      logger.warn('eBills webhook missing required fields:', missingFields);
      return res.status(400).json({
        success: false,
        error: 'missing_fields',
        message: `Missing required fields: ${missingFields.join(', ')}`
      });
    }
    
    // Find the transaction
    transaction = await BillTransaction.findOne({
      $or: [
        { requestId: webhookData.request_id },
        { orderId: webhookData.order_id.toString() },
        { orderId: `pending_${webhookData.request_id}` },
        { orderId: webhookData.order_id }
      ]
    });
    
    if (!transaction) {
      logger.warn('Transaction not found for eBills webhook:', {
        order_id: webhookData.order_id,
        request_id: webhookData.request_id
      });
      
      return res.status(200).json({
        success: true,
        message: 'Transaction not found, but webhook acknowledged',
        note: 'This may be a webhook for a transaction not processed by this system'
      });
    }
    
    // Get user PIN for signature verification
    const User = require('../models/user');
    const user = await User.findById(transaction.userId).select('pin userPin ebillsPin');
    
    if (!user) {
      logger.error('User not found for transaction:', transaction.userId);
      addProcessingError(transaction, 'User not found for signature verification', 'webhook_processing');
      await transaction.save();
      
      return res.status(400).json({
        success: false,
        error: 'user_not_found',
        message: 'Transaction user not found'
      });
    }
    
    const userPin = user.ebillsPin || user.pin || user.userPin;
    
    if (!userPin) {
      logger.error('User PIN not found for signature verification:', user._id);
      addProcessingError(transaction, 'User PIN not found for signature verification', 'webhook_processing');
      await transaction.save();
      
      return res.status(400).json({
        success: false,
        error: 'missing_pin',
        message: 'User PIN required for signature verification'
      });
    }
    
    // Verify webhook signature
    if (!verifyWebhookSignature(rawPayload, signature, userPin)) {
      logger.error('Invalid eBills webhook signature:', {
        order_id: webhookData.order_id,
        userId: user._id
      });
      
      addProcessingError(transaction, 'Invalid webhook signature', 'webhook_processing');
      await transaction.save();
      
      return res.status(401).json({
        success: false,
        error: 'invalid_signature',
        message: 'Invalid webhook signature'
      });
    }
    
    logger.info('✅ eBills webhook signature verified successfully');
    
    // Check if webhook was already processed
    if (transaction.webhookProcessedAt) {
      logger.info('Webhook already processed for transaction:', transaction.orderId);
      return res.status(200).json({
        success: true,
        message: 'Webhook already processed',
        transaction_id: transaction._id
      });
    }
    
    // ==========================================
    // NEW LOGIC: CHECK IF TRANSACTION WAS PENDING
    // ==========================================
    const wasBalanceReserved = transaction.balanceReserved === true;
    const wasCompleted = transaction.metaData?.balance_action_type === 'updated';
    
    if (!wasBalanceReserved && !wasCompleted) {
      logger.warn('Webhook received for transaction with no balance action taken:', {
        order_id: webhookData.order_id,
        transaction_id: transaction._id,
        balanceReserved: transaction.balanceReserved,
        balanceActionType: transaction.metaData?.balance_action_type
      });
    }
    
    // Update transaction with webhook data
    const updateData = {
      orderId: webhookData.order_id.toString(),
      status: webhookData.status,
      webhookProcessedAt: new Date(),
      metaData: {
        ...transaction.metaData,
        webhook_data: webhookData,
        webhook_timestamp: webhookData.timestamp,
        date_created: webhookData.date_created,
        date_updated: webhookData.date_updated,
        amount_charged: webhookData.amount_charged,
        webhook_received_at: new Date().toISOString(),
        webhook_processed_status: 'processing'
      }
    };
    
    // Handle different webhook statuses
    switch (webhookData.status) {
      case 'completed-api':
        logger.info(`🎯 Processing completed-api webhook: ${webhookData.order_id}`);
        
        if (wasBalanceReserved) {
          // This was a pending transaction - release the reserved balance
          logger.info(`📤 Releasing reserved balance for completed pending transaction`);
          
          try {
            const currency = transaction.paymentCurrency || 'NGNB';
            const amount = transaction.amount || transaction.amountNaira;
            
            if (!isTokenSupported(currency)) {
              throw new Error(`Unsupported currency for balance operations: ${currency}`);
            }
            
            // Release the reserved balance (transaction is now complete)
            await releaseReservedBalance(transaction.userId, currency, amount);
            
            // Update user's portfolio balance
            await updateUserPortfolioBalance(transaction.userId);
            
            updateData.portfolioUpdated = true;
            updateData.balanceReserved = false;
            updateData.balanceCompleted = true;
            
            updateData.metaData.balance_completed = true;
            updateData.metaData.balance_completed_at = new Date();
            updateData.metaData.reserved_balance_released = true;
            updateData.metaData.webhook_balance_action = 'released_reserved';
            
            logger.info(`✅ Released reserved balance for completed transaction: ${transaction.userId}`, {
              amount,
              currency,
              billType: transaction.billType,
              orderId: webhookData.order_id
            });
            
          } catch (balanceError) {
            logger.error('Failed to release reserved balance for completed transaction:', {
              transactionId: transaction._id,
              userId: transaction.userId,
              error: balanceError.message
            });
            
            addProcessingError(transaction, `Reserved balance release failed: ${balanceError.message}`, 'webhook_processing');
            updateData.metaData.webhook_balance_action = 'release_failed';
          }
          
        } else if (wasCompleted) {
          // This was already completed immediately - just update portfolio
          logger.info(`📊 Updating portfolio for already completed transaction`);
          
          try {
            await updateUserPortfolioBalance(transaction.userId);
            updateData.portfolioUpdated = true;
            updateData.metaData.webhook_balance_action = 'portfolio_updated_only';
            
            logger.info(`✅ Portfolio updated for already completed transaction: ${transaction.userId}`);
          } catch (portfolioError) {
            logger.error('Failed to update portfolio for completed transaction:', portfolioError.message);
            addProcessingError(transaction, `Portfolio update failed: ${portfolioError.message}`, 'webhook_processing');
          }
          
        } else {
          logger.warn('Completed webhook for transaction with unknown balance state:', {
            order_id: webhookData.order_id,
            balanceReserved: transaction.balanceReserved,
            balanceActionType: transaction.metaData?.balance_action_type
          });
          updateData.metaData.webhook_balance_action = 'no_action_unknown_state';
        }
        break;
        
      case 'refunded':
        logger.info(`💰 Processing refunded webhook: ${webhookData.order_id}`);
        
        try {
          const currency = transaction.paymentCurrency || 'NGNB';
          const amount = transaction.amount || transaction.amountNaira;
          
          if (!isTokenSupported(currency)) {
            throw new Error(`Unsupported currency for balance operations: ${currency}`);
          }
          
          if (wasBalanceReserved) {
            // Release reserved balance AND add refund to user's actual balance
            await releaseReservedBalance(transaction.userId, currency, amount);
            
            // Add refund to user's actual balance (positive amount)
            await updateUserBalance(transaction.userId, currency, amount);
            
            updateData.metaData.webhook_balance_action = 'released_and_refunded';
            logger.info(`✅ Released reserved balance and added refund: +${amount} ${currency}`);
            
          } else if (wasCompleted) {
            // Transaction was completed immediately - add refund to user's balance
            await updateUserBalance(transaction.userId, currency, amount);
            
            updateData.metaData.webhook_balance_action = 'refunded_to_balance';
            logger.info(`✅ Added refund to user balance: +${amount} ${currency}`);
            
          } else {
            logger.warn('Refund webhook for transaction with unknown balance state');
            updateData.metaData.webhook_balance_action = 'refund_no_action';
          }
          
          // Update portfolio in all cases
          await updateUserPortfolioBalance(transaction.userId);
          
          updateData.refundProcessed = true;
          updateData.balanceReserved = false;
          updateData.metaData.balance_released = true;
          updateData.metaData.balance_released_at = new Date();
          updateData.metaData.refund_reason = 'ebills_refund';
          updateData.metaData.refund_amount = amount;
          updateData.metaData.refund_currency = currency;
          
        } catch (balanceError) {
          logger.error('Failed to process refund:', {
            transactionId: transaction._id,
            userId: transaction.userId,
            error: balanceError.message
          });
          
          addProcessingError(transaction, `Refund processing failed: ${balanceError.message}`, 'webhook_processing');
          updateData.metaData.webhook_balance_action = 'refund_failed';
        }
        break;
        
      case 'failed':
        logger.info(`❌ Processing failed webhook: ${webhookData.order_id}`);
        
        if (wasBalanceReserved) {
          try {
            const currency = transaction.paymentCurrency || 'NGNB';
            const amount = transaction.amount || transaction.amountNaira;
            
            if (!isTokenSupported(currency)) {
              throw new Error(`Unsupported currency for balance operations: ${currency}`);
            }
            
            // Release the reserved balance (return funds to available balance)
            await releaseReservedBalance(transaction.userId, currency, amount);
            
            // Update portfolio
            await updateUserPortfolioBalance(transaction.userId);
            
            updateData.balanceReserved = false;
            updateData.metaData.balance_released = true;
            updateData.metaData.balance_released_at = new Date();
            updateData.metaData.release_reason = 'transaction_failed';
            updateData.metaData.failed_amount = amount;
            updateData.metaData.failed_currency = currency;
            updateData.metaData.webhook_balance_action = 'released_failed_transaction';
            
            logger.info(`✅ Released reserved balance for failed transaction: ${amount} ${currency}`);
            
          } catch (balanceError) {
            logger.error('Failed to release balance for failed transaction:', {
              transactionId: transaction._id,
              userId: transaction.userId,
              error: balanceError.message
            });
            
            addProcessingError(transaction, `Balance release failed for failed transaction: ${balanceError.message}`, 'webhook_processing');
            updateData.metaData.webhook_balance_action = 'release_failed';
          }
        } else {
          logger.info('Failed webhook for transaction with no reserved balance - no action needed');
          updateData.metaData.webhook_balance_action = 'no_action_needed';
        }
        break;
        
      default:
        logger.warn(`❓ Unexpected webhook status: ${webhookData.status} for order ${webhookData.order_id}`);
        addProcessingError(transaction, `Unexpected webhook status: ${webhookData.status}`, 'webhook_processing');
        updateData.metaData.webhook_balance_action = 'no_action_unexpected_status';
        break;
    }
    
    // Mark webhook processing as complete
    updateData.metaData.webhook_processed_status = 'completed';
    
    // Update transaction in database
    const updatedTransaction = await BillTransaction.findByIdAndUpdate(
      transaction._id,
      { 
        $set: updateData,
        $push: transaction.processingErrors && transaction.processingErrors.length > 0 ? 
          { processingErrors: { $each: transaction.processingErrors } } : undefined
      },
      { new: true }
    );
    
    const processingTime = Date.now() - startTime;
    
    logger.info('✅ eBills webhook processed successfully:', {
      order_id: webhookData.order_id,
      status: webhookData.status,
      transaction_id: updatedTransaction._id,
      processing_time: processingTime,
      balance_action: updateData.metaData.webhook_balance_action,
      was_balance_reserved: wasBalanceReserved,
      was_completed: wasCompleted,
      bill_type: updatedTransaction.billType
    });
    
    // Send success response to eBills
    return res.status(200).json({
      success: true,
      message: 'Webhook processed successfully',
      data: {
        order_id: webhookData.order_id,
        status: webhookData.status,
        transaction_id: updatedTransaction._id,
        processed_at: updateData.webhookProcessedAt,
        bill_type: updatedTransaction.billType,
        balance_action: updateData.metaData.webhook_balance_action,
        balance_status: {
          was_reserved: wasBalanceReserved,
          was_completed: wasCompleted,
          current_reserved: updatedTransaction.balanceReserved,
          portfolio_updated: updatedTransaction.portfolioUpdated
        }
      }
    });
    
  } catch (error) {
    const processingTime = Date.now() - startTime;
    
    logger.error('eBills webhook processing error:', {
      error: error.message,
      stack: error.stack,
      webhook_data: webhookData,
      transaction_id: transaction?._id,
      processing_time: processingTime
    });
    
    // Add error to transaction if we have it
    if (transaction) {
      try {
        addProcessingError(transaction, `Webhook processing error: ${error.message}`, 'unexpected_error');
        await transaction.save();
      } catch (saveError) {
        logger.error('Failed to save processing error to transaction:', saveError);
      }
    }
    
    // Return 500 to make eBills retry the webhook
    return res.status(500).json({
      success: false,
      error: 'internal_error',
      message: 'Webhook processing failedd'
    });
  }
});

/**
 * Webhook health check
 */
router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'eBills Webhook Handler (FIXED LOGIC)',
    timestamp: new Date().toISOString(),
    logic: {
      immediate_completion: 'Updates balance directly',
      pending_transactions: 'Reserves balance, webhook releases on completion',
      refunds: 'Releases reserved + adds refund to balance',
      failures: 'Releases reserved balance'
    },
    endpoints: {
      ebills: '/webhook/ebills',
      health: '/webhook/health'
    }
  });
});

module.exports = router;