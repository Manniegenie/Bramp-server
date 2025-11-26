// routes/analytics.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/user');
const ChatbotTransaction = require('../models/ChatbotTransaction');

/**
 * GET /analytics/dashboard
 * Fetch essential dashboard statistics
 */
router.get('/dashboard', async (req, res) => {
  try {
    const [
      userStats,
      chatbotTransactionStats,
      recentChatbotTrades,
      tokenStats
    ] = await Promise.all([
      // Basic user statistics
      User.aggregate([
        {
          $group: {
            _id: null,
            totalUsers: { $sum: 1 },
            verifiedEmails: { $sum: { $cond: ['$emailVerified', 1, 0] } },
            verifiedBVNs: { $sum: { $cond: ['$bvnVerified', 1, 0] } },
            chatbotVerified: { $sum: { $cond: ['$chatbotTransactionVerified', 1, 0] } }
          }
        }
      ]),

      // Chatbot transaction statistics (all transactions)
      ChatbotTransaction.aggregate([
        {
          $group: {
            _id: null,
            totalChatbotTransactions: { $sum: 1 },
            sellTransactions: { $sum: { $cond: [{ $eq: ['$kind', 'SELL'] }, 1, 0] } },
            buyTransactions: { $sum: { $cond: [{ $eq: ['$kind', 'BUY'] }, 1, 0] } },
            completedChatbot: { $sum: { $cond: [{ $in: ['$status', ['CONFIRMED', 'COMPLETED']] }, 1, 0] } },
            pendingChatbot: { $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0] } },
            expiredChatbot: { $sum: { $cond: [{ $eq: ['$status', 'EXPIRED'] }, 1, 0] } },
            // Volume calculations for chatbot transactions (exclude expired)
            totalSellVolume: { $sum: { $cond: [{ $and: [{ $eq: ['$kind', 'SELL'] }, { $ne: ['$status', 'EXPIRED'] }] }, '$sellAmount', 0] } },
            totalReceiveVolume: { $sum: { $cond: [{ $and: [{ $eq: ['$kind', 'SELL'] }, { $ne: ['$status', 'EXPIRED'] }] }, '$receiveAmount', 0] } },
            totalActualReceiveVolume: { $sum: { $cond: [{ $and: [{ $eq: ['$kind', 'SELL'] }, { $ne: ['$status', 'EXPIRED'] }] }, '$actualReceiveAmount', 0] } }
          }
        }
      ]),

      // Recent chatbot transactions (last 24 hours) - exclude expired from volume
      ChatbotTransaction.aggregate([
        {
          $match: {
            createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
          }
        },
        {
          $group: {
            _id: null,
            transactions24h: { $sum: 1 },
            sellTransactions24h: { $sum: { $cond: [{ $eq: ['$kind', 'SELL'] }, 1, 0] } },
            buyTransactions24h: { $sum: { $cond: [{ $eq: ['$kind', 'BUY'] }, 1, 0] } },
            volume24h: { $sum: { $cond: [{ $ne: ['$status', 'EXPIRED'] }, { $abs: '$sellAmount' }, 0] } }
          }
        }
      ]),

      // Token distribution in chatbot transactions
      ChatbotTransaction.aggregate([
        {
          $match: {
            status: { $in: ['CONFIRMED', 'COMPLETED', 'PENDING'] }
          }
        },
        {
          $group: {
            _id: '$token',
            transactionCount: { $sum: 1 },
            sellCount: { $sum: { $cond: [{ $eq: ['$kind', 'SELL'] }, 1, 0] } },
            buyCount: { $sum: { $cond: [{ $eq: ['$kind', 'BUY'] }, 1, 0] } },
            totalVolume: { $sum: { $cond: [{ $ne: ['$status', 'EXPIRED'] }, { $abs: '$sellAmount' }, 0] } }
          }
        },
        { $sort: { totalVolume: -1 } },
        { $limit: 10 }
      ])
    ]);

    const response = {
      success: true,
      timestamp: new Date().toISOString(),
      data: {
        // User Overview
        users: {
          total: userStats[0]?.totalUsers || 0,
          emailVerified: userStats[0]?.verifiedEmails || 0,
          bvnVerified: userStats[0]?.verifiedBVNs || 0,
          chatbotVerified: userStats[0]?.chatbotVerified || 0
        },

        // Transaction Statistics (only chatbot transactions)
        transactions: {
          total: chatbotTransactionStats[0]?.totalChatbotTransactions || 0,
          sell: chatbotTransactionStats[0]?.sellTransactions || 0,
          buy: chatbotTransactionStats[0]?.buyTransactions || 0,
          completed: chatbotTransactionStats[0]?.completedChatbot || 0,
          pending: chatbotTransactionStats[0]?.pendingChatbot || 0,
          expired: chatbotTransactionStats[0]?.expiredChatbot || 0
        },

        // Chatbot Transaction Statistics
        chatbotTransactions: {
          total: chatbotTransactionStats[0]?.totalChatbotTransactions || 0,
          sell: chatbotTransactionStats[0]?.sellTransactions || 0,
          buy: chatbotTransactionStats[0]?.buyTransactions || 0,
          completed: chatbotTransactionStats[0]?.completedChatbot || 0,
          pending: chatbotTransactionStats[0]?.pendingChatbot || 0,
          expired: chatbotTransactionStats[0]?.expiredChatbot || 0,
          volume: {
            totalSellVolume: chatbotTransactionStats[0]?.totalSellVolume || 0,
            totalReceiveVolume: chatbotTransactionStats[0]?.totalReceiveVolume || 0,
            totalActualReceiveVolume: chatbotTransactionStats[0]?.totalActualReceiveVolume || 0
          }
        },

        // Chatbot Trading Statistics (for backward compatibility)
        chatbotTrades: {
          overview: {
            total: chatbotTransactionStats[0]?.totalChatbotTransactions || 0,
            sell: chatbotTransactionStats[0]?.sellTransactions || 0,
            buy: chatbotTransactionStats[0]?.buyTransactions || 0,
            completed: chatbotTransactionStats[0]?.completedChatbot || 0,
            pending: chatbotTransactionStats[0]?.pendingChatbot || 0,
            expired: chatbotTransactionStats[0]?.expiredChatbot || 0,
            cancelled: 0
          },
          volume: {
            totalSellVolume: chatbotTransactionStats[0]?.totalSellVolume || 0,
            totalBuyVolumeNGN: chatbotTransactionStats[0]?.totalReceiveVolume || 0,
            totalReceiveAmount: chatbotTransactionStats[0]?.totalActualReceiveVolume || 0
          },
          success: {
            successfulPayouts: chatbotTransactionStats[0]?.completedChatbot || 0,
            successfulCollections: chatbotTransactionStats[0]?.completedChatbot || 0
          },
          recent24h: {
            trades: recentChatbotTrades[0]?.transactions24h || 0,
            sellTrades: recentChatbotTrades[0]?.sellTransactions24h || 0,
            buyTrades: recentChatbotTrades[0]?.buyTransactions24h || 0,
            volume: recentChatbotTrades[0]?.volume24h || 0
          }
        },

        // Recent Activity
        recentActivity: {
          transactions: recentChatbotTrades[0]?.transactions24h || 0,
          sellTransactions: recentChatbotTrades[0]?.sellTransactions24h || 0,
          buyTransactions: recentChatbotTrades[0]?.buyTransactions24h || 0,
          volume: recentChatbotTrades[0]?.volume24h || 0
        },

        // Transaction Volume
        transactionVolume: chatbotTransactionStats[0]?.totalSellVolume || 0,

        // Token Statistics
        tokenStats: tokenStats
      }
    };

    res.json(response);

  } catch (error) {
    console.error('Error fetching dashboard analytics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch analytics data',
      message: error.message
    });
  }
});

