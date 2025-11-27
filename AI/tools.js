// AI/tools.js
// Modern function calling / JSON schemas for LLM-powered frontend layer
// This implements R1 (Structured Prompts), R2 (Function Calling), R3 (Tool Router)

const axios = require('axios');
const API_BASE_URL = process.env.API_BASE_URL || 'https://priscaai.online';
const logger = require('../utils/logger');
const cache = require('./cache');
require('dotenv').config();
const OpenAI = require('openai');


/**
 * All available tools (functions) for the LLM
 * Each tool maps to a backend API endpoint or MCP tool
 */
const AVAILABLE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_sell_transaction',
      description: 'Initiate a sell transaction to convert crypto to NGN. Includes optional bank validation and save payout feature. Requires authentication.',
      parameters: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'],
            description: 'The cryptocurrency token to sell'
          },
          network: {
            type: 'string',
            enum: ['BTC', 'BITCOIN', 'ETH', 'ETHEREUM', 'ERC20', 'SOL', 'SOLANA', 'TRX', 'TRON', 'TRC20', 'BSC', 'BNB SMART CHAIN', 'BEP20', 'BINANCE', 'POLYGON', 'AVALANCHE'],
            description: 'The blockchain network for the token (must match token).'
          },
          amount: {
            type: 'number',
            description: 'Amount to sell in token units (optional)'
          },
          currency: {
            type: 'string',
            enum: ['TOKEN', 'NGN'],
            description: 'Currency of the amount - TOKEN for crypto, NGN for fiat',
            default: 'TOKEN'
          },
          bankCode: {
            type: 'string',
            description: 'Bank code for payout (optional)'
          },
          accountNumber: {
            type: 'string',
            description: 'Bank account number for payout (optional)'
          },
          savePayout: {
            type: 'boolean',
            description: 'If true, save bank info for future transactions',
            default: false
          }
        },
        required: ['token', 'network']
      }
    }
  },

  {
  type: 'function',
  function: {
    name: 'match_naira',
    description: 'Fetches the list of Naira banks and exposes the user-provided name for matching using the AI model’s reasoning capabilities.',
    parameters: {
      type: 'object',
      properties: {
        providedName: {
          type: 'string',
          description: 'The bank name provided by the user to be matched against the available bank list.'
        }
      },
      required: ['providedName']
    }
  }
},
  {
    type: 'function',
    function: {
      name: 'get_sell_quote',
      description: 'Get a quote showing how much NGN user will receive for selling crypto. Use when user asks "how much will I get", "what is the rate", "how much naira for X tokens", or wants to know the quote before selling. REQUIRES AUTHENTICATION. REQUIRES: token and amount. Network will be auto-detected from token if not provided. Do NOT call this function if token or amount is missing - ask the user first. Do NOT call if user is not authenticated.',
      parameters: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'],
            description: 'The cryptocurrency token to sell'
          },
          amount: {
            type: 'number',
            description: 'Amount to sell in token units'
          }
        },
        required: ['token', 'amount']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_buy_transaction',
      description: 'Initiate a buy transaction (NGN to crypto). REQUIRES USER TO BE AUTHENTICATED/SIGNED IN. Do not call this function if user is not signed in. User pays NGN and receives crypto.',
      parameters: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'],
            description: 'The cryptocurrency token to buy'
          },
          network: {
            type: 'string',
            enum: ['BITCOIN NETWORK', 'ETHEREUM NETWORK', 'SOLANA NETWORK', 'TRON NETWORK', 'BNB SMART CHAIN', 'POLYGON NETWORK', 'AVALANCHE NETWORK'],
            description: 'The blockchain network for the token'
          },
          amount: {
            type: 'number',
            description: 'Amount to buy in NGN (minimum 5000 NGN)'
          }
        },
        required: ['token', 'network', 'amount']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_buy_quote',
      description: 'Get a quote for buying crypto (how much crypto you will receive for NGN). REQUIRES USER TO BE AUTHENTICATED/SIGNED IN. Do not call this function if user is not signed in.',
      parameters: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'],
            description: 'The cryptocurrency token to buy'
          },
          amount: {
            type: 'number',
            description: 'Amount to spend in NGN'
          }
        },
        required: ['token', 'amount']
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
    name: 'get_bank_details',
    description: 'Enquire bank details (validate account number and get account name)',
    parameters: {
      type: 'object',
      properties: {
        bankCode: {
          type: 'string',
          description: 'Bank code (e.g., "044" for Access Bank)'
        },
        accountNumber: {
          type: 'string',
          description: 'Account number to validate'
        }
      },
      required: ['bankCode', 'accountNumber']
    }
  }
},

  {
    type: 'function',
    function: {
      name: 'connect_lisk_wallet',
      description: 'Connect a Lisk wallet to the user\'s account. Use when user wants to connect, link, or add their Lisk wallet. REQUIRES AUTHENTICATION. This will generate a message that the user needs to sign with their Lisk wallet to verify ownership. Do NOT call if user is not authenticated.',
      parameters: {
        type: 'object',
        properties: {
          network: {
            type: 'string',
            enum: ['mainnet', 'testnet'],
            description: 'Lisk network to connect to (mainnet or testnet)',
            default: 'mainnet'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'verify_lisk_wallet',
      description: 'Verify Lisk wallet connection by providing the signed message. Use after user has signed the connection message with their Lisk wallet. REQUIRES AUTHENTICATION. Needs: address, signature, and the original message. Do NOT call if user is not authenticated.',
      parameters: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: 'Lisk wallet address (starts with lsk)'
          },
          signature: {
            type: 'string',
            description: 'Signature of the connection message signed by the wallet'
          },
          message: {
            type: 'string',
            description: 'The original connection message that was signed'
          },
          network: {
            type: 'string',
            enum: ['mainnet', 'testnet'],
            description: 'Lisk network (mainnet or testnet)',
            default: 'mainnet'
          }
        },
        required: ['address', 'signature', 'message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_lisk_wallet',
      description: 'Get connected Lisk wallet information including address and balance. Use when user asks about their Lisk wallet, Lisk balance, or connected wallet. REQUIRES AUTHENTICATION. Do NOT call if user is not authenticated.',
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
      name: 'initiate_swap',
      description: 'Initiate a token swap (exchange one crypto for another)',
      parameters: {
        type: 'object',
        properties: {
          fromToken: {
            type: 'string',
            enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'],
            description: 'Token to swap from'
          },
          toToken: {
            type: 'string',
            enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'],
            description: 'Token to swap to'
          },
          amount: {
            type: 'number',
            description: 'Amount of fromToken to swap'
          },
          fromNetwork: {
            type: 'string',
            enum: ['BTC', 'BITCOIN', 'ETH', 'ETHEREUM', 'ERC20', 'SOL', 'SOLANA', 'TRX', 'TRON', 'TRC20', 'BSC', 'BNB SMART CHAIN', 'BEP20', 'BINANCE', 'POLYGON', 'AVALANCHE'],
            description: 'Network for fromToken'
          },
          toNetwork: {
            type: 'string',
            enum: ['BTC', 'BITCOIN', 'ETH', 'ETHEREUM', 'ERC20', 'SOL', 'SOLANA', 'TRX', 'TRON', 'TRC20', 'BSC', 'BNB SMART CHAIN', 'BEP20', 'BINANCE', 'POLYGON', 'AVALANCHE'],
            description: 'Network for toToken'
          }
        },
        required: ['fromToken', 'toToken', 'amount', 'fromNetwork', 'toNetwork']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_quote_price',
      description: 'Get a general price quote for any token in NGN (selling rate)',
      parameters: {
        type: 'object',
        properties: {
          token: {
            type: 'string',
            enum: ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'],
            description: 'The cryptocurrency token'
          },
          amount: {
            type: 'number',
            description: 'Amount in token units'
          }
        },
        required: ['token', 'amount']
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
      case 'create_sell_transaction':
  if (!authenticated) {
    return {
      success: false,
      error: 'Authentication required',
      message: 'You need to sign in to initiate a sell transaction.',
      requiresAuth: true
    };
  }

  try {
    // 1️⃣ Validate bank details if provided
    if (parameters.bankCode && parameters.accountNumber) {
      const bankValidation = await executeTool('get_bank_details', {
        bankCode: parameters.bankCode,
        accountNumber: parameters.accountNumber
      }, authCtx);

      if (!bankValidation.success) {
        return {
          success: false,
          error: 'Invalid bank details',
          message: 'Please check your bank code and account number.'
        };
      }

      if (parameters.savePayout) {
        await saveUserPayout(authCtx.userId, parameters.bankCode, parameters.accountNumber);
      }
    }

    // 2️⃣ Call the sell endpoint
    const sellUrl = `${API_BASE_URL}/sell/initiate`;
    logger.info('Calling sell endpoint', { url: sellUrl, userId });

    const sellRes = await axios.post(
      sellUrl,
      parameters,
      {
        headers,
        timeout: 15000,
        validateStatus: (status) => status < 500
      }
    );

    const responseData = sellRes.data;
    const isHtmlResponse = typeof responseData === 'string' && (
      responseData.includes('<!DOCTYPE html>') ||
      responseData.includes('<html') ||
      responseData.includes('Service Suspended')
    );

    if (isHtmlResponse || sellRes.status >= 400) {
      return {
        success: false,
        error: sellRes.status >= 400 ? `Transaction failed: ${sellRes.status}` : 'Service unavailable',
        message: 'Unable to initiate sell transaction. Please try again later.',
        status: sellRes.status || 500
      };
    }

    // 3️⃣ Format success message
    let displayMessage = 'Sell transaction initiated successfully! ';
    if (responseData.paymentId) displayMessage += `Payment ID: ${responseData.paymentId}. `;
    if (responseData.depositAddress) displayMessage += `Deposit address: ${responseData.depositAddress}. `;
    if (responseData.quote?.amountNGN) {
      displayMessage += `You will receive ₦${Number(responseData.quote.amountNGN).toLocaleString()} for ${responseData.quote.amount || 'your crypto'}. `;
    }
    displayMessage += 'Please display the deposit address and payment details clearly to the user.';

    return {
      success: true,
      data: responseData,
      message: displayMessage
    };

  } catch (error) {
    if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
      return {
        success: false,
        error: 'Request timeout',
        message: 'The transaction request took too long. Please try again.',
        status: 408
      };
    }
    throw error;
  }

      case 'get_sell_quote':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to get a sell quote. Please sign in first.',
            requiresAuth: true
          };
        }
        try {
          // Map token to network if not provided
          const tokenToNetwork = {
            'BTC': 'BITCOIN',
            'ETH': 'ETHEREUM',
            'SOL': 'SOLANA',
            'USDT': 'TRON',
            'USDC': 'ETHEREUM',
            'BNB': 'BNB SMART CHAIN',
            'MATIC': 'POLYGON',
            'AVAX': 'AVALANCHE'
          };

          const network = parameters.network || tokenToNetwork[parameters.token?.toUpperCase()] || 'ETHEREUM';

          const quoteUrl = `${API_BASE_URL}/sell/initiate`;
          logger.info('Calling sell quote endpoint', {
            url: quoteUrl,
            hasAuth: !!headers.Authorization,
            token: parameters.token,
            network,
            amount: parameters.amount
          });

          // Reuse initiate endpoint with amount to get quote
          const quoteRes = await axios.post(
            quoteUrl,
            {
              token: parameters.token,
              network: network,
              amount: parameters.amount || 0
            },
            {
              headers,
              timeout: 15000,
              validateStatus: (status) => status < 500
            }
          );

          // Check for HTML error responses
          const responseData = quoteRes.data;
          const isHtmlResponse = typeof responseData === 'string' && (
            responseData.includes('<!DOCTYPE html>') ||
            responseData.includes('<html') ||
            responseData.includes('Service Suspended')
          );

          if (isHtmlResponse || quoteRes.status >= 400) {
            return {
              success: false,
              error: quoteRes.status >= 400 ? `Failed to get quote: ${quoteRes.status}` : 'Service unavailable',
              message: 'Unable to retrieve sell quote. Please try again later.',
              status: quoteRes.status || 500
            };
          }

          const quoteData = responseData.quote || responseData;

          // Format helpful message with quote details
          let displayMessage = 'Sell quote retrieved successfully. ';
          if (quoteData.amountNGN) {
            displayMessage += `You will receive ₦${Number(quoteData.amountNGN).toLocaleString()} `;
          }
          if (quoteData.amount && quoteData.token) {
            displayMessage += `for ${quoteData.amount} ${quoteData.token}. `;
          }
          if (quoteData.rate) {
            displayMessage += `Rate: ₦${Number(quoteData.rate).toLocaleString()} per ${quoteData.token || 'token'}. `;
          }
          displayMessage += 'Please display the quote details clearly to the user.';

          return {
            success: true,
            data: quoteData,
            message: displayMessage
          };
        } catch (quoteError) {
          if (quoteError.code === 'ECONNABORTED' || quoteError.message.includes('timeout')) {
            return {
              success: false,
              error: 'Request timeout',
              message: 'The quote request took too long. Please try again.',
              status: 408
            };
          }
          throw quoteError;
        }

      case 'create_buy_transaction':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to initiate a buy transaction. Please sign in first.',
            requiresAuth: true
          };
        }
        try {
          const buyRes = await axios.post(
            `${API_BASE_URL}/buy/initiate`,
            parameters,
            {
              headers,
              timeout: 15000,
              validateStatus: (status) => status < 500
            }
          );

          // Check for HTML error responses
          const responseData = buyRes.data;
          const isHtmlResponse = typeof responseData === 'string' && (
            responseData.includes('<!DOCTYPE html>') ||
            responseData.includes('<html') ||
            responseData.includes('Service Suspended')
          );

          if (isHtmlResponse || buyRes.status >= 400) {
            return {
              success: false,
              error: buyRes.status >= 400 ? `Transaction failed: ${buyRes.status}` : 'Service unavailable',
              message: 'Unable to initiate buy transaction. Please try again later or contact support.',
              status: buyRes.status || 500
            };
          }

          // Format helpful message with transaction details
          let displayMessage = 'Buy transaction initiated successfully! ';
          if (responseData.paymentId) {
            displayMessage += `Payment ID: ${responseData.paymentId}. `;
          }
          if (responseData.quote) {
            const quote = responseData.quote;
            if (quote.amount) {
              displayMessage += `You will receive ${quote.amount} ${quote.token || parameters.token || 'crypto'} `;
            }
            if (quote.amountNGN) {
              displayMessage += `for ₦${Number(quote.amountNGN).toLocaleString()}. `;
            }
          }
          displayMessage += 'Please display the transaction details clearly to the user.';

          return {
            success: true,
            data: responseData,
            message: displayMessage
          };
        } catch (buyError) {
          if (buyError.code === 'ECONNABORTED' || buyError.message.includes('timeout')) {
            return {
              success: false,
              error: 'Request timeout',
              message: 'The transaction request took too long. Please try again.',
              status: 408
            };
          }
          throw buyError;
        }

      case 'get_buy_quote':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to get a buy quote. Please sign in first.',
            requiresAuth: true
          };
        }
        try {
          const buyQuoteRes = await axios.post(
            `${API_BASE_URL}/buy/quote`,
            parameters,
            {
              headers,
              timeout: 15000,
              validateStatus: (status) => status < 500
            }
          );

          // Check for HTML error responses
          const responseData = buyQuoteRes.data;
          const isHtmlResponse = typeof responseData === 'string' && (
            responseData.includes('<!DOCTYPE html>') ||
            responseData.includes('<html') ||
            responseData.includes('Service Suspended')
          );

          if (isHtmlResponse || buyQuoteRes.status >= 400) {
            return {
              success: false,
              error: buyQuoteRes.status >= 400 ? `Failed to get quote: ${buyQuoteRes.status}` : 'Service unavailable',
              message: 'Unable to retrieve buy quote. Please try again later.',
              status: buyQuoteRes.status || 500
            };
          }

          // Format helpful message with quote details
          let displayMessage = 'Buy quote retrieved successfully. ';
          if (responseData.amount) {
            displayMessage += `You will receive ${responseData.amount} ${responseData.token || parameters.token || 'crypto'} `;
          }
          if (responseData.amountNGN) {
            displayMessage += `for ₦${Number(responseData.amountNGN).toLocaleString()}. `;
          }
          if (responseData.rate) {
            displayMessage += `Rate: ₦${Number(responseData.rate).toLocaleString()} per ${responseData.token || 'token'}. `;
          }
          displayMessage += 'Please display the quote details clearly to the user.';

          return {
            success: true,
            data: responseData,
            message: displayMessage
          };
        } catch (quoteError) {
          if (quoteError.code === 'ECONNABORTED' || quoteError.message.includes('timeout')) {
            return {
              success: false,
              error: 'Request timeout',
              message: 'The quote request took too long. Please try again.',
              status: 408
            };
          }
          throw quoteError;
        }

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


       case 'match_naira':
  try {
    const { providedName } = JSON.parse(toolCall.function.arguments);

    // 1. Fetch Bank List
    const response = await fetch(`${BASE_URL}/naira-accounts`, { method: 'GET' });

    if (!response.ok) {
      throw new Error(`Failed to fetch bank list: ${response.statusText}`);
    }

    const result = await response.json();
    const banks = Array.isArray(result.banks) ? result.banks : [];

    // 2. AI Matching (using existing openai + env model)
    const aiMatchResponse = await openai.chat.completions.create({
      model: MODEL_NAME,
      messages: [
        {
          role: "system",
          content: `
You are a matcher.
Given a user-provided bank name and a list of banks,
return ONLY:
{
  "bankName": "<best_match>",
  "confidence": <0-1>
}
If unsure (<0.4), bankName = null.
`
        },
        {
          role: "user",
          content: JSON.stringify({ providedName, banks })
        }
      ],
      temperature: 0
    });

    let matchPayload = {};
    try {
      matchPayload = JSON.parse(aiMatchResponse.choices[0].message.content);
    } catch (e) {
      matchPayload = { bankName: null, confidence: 0 };
    }

    // 3. Extract bankCode from the matched bank
    let bankCode = null;
    if (matchPayload.bankName) {
      const match = banks.find(
        b => b.bankName.toLowerCase() === matchPayload.bankName.toLowerCase()
      );
      bankCode = match ? match.bankCode : null;
    }

    // 4. Return Final Payload
    return JSON.stringify({
      success: true,
      data: {
        providedName,
        banks,
        count: result.count || 0,
        bankName: matchPayload.bankName,
        bankCode: bankCode,              // <-- EXPOSED HERE
        accountName: providedName,
        confidence: matchPayload.confidence
      }
    });

  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error.message
    });
  }

