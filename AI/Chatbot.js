// AI/Chatbot.js — Modern LLM-powered chatbot with tool use (R1-R3)
// Architecture: Structured Prompts (R1) + Tool Use (R2) + Tool Router (R3)
// No fine-tuning needed - uses Claude tool use (Anthropic Messages API)
//
// Internal representation stays in the same shape this file always used
// (OpenAI-style: assistantMessage.tool_calls[].function.{name,arguments as
// JSON string}, tool results as {role:'tool', tool_call_id, content}). The
// callClaude() adapter below is the ONLY place that speaks Anthropic's actual
// wire format — everything else (intent detection, validation, the sell-flow
// tool chaining, etc.) is untouched by the provider swap.

require('dotenv').config();
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Anthropic = (() => { try { return require('@anthropic-ai/sdk'); } catch (e) { return null; } })();
const { AVAILABLE_TOOLS, executeTool } = require('./tools');
const { quickIntentCheck, analyzeConversationContext } = require('./aiIntents');
// Session management removed - no longer using 2-minute session windows
const cache = require('./cache');
const logger = require('../utils/logger');
const axios = require('axios');

// Config
const JWT_SECRET = process.env.JWT_SECRET || process.env.ACCESS_TOKEN_SECRET || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const AI_MODEL = process.env.CLAUDE_MODEL_PRIMARY || 'claude-sonnet-5';
const AI_OUTPUT_MAX_TOKENS = parseInt(process.env.AI_OUTPUT_MAX_TOKENS || '500', 10);
const MAX_SESSION_MESSAGES = parseInt(process.env.AI_MAX_SESSION_MESSAGES || '15', 10);
const API_BASE_URL = process.env.API_BASE_URL || 'https://priscaai.online';

// Anthropic client
let anthropic = null;
try {
  if (Anthropic && ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    logger.info('Anthropic initialized with tool use support', { model: AI_MODEL });
  } else {
    logger.warn('ANTHROPIC_API_KEY missing or Anthropic SDK not installed');
  }
} catch (e) {
  logger.error('Anthropic init error:', e?.message || e);
}

// ─── OpenAI-shape compatibility adapter over the Anthropic Messages API ────
// Converts this file's existing OpenAI-shaped {messages, tools, tool_choice}
// call into a real Anthropic request, and converts the response back into an
// OpenAI-completion-shaped object ({choices:[{message:{content,tool_calls}}]})
// so every call site below is unchanged.

function toAnthropicTools(openAiTools) {
  return (openAiTools || []).map(t => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters
  }));
}

function toAnthropicToolChoice(openAiChoice) {
  if (!openAiChoice || openAiChoice === 'auto') return { type: 'auto' };
  if (openAiChoice === 'required' || openAiChoice === 'any') return { type: 'any' };
  if (typeof openAiChoice === 'object' && openAiChoice.function?.name) {
    return { type: 'tool', name: openAiChoice.function.name };
  }
  return { type: 'auto' };
}

// Splits an OpenAI-shaped messages array into Anthropic's {system, messages}
// shape. Handles the three message forms this file actually produces: plain
// user/assistant text, an assistant message carrying .tool_calls (pushed back
// in after a completion), and {role:'tool', tool_call_id, content} results.
function toAnthropicMessages(openAiMessages) {
  let system = '';
  const converted = [];

  for (const m of openAiMessages) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + m.content;
    } else if (m.role === 'user') {
      converted.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      if (m.tool_calls && m.tool_calls.length > 0) {
        const blocks = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const tc of m.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function.arguments || '{}'); } catch (_) { /* leave empty */ }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
        converted.push({ role: 'assistant', content: blocks });
      } else {
        converted.push({ role: 'assistant', content: m.content || '' });
      }
    } else if (m.role === 'tool') {
      converted.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }]
      });
    }
  }

  return { system, messages: converted };
}

