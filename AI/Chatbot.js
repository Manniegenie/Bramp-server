// AI/Chatbot.js — Modern LLM-powered chatbot with function calling (R1-R3)
// Architecture: Structured Prompts (R1) + Function Calling (R2) + Tool Router (R3)
// No fine-tuning needed - uses OpenAI function calling

require('dotenv').config();
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const OpenAI = (() => { try { return require('openai'); } catch (e) { return null; } })();
const { AVAILABLE_TOOLS, executeTool } = require('./tools');
const { quickIntentCheck, analyzeConversationContext } = require('./aiIntents');
// Session management removed - no longer using 2-minute session windows
const cache = require('./cache');
const logger = require('../utils/logger');
const axios = require('axios');

// Config
const JWT_SECRET = process.env.JWT_SECRET || process.env.ACCESS_TOKEN_SECRET || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
const AI_MODEL = process.env.OPENAI_MODEL_PRIMARY || 'gpt-4o'; // Use gpt-4o for function calling
const AI_OUTPUT_MAX_TOKENS = parseInt(process.env.AI_OUTPUT_MAX_TOKENS || '500', 10);
const API_BASE_URL = process.env.API_BASE_URL || 'https://priscaai.online';
const OPENAI_SUPPORTS_RESPONSES = false; // Use chat completions with function calling

// OpenAI client
let openai = null;
try {
  if (OpenAI && OPENAI_API_KEY && OPENAI_API_KEY.startsWith('sk-')) {
    openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    logger.info('OpenAI initialized with function calling support');
  } else {
    logger.warn('OPENAI_API_KEY missing or OpenAI SDK not installed');
  }
} catch (e) {
  logger.error('OpenAI init error:', e?.message || e);
}

// Simple session management
const chatSessions = new Map();
function getSession(sessionId) {
  let s = chatSessions.get(sessionId);
  if (!s) {
    s = { welcomed: false, aiTurns: 0, messages: [] };
    chatSessions.set(sessionId, s);
  }
  return s;
}

// Auth context extractor
async function getAuthContext(req) {
  try {
    let token = null;
    const authHdr = req.headers['authorization'] || req.headers['Authorization'];
    if (authHdr && /^Bearer\s+/i.test(authHdr)) {
      token = authHdr.replace(/^Bearer\s+/i, '').trim();
    }
    if (!token && req.headers['x-access-token']) {
      token = String(req.headers['x-access-token']).trim();
    }
    if (!token && req.body && req.body.accessToken) {
      token = String(req.body.accessToken).trim();
    }
    if (!token || !JWT_SECRET) {
      return { authenticated: false };
    }
    const payload = jwt.verify(token, JWT_SECRET);
    const userId = payload.sub || payload.id || payload.userId;
    if (!userId) {
      return { authenticated: false };
    }
    return { authenticated: true, userId, tokenPayload: payload, token };
  } catch (e) {
    if (e?.name === 'TokenExpiredError') {
      logger.info('Auth parse/verify: token expired');
      return { authenticated: false };
    }
    logger.warn('Auth parse/verify failed', { error: e?.message || e });
    return { authenticated: false };
  }
}

/**
 * Detect user expertise level from their messages
 * Returns: 'novice', 'intermediate', or 'expert'
 */
