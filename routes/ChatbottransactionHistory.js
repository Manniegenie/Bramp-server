const express = require('express');
const router = express.Router();
const ChatbotTransaction = require('../models/ChatbotTransaction');
const logger = require('../utils/logger');
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs').promises;
const rateLimit = require('express-rate-limit');

// Helper function to build date range filter
function buildDateRangeFilter(dateFrom, dateTo) {
  const filter = {};
  
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
  
  return filter;
}

// Helper function to get default date range (current month)
function getDefaultDateRange() {
  const now = new Date();
  const dateTo = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const dateFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  
  return {
    dateFrom: dateFrom.toISOString().split('T')[0],
    dateTo: dateTo.toISOString().split('T')[0]
  };
}

// Date normalization function to handle various date formats
function normalizeDateRange(dateInput) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  // Handle relative dates
  if (typeof dateInput === 'string') {
    const input = dateInput.toLowerCase().trim();
    
    // Last N days/weeks/months
    if (input.includes('last')) {
      const match = input.match(/last\s+(\d+)\s*(day|week|month|year)s?/);
      if (match) {
        const amount = parseInt(match[1]);
        const unit = match[2];
        const dateFrom = new Date(today);
        
        switch (unit) {
          case 'day':
            dateFrom.setDate(dateFrom.getDate() - amount);
            break;
          case 'week':
            dateFrom.setDate(dateFrom.getDate() - (amount * 7));
            break;
          case 'month':
            dateFrom.setMonth(dateFrom.getMonth() - amount);
            break;
          case 'year':
            dateFrom.setFullYear(dateFrom.getFullYear() - amount);
            break;
        }
        
        return {
          dateFrom: dateFrom.toISOString().split('T')[0],
          dateTo: today.toISOString().split('T')[0]
        };
      }
    }
    
    // This month/year
    if (input === 'this month') {
      const dateFrom = new Date(now.getFullYear(), now.getMonth(), 1);
      const dateTo = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return {
        dateFrom: dateFrom.toISOString().split('T')[0],
        dateTo: dateTo.toISOString().split('T')[0]
      };
    }
    
    if (input === 'this year') {
      const dateFrom = new Date(now.getFullYear(), 0, 1);
      const dateTo = new Date(now.getFullYear(), 11, 31);
      return {
        dateFrom: dateFrom.toISOString().split('T')[0],
        dateTo: dateTo.toISOString().split('T')[0]
      };
    }
    
    // Since last Monday, etc.
    if (input.includes('since last')) {
      const dayMap = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0 };
      const match = input.match(/since last (monday|tuesday|wednesday|thursday|friday|saturday|sunday)/);
      if (match) {
        const targetDay = dayMap[match[1]];
        const dateFrom = new Date(today);
        const daysSince = (today.getDay() - targetDay + 7) % 7;
        dateFrom.setDate(dateFrom.getDate() - daysSince);
        
        return {
          dateFrom: dateFrom.toISOString().split('T')[0],
          dateTo: today.toISOString().split('T')[0]
        };
      }
    }
  }
  
  // Handle object with dateFrom/dateTo
  if (typeof dateInput === 'object' && dateInput.dateFrom && dateInput.dateTo) {
    return {
      dateFrom: new Date(dateInput.dateFrom).toISOString().split('T')[0],
      dateTo: new Date(dateInput.dateTo).toISOString().split('T')[0]
    };
  }
  
  // Default to current month
  return getDefaultDateRange();
}

// Rate limiting for PDF generation (5 PDFs per hour per user)
const pdfRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 PDFs per hour
  message: { success: false, message: 'Too many PDF requests. Please try again later.' },
  keyGenerator: (req) => req.user?.id || req.ip, // Rate limit per user
  standardHeaders: true,
  legacyHeaders: false
});

// Helper functions for formatting
function formatTransactionKind(kind) {
  const kindMap = {
    'SELL': 'Sell Crypto',
    'BUY': 'Buy Crypto'
  };
  return kindMap[kind] || kind;
}