async function callClaude({ model, messages, tools, tool_choice, max_completion_tokens }) {
  const { system, messages: anthMessages } = toAnthropicMessages(messages);

  const params = {
    model: model || AI_MODEL,
    system: system || undefined,
    messages: anthMessages,
    max_tokens: max_completion_tokens || AI_OUTPUT_MAX_TOKENS
    // No temperature — claude-sonnet-5 hard-rejects it (400: "temperature is
    // deprecated for this model"), unlike OpenAI where it's just a knob.
    // Callers below still pass temperature (leftover from the OpenAI-shaped
    // call sites) but it's intentionally dropped here at the adapter boundary.
  };

  // tool_choice 'none' means "don't call more tools, just answer" — the
  // Anthropic-native way to force that is to omit tools entirely.
  if (tool_choice !== 'none' && tools && tools.length > 0) {
    params.tools = toAnthropicTools(tools);
    params.tool_choice = toAnthropicToolChoice(tool_choice);
  }

  const response = await anthropic.messages.create(params);

  let textContent = '';
  const toolCalls = [];
  for (const block of response.content || []) {
    if (block.type === 'text') {
      textContent += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: { name: block.name, arguments: JSON.stringify(block.input || {}) }
      });
    }
  }

  return {
    choices: [{
      message: {
        role: 'assistant',
        content: textContent,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined
      }
    }]
  };
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
function buildSystemPrompt(authCtx = {}, userExpertise = 'intermediate', assistantName = null) {
  const selfName = assistantName && assistantName.trim() ? assistantName.trim() : 'Bramp AI';
  let prompt = `You are ${selfName}, the user's AI assistant for Bramp — composed, precise, and quietly capable, in the manner of Jarvis. When asked your name, or what to call you, answer "${selfName}" — that's the name the user chose for you, use it consistently, never revert to calling yourself "Bramp AI" or any other name once one has been set. You address the user directly, never pad with corporate filler, and get straight to what's useful. Confident and efficient, not chatty for its own sake.

ABOUT BRAMP: Bramp converts crypto to Naira automatically. Deposits are auto-converted to NGNB (Bramp's naira balance) the moment they land — there is no manual "sell" or "swap" step for the user to trigger. Your job is to help users understand and act on their account, not to broker manual trades.

WHAT YOU CAN DO:
- Show dashboard/portfolio and balances (if authenticated)
- Show transaction history and check a specific transaction's status
- Show current NGN rates and token prices
- Validate a bank account's details (resolve the account name before a withdrawal)
- Show and manage notifications (view, mark read)
- Prepare a withdrawal, airtime purchase, data purchase, electricity payment, or cable TV payment
- Answer finance and crypto questions conversationally — how crypto works, market concepts, NGN economics, personal finance as it relates to using Bramp

SECURITY — NON-NEGOTIABLE: You NEVER ask for, accept, or process a PIN, password, or 2FA code in chat. For anything that moves money (withdrawal, airtime, data, electricity, cable), your "prepare_*" tools only validate details and hand off to the app's own secure confirmation screen — that screen is where the user enters their PIN. After calling one of these tools, tell the user what you've prepared and that they should confirm it on the screen that just opened. Do not imply the action is complete until they've confirmed it there.

SCOPE: Stay strictly within finance and crypto — Bramp's own features, cryptocurrency, blockchain concepts, Nigerian financial context, and personal finance as it relates to money and crypto. For anything outside that (coding help, general trivia, unrelated topics), decline briefly and steer back to what you can actually help with. Don't be preachy about it — one line, then move on.

GUIDELINES:
1. Be direct and confident, not corporate or over-eager.
2. Adapt your depth and vocabulary to the user's apparent expertise level (see below) — don't over-explain to someone who clearly knows crypto, and don't assume jargon for someone who doesn't.
3. Present account numbers, bank names, and similar details clearly and precisely so they're easy to copy correctly.
4. If a user asks to "sell" or "swap" crypto, explain that deposits auto-convert to NGNB automatically — there's nothing manual for them to trigger.
`;

  return prompt;
}
/**
 * Map detected intent to recommended function(s)
 * This helps guide the LLM to call the right function
 */