/**
 * GET /analytics/recent-transactions
 */
router.get('/recent-transactions', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = (page - 1) * limit;

    const { username, transactionId, date, dateFrom, dateTo, type, status } = req.query;
    const filter = {};

    if (username) {
      const escapeForRegex = (s) => {
        if (!s) return s;
        const specials = ['.', '*', '+', '?', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\', '/'];
        let out = s;
        for (const ch of specials) out = out.split(ch).join('\\' + ch);
        return out;
      };

      const escaped = escapeForRegex(username);
      const regex = new RegExp(`^${escaped}$`, 'i');

      const user = await User.findOne({
        $or: [
          { username: regex },
          { firstname: regex },
          { lastname: regex }
        ]
      }).select('_id').lean();

      if (user && user._id) {
        filter.userId = user._id;
      } else {
        return res.json({
          success: true,
          timestamp: new Date().toISOString(),
          pagination: { currentPage: page, totalPages: 0, limit, totalCount: 0, hasNextPage: false, hasPreviousPage: false },
          data: []
        });
      }
    }

    if (transactionId) {
      const orClauses = [];
      if (mongoose.Types.ObjectId.isValid(transactionId)) {
        orClauses.push({ _id: mongoose.Types.ObjectId(transactionId) });
      }
      orClauses.push({ transactionId: transactionId });
      orClauses.push({ reference: transactionId });
      orClauses.push({ 'receiptDetails.transactionId': transactionId });
      filter.$or = orClauses;
    }

    if (date) {
      const d = new Date(date);
      if (!isNaN(d.getTime())) {
        const start = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0));
        const end = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999));
        filter.createdAt = { $gte: start, $lte: end };
      }
    } else if (dateFrom || dateTo) {
      const range = {};
      if (dateFrom) {
        const d1 = new Date(dateFrom);
        if (!isNaN(d1.getTime())) range.$gte = new Date(Date.UTC(d1.getFullYear(), d1.getMonth(), d1.getDate(), 0, 0, 0));
      }
      if (dateTo) {
        const d2 = new Date(dateTo);
        if (!isNaN(d2.getTime())) range.$lte = new Date(Date.UTC(d2.getFullYear(), d2.getMonth(), d2.getDate(), 23, 59, 59, 999));
      }
      if (Object.keys(range).length) filter.createdAt = range;
    }

    if (type) filter.kind = type;
    if (status) filter.status = status;

    // Fetch all chatbot transactions (including expired)
    const [chatbotTransactions, totalCount] = await Promise.all([
      ChatbotTransaction.find(filter)
        .sort({ createdAt: -1 })
        .limit(limit)
        .skip(skip)
        .populate('userId', 'username email firstname lastname')
        .lean(),
      ChatbotTransaction.countDocuments(filter)
    ]);

    const formattedTransactions = chatbotTransactions.map(tx => ({
      id: tx._id.toString(),
      userId: tx.userId?._id?.toString(),
      username: tx.userId?.username || tx.userId?.firstname || 'Unknown',
      userEmail: tx.userId?.email,
      type: tx.kind, // SELL or BUY
      status: tx.status,
      currency: tx.token,
      amount: tx.sellAmount,
      narration: `${tx.kind} ${tx.token} - ${tx.paymentId}`,
      reference: tx.paymentId,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
      completedAt: (tx.status === 'CONFIRMED' || tx.status === 'COMPLETED') ? tx.updatedAt : null,
      // Chatbot-specific fields
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
      payout: tx.payout || null,
      payoutStatus: tx.payoutStatus,
      expiresAt: tx.expiresAt
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
    console.error('Error fetching recent transactions:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch recent transactions',
      message: error.message
    });
  }
});

