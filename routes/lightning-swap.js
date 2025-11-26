const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

// Speed Wallet API configuration
const SPEED_CONFIG = {
    baseURL: process.env.SPEED_API_URL || 'https://api.speed.app',
    apiKey: process.env.SPEED_API_KEY,
    webhookSecret: process.env.SPEED_WEBHOOK_SECRET,
    testnet: process.env.USE_TESTNET === 'true'
};

// Axios instance for Speed API
const speedAPI = axios.create({
    baseURL: SPEED_CONFIG.baseURL,
    headers: {
        'Authorization': `Bearer ${SPEED_CONFIG.apiKey}`,
        'Content-Type': 'application/json'
    }
});

// In-memory storage for demo purposes
const swapTracker = new Map();
const processedWebhooks = new Set();

// Utility functions
const logger = {
    info: (message, data = {}) => console.log(`[SWAP INFO] ${new Date().toISOString()} - ${message}`, data),
    error: (message, error = {}) => console.error(`[SWAP ERROR] ${new Date().toISOString()} - ${message}`, error),
    warn: (message, data = {}) => console.warn(`[SWAP WARN] ${new Date().toISOString()} - ${message}`, data)
};

// Get BTC price from Binance API
async function getBTCPrice() {
    try {
        const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', {
            timeout: 10000
        });

        const price = parseFloat(response.data.price);
        return {
            success: true,
            price: price,
            currency: 'USD',
            lastUpdated: new Date().toISOString()
        };
    } catch (error) {
        logger.error('Failed to fetch BTC price', error.message);
        return {
            success: false,
            error: 'Failed to fetch BTC price',
            price: 50000, // Fallback price
            currency: 'USD',
            lastUpdated: new Date().toISOString()
        };
    }
}

// Get BTC price endpoint
router.get('/btc-price', async (req, res) => {
    try {
        const priceData = await getBTCPrice();
        res.json(priceData);
    } catch (error) {
        logger.error('BTC price endpoint error', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch BTC price'
        });
    }
});

