// AI/tools.js
// Modern function calling / JSON schemas for LLM-powered frontend layer
// This implements R1 (Structured Prompts), R2 (Function Calling), R3 (Tool Router)

const axios = require('axios');
const API_BASE_URL = process.env.API_BASE_URL || 'https://priscaai.online';
const logger = require('../utils/logger');
const cache = require('./cache');
require('dotenv').config();
const Anthropic = (() => { try { return require('@anthropic-ai/sdk'); } catch (e) { return null; } })();
const CLAUDE_MODEL = process.env.CLAUDE_MODEL_PRIMARY || 'claude-sonnet-5';
let anthropicClient = null;
try {
  if (Anthropic && process.env.ANTHROPIC_API_KEY) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
} catch (e) {
  logger.error('Anthropic init error in AI/tools.js:', e?.message || e);
}

/**
 * Match a user-provided (possibly partial) bank name against the official
 * bank list, using Claude tool use to force a structured {bankCode,
 * bankName} result instead of parsing free-text JSON.
 */
async function matchBankNameWithClaude(providedName, officialBanks) {
  const bankNames = officialBanks.map(b => `${b.code}: ${b.name}`).join('\n');

  const response = await anthropicClient.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `The user provided the bank name: "${providedName}".\nMatch this name against the official list of banks below (format: CODE: Full Bank Name). Use the return_bank_match tool to give your answer — if no reasonable match exists, pass null for both fields.\n\nOfficial Bank List:\n${bankNames}`
    }],
    tools: [{
      name: 'return_bank_match',
      description: 'Return the single best-matching bank code and name from the official list, or null values if no reasonable match exists.',
      input_schema: {
        type: 'object',
        properties: {
          bankCode: { type: ['string', 'null'], description: 'The matched bank code from the official list, or null if no match' },
          bankName: { type: ['string', 'null'], description: 'The matched full bank name from the official list, or null if no match' }
        },
        required: ['bankCode', 'bankName']
      }
    }],
    tool_choice: { type: 'tool', name: 'return_bank_match' }
  });

  const toolUse = (response.content || []).find(b => b.type === 'tool_use');
  return toolUse ? toolUse.input : { bankCode: null, bankName: null };
}


/**
 * All available tools (functions) for the LLM
 * Each tool maps to a backend API endpoint or MCP tool
 */
