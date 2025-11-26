// AI/aiHelpers.js - GPT-5 Performance (optimized for quality and accuracy)
const SessionManager = require('./sessionManager');

// Balanced system messages
const SYSTEM_MESSAGES = {
  fast: "Hey! I'm Bramp AI - your friendly crypto helper. I'll give you quick, helpful answers in a natural, conversational way. No need to be formal - let's just chat!",
  standard: "Hey there! I'm Bramp AI, your go-to crypto buddy. I'm here to help you trade, check rates, and manage your crypto through Bramp. I'll keep things friendly and conversational - think of me as a helpful friend who knows a lot about crypto. Let's make this easy and fun!"
};

/**
 * Robust sendMessage that handles multiple OpenAI SDK shapes,
 * streaming and non-streaming, and returns a plain string.
 */
async function sendMessage(openaiClient, sessionId, userMessage, config = {}, retrievedFacts = []) {
  const requestStart = Date.now();

  const {
    model = process.env.OPENAI_MODEL_PRIMARY || 'gpt-5-mini',
    max_tokens = 300,
    temperature = 0.8,
    top_p = 0.9,
    stream = true,
    timeoutMs = parseInt(process.env.OPENAI_TIMEOUT_MS || '12000', 10)
  } = config;

  // Load recent session messages
  let sessionMessages = [];
  try {
    const session = await SessionManager.getSession(sessionId);
    sessionMessages = (session?.messages || []).slice(-4);
  } catch (err) {
    logger?.warn('Session load failed, continuing without context:', err?.message || err);
  }

  // Helper to extract text from chunk/response shapes
  function extractTextFromChunk(chunk) {
    if (!chunk) return '';
    try {
      if (typeof chunk === 'string') return chunk;
      if (chunk.output_text && typeof chunk.output_text === 'string') return chunk.output_text;
      if (chunk?.choices && Array.isArray(chunk.choices) && chunk.choices.length) {
        const c0 = chunk.choices[0];
        if (!c0) return '';
        if (c0.delta) {
          if (typeof c0.delta === 'string') return c0.delta;
          if (typeof c0.delta.content === 'string') return c0.delta.content;
          if (Array.isArray(c0.delta.content)) return c0.delta.content.join('');
          if (c0.delta?.content?.text) return String(c0.delta.content.text);
        }
        if (c0.text && typeof c0.text === 'string') return c0.text;
        if (c0.message && c0.message.content) {
          const cont = c0.message.content;
          if (typeof cont === 'string') return cont;
          if (Array.isArray(cont)) {
            return cont.map(part => (part?.text || part?.content || '')).join('');
          }
        }
      }
      if (chunk.output && Array.isArray(chunk.output) && chunk.output.length) {
        const first = chunk.output[0];
        if (first.content && Array.isArray(first.content)) {
          return first.content.map(c => (c?.text || c?.content || '')).join('');
        }
      }
      if (typeof chunk === 'object') {
        if (chunk?.text) return String(chunk.text);
        return JSON.stringify(chunk).slice(0, 1000);
      }
      return '';
    } catch (e) {
      return '';
    }
  }

  // Build messages
  const messages = [
    { role: 'system', content: (max_tokens <= 150 ? SYSTEM_MESSAGES.fast : SYSTEM_MESSAGES.standard) },
    ...sessionMessages.map(m => ({ role: m.role, content: (m.text || m.content || '').substring(0, 300) })),
    { role: 'user', content: userMessage }
  ];

  // Add concise RAG context
  if (retrievedFacts && retrievedFacts.length > 0) {
    const contextFacts = retrievedFacts.slice(0, 2).map((f, i) => `Fact ${i + 1}: ${String(f.text || f).substring(0, 400)}`).join('\n');
    messages.splice(-1, 0, { role: 'system', content: `Context: ${contextFacts}` });
  }

  // GPT-5-mini requires max_completion_tokens instead of max_tokens
  // GPT-5-mini only supports default temperature (1), so we omit temperature for GPT-5 models
  // GPT-5: Use minimal reasoning for faster responses while keeping intelligence
  const isGPT5 = model.includes('gpt-5-mini') || model.includes('gpt-5');
  const tokenParam = isGPT5 ? { max_completion_tokens: max_tokens } : { max_tokens };
  const tempParam = isGPT5 ? {
    reasoning_effort: "minimal",
    verbosity: "low"
  } : { temperature, top_p };
  const payload = { model, messages, ...tokenParam, ...tempParam };

  // Call the client
  let completionPromise;
  if (openaiClient?.chat && typeof openaiClient.chat.completions?.create === 'function') {
    completionPromise = openaiClient.chat.completions.create(payload);
  } else if (typeof openaiClient.responses?.create === 'function') {
    completionPromise = openaiClient.responses.create({
      model,
      input: messages.map(m => ({ role: m.role, content: m.content })),
      ...tokenParam,
      // GPT-5: Use minimal reasoning for faster responses
      ...(isGPT5 ? {
        reasoning: { effort: "minimal" },
        text: { verbosity: "low" }
      } : {})
    });
  } else {
    throw new Error('OpenAI client does not expose a chat or responses API in a supported shape');
  }

  // Timeout wrapper
  const completion = await Promise.race([
    completionPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('OpenAI request timeout')), timeoutMs))
  ]);

  let aiText = '';

  // Streaming detection: async iterator
  const isAsyncIter = completion && typeof completion[Symbol.asyncIterator] === 'function';
  if (stream && isAsyncIter) {
    const streamTimeout = setTimeout(() => { throw new Error('Stream processing timeout'); }, timeoutMs);
    try {
      for await (const chunk of completion) {
        const piece = extractTextFromChunk(chunk);
        if (piece) aiText += piece;
        // safe punctuation-based early stop after minimum length
        if (aiText.length > 300) {
          const trimmed = aiText.trim();
          const lastChar = trimmed[trimmed.length - 1];
          if (lastChar === '.' || lastChar === '!' || lastChar === '?') {
            break;
          }
        }
      }
    } finally {
      clearTimeout(streamTimeout);
    }
  } else {
    // Non-streaming extraction
    aiText = '';
    if (completion?.choices && Array.isArray(completion.choices) && completion.choices.length) {
      const c = completion.choices[0];
      if (c?.message?.content) {
        if (typeof c.message.content === 'string') aiText = c.message.content;
        else if (Array.isArray(c.message.content)) aiText = c.message.content.map(p => p?.text || p?.content || '').join('');
        else aiText = JSON.stringify(c.message.content);
      } else if (c?.text) aiText = c.text;
      else if (c?.delta) aiText = extractTextFromChunk(c);
    }
    if (!aiText && completion?.output && Array.isArray(completion.output) && completion.output.length) {
      const first = completion.output[0];
      if (first?.content && Array.isArray(first.content)) {
        aiText = first.content.map(p => (p?.text || p?.content || '')).join('');
      } else if (completion.output_text) {
        aiText = completion.output_text;
      }
    }
    if (!aiText && typeof completion === 'string') aiText = completion;
    if (!aiText && completion?.text) aiText = completion.text;
  }

  // sanitize & guarantee string
  if (!aiText || typeof aiText !== 'string') {
    try {
      aiText = String(aiText || '');
    } catch (e) {
      aiText = '';
    }
  }
  aiText = aiText.trim();
  if (!aiText) {
    throw new Error('Empty response from OpenAI (extracted text was empty)');
  }

  // Save to session
  try {
    await SessionManager.appendMessage(sessionId, { role: 'user', text: userMessage });
    await SessionManager.appendMessage(sessionId, { role: 'assistant', text: aiText });
  } catch (err) {
    logger?.warn('Session save failed:', err?.message || err);
  }

  const processingTime = Date.now() - requestStart;
  console.log(`Chat Success - ${processingTime}ms, len:${aiText.length}, model:${model}`);
  return aiText;
}