case 'get_bank_details':
  try {
    const { bankCode, accountNumber } = JSON.parse(toolCall.function.arguments);

    // Call your API to validate account and get details
    const response = await fetch(`${BASE_URL}/bank-details?bankCode=${bankCode}&accountNumber=${accountNumber}`, {
      method: 'GET'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch bank details: ${response.statusText}`);
    }

    const result = await response.json();

    return JSON.stringify({
      success: true,
      data: {
        bankCode,
        accountNumber,
        accountName: result.accountName || null,  // returned by API
        valid: result.valid || false,             // true/false
        message: result.message || 'Bank details retrieved successfully'
      }
    });

  } catch (error) {
    return JSON.stringify({
      success: false,
      error: error.message
    });
  }


      case 'initiate_swap':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to initiate a swap. Please sign in first.',
            requiresAuth: true
          };
        }
        try {
          const swapRes = await axios.post(
            `${API_BASE_URL}/swap/initiate`,
            parameters,
            {
              headers,
              timeout: 15000,
              validateStatus: (status) => status < 500
            }
          );

          // Check for HTML error responses
          const responseData = swapRes.data;
          const isHtmlResponse = typeof responseData === 'string' && (
            responseData.includes('<!DOCTYPE html>') ||
            responseData.includes('<html') ||
            responseData.includes('Service Suspended')
          );

          if (isHtmlResponse || swapRes.status >= 400) {
            return {
              success: false,
              error: swapRes.status >= 400 ? `Swap failed: ${swapRes.status}` : 'Service unavailable',
              message: 'Unable to initiate swap. Please try again later or contact support.',
              status: swapRes.status || 500
            };
          }

          // Format helpful message with swap details
          let displayMessage = 'Swap initiated successfully! ';
          if (responseData.fromAmount && responseData.fromToken) {
            displayMessage += `Swapping ${responseData.fromAmount} ${responseData.fromToken} `;
          }
          if (responseData.toAmount && responseData.toToken) {
            displayMessage += `for ${responseData.toAmount} ${responseData.toToken}. `;
          }
          if (responseData.exchangeRate) {
            displayMessage += `Exchange rate: ${Number(responseData.exchangeRate).toFixed(6)}. `;
          }
          displayMessage += 'Please display the swap details clearly to the user.';

          return {
            success: true,
            data: responseData,
            message: displayMessage
          };
        } catch (swapError) {
          if (swapError.code === 'ECONNABORTED' || swapError.message.includes('timeout')) {
            return {
              success: false,
              error: 'Request timeout',
              message: 'The swap request took too long. Please try again.',
              status: 408
            };
          }
          throw swapError;
        }

      case 'get_quote_price':
        // Same as get_sell_quote for now
        return executeTool('get_sell_quote', parameters, authCtx);

      case 'connect_lisk_wallet':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to connect your Lisk wallet. Please sign in first.',
            requiresAuth: true
          };
        }
        try {
          const connectUrl = `${API_BASE_URL}/lisk/connect`;
          logger.info('Initiating Lisk wallet connection', {
            url: connectUrl,
            hasAuth: !!headers.Authorization,
            userId
          });

          const connectRes = await axios.post(connectUrl, {
            network: parameters.network || 'mainnet'
          }, {
            headers,
            timeout: 10000
          });

          logger.info('Lisk wallet connection initiated', {
            status: connectRes.status,
            hasData: !!connectRes.data
          });

          const data = connectRes.data;

          return logAndReturnResult('connect_lisk_wallet', {
            success: true,
            data: data,
            message: `To connect your Lisk wallet, please sign this message with your wallet: "${data.message}". This will verify your wallet ownership without triggering any blockchain transaction.`
          });
        } catch (error) {
          logger.error('connect_lisk_wallet failed', {
            error: error.message,
            status: error.response?.status,
            url: `${API_BASE_URL}/lisk/connect`,
            userId
          });

          return logAndReturnResult('connect_lisk_wallet', {
            success: false,
            error: error.message,
            message: 'Failed to initiate wallet connection.',
            status: error.response?.status || 500
          });
        }

      case 'verify_lisk_wallet':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to verify your Lisk wallet. Please sign in first.',
            requiresAuth: true
          };
        }
        try {
          const verifyUrl = `${API_BASE_URL}/lisk/verify`;
          logger.info('Verifying Lisk wallet connection', {
            url: verifyUrl,
            hasAuth: !!headers.Authorization,
            userId,
            address: parameters.address
          });

          const verifyRes = await axios.post(verifyUrl, {
            address: parameters.address,
            signature: parameters.signature,
            message: parameters.message,
            network: parameters.network || 'mainnet'
          }, {
            headers,
            timeout: 15000
          });

          logger.info('Lisk wallet verified', {
            status: verifyRes.status,
            hasData: !!verifyRes.data
          });

          const data = verifyRes.data;

          return logAndReturnResult('verify_lisk_wallet', {
            success: true,
            data: data,
            message: `Lisk wallet connected successfully! Your wallet address ${data.wallet?.address} is now linked to your account. Balance: ${data.wallet?.balance || '0'} LSK.`
          });
        } catch (error) {
          logger.error('verify_lisk_wallet failed', {
            error: error.message,
            status: error.response?.status,
            url: `${API_BASE_URL}/lisk/verify`,
            userId
          });

          return logAndReturnResult('verify_lisk_wallet', {
            success: false,
            error: error.message,
            message: 'Failed to verify wallet connection.',
            status: error.response?.status || 500
          });
        }

      case 'browse_web':
        try {
          // This is a placeholder - browsing will be handled in Chatbot.js with OpenAI's browsing capability
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

      case 'get_lisk_wallet':
        if (!authenticated) {
          return {
            success: false,
            error: 'Authentication required',
            message: 'You need to sign in to view your Lisk wallet. Please sign in first.',
            requiresAuth: true
          };
        }
        try {
          const walletUrl = `${API_BASE_URL}/lisk/account`;
          logger.info('Fetching Lisk wallet info', {
            url: walletUrl,
            hasAuth: !!headers.Authorization,
            userId
          });

          const walletRes = await axios.get(walletUrl, {
            headers,
            timeout: 10000
          });

          logger.info('Lisk wallet info retrieved', {
            status: walletRes.status,
            hasData: !!walletRes.data
          });

          const data = walletRes.data;

          return logAndReturnResult('get_lisk_wallet', {
            success: true,
            data: data,
            message: `Your Lisk wallet: ${data.wallet?.address || 'N/A'}. Balance: ${data.wallet?.balance || '0'} LSK. Network: ${data.wallet?.network || 'mainnet'}.`
          });
        } catch (error) {
          logger.error('get_lisk_wallet failed', {
            error: error.message,
            status: error.response?.status,
            url: `${API_BASE_URL}/lisk/account`,
            userId
          });

          // If wallet not connected, return helpful message
          if (error.response?.status === 404) {
            return logAndReturnResult('get_lisk_wallet', {
              success: false,
              error: 'Wallet not connected',
              message: 'No Lisk wallet connected. Would you like to connect your Lisk wallet?',
              status: 404
            });
          }

          return logAndReturnResult('get_lisk_wallet', {
            success: false,
            error: error.message,
            message: 'Failed to retrieve wallet information.',
            status: error.response?.status || 500
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

