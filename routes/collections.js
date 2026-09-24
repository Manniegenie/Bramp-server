// routes/collections.js
const express = require('express');
const GlydeVirtualAccount = require('../models/glydeVirtualAccount');
const User = require('../models/user');
const {
  createVirtualAccount,
  getVirtualAccountTransactions,
  deactivateVirtualAccount,
} = require('../services/collectionService');
const logger = require('../utils/logger');

const router = express.Router();

// ---------------------------------------------------------------------
// Virtual Accounts - dedicated bank accounts (Glyde). This file used to also
// have wallet-funding endpoints built on Glyde's hosted-checkout Collection
// product (POST /initialize, GET /status/:reference) - those are removed
// now that Virtual Accounts cover that use case. The underlying
// initializeCollection() function still exists in services/collectionService.js
// and is still used by routes/buy.js for a separate feature (paying for a
// crypto purchase), so it wasn't touched.
//
// Virtual Accounts are also intended to eventually replace the Nomba
// virtual-account flow (routes/Nombadeposit.js), but that cutover is a
// deliberate later step, not part of this file.
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