function getOptimizedConfig(message, intent, messageLength) {
  if (messageLength < 30 || ['greeting', 'sell', 'deposit'].includes(intent)) {
    return {
      model: process.env.OPENAI_MODEL_PRIMARY || 'gpt-5-mini',
      max_tokens: 120,
      temperature: 0.7,
      top_p: 0.9,
      stream: true,
      timeoutMs: 8000
    };
  }

  if (messageLength < 100) {
    return {
      model: process.env.OPENAI_MODEL_PRIMARY || 'gpt-5-mini',
      max_tokens: Math.min(220, parseInt(process.env.AI_OUTPUT_MAX_TOKENS || '300', 10)),
      temperature: 0.75,
      top_p: 0.9,
      stream: true,
      timeoutMs: 12000
    };
  }

  return {
    model: process.env.OPENAI_MODEL_PRIMARY || 'gpt-5-mini',
    max_tokens: Math.min(400, parseInt(process.env.AI_OUTPUT_MAX_TOKENS || '400', 10)),
    temperature: 0.8,
    top_p: 0.9,
    stream: true,
    timeoutMs: 18000
  };
}

async function sendStreamingMessage(openaiClient, sessionId, userMessage, config = {}, retrievedFacts = []) {
  const streamConfig = {
    ...config,
    stream: true,
    max_tokens: Math.min(config.max_tokens || 300, 400)
  };
  return sendMessage(openaiClient, sessionId, userMessage, streamConfig, retrievedFacts);
}

