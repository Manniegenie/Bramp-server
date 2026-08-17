const cron = require('node-cron');
const PriceChange = require('../models/pricechange');
const { sendPushNotification } = require('./notificationService');
const User = require('../models/user');
const logger = require('../utils/logger');
const { offrampService } = require('./offramppriceservice');

class ScheduledNotificationService {
  constructor() {
    this.isRunning = false;
    this.jobs = [];
    // Define schedules as class property so they're always available
    this.scheduleConfig = [
      { time: '5:00 AM', cron: '0 5 * * *', greeting: 'Good morning ☀️' },
      { time: '12:00 PM', cron: '0 12 * * *', greeting: 'Good afternoon 🌤️' },
      { time: '4:00 PM', cron: '0 16 * * *', greeting: 'Good evening 🌆' },
      { time: '11:00 PM', cron: '0 23 * * *', greeting: 'Good night 🌙' }
    ];
  }

  // Start all scheduled notifications
  start() {
    if (this.isRunning) {
      logger.warn('Scheduled notifications already running');
      return;
    }

    logger.info('Starting scheduled notification service...');

    this.scheduleConfig.forEach(({ time, cron: cronExpression, greeting }) => {
      const job = cron.schedule(cronExpression, async () => {
        logger.info(`Running scheduled price notification at ${time} (${cronExpression})`);
        try {
          await this.sendPriceNotification(greeting);
        } catch (err) {
          logger.error('Scheduled notification job failed', { time, error: err.message });
        }
      }, {
        scheduled: false,
        timezone: 'Africa/Lagos'
      });

      job.start();
      this.jobs.push({ time, job });
      logger.info(`Scheduled price notification for ${time} (${cronExpression})`);
    });

    this.isRunning = true;
    logger.info('Scheduled notification service started successfully');
  }

  // Stop all scheduled notifications
  stop() {
    if (!this.isRunning) {
      logger.warn('Scheduled notifications not running');
      return;
    }

    this.jobs.forEach(({ time, job }) => {
      job.stop();
      logger.info(`Stopped scheduled notification for ${time}`);
    });

    this.jobs = [];
    this.isRunning = false;
    logger.info('Scheduled notification service stopped');
  }

  // Fetch NGNB + major token rates, shared by both send paths below.
  async getAllPrices() {
    // Get NGNB rate (offramp only)
    let ngnbRate = null;
    try {
      const rateInfo = await offrampService.getUsdToNgnRate();
      ngnbRate = {
        symbol: 'NGNB',
        price: rateInfo.finalPrice,
        hourly_change: 0
      };
    } catch (error) {
      logger.warn('NGNB rate unavailable (set offramp rate in admin):', error.message);
    }

    // Get latest prices for major tokens (from PriceChange - populated by crypto price job)
    const latestPrices = await PriceChange.getLatestPrices() || [];

    // Filter for major tokens (BTC, BNB, ETH, SOL) and sort in display order
    const majorTokens = ['BTC', 'BNB', 'ETH', 'SOL'];
    const relevantPrices = latestPrices
      .filter(price => majorTokens.includes(price.symbol))
      .sort((a, b) => majorTokens.indexOf(a.symbol) - majorTokens.indexOf(b.symbol));

    // Add NGNB at the beginning if available
    return ngnbRate ? [ngnbRate, ...relevantPrices] : relevantPrices;
  }

  // Send price notification to all users
  async sendPriceNotification(greeting) {
    try {
      logger.info('Fetching latest crypto prices...');

      const allPrices = await this.getAllPrices();

      if (allPrices.length === 0) {
        logger.warn('No prices for notification: NGNB/offramp rate not set in admin; no BTC/BNB/ETH/SOL in pricechanges (run crypto price job)');
        return;
      }

      // Format the notification message
      const notification = this.formatPriceNotification(allPrices, greeting);
      
      logger.info('Sending price notification to all users...', {
        message: notification.title,
        tokensCount: allPrices.length
      });

      // Get all users with valid Expo push tokens (Expo-only; FCM removed)
      const users = await User.find({
        expoPushToken: { $exists: true, $nin: [null, ''] }
      }).select('_id expoPushToken email username');

      if (users.length === 0) {
        logger.warn('No users with Expo push tokens found');
        return;
      }

      // Send notification to each user
      let successCount = 0;
      let errorCount = 0;

      for (const user of users) {
        try {
          const result = await sendPushNotification(user._id.toString(), {
            title: notification.title,
            body: notification.body,
            data: {
              type: 'price_update',
              timestamp: new Date().toISOString(),
              tokens: allPrices.map(p => ({
                symbol: p.symbol,
                price: p.price,
                change: p.hourly_change
              }))
            }
          });

          if (result.success) {
            successCount++;
          } else {
            errorCount++;
            logger.warn('Failed to send notification to user', { 
              userId: user._id, 
              error: result.message 
            });
          }
        } catch (error) {
          errorCount++;
          logger.error('Error sending notification to user', { 
            userId: user._id, 
            error: error.message 
          });
        }
      }

      logger.info('Price notification completed', {
        totalUsers: users.length,
        successCount,
        errorCount,
        tokensIncluded: allPrices.map(p => p.symbol)
      });

    } catch (error) {
      logger.error('Error in scheduled price notification', { error: error.message });
    }
  }