function detectUserExpertise(message, history = []) {
  const msg = String(message || '').toLowerCase();
  const recentMessages = history.slice(-5).map(h => String(h.content || h.text || '').toLowerCase()).join(' ');
  const combined = msg + ' ' + recentMessages;

  // Expert indicators
  const expertIndicators = [
    /\b(erc20|trc20|bep20|mainnet|testnet|gas|mempool|blockchain|defi|dex|cex)\b/i,
    /\b(metamask|trust wallet|ledger|trezor|hardware wallet)\b/i,
    /\b(swap|bridge|liquidity|staking|yield)\b/i,
    /\b(transaction hash|txid|tx hash|block explorer)\b/i,
    /\b(uniswap|pancakeswap|sushiswap|1inch)\b/i
  ];

  // Novice indicators
  const noviceIndicators = [
    /\b(how do i|what is|explain|help me|i don't know|i'm new|beginner|first time)\b/i,
    /\b(where do i|how can i|what does|what's the difference)\b/i,
    /\b(i don't understand|confused|not sure|what does this mean)\b/i
  ];

  const expertCount = expertIndicators.filter(pattern => pattern.test(combined)).length;
  const noviceCount = noviceIndicators.filter(pattern => pattern.test(combined)).length;

  // Check for technical terms that suggest experience
  const hasTechnicalTerms = /\b(network|chain|address|private key|seed phrase|mnemonic)\b/i.test(combined);

  if (expertCount >= 2 || (expertCount >= 1 && hasTechnicalTerms)) {
    return 'expert';
  } else if (noviceCount >= 2 || (noviceCount >= 1 && !hasTechnicalTerms)) {
    return 'novice';
  } else if (expertCount === 1 || hasTechnicalTerms) {
    return 'intermediate';
  }

  // Default to intermediate if unclear
  return 'intermediate';
}

// Build system prompt (R1: Structured Prompts)
function buildSystemPrompt(authCtx = {}, userExpertise = 'intermediate') {
  const authed = authCtx.authenticated;

  let prompt = `You are Bramp AI, a friendly and helpful crypto companion. You help users move between crypto and NGN (Nigerian Naira) effortlessly.

Your capabilities:
- Initiate sell transactions (crypto to NGN)
- Get sell/buy quotes
- Check transaction status
- Get current rates and prices
- View dashboard/portfolio (if authenticated)
- Get transaction history (if authenticated)
- Validate bank account details (combines bank name matching and account name resolution)
- Initiate token swaps

CRITICAL SELL TRANSACTION FLOW:
When a user wants to sell crypto, follow this EXACT sequence:

1. **Collect Sell Intent**: Ask for token, network, and amount (if they want to specify)
   
2. **Collect Bank Details**: 
   - Ask: "Which bank and account number should we send the money to?"
   - User provides bank name (e.g., "Access Bank", "GTBank") and account number
   
3. **Create Transaction with Validation**:
   - Call create_sell_transaction with the provided details: token, network, bankCode (if known), accountNumber, bankName (optional/partial).
   - The system will automatically:
     - Match partial bank names to official code/name if needed.
     - Validate the account number and resolve the account name.
     - Save payout details.
     - Return the deposit address and a double-check prompt like: "Validated account name: **John Doe**. Does this name match the account you want to send to? Please double-check to avoid errors in transfers."
   - SHOW THIS VALIDATION PROMPT TO THE USER and wait for confirmation before proceeding further (e.g., if they need to adjust details).
   - Example: After transaction init, display: "Sell initiated! Validated: John Doe - Access Bank (1234567890). Does this match? Deposit to: [address]."

IMPORTANT: 
- Do NOT provide bankCode or accountName upfront - let the system validate automatically via create_sell_transaction.
- make sure account numbers, names and bank details are copiable and bolded for clarity.
- If user wants to validate details standalone (before selling), call validate_account tool directly.
- Always display the validated account name clearly and prompt for double-check.
- Use validate_account when user specifically asks to "check my bank details" without selling.

Guidelines:
1. Be conversational and friendly - no corporate speak
2. For sell intents, process normally without session restrictions
3. CRITICAL: Adapt your communication style based on user expertise level...
`;

  // ... rest of your existing prompt (e.g., expertise adaptation, etc.)
  
  return prompt;}
/**
 * Map detected intent to recommended function(s)
 * This helps guide the LLM to call the right function
 */
function getRecommendedFunctionsForIntent(intent, authCtx) {
  const { authenticated } = authCtx;
  const functionMap = {
    'sell': authenticated ? ['create_sell_transaction'] : [],
    'deposit': authenticated ? [] : [], // Deposit handled differently
    'naira_rates': ['get_naira_rates'],
    'supported_token_price': ['get_token_price'],
    'dashboard': authenticated ? ['get_dashboard'] : [],
    'transaction_history': authenticated ? ['get_transaction_history'] : [],
    'general': [] // Let LLM decide
  };

  return functionMap[intent] || [];
}

/**
 * Validate function parameters before execution
 */
function validateFunctionParameters(functionName, parameters, authCtx, userExpertise = 'intermediate') {
  const { authenticated } = authCtx;

  // Check authentication requirements
  const authRequiredFunctions = [
    'create_sell_transaction', 'get_sell_quote', 'create_buy_transaction',
    'get_buy_quote', 'get_dashboard', 'get_transaction_history',
    'get_bank_details', 'initiate_swap', 'check_transaction_status'
  ];

  if (authRequiredFunctions.includes(functionName) && !authenticated) {
    return `This function requires authentication. Please sign in first.`;
  }

  // Validate required parameters - adapt message based on user expertise
  const requiredParams = getRequiredParamsForFunction(functionName);
  for (const param of requiredParams) {
    if (parameters[param] === undefined || parameters[param] === null || parameters[param] === '') {
      // Provide guidance based on parameter and user expertise
      if (param === 'network') {
        if (userExpertise === 'novice') {
          return `I need to know which network you're using. This depends on where you're sending from. For example: If you're sending USDT from Binance, it's usually TRON (TRC20). If from Coinbase, it's usually Ethereum (ERC20). Can you tell me which exchange or wallet you're using?`;
        } else if (userExpertise === 'expert') {
          return `Which network? (e.g., TRON/TRC20, Ethereum/ERC20, BSC/BEP20)`;
        } else {
          return `Which network are you using? (e.g., TRON/TRC20 for USDT from Binance, Ethereum/ERC20 for USDT from Coinbase)`;
        }
      }
      if (param === 'token') {
        if (userExpertise === 'novice') {
          return `Which cryptocurrency would you like to sell? Supported tokens: BTC, ETH, SOL, USDT, USDC, BNB, MATIC, or AVAX.`;
        } else {
          return `Which token? (BTC, ETH, SOL, USDT, USDC, BNB, MATIC, AVAX)`;
        }
      }
      if (param === 'amount') {
        if (userExpertise === 'novice') {
          return `How much ${parameters.token || 'crypto'} would you like to sell?`;
        } else {
          return `Amount?`;
        }
      }
      return userExpertise === 'novice'
        ? `I need to know: ${param}. Can you provide this information?`
        : `Missing: ${param}`;
    }
  }

  // Validate enum values
  if (functionName === 'get_token_price' && parameters.token) {
    const validTokens = ['BTC', 'ETH', 'SOL', 'USDT', 'USDC', 'BNB', 'MATIC', 'AVAX'];
    if (!validTokens.includes(parameters.token.toUpperCase())) {
      return `Invalid token: ${parameters.token}. Supported tokens: ${validTokens.join(', ')}`;
    }
    // Normalize token to uppercase
    parameters.token = parameters.token.toUpperCase();
  }

  return null; // No validation errors
}

/**
 * Get required parameters for a function
 */
function getRequiredParamsForFunction(functionName) {
  const paramMap = {
    'create_sell_transaction': ['token', 'network'],
    'create_buy_transaction': ['token', 'network', 'amount'],
    'get_buy_quote': ['token', 'amount'],
    'check_transaction_status': ['paymentId'],
    'get_token_price': ['token'],
    'get_bank_details': ['bankCode', 'accountNumber'],
    'initiate_swap': ['fromToken', 'toToken', 'amount', 'fromNetwork', 'toNetwork'],
    'get_naira_rates': [],
    'get_dashboard': [],
    'get_transaction_history': []
  };

  return paramMap[functionName] || [];
}

/**
 * Get tool_choice parameter based on intent
 * 'auto' = let LLM decide
 * 'required' = force function call
 * { type: 'function', function: { name: 'function_name' } } = force specific function
 */
function getToolChoiceForIntent(intent, authCtx, message) {
  const { authenticated } = authCtx;
  const msg = String(message || '').toLowerCase();

  // For clear intents, guide the LLM more strongly
  if (intent === 'naira_rates') {
    return { type: 'function', function: { name: 'get_naira_rates' } };
  }

  if (intent === 'supported_token_price') {
    // Extract token from message if possible
    const tokenMatch = msg.match(/\b(btc|bitcoin|eth|ethereum|sol|solana|usdt|tether|usdc|bnb|binance|matic|polygon|avax|avalanche)\b/i);
    if (tokenMatch) {
      return { type: 'function', function: { name: 'get_token_price' } };
    }
    return 'auto'; // Let LLM ask which token
  }

  if (intent === 'dashboard' && authenticated) {
    return { type: 'function', function: { name: 'get_dashboard' } };
  }

  if (intent === 'transaction_history' && authenticated) {
    return { type: 'function', function: { name: 'get_transaction_history' } };
  }

  if (intent === 'sell' && authenticated) {
    // Check if we have all required info for sell
    const hasToken = /\b(btc|eth|sol|usdt|usdc|bnb|matic|avax|bitcoin|ethereum|solana)\b/i.test(msg);
    const hasNetwork = /\b(bitcoin|ethereum|erc20|tron|trc20|solana|bsc|bep20|bnb smart chain|polygon|avalanche)\b/i.test(msg);
    const hasAmount = /\d+/.test(msg);

    // If we have token and amount, suggest quote (network can be auto-detected for quote)
    if (hasToken && hasAmount) {
      return { type: 'function', function: { name: 'get_sell_quote' } };
    }
    // If we have token and network and amount, suggest create transaction
    if (hasToken && hasNetwork && hasAmount) {
      return { type: 'function', function: { name: 'create_sell_transaction' } };
    }
    // Otherwise, let LLM ask for missing info conversationally
    return 'auto';
  }

  // Default: let LLM decide
  return 'auto';
}

// Handle function calling with tool execution (R2: Function Calling)
async function handleFunctionCall(toolCall, authCtx) {
  const functionName = toolCall.function.name;
  let functionArgs = {};

  try {
    functionArgs = JSON.parse(toolCall.function.arguments || '{}');
  } catch (parseError) {
    logger.error('Failed to parse function arguments', {
      function: functionName,
      arguments: toolCall.function.arguments,
      error: parseError.message
    });
    return {
      role: 'tool',
      tool_call_id: toolCall.id,
      content: JSON.stringify({
        success: false,
        error: 'Invalid function arguments',
        message: 'The function arguments could not be parsed. Please try again.'
      })
    };
  }

  const toolCallId = toolCall.id; // Get tool_call_id

  // Validate required parameters based on function
  const validationError = validateFunctionParameters(functionName, functionArgs, authCtx);
  if (validationError) {
    logger.warn('Function parameter validation failed', {
      function: functionName,
      arguments: functionArgs,
      error: validationError
    });
    return {
      role: 'tool',
      tool_call_id: toolCallId,
      content: JSON.stringify({
        success: false,
        error: 'Missing required parameters',
        message: validationError,
        requiredParams: getRequiredParamsForFunction(functionName)
      })
    };
  }

  logger.info('Function call requested', {
    function: functionName,
    arguments: functionArgs,
    toolCallId
  });

  try {
    // Special handling for sell transactions - create session
    // Special handling for sell transactions - create session
// Special handling for sell transactions - create session
// Special handling for sell transactions - create session
if (functionName === 'create_sell_transaction') {
  // Execute the tool first
  const toolResult = await executeTool(functionName, functionArgs, authCtx);

  // Log tool execution result
  logger.info('Tool execution result', {
    function: functionName,
    toolCallId,
    success: toolResult.success,
    hasData: !!toolResult.data,
    message: toolResult.message,
    error: toolResult.error,
    paymentId: toolResult.data?.paymentId,
    dataPreview: toolResult.data ? (typeof toolResult.data === 'object' ?
      Object.keys(toolResult.data).slice(0, 5).join(', ') :
      String(toolResult.data).substring(0, 100)) : null
  });

  // Call validate_account and then save_payout immediately after successful sell transaction if bank details provided
  if (toolResult.success && toolResult.data?.paymentId) {
    // Check if we have basic bank details to validate and save payout
    const hasBasicBankDetails = functionArgs.bankCode && functionArgs.accountNumber;
    
    if (hasBasicBankDetails) {
      try {
        // Prepare parameters for validate_account
        const validateArgs = {
          bankCode: functionArgs.bankCode,
          accountNumber: functionArgs.accountNumber,
          providedName: functionArgs.bankName // Pass provided bank name for matching if partial/incomplete
        };

        logger.info('Calling validate_account after successful sell transaction', {
          userId: authCtx.userId,
          paymentId: toolResult.data.paymentId,
          validateArgs
        });

        // Call validate_account tool
        const validateResult = await executeTool('validate_account', validateArgs, authCtx);

        logger.info('validate_account execution result', {
          success: validateResult.success,
          hasData: !!validateResult.data,
          message: validateResult.message,
          paymentId: toolResult.data.paymentId
        });

        if (!validateResult.success) {
          logger.warn('validate_account failed after sell transaction', {
            paymentId: toolResult.data.paymentId,
            error: validateResult.error,
            message: validateResult.message
          });
          
          // Add warning to response but proceed to save with provided details if available
          toolResult.validationWarning = validateResult.message || 'Failed to validate bank details';
        } else {
          // Use validated details for payout
          const validatedAccountName = validateResult.data?.accountName || functionArgs.accountName;
          const validatedBankName = validateResult.data?.bankName || functionArgs.bankName;
          
          // Merge validation success into main result
          toolResult.validationSuccess = true;
          toolResult.validatedDetails = {
            bankName: validatedBankName,
            bankCode: functionArgs.bankCode,
            accountNumber: functionArgs.accountNumber,
            accountName: validatedAccountName
          };

          // Append validation message (includes double-check prompt)
          if (toolResult.message && validateResult.message) {
            toolResult.message += ` ${validateResult.message}`;
          } else if (validateResult.message) {
            toolResult.message = validateResult.message;
          }

          logger.info('Account validated successfully', {
            paymentId: toolResult.data.paymentId,
            accountName: validatedAccountName
          });

          // Proceed to save payout with validated details
          const payoutUrl = `${API_BASE_URL}/sell/payout`;
          const headers = {
            'Content-Type': 'application/json'
          };
          if (authCtx.token) {
            headers['Authorization'] = `Bearer ${authCtx.token}`;
          }

          const payoutResponse = await axios.post(
            payoutUrl,
            {
              paymentId: toolResult.data.paymentId,
              bankName: validatedBankName,
              bankCode: functionArgs.bankCode,
              accountNumber: functionArgs.accountNumber,
              accountName: validatedAccountName
            },
            {
              headers,
              timeout: 10000,
              validateStatus: (status) => status < 500
            }
          );

          const payoutData = payoutResponse.data;

          logger.info('save_payout execution result', {
            success: payoutData.success,
            message: payoutData.message,
            paymentId: toolResult.data.paymentId
          });

          // Merge the payout save status into the main result
          if (payoutData.success) {
            toolResult.payoutSaved = true;
            toolResult.payoutDetails = toolResult.validatedDetails;
            
            logger.info('Payout details saved successfully with validated info', {
              paymentId: toolResult.data.paymentId,
              accountName: validatedAccountName
            });
          } else {
            logger.warn('Payout save returned success=false after validation', {
              paymentId: toolResult.data.paymentId,
              message: payoutData.message
            });
            
            // Add warning to response but don't fail the transaction
            toolResult.payoutWarning = payoutData.message || 'Failed to save payout details';
          }
        }
      } catch (validationError) {
        logger.error('Failed to validate or save payout details', {
          error: validationError.message,
          status: validationError.response?.status,
          userId: authCtx.userId,
          paymentId: toolResult.data?.paymentId
        });
        
        // Add error to response but don't fail the transaction
        toolResult.validationError = validationError.message;
        toolResult.payoutWarning = 'Bank details could not be validated or saved automatically. Please provide them again if needed.';
      }
    } else {
      // Log which basic bank details are missing
      logger.info('Validation/Payout not performed: missing basic bank details', {
        paymentId: toolResult.data.paymentId,
        hasBankCode: !!functionArgs.bankCode,
        hasAccountNumber: !!functionArgs.accountNumber
      });
    }
  } else {
    // Log why validation/payout wasn't performed
    if (!toolResult.success) {
      logger.info('Validation/Payout not performed: sell transaction failed');
    } else if (!toolResult.data?.paymentId) {
      logger.warn('Validation/Payout not performed: no paymentId in response');
    }
  }

  return {
    role: 'tool',
    tool_call_id: toolCallId,
    content: JSON.stringify(toolResult)
  };
}

    // Execute other tools normally
    const toolResult = await executeTool(functionName, functionArgs, authCtx);

    // Log tool execution result
    logger.info('Tool execution result', {
      function: functionName,
      toolCallId,
      success: toolResult.success,
      hasData: !!toolResult.data,
      message: toolResult.message,
      error: toolResult.error,
      dataPreview: toolResult.data ? (typeof toolResult.data === 'object' ?
        Object.keys(toolResult.data).slice(0, 5).join(', ') :
        String(toolResult.data).substring(0, 100)) : null
    });

    return {
      role: 'tool',
      tool_call_id: toolCallId,
      content: JSON.stringify(toolResult)
    };
  } catch (error) {
    logger.error('Tool execution error', {
      function: functionName,
      error: error.message,
      toolCallId
    });

    // Return error response
    return {
      role: 'tool',
      tool_call_id: toolCallId,
      content: JSON.stringify({
        success: false,
        error: error.message || 'Tool execution failed'
      })
    };
  }
}

// Session checking removed - no longer using session windows

/**
 * Process browsing chat with OpenAI browsing capability
 */
async function processBrowsingChat({ sessionId, message, history = [], authCtx = {}, timeout }) {
  const startTime = Date.now();
  const session = getSession(sessionId);
  const userExpertise = detectUserExpertise(message, history);

  // Build messages array
  const messages = [];
  messages.push({
    role: 'system',
    content: buildSystemPrompt(authCtx, userExpertise)
  });

  // Add conversation history
  const recentHistory = history.slice(-20).map(h => ({
    role: h.role || 'user',
    content: h.content || h.text || ''
  }));
  messages.push(...recentHistory);

  // Add current user message
  messages.push({
    role: 'user',
    content: message
  });

  try {
    // Use OpenAI with browsing enabled (if available)
    const completion = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: messages,
      tools: AVAILABLE_TOOLS,
      tool_choice: 'auto',
      max_completion_tokens: AI_OUTPUT_MAX_TOKENS * 2, // Allow more tokens for browsing results
      temperature: 0.7
    });

    const assistantMessage = completion.choices[0].message;
    let finalMessages = [...messages, assistantMessage];

    // Handle function calls
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      const functionCalls = assistantMessage.tool_calls.filter(tc => tc.type === 'function');

      // Execute all tool calls
      const functionPromises = functionCalls.map(async (toolCall) => {
        try {
          return await handleFunctionCall(toolCall, authCtx, userExpertise);
        } catch (error) {
          logger.error('Failed to handle function call during browsing', {
            toolCallId: toolCall.id,
            error: error.message
          });
          return {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              success: false,
              error: error.message || 'Function execution failed'
            })
          };
        }
      });

      const results = await Promise.all(functionPromises);

      // Add results to messages
      results.forEach(result => {
        if (result) {
          finalMessages.push(result);
        }
      });

      // Continue conversation to get final response
      const finalCompletion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: finalMessages,
        tools: AVAILABLE_TOOLS,
        tool_choice: 'none',
        max_completion_tokens: AI_OUTPUT_MAX_TOKENS * 2,
        temperature: 0.7
      });

      const finalResponse = finalCompletion.choices[0].message.content || '';

      return {
        reply: finalResponse.trim(),
        metadata: {
          intent: 'browsing_complete',
          functionsCalled: functionCalls.map(tc => tc.function.name),
          responseTime: Date.now() - startTime,
          model: AI_MODEL
        }
      };
    }

    // No function calls - direct response
    return {
      reply: assistantMessage.content || '',
      metadata: {
        intent: 'browsing_complete',
        responseTime: Date.now() - startTime,
        model: AI_MODEL
      }
    };

  } catch (error) {
    logger.error('Browsing chat processing failed', {
      error: error.message,
      stack: error.stack
    });

    return {
      reply: "I encountered an issue while gathering information. Please try again.",
      metadata: {
        intent: 'error',
        responseTime: Date.now() - startTime,
        error: error.message
      }
    };
  }
}