/**
 * GET /analytics/filter
 * Universal filter endpoint
 */
router.get('/filter', async (req, res) => {
  try {
    const {
      searchTerm,
      dateFrom,
      dateTo,
      transactionType,
      transactionStatus,
      userVerificationStatus,
      currency,
      minAmount,
      maxAmount,
      page = 1,
      limit = 50
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(parseInt(limit), 200);
    const skip = (pageNum - 1) * limitNum;

    // Build date range filter
    const dateFilter = {};
    if (dateFrom) {
      const d1 = new Date(dateFrom);
      if (!isNaN(d1.getTime())) {
        dateFilter.$gte = new Date(Date.UTC(d1.getFullYear(), d1.getMonth(), d1.getDate(), 0, 0, 0));
      }
    }
    if (dateTo) {
      const d2 = new Date(dateTo);
      if (!isNaN(d2.getTime())) {
        dateFilter.$lte = new Date(Date.UTC(d2.getFullYear(), d2.getMonth(), d2.getDate(), 23, 59, 59, 999));
      }
    }

    // Build transaction filter
    const transactionFilter = {};
    if (Object.keys(dateFilter).length) {
      transactionFilter.createdAt = dateFilter;
    }
    if (transactionType) {
      transactionFilter.kind = transactionType;
    }
    if (transactionStatus) {
      transactionFilter.status = transactionStatus;
    }
    if (currency) {
      transactionFilter.token = currency.toUpperCase();
    }
    if (minAmount || maxAmount) {
      transactionFilter.sellAmount = {};
      if (minAmount) transactionFilter.sellAmount.$gte = parseFloat(minAmount);
      if (maxAmount) transactionFilter.sellAmount.$lte = parseFloat(maxAmount);
    }

    // Build user filter
    const userFilter = {};
    if (userVerificationStatus === 'emailVerified') {
      userFilter.emailVerified = true;
    } else if (userVerificationStatus === 'bvnVerified') {
      userFilter.bvnVerified = true;
    } else if (userVerificationStatus === 'chatbotVerified') {
      userFilter.chatbotTransactionVerified = true;
    } else if (userVerificationStatus === 'unverified') {
      userFilter.emailVerified = false;
      userFilter.bvnVerified = false;
    }

    // Search logic - build $or array for EITHER user match OR transaction field match
    let userIds = [];
    if (searchTerm) {
      const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escapeRegex(searchTerm), 'i');

      // Search for matching users
      const matchingUsers = await User.find({
        $or: [
          { username: regex },
          { email: regex },
          { firstname: regex },
          { lastname: regex },
          { phoneNumber: regex }
        ],
        ...userFilter
      }).select('_id').lean();

      userIds = matchingUsers.map(u => u._id);

      // Build $or array for EITHER user match OR transaction field match
      const searchOrClauses = [];

      // Add user ID matches
      if (userIds.length > 0) {
        searchOrClauses.push({ userId: { $in: userIds } });
      }

      // Add transaction field matches
      if (mongoose.Types.ObjectId.isValid(searchTerm)) {
        searchOrClauses.push({ _id: mongoose.Types.ObjectId(searchTerm) });
      }
      searchOrClauses.push({ paymentId: regex });

      // Set as $or so ANY condition matches
      if (searchOrClauses.length > 0) {
        transactionFilter.$or = searchOrClauses;
      }
    }

    // Execute queries in parallel - all chatbot transactions (including expired)
    const [chatbotTransactions, chatbotCount, users, userCount] = await Promise.all([
      ChatbotTransaction.find(transactionFilter)
        .sort({ createdAt: -1 })
        .limit(limitNum)
        .skip(skip)
        .populate('userId', 'username email firstname lastname')
        .lean(),
      ChatbotTransaction.countDocuments(transactionFilter),
      searchTerm || Object.keys(userFilter).length > 0
        ? User.find({
          ...(searchTerm && userIds.length > 0 ? { _id: { $in: userIds } } : {}),
          ...userFilter
        })
          .sort({ createdAt: -1 })
          .limit(limitNum)
          .select('username email firstname lastname emailVerified bvnVerified chatbotTransactionVerified createdAt')
          .lean()
        : [],
      searchTerm || Object.keys(userFilter).length > 0
        ? User.countDocuments({
          ...(searchTerm && userIds.length > 0 ? { _id: { $in: userIds } } : {}),
          ...userFilter
        })
        : 0
    ]);

    const totalTransactionCount = chatbotCount;

    // Format transactions - only chatbot transactions
    const formattedTransactions = chatbotTransactions.map(tx => ({
      id: tx._id.toString(),
      userId: tx.userId?._id?.toString(),
      username: tx.userId?.username || tx.userId?.firstname || 'Unknown',
      userEmail: tx.userId?.email,
      type: tx.kind, // SELL or BUY
      status: tx.status,
      currency: tx.token,
      amount: tx.sellAmount,
      narration: `${tx.kind} ${tx.token} - ${tx.paymentId}`,
      reference: tx.paymentId,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
      completedAt: (tx.status === 'CONFIRMED' || tx.status === 'COMPLETED') ? tx.updatedAt : null,
      // Chatbot-specific fields
      paymentId: tx.paymentId,
      // webhookRef removed in new system
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
      payout: tx.payout || null,
      payoutStatus: tx.payoutStatus,
      expiresAt: tx.expiresAt
    }));

    // Format users
    const formattedUsers = users.map(user => ({
      id: user._id.toString(),
      username: user.username,
      email: user.email,
      firstname: user.firstname,
      lastname: user.lastname,
      emailVerified: user.emailVerified || false,
      bvnVerified: user.bvnVerified || false,
      chatbotVerified: user.chatbotTransactionVerified || false,
      createdAt: user.createdAt
    }));

    // Calculate aggregate statistics for chatbot transactions (exclude expired from volume)
    const aggregateStats = await ChatbotTransaction.aggregate([
      { $match: transactionFilter },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: { $cond: [{ $ne: ['$status', 'EXPIRED'] }, { $abs: '$sellAmount' }, 0] } },
          totalReceiveAmount: { $sum: { $cond: [{ $ne: ['$status', 'EXPIRED'] }, '$receiveAmount', 0] } },
          totalActualReceiveAmount: { $sum: { $cond: [{ $ne: ['$status', 'EXPIRED'] }, '$actualReceiveAmount', 0] } },
          avgAmount: { $avg: { $cond: [{ $ne: ['$status', 'EXPIRED'] }, { $abs: '$sellAmount' }, null] } },
          successfulCount: {
            $sum: {
              $cond: [{ $in: ['$status', ['CONFIRMED', 'COMPLETED']] }, 1, 0]
            }
          },
          pendingCount: {
            $sum: { $cond: [{ $eq: ['$status', 'PENDING'] }, 1, 0] }
          },
          expiredCount: {
            $sum: { $cond: [{ $eq: ['$status', 'EXPIRED'] }, 1, 0] }
          }
        }
      }
    ]);

    const totalPages = Math.ceil(Math.max(totalTransactionCount, userCount) / limitNum);

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      filters: {
        searchTerm: searchTerm || null,
        dateFrom: dateFrom || null,
        dateTo: dateTo || null,
        transactionType: transactionType || null,
        transactionStatus: transactionStatus || null,
        userVerificationStatus: userVerificationStatus || null,
        currency: currency || null,
        minAmount: minAmount || null,
        maxAmount: maxAmount || null
      },
      pagination: {
        currentPage: pageNum,
        totalPages,
        limit: limitNum,
        totalCount: Math.max(totalTransactionCount, userCount),
        transactionCount: totalTransactionCount,
        chatbotTransactionCount: chatbotCount,
        userCount,
        hasNextPage: pageNum < totalPages,
        hasPreviousPage: pageNum > 1
      },
      aggregateStats: {
        totalAmount: aggregateStats[0]?.totalAmount || 0,
        totalReceiveAmount: aggregateStats[0]?.totalReceiveAmount || 0,
        totalActualReceiveAmount: aggregateStats[0]?.totalActualReceiveAmount || 0,
        avgAmount: aggregateStats[0]?.avgAmount || 0,
        successfulCount: aggregateStats[0]?.successfulCount || 0,
        pendingCount: aggregateStats[0]?.pendingCount || 0,
        expiredCount: aggregateStats[0]?.expiredCount || 0
      },
      data: {
        transactions: formattedTransactions,
        users: formattedUsers
      }
    });

  } catch (error) {
    console.error('Error in universal filter endpoint:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to filter data',
      message: error.message
    });
  }
});