const AVAILABLE_TOOLS = [
// Update to AVAILABLE_TOOLS: Remove deprecated 'match_naira' and 'get_bank_details' tools
  {
    type: 'function',
    function: {
      name: 'validate_account',
      description: 'Validate bank account details by matching a provided bank name (if partial) to the official code/name, then resolving the account name via bank API. Use this when user wants to check/validate their bank details, or let prepare_withdrawal handle it automatically as part of preparing a withdrawal. Returns matched bank details, validated account name, and a confirmation prompt. REQUIRES AUTHENTICATION.',
      parameters: {
        type: 'object',
        properties: {
          bankCode: {
            type: 'string',
            description: 'Bank code (e.g., "044" for Access Bank) - REQUIRED if no providedName'
          },
          accountNumber: {
            type: 'string',
            description: 'Account number to validate - REQUIRED'
          },
          providedName: {
            type: 'string',
            description: 'Full or partial bank name to match (e.g., "GTB", "Access") - optional, but triggers matching if provided'
          }
        },
        required: ['accountNumber']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_transaction_status',
      description: 'Check the status of a transaction by payment ID',
      parameters: {
        type: 'object',
        properties: {
          paymentId: {
            type: 'string',
            description: 'The payment ID or transaction reference'
          }
        },
        required: ['paymentId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_naira_rates',
      description: 'Get current NGN/USD exchange rates. Use this when user asks about naira rates, NGN rates, exchange rates, selling rates, buying rates, or "how much naira". Returns both offramp (selling) and onramp (buying) rates. No authentication required.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_token_price',
      description: 'Get current price of a cryptocurrency token in USD. Use this when user asks about token price, crypto price, "how much is BTC", "what is the price of ETH", or current value of any supported token (BTC, ETH, SOL, USDT, USDC, BNB, MATIC, AVAX). No authentication required.',
      parameters: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'],
            description: 'The cryptocurrency token'
          }
        },
        required: ['token']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_dashboard',
      description: 'Get user dashboard data including portfolio balance, holdings, and account info. Use when user asks about balance, portfolio, wallet, holdings, assets, or "show my account". REQUIRES AUTHENTICATION. Do NOT call if user is not authenticated.',
      parameters: {
        type: 'object',
        properties: {},
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_transaction_history',
      description: 'Get transaction history for the user (recent transactions)',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of transactions to return',
            default: 10
          },
          dateFrom: {
            type: 'string',
            description: 'Start date in ISO format (optional)'
          },
          dateTo: {
            type: 'string',
            description: 'End date in ISO format (optional)'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browse_web',
      description: 'Search the web for recent information that is not available in my training data. Use this when user asks about current events, recent news, latest prices, recent releases, or any information that requires up-to-date data from the internet. This will take a moment to gather the latest information. Do NOT use this for information I already have (like crypto prices from our API, NGN rates, or general crypto knowledge).',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query or question to search for on the web'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_notifications',
      description: 'Get the user\'s notifications (transaction alerts, deposit confirmations, system messages, etc). Use when user asks to see their notifications, alerts, or updates. REQUIRES AUTHENTICATION.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of notifications to return',
            default: 50
          },
          unreadOnly: {
            type: 'boolean',
            description: 'Only return unread notifications',
            default: false
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mark_notification_read',
      description: 'Mark one notification (or all notifications) as read. Use when user asks to clear, dismiss, or mark notifications as read. REQUIRES AUTHENTICATION. Provide either notificationId for a single notification, or markAll to clear everything.',
      parameters: {
        type: 'object',
        properties: {
          notificationId: {
            type: 'string',
            description: 'ID of the specific notification to mark as read (omit if using markAll)'
          },
          markAll: {
            type: 'boolean',
            description: 'Mark all notifications as read instead of a single one',
            default: false
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'prepare_withdrawal',
      description: 'Prepare a withdrawal of NGNB balance to a bank account. Validates the bank details and resolves the account name, then hands off to the app\'s secure confirmation screen where the user enters their PIN — this tool does NOT move any money itself. REQUIRES AUTHENTICATION. Do NOT ask for or accept a PIN or 2FA code in chat.',
      parameters: {
        type: 'object',
        properties: {
          amount: { type: 'number', description: 'Amount in NGN to withdraw' },
          accountNumber: { type: 'string', description: 'Destination bank account number' },
          bankCode: { type: 'string', description: 'Bank code, if known (e.g. "044" for Access Bank)' },
          bankName: { type: 'string', description: 'Full or partial bank name — used to match the bank if bankCode is not known' },
          narration: { type: 'string', description: 'Optional note for the withdrawal' }
        },
        required: ['amount', 'accountNumber']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'prepare_airtime_purchase',
      description: 'Prepare an airtime purchase. Hands off to the app\'s secure confirmation screen where the user enters their PIN — this tool does NOT complete the purchase itself. REQUIRES AUTHENTICATION. Do NOT ask for or accept a PIN or 2FA code in chat.',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Phone number to top up' },
          network: { type: 'string', enum: ['mtn', 'glo', 'airtel', '9mobile'], description: 'Mobile network' },
          amount: { type: 'number', description: 'Amount in NGN' }
        },
        required: ['phone', 'network', 'amount']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'prepare_data_purchase',
      description: 'Prepare a mobile data purchase. Opens the app\'s data purchase screen where the user picks a plan and enters their PIN — this tool does NOT complete the purchase itself. REQUIRES AUTHENTICATION. Do NOT ask for or accept a PIN or 2FA code in chat.',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Phone number to buy data for' },
          network: { type: 'string', enum: ['mtn', 'glo', 'airtel', '9mobile'], description: 'Mobile network' },
          planId: { type: 'string', description: 'Specific data plan/variation ID, if the user named one' }
        },
        required: ['phone', 'network']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'prepare_electricity_purchase',
      description: 'Prepare an electricity bill payment. Verifies the meter number against the disco before handing off to the app\'s secure confirmation screen where the user enters their PIN — this tool does NOT complete the payment itself. REQUIRES AUTHENTICATION. Do NOT ask for or accept a PIN or 2FA code in chat.',
      parameters: {
        type: 'object',
        properties: {
          meterNumber: { type: 'string', description: 'Meter number' },
          disco: {
            type: 'string',
            enum: ['ikeja-electric', 'eko-electric', 'kano-electric', 'portharcourt-electric', 'jos-electric', 'ibadan-electric', 'kaduna-electric', 'abuja-electric', 'enugu-electric', 'benin-electric', 'aba-electric', 'yola-electric'],
            description: 'Electricity distribution company'
          },
          meterType: { type: 'string', enum: ['prepaid', 'postpaid'], description: 'Meter type' },
          amount: { type: 'number', description: 'Amount in NGN' }
        },
        required: ['meterNumber', 'disco', 'meterType', 'amount']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'prepare_cable_purchase',
      description: 'Prepare a cable TV subscription renewal. Verifies the smartcard/IUC number against the provider before handing off to the app\'s secure confirmation screen where the user enters their PIN — this tool does NOT complete the payment itself. REQUIRES AUTHENTICATION. Do NOT ask for or accept a PIN or 2FA code in chat.',
      parameters: {
        type: 'object',
        properties: {
          smartcardNumber: { type: 'string', description: 'Smartcard or IUC number' },
          provider: { type: 'string', enum: ['dstv', 'gotv', 'startimes', 'showmax'], description: 'Cable TV provider' },
          packageId: { type: 'string', description: 'Specific package/variation ID, if the user named one' }
        },
        required: ['smartcardNumber', 'provider']
      }
    }
  }
];

/**
 * Helper function to log and return tool result
 */
function logAndReturnResult(toolName, result) {
  // Log the result being returned
  logger.info('Tool execution completed', {
    toolName,
    success: result.success,
    hasData: !!result.data,
    message: result.message,
    error: result.error,
    status: result.status,
    dataKeys: result.data && typeof result.data === 'object' ? Object.keys(result.data).slice(0, 10) : null,
    dataPreview: result.data ? (
      typeof result.data === 'object' ?
        JSON.stringify(result.data).substring(0, 500) :
        String(result.data).substring(0, 200)
    ) : null
  });

  return result;
}

/**
 * Execute a tool function
 * @param {string} toolName - Name of the tool to execute
 * @param {object} parameters - Tool parameters
 * @param {object} authCtx - Authentication context (userId, token, etc.)
 * @returns {Promise<object>} Tool execution result
 */
async function executeTool(toolName, parameters, authCtx = {}) {
  const { authenticated, userId, token } = authCtx;

  logger.info('Executing tool', {
    toolName,
    authenticated,
    userId,
    parameters: JSON.stringify(parameters)
  });

  try {
    const headers = {
      'Content-Type': 'application/json'
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      logger.debug('Auth token included in headers', { hasToken: !!token, tokenLength: token.length });
    } else {
      logger.warn('No auth token available', { toolName, authenticated });
    }

    switch (toolName) {
      case 'check_transaction_status':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to check transaction status. Please sign in first.',
            requiresAuth: true
          };
        }
        try {
          const statusRes = await axios.get(
            `${API_BASE_URL}/history?paymentId=${parameters.paymentId}`,
            {
              headers,
              timeout: 10000,
              validateStatus: (status) => status < 500
            }
          );

          // Check for HTML error responses
          const responseData = statusRes.data;
          const isHtmlResponse = typeof responseData === 'string' && (
            responseData.includes('<!DOCTYPE html>') ||
            responseData.includes('<html') ||
            responseData.includes('Service Suspended')
          );

          if (isHtmlResponse || statusRes.status >= 400) {
            return {
              success: false,
              error: statusRes.status >= 400 ? `Failed to get status: ${statusRes.status}` : 'Service unavailable',
              message: 'Unable to retrieve transaction status. Please try again later.',
              status: statusRes.status || 500
            };
          }

          const transactionData = responseData.data || responseData;

          // Format helpful message with transaction status
          let displayMessage = 'Transaction status retrieved. ';
          if (transactionData.status) {
            displayMessage += `Status: ${transactionData.status}. `;
          }
          if (transactionData.amount && transactionData.token) {
            displayMessage += `Amount: ${transactionData.amount} ${transactionData.token}. `;
          }
          if (transactionData.amountNGN) {
            displayMessage += `NGN amount: ₦${Number(transactionData.amountNGN).toLocaleString()}. `;
          }
          displayMessage += 'Please display the transaction status and details clearly to the user.';

          return {
            success: true,
            data: transactionData,
            message: displayMessage
          };
        } catch (statusError) {
          if (statusError.code === 'ECONNABORTED' || statusError.message.includes('timeout')) {
            return {
              success: false,
              error: 'Request timeout',
              message: 'The status check took too long. Please try again.',
              status: 408
            };
          }
          throw statusError;
        }

      case 'get_naira_rates':
        try {
          const ratesUrl = `${API_BASE_URL}/rates/naira`;
          logger.info('Fetching naira rates', { url: ratesUrl });

          // Public route - no auth needed
          const ratesRes = await axios.get(ratesUrl, {
            timeout: 10000
          });

          logger.info('Rates response', {
            status: ratesRes.status,
            hasData: !!ratesRes.data
          });

          const data = ratesRes.data?.data || ratesRes.data;

          // Build a conversational message with the rates
          let message = 'Here are the current NGN exchange rates: ';
          if (data.offramp?.effectiveRate) {
            message += `When you sell crypto, you'll get ₦${Number(data.offramp.effectiveRate).toLocaleString()} per USD. `;
          }
          if (data.onramp?.effectiveRate) {
            message += `When you buy crypto, the rate is ₦${Number(data.onramp.effectiveRate).toLocaleString()} per USD.`;
          }

          return logAndReturnResult('get_naira_rates', {
            success: true,
            data: data,
            message: message
          });
        } catch (error) {
          logger.error('get_naira_rates failed', {
            error: error.message,
            status: error.response?.status,
            url: `${API_BASE_URL}/rates/naira`
          });

          return logAndReturnResult('get_naira_rates', {
            success: false,
            error: error.message,
            message: 'Failed to fetch rates.',
            status: error.response?.status || 500
          });
        }

      case 'get_token_price':
        try {
          // Check cache first
          const cachedPrice = cache.get('get_token_price', parameters, authCtx);
          if (cachedPrice) {
            logger.debug('Returning cached token price', { token: parameters.token });
            return logAndReturnResult('get_token_price', cachedPrice);
          }

          if (!authenticated) {
            // Can still get price without auth, but might be cached
            const priceRes = await axios.get(
              `${API_BASE_URL}/prices?token=${parameters.token}`,
              {
                headers,
                timeout: 10000,
                validateStatus: (status) => status < 500
              }
            );

            // Check for HTML error responses
            const responseData = priceRes.data;
            const isHtmlResponse = typeof responseData === 'string' && (
              responseData.includes('<!DOCTYPE html>') ||
              responseData.includes('<html') ||
              responseData.includes('Service Suspended')
            );

            if (isHtmlResponse || priceRes.status >= 400) {
              return {
                success: false,
                error: priceRes.status >= 400 ? `Failed to get price: ${priceRes.status}` : 'Service unavailable',
                message: 'Unable to retrieve token price. Please try again later.',
                status: priceRes.status || 500
              };
            }

            const price = responseData.price || responseData.data?.price || responseData[parameters.token];

            // Format helpful message
            let displayMessage = `Token price retrieved for ${parameters.token}. `;
            if (price) {
              displayMessage += `Current price: $${Number(price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}. `;
            }
            displayMessage += 'Please display the price clearly to the user.';

            const result = {
              success: true,
              data: responseData,
              message: displayMessage
            };

            // Cache the result
            cache.set('get_token_price', parameters, authCtx, result);

            return result;
          } else {
            // Use dashboard which has prices
            const dashRes = await axios.get(`${API_BASE_URL}/api/dashboard`, {
              headers,
              timeout: 10000,
              validateStatus: (status) => status < 500
            });

            // Check for HTML error responses
            const dashResponseData = dashRes.data;
            const isDashHtmlResponse = typeof dashResponseData === 'string' && (
              dashResponseData.includes('<!DOCTYPE html>') ||
              dashResponseData.includes('<html') ||
              dashResponseData.includes('Service Suspended')
            );

            if (isDashHtmlResponse || dashRes.status >= 400) {
              return {
                success: false,
                error: dashRes.status >= 400 ? `Failed to get price: ${dashRes.status}` : 'Service unavailable',
                message: 'Unable to retrieve token price. Please try again later.',
                status: dashRes.status || 500
              };
            }

            const prices = dashResponseData?.data?.market?.prices || {};
            const price = prices[parameters.token];

            // Format helpful message
            let displayMessage = `Token price retrieved for ${parameters.token}. `;
            if (price) {
              displayMessage += `Current price: $${Number(price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}. `;
            } else {
              displayMessage += 'Price not available. ';
            }
            displayMessage += 'Please display the price clearly to the user.';

            const result = {
              success: true,
              data: {
                token: parameters.token,
                price: price || null
              },
              message: displayMessage
            };

            // Cache the result
            cache.set('get_token_price', parameters, authCtx, result);

            return result;
          }
        } catch (priceError) {
          if (priceError.code === 'ECONNABORTED' || priceError.message.includes('timeout')) {
            return {
              success: false,
              error: 'Request timeout',
              message: 'The price request took too long. Please try again.',
              status: 408
            };
          }
          throw priceError;
        }

      case 'get_dashboard':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to view your dashboard. Please sign in first.',
            requiresAuth: true
          };
        }
        try {
          const dashUrl = `${API_BASE_URL}/api/dashboard`;
          logger.info('Calling dashboard endpoint', {
            url: dashUrl,
            userId,
            hasAuth: !!headers.Authorization
          });

          const dashRes = await axios.get(dashUrl, {
            headers,
            timeout: 15000
          });

          logger.info('Dashboard response', {
            status: dashRes.status,
            hasData: !!dashRes.data
          });

          const data = dashRes.data?.data || dashRes.data;

          // Extract key information for the message
          const portfolio = data?.portfolio || {};
          const totalBalance = portfolio?.totalPortfolioBalance || 0;
          const balances = portfolio?.balances || {};

          // Build a helpful message with portfolio summary
          let message = 'Here\'s your portfolio summary: ';
          if (totalBalance > 0) {
            message += `Your total portfolio value is $${Number(totalBalance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}. `;
          }

          // Count tokens with balances
          const tokensWithBalances = Object.keys(balances).filter(token =>
            balances[token]?.balance > 0
          );

          if (tokensWithBalances.length > 0) {
            message += `You have ${tokensWithBalances.length} token${tokensWithBalances.length !== 1 ? 's' : ''} with balances. `;
          } else {
            message += 'You currently have no token balances. ';
          }

          message += 'I can show you detailed balances for any specific token if you\'d like.';

          return logAndReturnResult('get_dashboard', {
            success: true,
            data: data,
            message: message
          });
        } catch (error) {
          logger.error('get_dashboard failed', {
            error: error.message,
            status: error.response?.status,
            url: `${API_BASE_URL}/api/dashboard`,
            userId
          });

          return logAndReturnResult('get_dashboard', {
            success: false,
            error: error.message,
            message: 'Failed to fetch dashboard.',
            status: error.response?.status || 500
          });
        }

      case 'get_transaction_history':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to view transaction history. Please sign in first.',
            requiresAuth: true
          };
        }
        try {
          const params = new URLSearchParams();
          if (parameters.limit) params.append('limit', parameters.limit);
          if (parameters.dateFrom) params.append('dateFrom', parameters.dateFrom);
          if (parameters.dateTo) params.append('dateTo', parameters.dateTo);

          const historyRes = await axios.get(
            `${API_BASE_URL}/history?${params.toString()}`,
            {
              headers,
              timeout: 15000,
              validateStatus: (status) => status < 500
            }
          );

          // Check for HTML error responses
          const responseData = historyRes.data;
          const isHtmlResponse = typeof responseData === 'string' && (
            responseData.includes('<!DOCTYPE html>') ||
            responseData.includes('<html') ||
            responseData.includes('Service Suspended')
          );

          if (isHtmlResponse || historyRes.status >= 400) {
            return {
              success: false,
              error: historyRes.status >= 400 ? `Failed to get history: ${historyRes.status}` : 'Service unavailable',
              message: 'Unable to retrieve transaction history. Please try again later.',
              status: historyRes.status || 500
            };
          }

          const historyData = responseData.data || responseData;
          const transactions = Array.isArray(historyData) ? historyData : (historyData.transactions || []);

          // Format helpful message with history summary
          let displayMessage = 'Transaction history retrieved. ';
          if (transactions.length > 0) {
            displayMessage += `Found ${transactions.length} transaction${transactions.length !== 1 ? 's' : ''}. `;
          } else {
            displayMessage += 'No transactions found. ';
          }
          displayMessage += 'Please display the transaction history clearly to the user, showing transaction type, amount, status, and date for each transaction.';

          return {
            success: true,
            data: historyData,
            message: displayMessage
          };
        } catch (historyError) {
          if (historyError.code === 'ECONNABORTED' || historyError.message.includes('timeout')) {
            return {
              success: false,
              error: 'Request timeout',
              message: 'The history request took too long. Please try again.',
              status: 408
            };
          }
          throw historyError;
        }

      case 'get_notifications':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to view notifications. Please sign in first.',
            requiresAuth: true
          };
        }
        try {
          const params = new URLSearchParams();
          if (parameters.limit) params.append('limit', parameters.limit);
          if (parameters.unreadOnly) params.append('unreadOnly', 'true');

          const notifRes = await axios.get(
            `${API_BASE_URL}/notifications?${params.toString()}`,
            {
              headers,
              timeout: 15000,
              validateStatus: (status) => status < 500
            }
          );

          if (notifRes.status >= 400) {
            return logAndReturnResult('get_notifications', {
              success: false,
              error: `Failed to get notifications: ${notifRes.status}`,
              message: 'Unable to retrieve notifications right now. Please try again later.',
              status: notifRes.status
            });
          }

          const notifications = notifRes.data?.data || [];
          let displayMessage = notifications.length > 0
            ? `Found ${notifications.length} notification${notifications.length !== 1 ? 's' : ''}. `
            : 'No notifications found. ';
          displayMessage += 'Please display each notification clearly, showing title, message, and whether it has been read.';

          return logAndReturnResult('get_notifications', {
            success: true,
            data: notifications,
            message: displayMessage
          });
        } catch (notifError) {
          logger.error('get_notifications failed', { error: notifError.message, userId });
          return logAndReturnResult('get_notifications', {
            success: false,
            error: notifError.message,
            message: 'Failed to fetch notifications.',
            status: notifError.response?.status || 500
          });
        }

      case 'mark_notification_read':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to manage notifications. Please sign in first.',
            requiresAuth: true
          };
        }
        if (!parameters.markAll && !parameters.notificationId) {
          return {
            success: false,
            error: 'Missing required parameters',
            message: 'Either notificationId or markAll must be provided.'
          };
        }
        try {
          const markUrl = parameters.markAll
            ? `${API_BASE_URL}/notifications/read-all`
            : `${API_BASE_URL}/notifications/${parameters.notificationId}/read`;

          const markRes = await axios.put(markUrl, {}, {
            headers,
            timeout: 10000,
            validateStatus: (status) => status < 500
          });

          if (markRes.status >= 400) {
            return logAndReturnResult('mark_notification_read', {
              success: false,
              error: `Failed to mark as read: ${markRes.status}`,
              message: 'Unable to update notification status right now. Please try again later.',
              status: markRes.status
            });
          }

          return logAndReturnResult('mark_notification_read', {
            success: true,
            data: markRes.data?.data,
            message: parameters.markAll
              ? 'All notifications marked as read.'
              : 'Notification marked as read.'
          });
        } catch (markError) {
          logger.error('mark_notification_read failed', { error: markError.message, userId });
          return logAndReturnResult('mark_notification_read', {
            success: false,
            error: markError.message,
            message: 'Failed to update notification.',
            status: markError.response?.status || 500
          });
        }

      // ─── "Prepare" tools: validate details and hand off to the app's own ───
      // secure PIN/2FA confirmation UI. NONE of these execute the actual
      // money movement — passwordpin/twoFactorCode must never be collected
      // via chat text. Each returns requiresConfirmation + confirmationScreen
      // + prefillData, which Chatbot.js short-circuits on before Layer 3
      // formatting, and the frontend uses to navigate to the real screen.

      case 'prepare_withdrawal':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to withdraw. Please sign in first.',
            requiresAuth: true
          };
        }
        if (!parameters.amount || parameters.amount <= 0) {
          return {
            success: false,
            error: 'Missing required parameters',
            message: 'Please provide the amount you want to withdraw.'
          };
        }
        if (!parameters.accountNumber || (!parameters.bankCode && !parameters.bankName)) {
          return {
            success: false,
            error: 'Missing required parameters',
            message: 'Please provide the account number and bank name (or bank code) to withdraw to.'
          };
        }
        try {
          const validation = await executeTool('validate_account', {
            bankCode: parameters.bankCode,
            accountNumber: parameters.accountNumber,
            providedName: parameters.bankName
          }, authCtx);

          if (!validation.success) {
            return logAndReturnResult('prepare_withdrawal', {
              success: false,
              error: validation.error,
              message: validation.message || 'Could not validate those bank details.'
            });
          }

          const v = validation.data || {};
          return logAndReturnResult('prepare_withdrawal', {
            success: true,
            requiresConfirmation: true,
            confirmationScreen: 'withdraw',
            prefillData: {
              amount: parameters.amount,
              bankCode: v.bankCode || parameters.bankCode,
              bankName: v.bankName || parameters.bankName,
              accountNumber: parameters.accountNumber,
              accountName: v.accountName || null,
              narration: parameters.narration || null
            },
            message: `Ready to withdraw ₦${Number(parameters.amount).toLocaleString('en-NG')} to ${v.accountName || 'the account'} (${v.bankName || parameters.bankName}, ${parameters.accountNumber}). I've opened the confirmation screen — enter your PIN there to complete it.`
          });
        } catch (error) {
          logger.error('prepare_withdrawal failed', { error: error.message, userId });
          return logAndReturnResult('prepare_withdrawal', {
            success: false,
            error: error.message,
            message: 'Failed to prepare withdrawal.'
          });
        }

      case 'prepare_airtime_purchase':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to buy airtime. Please sign in first.',
            requiresAuth: true
          };
        }
        if (!parameters.phone || !parameters.network || !parameters.amount) {
          return {
            success: false,
            error: 'Missing required parameters',
            message: 'Please provide the phone number, network, and amount for the airtime purchase.'
          };
        }
        return logAndReturnResult('prepare_airtime_purchase', {
          success: true,
          requiresConfirmation: true,
          confirmationScreen: 'airtime',
          prefillData: {
            phone: parameters.phone,
            service_id: String(parameters.network).toLowerCase(),
            amount: parameters.amount
          },
          message: `Ready to buy ₦${Number(parameters.amount).toLocaleString('en-NG')} ${parameters.network} airtime for ${parameters.phone}. I've opened the confirmation screen — enter your PIN there to complete it.`
        });

      case 'prepare_data_purchase':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to buy data. Please sign in first.',
            requiresAuth: true
          };
        }
        if (!parameters.phone || !parameters.network) {
          return {
            success: false,
            error: 'Missing required parameters',
            message: 'Please provide the phone number and network for the data purchase.'
          };
        }
        return logAndReturnResult('prepare_data_purchase', {
          success: true,
          requiresConfirmation: true,
          confirmationScreen: 'data',
          prefillData: {
            phone: parameters.phone,
            service_id: String(parameters.network).toLowerCase(),
            variation_id: parameters.planId || null,
            amount: parameters.amount || null
          },
          message: `I've opened the data purchase screen for ${parameters.phone} on ${parameters.network} — pick your plan and enter your PIN there to complete it.`
        });

      case 'prepare_electricity_purchase':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to pay for electricity. Please sign in first.',
            requiresAuth: true
          };
        }
        if (!parameters.meterNumber || !parameters.disco || !parameters.meterType || !parameters.amount) {
          return {
            success: false,
            error: 'Missing required parameters',
            message: 'Please provide the meter number, electricity provider (disco), meter type (prepaid/postpaid), and amount.'
          };
        }
        try {
          const verifyRes = await axios.post(`${API_BASE_URL}/verifybill/customer`, {
            customer_id: parameters.meterNumber,
            service_id: parameters.disco,
            variation_id: parameters.meterType
          }, { headers, timeout: 15000, validateStatus: (status) => status < 500 });

          if (verifyRes.status >= 400 || !verifyRes.data?.success) {
            return logAndReturnResult('prepare_electricity_purchase', {
              success: false,
              error: 'Meter verification failed',
              message: verifyRes.data?.message || 'Could not verify that meter number. Please double-check it.'
            });
          }

          const customerName = verifyRes.data?.data?.customer_name || verifyRes.data?.data?.Customer_Name || null;

          return logAndReturnResult('prepare_electricity_purchase', {
            success: true,
            requiresConfirmation: true,
            confirmationScreen: 'electricity',
            prefillData: {
              customer_id: parameters.meterNumber,
              service_id: parameters.disco,
              variation_id: parameters.meterType,
              amount: parameters.amount,
              customerName
            },
            message: `Ready to pay ₦${Number(parameters.amount).toLocaleString('en-NG')} for ${customerName || 'meter ' + parameters.meterNumber}. I've opened the confirmation screen — enter your PIN there to complete it.`
          });
        } catch (error) {
          logger.error('prepare_electricity_purchase failed', { error: error.message, userId });
          return logAndReturnResult('prepare_electricity_purchase', {
            success: false,
            error: error.message,
            message: 'Failed to verify meter details.'
          });
        }

      case 'prepare_cable_purchase':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to pay for cable TV. Please sign in first.',
            requiresAuth: true
          };
        }
        if (!parameters.smartcardNumber || !parameters.provider) {
          return {
            success: false,
            error: 'Missing required parameters',
            message: 'Please provide the smartcard/IUC number and provider (DStv, GOtv, Startimes, or Showmax).'
          };
        }
        try {
          const verifyRes = await axios.post(`${API_BASE_URL}/verifybill/customer`, {
            customer_id: parameters.smartcardNumber,
            service_id: String(parameters.provider).toLowerCase()
          }, { headers, timeout: 15000, validateStatus: (status) => status < 500 });

          if (verifyRes.status >= 400 || !verifyRes.data?.success) {
            return logAndReturnResult('prepare_cable_purchase', {
              success: false,
              error: 'Smartcard verification failed',
              message: verifyRes.data?.message || 'Could not verify that smartcard number. Please double-check it.'
            });
          }

          const customerName = verifyRes.data?.data?.customer_name || verifyRes.data?.data?.Customer_Name || null;

          return logAndReturnResult('prepare_cable_purchase', {
            success: true,
            requiresConfirmation: true,
            confirmationScreen: 'cabletv',
            prefillData: {
              customer_id: parameters.smartcardNumber,
              service_id: String(parameters.provider).toLowerCase(),
              variation_id: parameters.packageId || null,
              customerName
            },
            message: `I've opened the ${parameters.provider} renewal screen for ${customerName || 'smartcard ' + parameters.smartcardNumber} — pick your package and enter your PIN there to complete it.`
          });
        } catch (error) {
          logger.error('prepare_cable_purchase failed', { error: error.message, userId });
          return logAndReturnResult('prepare_cable_purchase', {
            success: false,
            error: error.message,
            message: 'Failed to verify smartcard details.'
          });
        }

       // ... inside executeTool(toolName, parameters, authCtx)