// Initiate swap
router.post('/initiate', async (req, res) => {
    try {
        const { usdtAddress, network, usdAmount } = req.body;

        if (!usdtAddress || !network || !usdAmount) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: usdtAddress, network, usdAmount'
            });
        }

        if (usdAmount > 10000) {
            return res.status(400).json({
                success: false,
                error: 'Maximum swap amount is $10,000'
            });
        }

        // Get current BTC price
        const priceData = await getBTCPrice();
        if (!priceData.success) {
            return res.status(500).json({
                success: false,
                error: 'Failed to fetch BTC price'
            });
        }

        const btcPrice = priceData.price;
        const btcAmount = usdAmount / btcPrice;
        const fee = usdAmount * 0.015; // 1.5% fee
        const usdtAmount = usdAmount - fee;

        const referenceId = uuidv4();
        const swapId = `swap_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Create Lightning invoice using Speed API
        const paymentData = {
            amount: usdAmount,
            currency: 'USD',
            payment_methods: ['BTC'], // Lightning Network
            target_currency: 'SATS', // We'll receive BTC first, then swap
            metadata: {
                reference_id: referenceId,
                swap_id: swapId,
                usdt_address: usdtAddress,
                network: network,
                btc_amount: btcAmount,
                usdt_amount: usdtAmount,
                fee: fee,
                created_at: new Date().toISOString()
            },
            ttl: 3600 // 1 hour TTL
        };

        logger.info('Creating Lightning invoice for swap', {
            referenceId,
            swapId,
            usdAmount,
            btcAmount,
            usdtAmount
        });

        const response = await speedAPI.post('/payments', paymentData);
        const payment = response.data;

        // Store swap info for tracking
        swapTracker.set(referenceId, {
            swapId: swapId,
            referenceId: referenceId,
            usdtAddress: usdtAddress,
            network: network,
            usdAmount: usdAmount,
            btcAmount: btcAmount,
            usdtAmount: usdtAmount,
            fee: fee,
            btcPrice: btcPrice,
            status: 'pending',
            createdAt: new Date().toISOString(),
            paymentId: payment.id,
            bolt11: payment.lightning_invoice?.bolt11 || null,
            onchainAddress: payment.onchain_address || null
        });

        logger.info('Swap initiated successfully', {
            referenceId,
            swapId,
            paymentId: payment.id,
            hasLightningInvoice: !!payment.lightning_invoice?.bolt11
        });

        res.json({
            success: true,
            swapId: swapId,
            reference: referenceId,
            btcAmount: btcAmount,
            usdtAmount: usdtAmount,
            fee: fee,
            usdtAddress: usdtAddress,
            network: network,
            expiresAt: payment.expires_at,
            lightningInvoice: payment.lightning_invoice?.bolt11,
            onchainAddress: payment.onchain_address
        });

    } catch (error) {
        logger.error('Failed to initiate swap', error.response?.data || error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to initiate swap',
            details: error.response?.data || error.message
        });
    }
});

// Webhook handler for payment confirmations
router.post('/webhook', async (req, res) => {
    try {
        const signature = req.headers['x-speed-signature'];
        const payload = JSON.stringify(req.body);

        // Validate webhook signature
        if (!validateWebhookSignature(payload, signature, SPEED_CONFIG.webhookSecret)) {
            logger.warn('Invalid webhook signature');
            return res.status(401).json({ error: 'Invalid signature' });
        }

        const event = req.body;
        const referenceId = event.metadata?.reference_id;

        if (!referenceId) {
            logger.warn('No reference ID in webhook event');
            return res.status(400).json({ error: 'No reference ID found' });
        }

        // Check for duplicate webhook processing
        const webhookId = `${event.id}_${event.type}`;
        if (processedWebhooks.has(webhookId)) {
            logger.info('Duplicate webhook ignored', { webhookId });
            return res.status(200).json({ message: 'Webhook already processed' });
        }

        processedWebhooks.add(webhookId);

        // Get swap info
        const swapInfo = swapTracker.get(referenceId);
        if (!swapInfo) {
            logger.warn('Swap not found for reference', { referenceId });
            return res.status(404).json({ error: 'Swap not found' });
        }

        logger.info('Processing webhook event', {
            eventType: event.type,
            referenceId,
            swapId: swapInfo.swapId,
            paymentId: event.id
        });

        // Handle different event types
        switch (event.type) {
            case 'payment.completed':
                await handlePaymentCompleted(event, swapInfo);
                break;
            case 'payment.failed':
                await handlePaymentFailed(event, swapInfo);
                break;
            default:
                logger.info('Unhandled event type', { eventType: event.type });
        }

        res.status(200).json({ message: 'Webhook processed successfully' });

    } catch (error) {
        logger.error('Webhook processing failed', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// Handle completed payment
async function handlePaymentCompleted(event, swapInfo) {
    try {
        logger.info('Payment completed, starting swap process', {
            referenceId: swapInfo.referenceId,
            swapId: swapInfo.swapId,
            amount: event.amount
        });

        // Update swap status
        swapInfo.status = 'completed';
        swapInfo.completedAt = new Date().toISOString();
        swapInfo.receivedAmount = event.amount;

        // Perform BTC to USDT-L swap
        const swapResult = await performSwap(
            swapInfo.btcAmount,
            'SATS',
            'USDT',
            swapInfo.usdtAddress,
            swapInfo.network
        );

        if (!swapResult.success) {
            throw new Error(`Swap failed: ${swapResult.error}`);
        }

        logger.info('Swap completed successfully', {
            referenceId: swapInfo.referenceId,
            swapId: swapInfo.swapId,
            swapResultId: swapResult.swapId,
            swappedAmount: swapResult.amount
        });

        // Update final status
        swapInfo.status = 'swapped';
        swapInfo.swapResultId = swapResult.swapId;
        swapInfo.swappedAt = new Date().toISOString();

    } catch (error) {
        logger.error('Payment completion processing failed', error);
        swapInfo.status = 'error';
        swapInfo.error = error.message;
    }
}

// Handle failed payment
async function handlePaymentFailed(event, swapInfo) {
    logger.warn('Payment failed', {
        referenceId: swapInfo.referenceId,
        swapId: swapInfo.swapId,
        reason: event.failure_reason
    });

    swapInfo.status = 'failed';
    swapInfo.failureReason = event.failure_reason;
    swapInfo.failedAt = new Date().toISOString();
}

// Perform BTC to USDT-L swap
async function performSwap(amount, fromCurrency, toCurrency, address, network) {
    try {
        logger.info('Initiating swap', { amount, fromCurrency, toCurrency, address, network });

        // Note: This is a placeholder for the actual swap API call
        // The actual Speed API swap endpoint would be called here
        const swapData = {
            from_currency: fromCurrency,
            to_currency: toCurrency,
            amount: amount,
            address: address,
            network: network,
            // Additional swap parameters as needed
        };

        // For demo purposes, we'll simulate a successful swap
        // In production, you would call the actual Speed swap API
        const swapId = `swap_result_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const swappedAmount = amount * 0.99; // Simulate 1% fee

        logger.info('Swap completed', { swapId, originalAmount: amount, swappedAmount });

        return {
            success: true,
            swapId: swapId,
            amount: swappedAmount,
            fromCurrency: fromCurrency,
            toCurrency: toCurrency,
            address: address,
            network: network
        };

    } catch (error) {
        logger.error('Swap failed', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Validate webhook signature
function validateWebhookSignature(payload, signature, secret) {
    try {
        const crypto = require('crypto');
        const expectedSignature = crypto
            .createHmac('sha256', secret)
            .update(payload, 'utf8')
            .digest('hex');

        return crypto.timingSafeEqual(
            Buffer.from(signature, 'hex'),
            Buffer.from(expectedSignature, 'hex')
        );
    } catch (error) {
        logger.error('Webhook signature validation failed', error);
        return false;
    }
}

// Get swap status
router.get('/status/:referenceId', (req, res) => {
    const { referenceId } = req.params;
    const swapInfo = swapTracker.get(referenceId);

    if (!swapInfo) {
        return res.status(404).json({ error: 'Swap not found' });
    }

    res.json({
        success: true,
        referenceId: referenceId,
        swapId: swapInfo.swapId,
        status: swapInfo.status,
        usdtAddress: swapInfo.usdtAddress,
        network: swapInfo.network,
        usdAmount: swapInfo.usdAmount,
        btcAmount: swapInfo.btcAmount,
        usdtAmount: swapInfo.usdtAmount,
        fee: swapInfo.fee,
        createdAt: swapInfo.createdAt,
        completedAt: swapInfo.completedAt,
        swappedAt: swapInfo.swappedAt,
        error: swapInfo.error
    });
});

// Health check endpoint
router.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        testnet: SPEED_CONFIG.testnet,
        activeSwaps: swapTracker.size
    });
});

module.exports = router;
