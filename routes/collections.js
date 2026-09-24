// routes/collections.js
const express = require('express');
const axios = require('axios');
const Transaction = require('../models/transaction');
const GlydeVirtualAccount = require('../models/glydeVirtualAccount');
const User = require('../models/user');
const {
  createVirtualAccount,
  getVirtualAccountTransactions,
  deactivateVirtualAccount,
} = require('../services/collectionService');
const logger = require('../utils/logger');

const router = express.Router();

const GLYDE_API_BASE_URL = process.env.GLYDE_API_BASE_URL || 'https://api.useglyde.io';
const GLYDE_API_KEY = process.env.GLYDE_API_KEY;

async function initializeGlydeCollection(collectionData) {
  try {
    const response = await axios.post(
      `${GLYDE_API_BASE_URL}/v1/collection/initialise`,
      collectionData,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${GLYDE_API_KEY}`
        },
        timeout: 30000
      }
    );
    return { success: true, data: response.data.data, message: response.data.message };
  } catch (error) {
    logger.error('Glyde API error', { error: error.message, response: error.response?.data, status: error.response?.status });
    return { success: false, error: error.response?.data?.message || error.message, statusCode: error.response?.status || 500 };
  }
}

// POST /collections/initialize
router.post('/initialize', async (req, res) => {
  try {
    const userId = req.user.id;
    const { currency, amount, customer_name, customer_email, customer_phone, channels, default_channel, meta } = req.body;

    const user = await User.findById(userId).select('email firstname lastname phonenumber');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (!currency || !amount || !customer_name || !customer_email) {
      return res.status(400).json({ success: false, message: 'Missing required fields: currency, amount, customer_name, customer_email' });
    }

    if (amount < 100) {
      return res.status(400).json({ success: false, message: 'Minimum collection amount is 100' });
    }

    const reference = `GLYDE_${userId}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`.toUpperCase();

    logger.info('Glyde collection request:', { userId, reference, amount, currency, customer: customer_name });

    const glydePayload = {
      currency: currency.toUpperCase(),
      reference,
      amount,
      customer_name,
      customer_email,
      channels: ['transfer'],
      default_channel: 'transfer',
      ...(customer_phone && { customer_phone }),
      ...(meta && { meta })
    };

    const glydeResult = await initializeGlydeCollection(glydePayload);

    if (glydeResult.success) {
      const transaction = new Transaction({
        userId,
        type: 'DEPOSIT',
        currency: currency.toUpperCase(),
        amount,
        status: 'PENDING',
        source: 'BANK',
        reference,
        narration: `Payment collection from ${customer_name}`,
        metadata: {
          glydeUrl: glydeResult.data?.url,
          customerName: customer_name,
          customerEmail: customer_email,
          paymentChannels: channels
        }
      });

      await transaction.save();

      logger.info('Glyde collection initialized successfully', { userId, reference, transactionId: transaction._id });

      return res.json({
        success: true,
        message: glydeResult.message || 'Collection initialized successfully',
        data: {
          reference,
          transactionId: transaction._id,
          amount,
          currency: currency.toUpperCase(),
          paymentUrl: glydeResult.data?.url,
          customer: { name: customer_name, email: customer_email },
          channels,
          createdAt: new Date().toISOString()
        }
      });
    } else {
      logger.error('Glyde collection initialization failed', { userId, reference, error: glydeResult.error });
      return res.status(502).json({ success: false, message: 'Collection initialization failed', error: glydeResult.error });
    }
  } catch (err) {
    logger.error('Collection initialization endpoint error', { error: err.stack, userId: req.user?.id });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /collections/status/:reference
router.get('/status/:reference', async (req, res) => {
  try {
    const userId = req.user.id;
    const { reference } = req.params;

    const referenceUserId = reference.split('_')[1];
    if (referenceUserId !== userId.toString()) {
      return res.status(403).json({ success: false, message: 'Unauthorized access to this collection' });
    }

    const transaction = await Transaction.findOne({
      reference,
      type: 'COLLECTION',
      source: 'GLYDE_COLLECTION'
    }).lean();

    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Collection not found' });
    }

    return res.json({
      success: true,
      data: {
        reference: transaction.reference,
        transactionId: transaction._id,
        status: transaction.status,
        amount: transaction.amount,
        currency: transaction.currency,
        paymentUrl: transaction.metadata?.glydeUrl,
        customer: { name: transaction.metadata?.customerName, email: transaction.metadata?.customerEmail },
        createdAt: transaction.createdAt,
        completedAt: transaction.completedAt
      }
    });
  } catch (err) {
    logger.error('Collection status endpoint error', { error: err.stack, userId: req.user?.id, reference: req.params?.reference });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------
// Virtual Accounts - dedicated bank accounts (Glyde). Separate product
// from the hosted-checkout Collection endpoints above; intended to
// eventually replace the Nomba virtual-account flow (routes/Nombadeposit.js),
// but that cutover is a deliberate later step, not part of this file.
// ---------------------------------------------------------------------

// POST /collections/virtual-accounts - create the caller's dedicated account
// body: { type: 'static'|'dynamic', bvn? (static, falls back to user.bvn), expectedAmount? (dynamic) }
router.post('/virtual-accounts', async (req, res) => {
  try {
    const userId = req.user.id;
    const { type, bvn, expectedAmount } = req.body;

    if (!['static', 'dynamic'].includes(type)) {
      return res.status(400).json({ success: false, message: 'type must be "static" or "dynamic"' });
    }

    const user = await User.findById(userId).select('email firstname lastname phonenumber bvn');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // One active account per type per user
    const existing = await GlydeVirtualAccount.findOne({ userId, type, status: 'active' });
    if (existing) {
      return res.status(400).json({
        success: false,
        message: `You already have an active ${type} virtual account`,
        data: { uid: existing.uid, accountNumber: existing.accountNumber, bankName: existing.bankName },
      });
    }

    const bvnToUse = type === 'static' ? (bvn || user.bvn) : undefined;
    if (type === 'static' && !bvnToUse) {
      return res.status(400).json({ success: false, message: 'BVN is required for a static virtual account' });
    }

    const reference = `bramp-va-${userId}-${type}`;

    const result = await createVirtualAccount({
      type,
      customer: {
        reference,
        first_name: user.firstname,
        last_name: user.lastname,
        email: user.email,
        phone: user.phonenumber,
        ...(type === 'static' && { bvn: bvnToUse }),
      },
      expectedAmount: type === 'dynamic' ? expectedAmount : undefined,
    });

    if (!result.success) {
      return res.status(result.statusCode || 502).json({ success: false, message: result.message });
    }

    const d = result.data;
    const record = await GlydeVirtualAccount.create({
      userId,
      uid: d.uid,
      reference,
      type: d.type || type,
      status: d.status === 'active' ? 'active' : 'active',
      accountNumber: d.account_number,
      accountName: d.account_name,
      bankName: d.bank_name,
      bvn: type === 'static' ? bvnToUse : undefined,
      expectedAmount: type === 'dynamic' ? expectedAmount : undefined,
      raw: d,
    });

    logger.info('Glyde virtual account created and stored', { userId, uid: record.uid, type });

    return res.status(201).json({
      success: true,
      message: 'Virtual account created successfully',
      data: {
        uid: record.uid,
        type: record.type,
        accountNumber: record.accountNumber,
        accountName: record.accountName,
        bankName: record.bankName,
        expectedAmount: record.expectedAmount,
        createdAt: record.createdAt,
      },
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: 'A virtual account with this reference already exists' });
    }
    logger.error('Create virtual account endpoint error', { error: err.stack, userId: req.user?.id });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /collections/virtual-accounts - list the caller's own accounts (from our DB)
router.get('/virtual-accounts', async (req, res) => {
  try {
    const accounts = await GlydeVirtualAccount.find({ userId: req.user.id }).sort({ createdAt: -1 }).lean();
    return res.json({
      success: true,
      data: accounts.map(a => ({
        uid: a.uid,
        type: a.type,
        status: a.status,
        accountNumber: a.accountNumber,
        accountName: a.accountName,
        bankName: a.bankName,
        expectedAmount: a.expectedAmount,
        createdAt: a.createdAt,
      })),
    });
  } catch (err) {
    logger.error('List virtual accounts endpoint error', { error: err.stack, userId: req.user?.id });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /collections/virtual-accounts/:uid/transactions - payments received on one account
router.get('/virtual-accounts/:uid/transactions', async (req, res) => {
  try {
    const { uid } = req.params;
    const account = await GlydeVirtualAccount.findOne({ uid, userId: req.user.id });
    if (!account) {
      return res.status(404).json({ success: false, message: 'Virtual account not found' });
    }

    const result = await getVirtualAccountTransactions(uid, req.query);
    if (!result.success) {
      return res.status(result.statusCode || 502).json({ success: false, message: result.message });
    }

    return res.json({ success: true, data: result.data });
  } catch (err) {
    logger.error('Virtual account transactions endpoint error', { error: err.stack, userId: req.user?.id, uid: req.params?.uid });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// POST /collections/virtual-accounts/:uid/deactivate
router.post('/virtual-accounts/:uid/deactivate', async (req, res) => {
  try {
    const { uid } = req.params;
    const account = await GlydeVirtualAccount.findOne({ uid, userId: req.user.id });
    if (!account) {
      return res.status(404).json({ success: false, message: 'Virtual account not found' });
    }

    const result = await deactivateVirtualAccount(uid);
    if (!result.success) {
      return res.status(result.statusCode || 502).json({ success: false, message: result.message });
    }

    account.status = 'inactive';
    await account.save();

    logger.info('Glyde virtual account deactivated', { userId: req.user.id, uid });

    return res.json({ success: true, message: 'Virtual account deactivated', data: { uid, status: 'inactive' } });
  } catch (err) {
    logger.error('Deactivate virtual account endpoint error', { error: err.stack, userId: req.user?.id, uid: req.params?.uid });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