// Core chat processing with function calling
async function processChat({ sessionId, message, history = [], authCtx }) {
  const startTime = Date.now();
  const msg = String(message || '').trim();

  if (!msg) {
    return {
      reply: 'Send me something to work with.',
      metadata: { intent: 'empty', responseTime: Date.now() - startTime }
    };
  }

  // Check if sell session expired
  // Session checking removed - no longer using session windows

  // Get or create session
  const session = getSession(sessionId);
  if (!session.welcomed && !authCtx.authenticated) {
    session.welcomed = true;
  }

  // Build messages array
  const messages = [];

  // Detect user expertise level for adaptive communication
  const userExpertise = detectUserExpertise(msg, history);

  // Add system prompt with expertise-aware guidance
  messages.push({
    role: 'system',
    content: buildSystemPrompt(authCtx, userExpertise)
  });

  // Add conversation history (keep last 20 messages)
  const recentHistory = history.slice(-20).map(h => ({
    role: h.role || 'user',
    content: h.content || h.text || ''
  }));
  messages.push(...recentHistory);

  // Add current user message
  messages.push({
    role: 'user',
    content: msg
  });

  // Detect intent to guide function calling
  const detectedIntent = quickIntentCheck(msg);
const contextAnalysis = analyzeConversationContext(msg, history, authCtx);
const finalIntent = contextAnalysis.intent || detectedIntent;

// Get recommended functions and tool choice based on intent
const recommendedFunctions = getRecommendedFunctionsForIntent(finalIntent, authCtx);
let toolChoice = getToolChoiceForIntent(finalIntent, authCtx, msg);

// Normalize tool_choice to prevent invalid values (fixes 400 error if 'tool_choice' is mistakenly returned)
if (typeof toolChoice === 'string' && toolChoice === 'tool_choice') {
  toolChoice = 'auto';
  logger.warn('Normalized invalid tool_choice from "tool_choice" to "auto"', { finalIntent });
}

// Reduce logging overhead - only log in debug mode or for errors
if (process.env.DEBUG_LOGGING === 'true') {
  logger.info('Intent detected for function calling', {
    message: msg.substring(0, 100),
    detectedIntent,
    finalIntent,
    recommendedFunctions,
    toolChoice: typeof toolChoice === 'object' ? toolChoice.function?.name : toolChoice,
    authenticated: authCtx.authenticated
  });
}
  // If OpenAI not available, return helpful message
  if (!openai) {
    return {
      reply: "I'm having a technical moment. Please check back in a few seconds or use the app directly.",
      showWidget: false,
      metadata: {
        intent: finalIntent,
        responseTime: Date.now() - startTime,
        error: 'openai_not_available'
      }
    };
  }

  try {
    // Enhance system prompt with intent-specific guidance
    let enhancedPrompt = buildSystemPrompt(authCtx);
    if (recommendedFunctions.length > 0) {
      enhancedPrompt += `\n\nCURRENT USER INTENT: ${finalIntent}\nRecommended functions: ${recommendedFunctions.join(', ')}\nConsider using these functions to fulfill the user's request.`;
    }

    // Update system message with enhanced prompt
    messages[0] = {
      role: 'system',
      content: enhancedPrompt
    };

    // Call OpenAI with function calling
    const completion = await openai.chat.completions.create({
  model: AI_MODEL,
  messages: messages,
  tools: AVAILABLE_TOOLS,
  tool_choice: toolChoice, // Now safely normalized
  max_completion_tokens: AI_OUTPUT_MAX_TOKENS,
  temperature: 0.7
});

    const assistantMessage = completion.choices[0].message;
    let finalMessages = [...messages, assistantMessage];
    let functionResults = [];

    // Handle function calls (R2: Function Calling)
    // Note: Frontend should handle authentication checks before sending sell/buy requests
    // Backend validation is kept as a safety measure only
    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      // Execute all tool calls in parallel for better performance
      const functionCalls = assistantMessage.tool_calls.filter(tc => tc.type === 'function');

      const functionPromises = functionCalls.map(async (toolCall) => {
        try {
          return await handleFunctionCall(toolCall, authCtx, userExpertise);
        } catch (error) {
          logger.error('Failed to handle function call', {
            toolCallId: toolCall.id,
            error: error.message
          });
          // Return error response for this tool call
          return {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({
              success: false,
              error: error.message || 'Function execution failed'
            })
          };
        }
      });

      // Check if any function call requires browsing
      const hasBrowsingCall = functionCalls.some(tc => tc.function.name === 'browse_web');

      // Wait for all function calls to complete in parallel
      const results = await Promise.all(functionPromises);

      // Map results back to their tool call IDs for proper ordering
      const resultMap = new Map();
      results.forEach(result => {
        if (result.tool_call_id) {
          resultMap.set(result.tool_call_id, result);
        }
      });

      // Add results in the order of tool calls
      functionCalls.forEach(toolCall => {
        const result = resultMap.get(toolCall.id) || results.find(r => r.tool_call_id === toolCall.id);
        if (result) {
          functionResults.push(result);
          finalMessages.push(result);
        }
      });

      // If browsing is required, return special flag for background processing
      if (hasBrowsingCall) {
        return {
          reply: "This might take a moment while I gather the latest information for you...",
          browsing: true,
          metadata: {
            intent: 'browsing',
            functionsCalled: ['browse_web'],
            responseTime: Date.now() - startTime,
            model: AI_MODEL
          }
        };
      }

      // Layer 3: Format response using LLM with context from original query
      // Always use LLM to format responses naturally using the original user message context
      logger.info('Layer 3: Formatting response with LLM', {
        originalMessage: msg.substring(0, 100),
        functionsCalled: functionCalls.map(tc => tc.function.name)
      });

      // Add a system message to guide the LLM on how to format the response
      const formattingPrompt = `The user asked: "${msg}"

You have executed the function(s) and received the results. Now format a natural, conversational response that:
1. Directly answers the user's original question
2. Uses the function results to provide specific information
3. Sounds natural and human-like (not robotic)
4. Is professional but friendly
5. Extracts and displays the actual data from the function results clearly

Do NOT just repeat "function executed successfully" - show the actual data and answer their question!`;

      // Add formatting instruction to messages
      finalMessages.push({
        role: 'user',
        content: formattingPrompt
      });

      const finalCompletion = await openai.chat.completions.create({
        model: AI_MODEL,
        messages: finalMessages,
        tools: AVAILABLE_TOOLS,
        tool_choice: 'none', // Don't call more functions, just format the response
        max_completion_tokens: AI_OUTPUT_MAX_TOKENS,
        temperature: 0.7
      });

      const finalResponse = finalCompletion.choices[0].message.content || '';

      // Update session
      if (!authCtx.authenticated) {
        session.aiTurns += 1;
      }

      const response = {
        reply: finalResponse.trim() || 'I\'ve executed that action for you. Is there anything else?',
        metadata: {
          intent: 'function_called',
          functionsCalled: assistantMessage.tool_calls.map(tc => tc.function.name),
          responseTime: Date.now() - startTime,
          model: AI_MODEL
        }
      };

      // Log the response being returned
      logger.info('Function call response generated', {
        functionsCalled: response.metadata.functionsCalled,
        replyLength: response.reply.length,
        replyPreview: response.reply.substring(0, 200),
        responseTime: response.metadata.responseTime
      });

      return response;
    }

    // No function calls - direct response
    const response = assistantMessage.content || '';

    if (!authCtx.authenticated) {
      session.aiTurns += 1;
    }

    return {
      reply: response.trim(),
      metadata: {
        intent: finalIntent,
        detectedIntent: detectedIntent,
        responseTime: Date.now() - startTime,
        model: AI_MODEL
      }
    };

  } catch (error) {
    logger.error('Chat processing failed', {
      error: error.message,
      stack: error.stack,
      status: error.response?.status
    });

    return {
      reply: "I'm having a technical moment. Please try again in a few seconds.",
      showWidget: false,
      metadata: {
        intent: 'error',
        responseTime: Date.now() - startTime,
        error: error.message
      }
    };
  }
}

