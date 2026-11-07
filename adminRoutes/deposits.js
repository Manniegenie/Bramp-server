// adminRoutes/deposits.js
// Admin visibility into Glyde virtual account deposits: a reconciliation
// view (what Glyde says came in vs what we actually credited a user for -
// built specifically to catch the class of bug where a deposit lands on
// Glyde's side but the webhook was never registered/configured, so it never
// got credited) and a virtual accounts list/management view.
const express = require('express');
const router = express.Router();

const GlydeVirtualAccount = require('../models/glydeVirtualAccount');
const Transaction = require('../models/transaction');
const DepositFee = require('../models/depositFee');
const {
  checkWalletBalance,
  getVirtualAccountTransactions,
  extractGlydeTransactionList,
  deactivateVirtualAccount,
} = require('../services/collectionService');
const { computeIdempotencyReference } = require('../services/glydeDepositCrediting');
const logger = require('../utils/logger');

// GET /deposits/wallet-balance - live Glyde business wallet balance
// query: currency (optional, defaults to home currency - NGN for us)
router.get('/wallet-balance', async (req, res) => {
  try {
    const result = await checkWalletBalance(req.query.currency);
    if (!result.success) {
      return res.status(result.statusCode || 502).json({ success: false, message: result.message });
    }
    return res.json({ success: true, data: result.data });
  } catch (err) {
    logger.error('Admin wallet balance endpoint error', { error: err.stack });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /deposits/fee - current flat fee deducted from each confirmed deposit
router.get('/fee', async (req, res) => {
  try {
    const feeDoc = await DepositFee.getOrCreateCurrentFee();
    return res.json({
      success: true,
      data: {
        feeAmount: feeDoc.feeAmount,
        isActive: feeDoc.isActive,
        description: feeDoc.description,
        updatedBy: feeDoc.updatedBy,
        updatedAt: feeDoc.updatedAt,
      },
    });
  } catch (err) {
    logger.error('Get deposit fee endpoint error', { error: err.stack });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// PUT /deposits/fee - update the flat deposit fee
// body: { feeAmount, isActive?, description? }
router.put('/fee', async (req, res) => {
  try {
    const { feeAmount, isActive, description } = req.body;

    if (typeof feeAmount !== 'number' || feeAmount < 0) {
      return res.status(400).json({ success: false, message: 'feeAmount must be a non-negative number' });
    }

    const updatedBy = req.admin?.email || req.admin?.username || 'admin';

    const feeDoc = await DepositFee.getOrCreateCurrentFee();

    feeDoc.feeAmount = feeAmount;
    if (typeof isActive === 'boolean') feeDoc.isActive = isActive;
    if (description) feeDoc.description = description;
    feeDoc.updatedBy = updatedBy;
    await feeDoc.save();

    logger.info('Deposit fee updated', { feeAmount, isActive: feeDoc.isActive, updatedBy });

    return res.json({
      success: true,
      message: 'Deposit fee updated successfully',
      data: {
        feeAmount: feeDoc.feeAmount,
        isActive: feeDoc.isActive,
        description: feeDoc.description,
        updatedBy: feeDoc.updatedBy,
        updatedAt: feeDoc.updatedAt,
      },
    });
  } catch (err) {
    logger.error('Update deposit fee endpoint error', { error: err.stack });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /deposits/reconciliation - each of our virtual accounts' real
// transaction history from Glyde (account-scoped calls, not the global
// ledger), cross-checked against our own credited Transaction records.
//
// Originally pulled Glyde's global GET /v1/transactions and tried to match
// entries back to an account via merchant_reference - abandoned that
// approach (2026-09-28) after confirming merchant_reference doesn't
// correspond to our accounts at all, and the global list doesn't carry
// uid/account_number either, so there was no reliable field to match on.
// Per-account calls need no matching: the account is already known.
// query: page (default 1), limit (accounts per page, default 20)
router.get('/reconciliation', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(5, parseInt(req.query.limit, 10) || 20));

    const [accounts, totalAccounts] = await Promise.all([
      GlydeVirtualAccount.find({})
        .populate('userId', 'firstname lastname email phonenumber')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      GlydeVirtualAccount.countDocuments({}),
    ]);

    const reconciled = [];
    let uncreditedCount = 0;

    for (const account of accounts) {
      const userInfo = account.userId ? {
        id: account.userId._id,
        name: `${account.userId.firstname || ''} ${account.userId.lastname || ''}`.trim(),
        email: account.userId.email,
        phonenumber: account.userId.phonenumber,
      } : null;

      const result = await getVirtualAccountTransactions(account.uid, { per_page: 50 });
      if (!result.success) {
        // Surfaced as a row rather than silently skipped - e.g. the orphaned
        // "Virtual account not found" case seen in production 2026-09-28.
        reconciled.push({
          virtualAccountUid: account.uid,
          accountNumber: account.accountNumber,
          user: userInfo,
          error: result.message,
        });
        continue;
      }

      const items = extractGlydeTransactionList(result.data);
      const creditEntries = items.filter((t) => {
        const type = String(t.type || t.transaction_type || '').toLowerCase();
        return !type || type === 'credit';
      });

      for (const t of creditEntries) {
        const data = { ...t, uid: account.uid };
        const idempotencyReference = computeIdempotencyReference(data, account);
        const ourTransaction = await Transaction.findOne({ reference: idempotencyReference })
          .select('_id amount status createdAt metadata').lean();

        const status = t.status || null;
        // A Transaction record existing isn't enough - the fee-shortfall and
        // name-mismatch cases also create one (status FAILED) purely so the
        // deposit stays visible here rather than vanishing, not because it
        // was actually credited.
        const credited = ourTransaction?.status === 'SUCCESSFUL';
        const blockedReason = ourTransaction?.metadata?.nameMismatch
          ? 'name_mismatch'
          : (ourTransaction?.metadata?.nameUnverifiable
            ? 'name_unverifiable'
            : (ourTransaction?.metadata?.depositLimitExceeded
              ? 'deposit_limit_exceeded'
              : (ourTransaction?.status === 'FAILED' ? 'fee_shortfall' : null)));
        if (!credited && status && String(status).toLowerCase() !== 'failed') uncreditedCount += 1;

        reconciled.push({
          transactionId: ourTransaction?._id || null,
          glydeReference: t.reference || t.id || null,
          amount: t.amount != null ? Number(t.amount) : null,
          fee: t.fee != null ? Number(t.fee) : null,
          status,
          createdAt: t.created_at || t.createdAt || null,
          credited,
          blockedReason,
          needsManualReview: ourTransaction?.metadata?.needsManualReview === true,
          payerAccountName: ourTransaction?.metadata?.payerAccountName || null,
          creditedAt: credited ? ourTransaction?.createdAt || null : null,
          creditedAmount: credited ? ourTransaction?.amount ?? null : null,
          user: userInfo,
          virtualAccountUid: account.uid,
          accountNumber: account.accountNumber,
        });
      }
    }

    reconciled.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return res.json({
      success: true,
      data: {
        transactions: reconciled,
        uncreditedCount,
        page,
        limit,
        totalAccounts,
        totalPages: Math.ceil(totalAccounts / limit),
      },
    });
  } catch (err) {
    logger.error('Admin deposits reconciliation endpoint error', { error: err.stack });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// GET /deposits/virtual-accounts - our own DB record of every virtual
// account, joined with the owning user. DB-first (not a live Glyde call) so
// the user link is always available - Glyde's list doesn't know our userIds.
// query: page (default 1), limit (default 25), status ('active'|'inactive')
router.get('/virtual-accounts', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(10, parseInt(req.query.limit, 10) || 25));
    const filter = {};
    if (req.query.status && ['active', 'inactive'].includes(req.query.status)) {
      filter.status = req.query.status;
    }

    const [accounts, total] = await Promise.all([
      GlydeVirtualAccount.find(filter)
        .populate('userId', 'firstname lastname email phonenumber')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      GlydeVirtualAccount.countDocuments(filter),
    ]);

    return res.json({
      success: true,
      data: {
        accounts: accounts.map((a) => ({
          uid: a.uid,
          type: a.type,
          status: a.status,
          accountNumber: a.accountNumber,
          accountName: a.accountName,
          bankName: a.bankName,
          createdAt: a.createdAt,
          user: a.userId ? {
            id: a.userId._id,
            name: `${a.userId.firstname || ''} ${a.userId.lastname || ''}`.trim(),
            email: a.userId.email,
            phonenumber: a.userId.phonenumber,
          } : null,
        })),
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    logger.error('Admin list virtual accounts endpoint error', { error: err.stack });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// POST /deposits/virtual-accounts/:uid/deactivate - admin can deactivate any
// user's virtual account (e.g. suspected fraud, user requested closure).
router.post('/virtual-accounts/:uid/deactivate', async (req, res) => {
  try {
    const { uid } = req.params;
    const account = await GlydeVirtualAccount.findOne({ uid });
    if (!account) {
      return res.status(404).json({ success: false, message: 'Virtual account not found' });
    }

    const result = await deactivateVirtualAccount(uid);
    // A 404 here means Glyde has no record of this account at all (seen in
    // production 2026-09-28 - an account with real deposit history vanished
    // from Glyde's own /v1/virtual-accounts list). There's nothing left to
    // deactivate on their side, so treat it the same as success and just
    // clean up our own record - otherwise an orphaned account can never be
    // cleared, permanently blocking the user from generating a new one
    // (the create endpoint refuses a second "active" account per user).
    const glydeAlreadyGone = !result.success && result.statusCode === 404;
    if (!result.success && !glydeAlreadyGone) {
      return res.status(result.statusCode || 502).json({ success: false, message: result.message });
    }

    account.status = 'inactive';
    await account.save();

    logger.info('Admin deactivated Glyde virtual account', {
      uid,
      userId: account.userId,
      adminId: req.admin?.id || req.admin?._id,
      glydeAlreadyGone,
    });

    return res.json({
      success: true,
      message: glydeAlreadyGone
        ? 'Virtual account was already gone on Glyde\'s side - cleared locally so the user can generate a new one.'
        : 'Virtual account deactivated',
      data: { uid, status: 'inactive', glydeAlreadyGone },
    });
  } catch (err) {
    logger.error('Admin deactivate virtual account endpoint error', { error: err.stack, uid: req.params?.uid });
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

module.exports = router;