function formatStatus(status, payoutStatus, collectionStatus, kind) {
  // For SELL transactions, consider both main status and payout status
  if (kind === 'SELL') {
    if (status === 'CONFIRMED' && payoutStatus === 'SUCCESS') {
      return 'Completed';
    }
    if (status === 'CONFIRMED' && payoutStatus === 'FAILED') {
      return 'Payout Failed';
    }
    if (status === 'CONFIRMED' && payoutStatus === 'REQUESTED') {
      return 'Processing Payout';
    }
    if (status === 'EXPIRED' || status === 'CANCELLED') {
      return 'Cancelled';
    }
    if (status === 'PENDING') {
      return 'Awaiting Deposit';
    }
    return 'Pending';
  }
  
  // For BUY transactions, consider both main status and collection status
  if (kind === 'BUY') {
    if (collectionStatus === 'SUCCESS' && status === 'PAID') {
      return 'Completed';
    }
    if (collectionStatus === 'FAILED') {
      return 'Payment Failed';
    }
    if (collectionStatus === 'REQUESTED') {
      return 'Awaiting Payment';
    }
    if (status === 'EXPIRED' || status === 'CANCELLED') {
      return 'Cancelled';
    }
    return 'Pending';
  }
  
  return 'Pending';
}

function formatAmount(transaction) {
  const { kind, sellAmount, buyAmount, receiveAmount, token, receiveCurrency } = transaction;
  
  if (kind === 'SELL') {
    return {
      primary: `${sellAmount} ${token}`,
      secondary: `₦${receiveAmount?.toLocaleString() || '0'}`
    };
  }
  
  if (kind === 'BUY') {
    return {
      primary: `₦${buyAmount?.toLocaleString() || '0'}`,
      secondary: `${receiveAmount || 0} ${token}`
    };
  }
  
  return {
    primary: `${receiveAmount || 0} ${receiveCurrency}`,
    secondary: null
  };
}

// Always format display date in Africa/Lagos
function formatDate(date) {
  return new Date(date).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Africa/Lagos'
  });
}