function requiresAIProcessing(message, intent) {
  const msg = String(message || '').trim();
  if (msg.length < 5) return false;
  const skipIntents = ['greeting', 'sell', 'deposit', 'naira_rates'];
  if (skipIntents.includes(intent)) return false;
  return intent === 'general' || intent === 'dashboard' || intent === 'supported_token_price';
}

function generateInstantResponse(message, intent) {
  const msg = String(message || '').toLowerCase().trim();
  if (msg === 'hi' || msg === 'hello' || msg === 'hey') {
    return "Hi! How can I help you with crypto today?";
  }
  if (msg.includes('thank')) {
    return "You're welcome! Anything else I can help with?";
  }
  if (msg === 'help' || msg === 'help me') {
    return "I can help with crypto trading, portfolio balance, current rates, and more. What do you need?";
  }
  return null;
}

function formatMessages(messages) {
  return messages.map(m => {
    const content = (m.text || m.content || '').substring(0, 100);
    return `${m.role.toUpperCase()}: ${content}${content.length === 100 ? '...' : ''}`;
  }).join('\n');
}

function validateMessage(message) {
  if (!message || typeof message !== 'string') {
    return { valid: false, error: 'Invalid message format' };
  }
  const cleaned = message.trim();
  if (cleaned.length === 0) return { valid: false, error: 'Empty message' };
  if (cleaned.length > 2000) {
    return { valid: true, message: cleaned.substring(0, 2000) + '...', warning: 'Message truncated for processing' };
  }
  return { valid: true, message: cleaned };
}

function getPerformanceStats() {
  return {
    target_response_time: '500-1000ms',
    model_defaults: {
      primary: process.env.OPENAI_MODEL_PRIMARY || 'gpt-5-mini',
      fallback: process.env.OPENAI_MODEL_FALLBACK || 'gpt-5-mini'
    },
    optimizations: [
      'Streaming responses',
      'Context truncation',
      'Conservative token budgets',
      'RAG when necessary',
      'Parallel API calls for fast paths'
    ]
  };
}

module.exports = {
  sendMessage,
  sendStreamingMessage,
  getOptimizedConfig,
  requiresAIProcessing,
  generateInstantResponse,
  formatMessages,
  validateMessage,
  getPerformanceStats
};