// ... before the default case
case 'match_naira':
        try {
          if (!anthropicClient) {
            return {
              success: false,
              error: 'LLM dependency missing',
              message: 'The AI matching service is currently unavailable.'
            };
          }

          // 1. Fetch the official list of banks using the new endpoint route
          const banksUrl = `${API_BASE_URL}/fetchnaira/naira-accounts`;
          logger.info('Fetching official bank list for matching', { url: banksUrl });

          const bankListRes = await axios.get(banksUrl, {
            timeout: 10000
          });

          // 🔴 FIX: Access the banks array directly from the 'banks' key
          const officialBanks = bankListRes.data.banks; 

          if (!Array.isArray(officialBanks) || officialBanks.length === 0) {
             logger.warn('match_naira: Fetched bank list is not an array or is empty', { data: bankListRes.data });
             return logAndReturnResult('match_naira', {
              success: false,
              error: 'Bank list unavailable',
              // Use a more specific message based on the status code if possible, 
              // but this is the correct message based on the log you provided.
              message: 'Could not retrieve the official list of banks for matching.' 
            });
          }

          // 2. Use Claude to perform the matching logic
          const matchResult = await matchBankNameWithClaude(parameters.providedName, officialBanks);

          // 3. Process and return the result
          let displayMessage = '';
          if (matchResult.bankCode && matchResult.bankName) {
            displayMessage = `I found a match! The bank you meant is **${matchResult.bankName}** with code **${matchResult.bankCode}**.`;
          } else {
            displayMessage = `I could not find a clear match for "${parameters.providedName}". Please provide the full official bank name.`;
          }

          return logAndReturnResult('match_naira', {
            success: true,
            data: matchResult,
            message: displayMessage
          });

        } catch (matchError) {
           logger.error('match_naira failed', { 
             error: matchError.message, 
             status: matchError.response?.status 
           });
           return logAndReturnResult('match_naira', {
             success: false,
             error: matchError.message,
             message: 'Failed to perform bank name matching due to an internal server or API error.'
           });
        }

      case 'get_bank_details':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to validate bank details. Please sign in first.',
            requiresAuth: true
          };
        }
        try {
          const bankRes = await axios.post(
            `${API_BASE_URL}/Accountname/resolve`,
            parameters,
            {
              headers,
              timeout: 15000,
              validateStatus: (status) => status < 500
            }
          );

          // Check for HTML error responses
          const responseData = bankRes.data;
          const isHtmlResponse = typeof responseData === 'string' && (
            responseData.includes('<!DOCTYPE html>') ||
            responseData.includes('<html') ||
            responseData.includes('Service Suspended')
          );

          if (isHtmlResponse || bankRes.status >= 400) {
            return {
              success: false,
              error: bankRes.status >= 400 ? `Bank validation failed: ${bankRes.status}` : 'Service unavailable',
              message: 'Unable to validate bank details. Please check the account number and bank code, or try again later.',
              status: bankRes.status || 500
            };
          }

          // Format helpful message with bank details
          let displayMessage = 'Bank details validated successfully. ';
          if (responseData.accountName) {
            displayMessage += `Account name: ${responseData.accountName}. `;
          }
          if (responseData.bankName) {
            displayMessage += `Bank: ${responseData.bankName}. `;
          }
          displayMessage += 'Please display the validated bank account name clearly to the user.';

          return {
            success: true,
            data: responseData,
            message: displayMessage
          };
        } catch (bankError) {
          if (bankError.code === 'ECONNABORTED' || bankError.message.includes('timeout')) {
            return {
              success: false,
              error: 'Request timeout',
              message: 'The bank validation request took too long. Please try again.',
              status: 408
            };
          }
          throw bankError;
        }