function getRecommendedFunctionsForIntent(intent, authCtx) {
  const { authenticated } = authCtx;
  const functionMap = {
    'sell': [], // No manual sell — deposits auto-convert; let the LLM explain that
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
    'get_dashboard', 'get_transaction_history', 'check_transaction_status',
    'validate_account', 'get_notifications', 'mark_notification_read',
    'prepare_withdrawal', 'prepare_airtime_purchase', 'prepare_data_purchase',
    'prepare_electricity_purchase', 'prepare_cable_purchase'
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
    'check_transaction_status': ['paymentId'],
    'get_token_price': ['token'],
    'validate_account': ['accountNumber'],
    'prepare_withdrawal': ['amount', 'accountNumber'],
    'prepare_airtime_purchase': ['phone', 'network', 'amount'],
    'prepare_data_purchase': ['phone', 'network'],
    'prepare_electricity_purchase': ['meterNumber', 'disco', 'meterType', 'amount'],
    'prepare_cable_purchase': ['smartcardNumber', 'provider'],
    'get_naira_rates': [],
    'get_dashboard': [],
    'get_transaction_history': [],
    'get_notifications': [],
    'mark_notification_read': []
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

  // 'sell' intent: no manual sell tool exists anymore (deposits auto-convert),
  // so just let the LLM explain that per the system prompt.

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
 * Process browsing chat, using the browse_web tool for live information
 */
async function processBrowsingChat({ sessionId, message, history = [], authCtx = {}, timeout, assistantName = null }) {
  const startTime = Date.now();
  const session = getSession(sessionId);
  const userExpertise = detectUserExpertise(message, history);

  // Build messages array
  const messages = [];
  messages.push({
    role: 'system',
    content: buildSystemPrompt(authCtx, userExpertise, assistantName)
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
    // Use Claude with browsing enabled (if available)
    const completion = await callClaude({
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
      const finalCompletion = await callClaude({
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
async function processChat({ sessionId, message, history = [], authCtx, assistantName = null }) {
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

  // Hard cap on messages per session to prevent abuse — counted before the
  // Claude call so a session at the limit never triggers another API call.
  session.aiTurns += 1;
  if (session.aiTurns > MAX_SESSION_MESSAGES) {
    return {
      reply: "We've reached the limit for this conversation — please start a new chat to keep going.",
      metadata: {
        intent: 'session_limit_reached',
        responseTime: Date.now() - startTime
      }
    };
  }

  // Build messages array
  const messages = [];

  // Detect user expertise level for adaptive communication
  const userExpertise = detectUserExpertise(msg, history);

  // Add system prompt with expertise-aware guidance
  messages.push({
    role: 'system',
    content: buildSystemPrompt(authCtx, userExpertise, assistantName)
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
  // If Claude not available, return helpful message
  if (!anthropic) {
    return {
      reply: "I'm having a technical moment. Please check back in a few seconds or use the app directly.",
      showWidget: false,
      metadata: {
        intent: finalIntent,
        responseTime: Date.now() - startTime,
        error: 'claude_not_available'
      }
    };
  }

  try {
    // Enhance system prompt with intent-specific guidance
    let enhancedPrompt = buildSystemPrompt(authCtx, userExpertise, assistantName);
    if (recommendedFunctions.length > 0) {
      enhancedPrompt += `\n\nCURRENT USER INTENT: ${finalIntent}\nRecommended functions: ${recommendedFunctions.join(', ')}\nConsider using these functions to fulfill the user's request.`;
    }

    // Update system message with enhanced prompt
    messages[0] = {
      role: 'system',
      content: enhancedPrompt
    };

    // Call Claude with tool use
    const completion = await callClaude({
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

      // If a tool prepared a money-moving action (withdrawal, bill payment),
      // hand off to the app's own secure PIN/2FA UI instead of formatting a
      // chat reply — PINs and 2FA codes must never be typed into chat text.
      // Short-circuits before Layer 3 since we already have a clear message.
      for (const result of functionResults) {
        let parsed;
        try { parsed = JSON.parse(result.content); } catch (_) { continue; }
        if (parsed && parsed.requiresConfirmation) {
          return {
            reply: parsed.message || 'I\'ve prepared that for you — please confirm in the app.',
            requiresConfirmation: true,
            confirmationScreen: parsed.confirmationScreen,
            prefillData: parsed.prefillData,
            metadata: {
              intent: 'requires_confirmation',
              functionsCalled: functionCalls.map(tc => tc.function.name),
              responseTime: Date.now() - startTime,
              model: AI_MODEL
            }
          };
        }
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

      const finalCompletion = await callClaude({
        model: AI_MODEL,
        messages: finalMessages,
        tools: AVAILABLE_TOOLS,
        tool_choice: 'none', // Don't call more functions, just format the response
        max_completion_tokens: AI_OUTPUT_MAX_TOKENS,
        temperature: 0.7
      });

      const finalResponse = finalCompletion.choices[0].message.content || '';

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
    const { message, history = [], sessionId, assistantName } = req.body || {};
    const id = String(sessionId || authCtx.userId || req.ip || 'anon');

    const result = await processChat({
      sessionId: id,
      message,
      history,
      authCtx,
      assistantName: typeof assistantName === 'string' ? assistantName.trim().slice(0, 50) : null
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
            assistantName: typeof assistantName === 'string' ? assistantName.trim().slice(0, 50) : null,
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
      requiresConfirmation: result.requiresConfirmation || false,
      confirmationScreen: result.confirmationScreen,
      prefillData: result.prefillData,
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
    provider: 'anthropic',
    available: !!anthropic,
    model: AI_MODEL,
    toolsAvailable: AVAILABLE_TOOLS.length,
    sellSessions: 0, // Session management removed
    sessions: chatSessions.size,
    timestamp: new Date().toISOString()
  });
});

// Sell session endpoint removed - no longer using session windows

module.exports = router;
