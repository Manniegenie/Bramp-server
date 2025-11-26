const express = require('express');
const router = express.Router();
const User = require('../models/user');
const Transaction = require('../models/transaction');
const ChatbotTransaction = require('../models/ChatbotTransaction');

router.post('/transactions-by-email', async (req, res) => {
  const { email, page = 1, limit = 20, includeChatbot = true } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  // Validate pagination parameters
  const pageNumber = parseInt(page);
  const limitNumber = parseInt(limit);

  if (pageNumber < 1) {
    return res.status(400).json({ error: 'Page number must be greater than 0' });
  }

  if (limitNumber < 1 || limitNumber > 100) {
    return res.status(400).json({ error: 'Limit must be between 1 and 100' });
  }

  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Calculate skip value for pagination
    const skip = (pageNumber - 1) * limitNumber;

    let allTransactions = [];
    let totalCount = 0;

    // Fetch regular transactions
    const regularTransactions = await Transaction.find({ userId: user._id })
      .sort({ createdAt: -1 })
      .lean();

    // Fetch chatbot transactions if requested
    let chatbotTransactions = [];
    if (includeChatbot) {
      chatbotTransactions = await ChatbotTransaction.find({ userId: user._id })
        .sort({ createdAt: -1 })
        .lean();
    }

    // Combine and format transactions
    const formattedRegular = regularTransactions.map(tx => ({
      ...tx,
      _id: tx._id.toString(),
      transactionType: 'regular',
      source: 'Transaction'
    }));

    const formattedChatbot = chatbotTransactions.map(tx => ({
      _id: tx._id.toString(),
      userId: tx.userId,
      kind: tx.kind,
      paymentId: tx.paymentId,
      webhookRef: tx.webhookRef,
      token: tx.token,
      network: tx.network,
      sellAmount: tx.sellAmount,
      originalAmount: tx.originalAmount,
      originalCurrency: tx.originalCurrency,
      quoteRate: tx.quoteRate,
      receiveCurrency: tx.receiveCurrency,
      receiveAmount: tx.receiveAmount,
      actualReceiveAmount: tx.actualReceiveAmount,
      actualRate: tx.actualRate,
      depositAddress: tx.depositAddress,
      depositMemo: tx.depositMemo,
      observedAmount: tx.observedAmount,
      observedTxHash: tx.observedTxHash,
      observedAt: tx.observedAt,
      payout: tx.payout,
      payoutStatus: tx.payoutStatus,
      status: tx.status,
      expiresAt: tx.expiresAt,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
      transactionType: 'chatbot',
      source: 'ChatbotTransaction',
      // Map to regular transaction fields for compatibility
      type: tx.kind,
      currency: tx.token,
      amount: tx.sellAmount,
      reference: tx.paymentId,
      narration: `${tx.kind} ${tx.token} - ${tx.paymentId}`,
      completedAt: tx.status === 'CONFIRMED' ? tx.updatedAt : null
    }));

    // Combine all transactions and sort by creation date
    allTransactions = [...formattedRegular, ...formattedChatbot]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    totalCount = allTransactions.length;

    // Apply pagination
    const paginatedTransactions = allTransactions.slice(skip, skip + limitNumber);

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalCount / limitNumber);
    const hasNextPage = pageNumber < totalPages;
    const hasPrevPage = pageNumber > 1;

    return res.status(200).json({
      success: true,
      transactions: paginatedTransactions,
      pagination: {
        currentPage: pageNumber,
        totalPages,
        totalTransactions: totalCount,
        limit: limitNumber,
        hasNextPage,
        hasPrevPage
      },
      summary: {
        regularTransactions: formattedRegular.length,
        chatbotTransactions: formattedChatbot.length,
        totalTransactions: totalCount
      }
    });
  } catch (error) {
    console.error('Error fetching transactions:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// New endpoint specifically for chatbot transactions
router.get('/chatbot-transactions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = (page - 1) * limit;

    const { 
      status, 
      kind, 
      token, 
      paymentId, 
      dateFrom, 
      dateTo,
      userId 
    } = req.query;

    // Build filter
    const filter = {};
    if (status) filter.status = status;
    if (kind) filter.kind = kind;
    if (token) filter.token = token.toUpperCase();
    if (paymentId) filter.paymentId = paymentId;
    if (userId) filter.userId = userId;

    // Date range filter
    if (dateFrom || dateTo) {
      filter.createdAt = {};
      if (dateFrom) {
        filter.createdAt.$gte = new Date(dateFrom);
      }
      if (dateTo) {
        const endDate = new Date(dateTo);
        endDate.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = endDate;
      }
    }

    const [transactions, totalCount] = await Promise.all([
      ChatbotTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('userId', 'username email firstname lastname phoneNumber')
        .lean(),
      ChatbotTransaction.countDocuments(filter)
    ]);

    const formattedTransactions = transactions.map(tx => ({
      _id: tx._id.toString(),
      userId: tx.userId?._id?.toString(),
      username: tx.userId?.username || tx.userId?.firstname || 'Unknown',
      userEmail: tx.userId?.email,
      userPhone: tx.userId?.phoneNumber,
      kind: tx.kind,
      paymentId: tx.paymentId,
      webhookRef: tx.webhookRef,
      token: tx.token,
      network: tx.network,
      sellAmount: tx.sellAmount,
      originalAmount: tx.originalAmount,
      originalCurrency: tx.originalCurrency,
      quoteRate: tx.quoteRate,
      receiveCurrency: tx.receiveCurrency,
      receiveAmount: tx.receiveAmount,
      actualReceiveAmount: tx.actualReceiveAmount,
      actualRate: tx.actualRate,
      depositAddress: tx.depositAddress,
      depositMemo: tx.depositMemo,
      observedAmount: tx.observedAmount,
      observedTxHash: tx.observedTxHash,
      observedAt: tx.observedAt,
      payout: tx.payout,
      payoutStatus: tx.payoutStatus,
      status: tx.status,
      expiresAt: tx.expiresAt,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt
    }));

    const totalPages = Math.ceil(totalCount / limit);

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      pagination: {
        currentPage: page,
        totalPages,
        limit,
        totalCount,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1
      },
      data: formattedTransactions
    });

  } catch (error) {
    console.error('Error fetching chatbot transactions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch chatbot transactions',
      message: error.message
    });
  }
});

module.exports = router;