  // Format the price notification message
  formatPriceNotification(prices, greeting = 'Latest Rates') {
    const title = greeting;

    // Format each token price (keep NGNB first, then sort the rest)
    const priceLines = prices.map(price => {
      const symbol = price.symbol;

      // NGNB shows as Naira rate
      if (symbol === 'NGNB') {
        return `NGNB: ₦${Math.round(price.price).toLocaleString()}/$`;
      }

      const priceFormatted = this.formatPrice(price.price);
      return `${symbol}: ${priceFormatted}`;
    });

    const body = `Here's how the market's looking —\n${priceLines.join(' | ')}`;

    return {
      title,
      body
    };
  }

  // Format price with appropriate decimal places
  formatPrice(price) {
    if (price >= 1000) {
      return `$${Math.round(price).toLocaleString()}`;
    } else if (price >= 1) {
      return `$${price.toFixed(2)}`;
    } else {
      return `$${price.toFixed(4)}`;
    }
  }

  // Format percentage change with color indicator
  formatChange(change) {
    const sign = change >= 0 ? '+' : '';
    return `${sign}${change.toFixed(2)}%`;
  }

  // Get status of scheduled notifications
  getStatus() {
    return {
      isRunning: this.isRunning,
      jobsCount: this.isRunning ? this.scheduleConfig.length : 0,
      schedules: this.scheduleConfig.map(({ time }) => ({
        time,
        running: this.isRunning
      }))
    };
  }

  // Test the notification (for manual testing) - returns detailed results
  async testNotification(greeting) {
    logger.info('Testing price notification...');
    return await this.sendPriceNotificationWithResults(greeting);
  }

  // Send price notification and return detailed results
  async sendPriceNotificationWithResults(greeting) {
    try {
      logger.info('Fetching latest crypto prices...');

      const allPrices = await this.getAllPrices();

      if (allPrices.length === 0) {
        return { success: false, reason: 'NGNB/offramp rate not configured in admin. no BTC/BNB/ETH/SOL in pricechanges (run crypto price job)' };
      }

      // Format the notification message
      const notification = this.formatPriceNotification(allPrices, greeting);

      // Get all users with valid Expo push tokens (Expo-only; FCM removed)
      const users = await User.find({
        expoPushToken: { $exists: true, $nin: [null, ''] }
      }).select('_id expoPushToken email username');

      if (users.length === 0) {
        return { success: false, reason: 'No users with Expo push tokens registered. Users must enable notifications in the app.' };
      }

      // Send notification to each user
      let successCount = 0;
      let errorCount = 0;
      let skippedCount = 0;
      const errors = [];

      for (const user of users) {
        try {
          const result = await sendPushNotification(user._id.toString(), {
            title: notification.title,
            body: notification.body,
            data: {
              type: 'price_update',
              timestamp: new Date().toISOString(),
              tokens: allPrices.map(p => ({
                symbol: p.symbol,
                price: p.price,
                change: p.hourly_change
              }))
            }
          });

          if (result.success) {
            successCount++;
          } else if (result.skipped) {
            skippedCount++;
          } else {
            errorCount++;
            errors.push({ userId: user._id, email: user.email, error: result.message });
          }
        } catch (error) {
          errorCount++;
          errors.push({ userId: user._id, email: user.email, error: error.message });
        }
      }

      return {
        success: successCount > 0,
        totalUsers: users.length,
        successCount,
        errorCount,
        skippedCount,
        notification: { title: notification.title, body: notification.body },
        errors: errors.slice(0, 5) // Return first 5 errors for debugging
      };

    } catch (error) {
      logger.error('Error in test price notification', { error: error.message });
      return { success: false, reason: error.message };
    }
  }
}

// Create singleton instance
const scheduledNotificationService = new ScheduledNotificationService();

module.exports = scheduledNotificationService;