case 'validate_account':
  if (!authenticated) {
    return {
      success: false,
      error: 'Authentication required',
      message: 'You need to sign in to validate account details. Please sign in first.',
      requiresAuth: true
    };
  }
  try {
    if (!anthropicClient) {
      return {
        success: false,
        error: 'LLM dependency missing',
        message: 'The AI matching service is currently unavailable.'
      };
    }

    // Step 1: Match provided bank name if available
    let bankCode = parameters.bankCode; // Use provided bankCode if given, otherwise match
    let bankName = parameters.bankName; // Similarly for bankName
    let displayMessage = '';

    if (parameters.providedName) {
      // Fetch the official list of banks
      const banksUrl = `${API_BASE_URL}/fetchnaira/naira-accounts`;
      logger.info('Fetching official bank list for matching', { url: banksUrl });

      const bankListRes = await axios.get(banksUrl, {
        timeout: 10000
      });

      const officialBanks = bankListRes.data.banks;

      if (!Array.isArray(officialBanks) || officialBanks.length === 0) {
        logger.warn('validate_account: Fetched bank list is not an array or is empty', { data: bankListRes.data });
        return logAndReturnResult('validate_account', {
          success: false,
          error: 'Bank list unavailable',
          message: 'Could not retrieve the official list of banks for matching.'
        });
      }

      // Use Claude to match
      const matchResult = await matchBankNameWithClaude(parameters.providedName, officialBanks);

      if (matchResult.bankCode && matchResult.bankName) {
        bankCode = matchResult.bankCode;
        bankName = matchResult.bankName;
        displayMessage += `Matched bank: **${bankName}** (code: **${bankCode}**). `;
      } else {
        return logAndReturnResult('validate_account', {
          success: false,
          error: 'Bank match failed',
          message: `Could not find a clear match for bank name "${parameters.providedName}". Please provide the full official bank name or code.`
        });
      }
    } else if (!bankCode) {
      return logAndReturnResult('validate_account', {
        success: false,
        error: 'Missing bank details',
        message: 'Please provide a bank code or bank name to validate the account.'
      });
    }

    // Step 2: Validate account with bank code (sortCode) and account number
    // Updated to match endpoint: GET /Accountname/resolve?sortCode={bankCode}&accountNumber={accountNumber}
    const queryParams = new URLSearchParams({
      sortCode: bankCode,
      accountNumber: parameters.accountNumber
    });
    const resolveUrl = `${API_BASE_URL}/Accountname/resolve?${queryParams.toString()}`;

    const bankRes = await axios.get(resolveUrl, {
      headers,
      timeout: 15000,
      validateStatus: (status) => status < 500
    });

    // Check for HTML error responses
    const responseData = bankRes.data;
    const isHtmlResponse = typeof responseData === 'string' && (
      responseData.includes('<!DOCTYPE html>') ||
      responseData.includes('<html') ||
      responseData.includes('Service Suspended')
    );

    if (isHtmlResponse || bankRes.status >= 400) {
      return {
        success: false,
        error: bankRes.status >= 400 ? `Account validation failed: ${bankRes.status}` : 'Service unavailable',
        message: 'Unable to validate account details. Please check the account number and bank code, or try again later.',
        status: bankRes.status || 500
      };
    }

    // Ensure success response structure matches endpoint expectation
    if (!responseData.success) {
      return {
        success: false,
        error: responseData.message || 'Validation failed',
        message: responseData.message || 'Unable to validate account details. Please check the account number and bank code, or try again later.',
        status: bankRes.status || 400
      };
    }

    const validatedData = responseData.data; // Endpoint nests under 'data'

    // Step 3: Format final message with confirmation prompt
    let finalMessage = displayMessage || '';
    if (validatedData.accountName) {
      finalMessage += `Validated account name: **${validatedData.accountName}**. `;
    }
    // Note: Endpoint does not directly return 'bankName' in top-level data; access from raw if available
    // Assuming Obiex raw response includes bankName; adjust if confirmed otherwise
    const resolvedBankName = validatedData.raw?.bankName || bankName || validatedData.bankId ? `Bank ID: ${validatedData.bankId}` : '';
    if (resolvedBankName && !bankName) {
      finalMessage += `Bank: **${resolvedBankName}**. `;
    }
    finalMessage += `Does this name match the account you want to send to? Please double-check to avoid errors in transfers.`;

    return logAndReturnResult('validate_account', {
      success: true,
      data: {
        ...validatedData,
        matchedBankCode: bankCode,
        matchedBankName: bankName
      },
      message: finalMessage
    });

  } catch (error) {
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      return {
        success: false,
        error: 'Request timeout',
        message: 'The validation request took too long. Please try again.',
        status: 408
      };
    }
    logger.error('validate_account failed', {
      error: error.message,
      status: error.response?.status
    });
    return logAndReturnResult('validate_account', {
      success: false,
      error: error.message,
      message: 'Failed to validate account due to an internal server or API error.'
    });
  }

      case 'browse_web':
        try {
          // This is a placeholder - browsing will be handled in Chatbot.js via processBrowsingChat
          // Return a special flag to indicate browsing is needed
          return logAndReturnResult('browse_web', {
            success: true,
            data: { query: parameters.query },
            message: 'Browsing initiated',
            requiresBrowsing: true
          });
        } catch (error) {
          logger.error('browse_web failed', {
            error: error.message
          });
          return logAndReturnResult('browse_web', {
            success: false,
            error: error.message,
            message: 'Failed to browse the web.'
          });
        }

      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  } catch (error) {
    // Extract error message from response
    let errorMessage = error.message || 'Tool execution failed';
    let errorData = error.response?.data;

    // Handle HTML error responses (like 503 Service Suspended)
    if (errorData && typeof errorData === 'string' && errorData.includes('<!DOCTYPE html>')) {
      if (errorData.includes('Service Suspended')) {
        errorMessage = 'Service temporarily unavailable';
      } else {
        errorMessage = `Service error (${error.response?.status || 'unknown'})`;
      }
      errorData = 'HTML error page received';
    } else if (errorData && typeof errorData === 'object') {
      errorMessage = errorData.message || errorData.error || errorMessage;
    } else if (errorData && typeof errorData === 'string') {
      errorMessage = errorData;
    }

    logger.error(`Tool execution failed: ${toolName}`, {
      error: error.message,
      errorMessage,
      parameters,
      status: error.response?.status,
      data: typeof errorData === 'string' ? errorData.substring(0, 200) : errorData // Truncate long strings
    });

    return logAndReturnResult(toolName, {
      success: false,
      error: errorMessage,
      message: error.response?.status === 503
        ? 'The service is temporarily unavailable. Please try again later.'
        : errorMessage,
      status: error.response?.status || 500,
      timestamp: new Date().toISOString()
    });
  }
}

module.exports = {
  AVAILABLE_TOOLS,
  executeTool
};