/**
 * GET /analytics/swap-pairs
 * Now returns top tokens by chatbot transaction volume
 */
router.get('/swap-pairs', async (req, res) => {
  try {
    const { timeframe = '24h' } = req.query;

    const timeAgo = new Date();
    const hours = timeframe === '24h' ? 24 :
      timeframe === '7d' ? 24 * 7 :
        timeframe === '30d' ? 24 * 30 : 24;
    timeAgo.setHours(timeAgo.getHours() - hours);

    const tokenStats = await ChatbotTransaction.aggregate([
      {
        $match: {
          kind: 'SELL',
          status: { $in: ['CONFIRMED', 'PENDING'] },
          createdAt: { $gte: timeAgo }
        }
      },
      {
        $group: {
          _id: '$token',
          totalTransactions: { $sum: 1 },
          totalVolume: { $sum: { $abs: '$sellAmount' } },
          avgReceiveAmount: { $avg: '$receiveAmount' },
          uniqueUsers: { $addToSet: '$userId' }
        }
      },
      {
        $project: {
          _id: 0,
          token: '$_id',
          totalTransactions: 1,
          totalVolume: 1,
          avgReceiveAmount: 1,
          uniqueUsers: { $size: '$uniqueUsers' }
        }
      },
      { $sort: { totalVolume: -1 } }
    ]);

    res.json({
      success: true,
      timeframe,
      data: tokenStats
    });

  } catch (error) {
    console.error('Error fetching token analytics:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch token analytics',
      message: error.message
    });
  }
});

module.exports = router;