// POST /api/transactions/chatbot-history - Get chatbot transaction history
router.post('/chatbot-history', async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    // Simple validation with defaults
    const body = req.body || {};
    const {
      kind, // 'SELL' or 'BUY'
      token,
      network,
      status,
      page = 1,
      limit = 20,
      sortBy = 'createdAt',
      sortOrder = 'desc'
    } = body;

    // Get date range
    const defaultRange = getDefaultDateRange();
    const dateFrom = body.dateFrom || defaultRange.dateFrom;
    const dateTo = body.dateTo || defaultRange.dateTo;

    // Build filter
    const filter = { userId: userId };

    // Add date range filter
    Object.assign(filter, buildDateRangeFilter(dateFrom, dateTo));

    // Add transaction kind filter
    if (kind) {
      filter.kind = kind.toUpperCase();
    }

    // Add token filter
    if (token) {
      filter.token = token.toUpperCase();
    }

    // Add network filter
    if (network) {
      filter.network = network.toUpperCase();
    }

    // Add status filter
    if (status) {
      switch (status.toLowerCase()) {
        case 'completed':
          // For completed transactions, we need complex logic
          filter.$or = [
            { kind: 'SELL', status: 'CONFIRMED', payoutStatus: 'SUCCESS' },
            { kind: 'BUY', collectionStatus: 'SUCCESS', status: 'PAID' }
          ];
          break;
        case 'pending':
          filter.$or = [
            { status: { $in: ['PENDING', 'CONFIRMED'] }, payoutStatus: { $in: ['NOT_SET', 'REQUESTED'] } },
            { status: { $in: ['PENDING'] }, collectionStatus: { $in: ['NOT_SET', 'REQUESTED'] } }
          ];
          break;
        case 'failed':
          filter.$or = [
            { payoutStatus: 'FAILED' },
            { collectionStatus: 'FAILED' }
          ];
          break;
        case 'cancelled':
          filter.status = { $in: ['EXPIRED', 'CANCELLED'] };
          break;
      }
    }

    // Pagination
    const skip = (page - 1) * limit;
    const sort = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

    // Get transactions
    const [transactions, totalCount] = await Promise.all([
      ChatbotTransaction.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      ChatbotTransaction.countDocuments(filter)
    ]);

    // Format transactions
    const formattedTransactions = transactions.map(tx => {
      const createdAtISO = new Date(tx.createdAt).toISOString();
      const amounts = formatAmount(tx);
      
      return {
        id: tx._id,
        paymentId: tx.paymentId,
        kind: formatTransactionKind(tx.kind),
        status: formatStatus(tx.status, tx.payoutStatus, tx.collectionStatus, tx.kind),
        token: tx.token,
        network: tx.network,
        amounts: amounts,
        quoteRate: tx.quoteRate,
        date: formatDate(tx.createdAt),
        createdAt: createdAtISO,
        details: {
          webhookRef: tx.webhookRef,
          kind: tx.kind,
          token: tx.token,
          network: tx.network,
          quoteRate: tx.quoteRate,
          receiveCurrency: tx.receiveCurrency,
          
          // SELL specific details
          ...(tx.kind === 'SELL' && {
            sellAmount: tx.sellAmount,
            depositAddress: tx.depositAddress,
            depositMemo: tx.depositMemo,
            cryptoToReceive: tx.cryptoToReceive,
            obiexRate: tx.obiexRate,
            payoutStatus: tx.payoutStatus,
            payoutAmount: tx.payoutAmount,
            bankDetails: tx.payout ? {
              bankName: tx.payout.bankName,
              accountNumber: tx.payout.accountNumber,
              accountName: tx.payout.accountName
            } : null
          }),
          
          // BUY specific details
          ...(tx.kind === 'BUY' && {
            buyAmount: tx.buyAmount,
            tokenAmount: tx.tokenAmount,
            collectionStatus: tx.collectionStatus,
            collectionAmount: tx.collectionAmount,
            walletAddress: tx.collectionDetails?.walletAddress,
            walletNetwork: tx.collectionDetails?.walletNetwork,
            paymentUrl: tx.collectionResult?.paymentUrl
          }),
          
          observedTxHash: tx.observedTxHash,
          observedAmount: tx.observedAmount,
          observedAt: tx.observedAt,
          expiresAt: tx.expiresAt
        }
      };
    });

    return res.status(200).json({
      success: true,
      message: 'Chatbot transaction history retrieved successfully',
      data: {
        transactions: formattedTransactions,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(totalCount / limit),
          totalCount,
          limit: parseInt(limit)
        },
        dateRange: {
          dateFrom,
          dateTo
        },
        filters: {
          kind,
          token,
          network,
          status
        }
      }
    });

  } catch (error) {
    logger.error('Error fetching chatbot transaction history', {
      userId: req.user?.id,
      filters: req.body,
      error: error.message
    });

    return res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// PDF Generation Route
router.post('/chatbot-history-pdf', pdfRateLimit, async (req, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: 'Unauthorized' });
    }

    const { dateRange } = req.body || {};
    const normalizedRange = normalizeDateRange(dateRange);
    
    // Get all transactions for the date range
    const filter = { 
      userId: userId,
      ...buildDateRangeFilter(normalizedRange.dateFrom, normalizedRange.dateTo)
    };
    
    const transactions = await ChatbotTransaction.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    // Generate HTML for PDF
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Bramp Transaction History</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          .header { text-align: center; margin-bottom: 30px; }
          .logo { font-size: 24px; font-weight: bold; color: #2563eb; }
          .date-range { color: #666; margin-top: 10px; }
          table { width: 100%; border-collapse: collapse; margin-top: 20px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f2f2f2; }
          .status-completed { color: green; }
          .status-pending { color: orange; }
          .status-failed { color: red; }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="logo">Bramp Transaction History</div>
          <div class="date-range">${normalizedRange.dateFrom} to ${normalizedRange.dateTo}</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Token</th>
            </tr>
          </thead>
          <tbody>
            ${transactions.map(tx => `
              <tr>
                <td>${formatDate(tx.createdAt)}</td>
                <td>${formatTransactionKind(tx.kind)}</td>
                <td>${formatAmount(tx).primary}</td>
                <td class="status-${formatStatus(tx.status, tx.payoutStatus, tx.collectionStatus, tx.kind).toLowerCase().replace(' ', '-')}">
                  ${formatStatus(tx.status, tx.payoutStatus, tx.collectionStatus, tx.kind)}
                </td>
                <td>${tx.token}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </body>
      </html>
    `;

    // Generate PDF
    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(html);
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    await browser.close();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="bramp-transactions-${Date.now()}.pdf"`);
    res.send(pdf);

  } catch (error) {
    logger.error('Error generating PDF', { userId: req.user?.id, error: error.message });
    res.status(500).json({ success: false, message: 'PDF generation failed' });
  }
});

// Test endpoint for PDF generation
router.post('/test-pdf', async (req, res) => {
  try {
    const testDateRange = "last 30 days";
    const normalizedRange = normalizeDateRange(testDateRange);
    
    res.json({
      success: true,
      message: 'PDF generation test endpoint',
      testData: {
        inputDateRange: testDateRange,
        normalizedRange: normalizedRange,
        endpoint: '/chatbot-history-pdf',
        rateLimit: '5 PDFs per hour per user',
        authentication: 'Required'
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Test endpoint error',
      error: error.message
    });
  }
});

module.exports = router;