// ROUTES
router.post('/chat', async (req, res) => {
  try {
    const authCtx = await getAuthContext(req);
    const { message, history = [], sessionId } = req.body || {};
    const id = String(sessionId || authCtx.userId || req.ip || 'anon');

    const result = await processChat({
      sessionId: id,
      message,
      history,
      authCtx
    });

    // If browsing is required, send immediate response and process in background
    if (result.browsing) {
      // Send immediate response
      const immediateResponse = {
        reply: result.reply,
        browsing: true,
        timestamp: new Date().toISOString(),
        metadata: result.metadata || {}
      };

      res.json(immediateResponse);

      // Process browsing in background with 3-minute timeout
      const browsingTimeout = setTimeout(() => {
        logger.warn('Browsing timeout after 3 minutes', { sessionId: id });
      }, 3 * 60 * 1000); // 3 minutes

      (async () => {
        try {
          // Re-process with browsing enabled
          const browsingResult = await processBrowsingChat({
            sessionId: id,
            message,
            history,
            authCtx,
            timeout: browsingTimeout
          });

          clearTimeout(browsingTimeout);

          // Send final response via WebSocket or polling endpoint
          // For now, we'll use a callback mechanism
          // Store result for polling endpoint
          if (!browsingResults) browsingResults = new Map();
          browsingResults.set(id, {
            reply: browsingResult.reply,
            timestamp: new Date().toISOString(),
            metadata: browsingResult.metadata || {},
            completed: true
          });

          // Clean up after 5 minutes
          setTimeout(() => {
            browsingResults?.delete(id);
          }, 5 * 60 * 1000);

        } catch (browsingError) {
          clearTimeout(browsingTimeout);
          logger.error('Background browsing failed', {
            error: browsingError.message,
            sessionId: id
          });

          if (!browsingResults) browsingResults = new Map();
          browsingResults.set(id, {
            reply: "I encountered an issue while gathering information. Please try again.",
            timestamp: new Date().toISOString(),
            metadata: { error: browsingError.message },
            completed: true
          });
        }
      })();

      return; // Don't send another response
    }

    const responsePayload = {
      reply: result.reply,
      showWidget: result.showWidget || false,
      timestamp: new Date().toISOString(),
      metadata: result.metadata || {}
    };

    // Log what's being sent to frontend
    logger.info('Sending response to frontend', {
      sessionId: id,
      userId: authCtx.userId,
      replyLength: responsePayload.reply.length,
      replyPreview: responsePayload.reply.substring(0, 300),
      showWidget: responsePayload.showWidget,
      intent: responsePayload.metadata.intent,
      functionsCalled: responsePayload.metadata.functionsCalled,
      responseTime: responsePayload.metadata.responseTime,
      fullResponse: responsePayload
    });

    res.json(responsePayload);
  } catch (err) {
    logger.error('Chat endpoint error', {
      error: err.message,
      stack: err.stack
    });
    res.status(500).json({
      error: 'Internal server error',
      reply: 'Something went wrong. Please try again.'
    });
  }
});

// Store browsing results for polling
let browsingResults = null;

// Polling endpoint for browsing results
router.get('/chat/browsing/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!browsingResults || !browsingResults.has(sessionId)) {
      return res.json({
        completed: false,
        message: 'Still processing...'
      });
    }

    const result = browsingResults.get(sessionId);
    browsingResults.delete(sessionId); // Remove after retrieval

    res.json(result);
  } catch (err) {
    logger.error('Browsing polling error', {
      error: err.message
    });
    res.status(500).json({
      error: 'Internal server error'
    });
  }
});

// Health check
router.get('/chat/health', async (_req, res) => {
  res.json({
    status: 'active',
    openai: !!openai,
    model: AI_MODEL,
    toolsAvailable: AVAILABLE_TOOLS.length,
    sellSessions: 0, // Session management removed
    sessions: chatSessions.size,
    timestamp: new Date().toISOString()
  });
});

// Sell session endpoint removed - no longer using session windows

module.exports = router;
