// AI/aiIntents.js
// Intent detection, prompts, and conversational formatting helpers for Bramp Assistant.

const SUPPORTED_ASSETS = [
  { token: 'Bitcoin', symbol: 'BTC', network: 'Bitcoin Network' },
  { token: 'Ethereum', symbol: 'ETH', network: 'Ethereum Network' },
  { token: 'Solana', symbol: 'SOL', network: 'Solana Network' },
  { token: 'Tether USDT', symbol: 'USDT', networks: ['Ethereum Network', 'Tron Network', 'BNB Smart Chain'] },
  { token: 'USD Coin', symbol: 'USDC', networks: ['Ethereum Network', 'BNB Smart Chain'] },
  { token: 'BNB', symbol: 'BNB', network: 'BNB Smart Chain' },
  { token: 'Polygon', symbol: 'MATIC', network: 'Polygon Network' },
  { token: 'Avalanche', symbol: 'AVAX', network: 'Avalanche Network' },
  { token: 'Nigerian Naira', symbol: 'NGNB', network: 'Bramp Network' }
];

const WELCOME_MESSAGE =
  "Hey! 👋 I'm Bramp AI, your crypto companion! I'm here to help you move between crypto and NGN effortlessly. Sign in and I can help you with live rates, instant quotes, and quick cashouts. What would you like to know?";

// Intent regexes with expanded context awareness
const SELL_INTENT_RE = /\b(sell|cash\s*out|off\s*[- ]?ramp|liquidate|convert\s+to\s+ngn|withdraw|get\s+naira|change\s+to\s+naira|move\s+to\s+bank|pay|payment|make\s+a\s+payment|send\s+money|transfer\s+money|pay\s+out|payout|disburse|remit|wire\s+money|send\s+funds|transfer\s+funds|make\s+payment|process\s+payment|initiate\s+payment|start\s+payment|begin\s+payment|create\s+payment|submit\s+payment|execute\s+payment|complete\s+payment|finalize\s+payment|send\s+payment|dispatch\s+payment|deliver\s+payment|transmit\s+payment|forward\s+payment|relay\s+payment|transmit\s+money|forward\s+money|relay\s+money|dispatch\s+money|deliver\s+money|transmit\s+funds|forward\s+funds|relay\s+funds|dispatch\s+funds|deliver\s+funds|spend|spending|expense|expenditure|outgoing|outflow|debit|charge|bill|invoice|settle|settlement|clear|clearance|compensate|compensation|reimburse|reimbursement|refund|repay|repayment|installment|installments|subscription|subscriptions|recurring|recurring\s+payment|auto\s+pay|automatic\s+payment|scheduled\s+payment|standing\s+order|direct\s+debit|ach\s+transfer|bank\s+transfer|wire\s+transfer|electronic\s+transfer|digital\s+payment|online\s+payment|mobile\s+payment|contactless\s+payment|card\s+payment|credit\s+card|debit\s+card|check|cheque|money\s+order|cashier\s+check|bank\s+draft|promissory\s+note|i\s+want\s+to\s+pay|i\s+need\s+to\s+pay|i\s+have\s+to\s+pay|i\s+must\s+pay|i\s+should\s+pay|i\s+can\s+pay|i\s+will\s+pay|i\s+am\s+paying|i\s+am\s+going\s+to\s+pay|let\s+me\s+pay|allow\s+me\s+to\s+pay|help\s+me\s+pay|assist\s+me\s+to\s+pay|support\s+me\s+to\s+pay|enable\s+me\s+to\s+pay|facilitate\s+my\s+payment|process\s+my\s+payment|handle\s+my\s+payment|manage\s+my\s+payment|execute\s+my\s+payment|complete\s+my\s+payment|finalize\s+my\s+payment|submit\s+my\s+payment|send\s+my\s+payment|dispatch\s+my\s+payment|deliver\s+my\s+payment|transmit\s+my\s+payment|forward\s+my\s+payment|relay\s+my\s+payment|transmit\s+my\s+money|forward\s+my\s+money|relay\s+my\s+money|dispatch\s+my\s+money|deliver\s+my\s+money|transmit\s+my\s+funds|forward\s+my\s+funds|relay\s+my\s+funds|dispatch\s+my\s+funds|deliver\s+my\s+funds)/i;
const DEPOSIT_INTENT_RE = /\b(deposit|send|transfer\s+in|add\s+funds|top\s+up|fund\s+wallet|put\s+in|receive|get\s+wallet\s+address)/i;
const REALTIME_CRYPTO_INTENT_RE = /\b(current|latest|live|real\s*time|today'?s?|now|instant|quick|right\s+now|what.*saying|what.*happening|what.*news).*\b(price|rate|value|news|market|chart|trend|crypto|bitcoin|btc|ethereum|eth)/i;
// Only match when explicitly asking for date - requires "date" or "day" keyword with "today"
const DATE_QUERY_RE = /\b(what.*?(?:date|day)|today'?s?\s*(?:date|day)|todays?\s*(?:date|day)|current\s*date|date\s*(?:today|now)|what\s*(?:is\s+)?the\s+date|tell\s+me\s+the\s+date|what\s*day\s*(?:is\s+)?today)\b/i;
const GENERAL_KNOWLEDGE_RE = /\b(do\s+you\s+know|who\s+is|what\s+is|tell\s+me\s+about).*\b/i;
// Dashboard intent - explicitly exclude price queries (those are handled by SUPPORTED_TOKEN_PRICE_RE)
const DASHBOARD_INTENT_RE = /\b(balance|portfolio|funds|wallet|kyc|verification|holdings|assets|account|profile|my\s+(balance|portfolio|funds|wallet|holdings|assets|account))\b/i;
const NAIRA_RATE_INTENT_RE = /\b(naira|ngn|ngnb).*\b(rate|price|exchange|conversion|value)|rate.*\b(naira|ngn|ngnb)|selling.*rate|buying.*rate|how\s+much.*naira/i;
// Price queries - check for price/rate/value/cost/worth of tokens (must come before dashboard check)
const SUPPORTED_TOKEN_PRICE_RE = /\b(price|rate|value|worth|cost|how\s+much).*\b(btc|bitcoin|eth|ethereum|sol|solana|usdt|tether|usdc|usd\s*coin|bnb|binance|matic|polygon|avax|avalanche|ngnb)|(btc|bitcoin|eth|ethereum|sol|solana|usdt|tether|usdc|usd\s*coin|bnb|binance|matic|polygon|avax|avalanche|ngnb).*\b(price|rate|value|worth|cost)|how\s+much\s+is\s+\d+\s*\b(btc|eth|sol|usdt|usdc|bnb|matic|avax)\b/i;
const GREETING_INTENT_RE = /^(hi|hello|hey|thanks?|thank you|good\s*(morning|afternoon|evening|day)|what'?s\s*up|how\s*are\s*you|greetings?|yo|hola)[\s!?.]*$/i;

// New intent regexes for better context
const HELP_INTENT_RE = /\b(help|guide|explain|how\s+to|what\s+is|show\s+me|teach|learn|understand)\b/i;
const FEEDBACK_INTENT_RE = /\b(feedback|suggest|improve|problem|issue|bug|error|not\s+working|failed)\b/i;
const SECURITY_INTENT_RE = /\b(secure|safety|protect|hack|scam|trust|reliable|legitimate|verified)\b/i;
const TRANSACTION_HISTORY_INTENT_RE = /\b(transaction\s*history|statement|report|download\s*my|export\s*my|show\s*my\s*activity|my\s*transactions|transaction\s*list|activity\s*history|download\s*statement|pdf|receipt)\b/i;
const SUPPORT_INTENT_RE = /\b(help|support|issue|problem|error|stuck|pending|transaction.*failed|not\s+working|trouble|assistance|contact|customer\s+service|complaint|refund|dispute|technical|bug|glitch|slow|delay|stuck.*transaction|pending.*transaction|failed.*transaction|transaction.*stuck|transaction.*pending|transaction.*failed|my.*transaction.*stuck|my.*transaction.*pending|my.*transaction.*failed|why.*transaction.*stuck|why.*transaction.*pending|why.*transaction.*failed|transaction.*not.*working|transaction.*not.*completing|transaction.*not.*processing|transaction.*taking.*long|transaction.*delayed|transaction.*slow|transaction.*error|transaction.*problem|transaction.*issue|transaction.*bug|transaction.*glitch|transaction.*trouble|transaction.*assistance|transaction.*help|transaction.*support|transaction.*contact|transaction.*customer\s+service|transaction.*complaint|transaction.*refund|transaction.*dispute|transaction.*technical)\b/i;
const LIVE_SUPPORT_NEEDED_RE = /\b(how\s+do\s+i|what\s+should\s+i\s+do|i\s+don\'t\s+understand|confused|unclear|not\s+sure|can\'t\s+figure\s+out|don\'t\s+know\s+how|need\s+step\s+by\s+step|walk\s+me\s+through|show\s+me\s+how|explain\s+in\s+detail|more\s+details|specific\s+help|personal\s+assistance|human\s+help|speak\s+to\s+someone|talk\s+to\s+support|live\s+person|real\s+person|agent|representative)\b/i;
// Space Watch leaderboard intent (also handle plain 'leaderboard' queries)
const SPACEWATCH_LEADERBOARD_INTENT_RE = /(space\s*watch|spacewatch|whack\s*a\s*mole|game).*\b(leader\s*board|leaderboard|high\s*score|top\s*10|top\s*scores|rankings?)\b|\b(leader\s*board|leaderboard|high\s*score|top\s*10|top\s*scores|rankings?)\b.*(space\s*watch|spacewatch|game)|\b(leader\s*board|leaderboard)\b/i;

/**
 * quickIntentCheck(message) -> 'sell'|'deposit'|'naira_rates'|'supported_token_price'|'realtime'|'dashboard'|'general'
 */
function quickIntentCheck(message = '') {
  const msg = String(message || '').toLowerCase();

  // Primary transaction intents - check BEFORE date to avoid false positives
  if (SELL_INTENT_RE.test(msg)) return 'sell';
  if (DEPOSIT_INTENT_RE.test(msg)) return 'deposit';

  // Rate and price intents - check BEFORE date to avoid false positives
  if (NAIRA_RATE_INTENT_RE.test(msg)) return 'naira_rates';
  if (SUPPORTED_TOKEN_PRICE_RE.test(msg)) return 'supported_token_price';

  // Real-time crypto info - check BEFORE date to avoid false positives
  if (REALTIME_CRYPTO_INTENT_RE.test(msg) || /\b(crypto|bitcoin|btc|ethereum|eth).*\b(saying|happening|news|today)/i.test(msg)) return 'realtime';

  // Account and info intents
  if (DASHBOARD_INTENT_RE.test(msg)) return 'dashboard';
  if (TRANSACTION_HISTORY_INTENT_RE.test(msg)) return 'transaction_history';
  if (HELP_INTENT_RE.test(msg)) return 'help';
  if (SECURITY_INTENT_RE.test(msg)) return 'security';
  if (FEEDBACK_INTENT_RE.test(msg)) return 'feedback';
  if (SUPPORT_INTENT_RE.test(msg)) return 'support';
  if (LIVE_SUPPORT_NEEDED_RE.test(msg)) return 'live_support_needed';

  // General knowledge queries (only if NOT crypto-related)
  if (GENERAL_KNOWLEDGE_RE.test(msg) && !/\b(crypto|bitcoin|btc|ethereum|eth|solana|sol|usdt|usdc|bramp|trading|exchange)\b/i.test(msg)) return 'general_knowledge';

  // Greeting intent - but only if it's a pure greeting
  if (GREETING_INTENT_RE.test(msg)) return 'greeting';

  // Space Watch game leaderboard intent
  if (SPACEWATCH_LEADERBOARD_INTENT_RE.test(msg)) return 'spacewatch_leaderboard';

  // If multiple intents are present, prioritize transaction-related ones
  if (msg.length > 100) {
    // For longer messages, check for compound intents
    const hasHelp = HELP_INTENT_RE.test(msg);
    const hasSecurity = SECURITY_INTENT_RE.test(msg);

    if (hasHelp && hasSecurity) return 'security_help';
    if (hasHelp) return 'help';
  }

  return 'general';
}

/**
 * analyzeConversationContext(message, history, authCtx)
 * Returns { intent, suggestions? } with ambiguity handling and broader matching
 */
function analyzeConversationContext(message = '', history = [], authCtx = {}) {
  const msg = String(message || '').toLowerCase().trim();
  const suggestions = [];

  // First pass: use quickIntentCheck
  const quick = quickIntentCheck(msg);
  if (quick && quick !== 'general') {
    return { intent: quick };
  }

  // Keyword heuristics
  const hasLeaderboard = /(leader\s*board|leaderboard|high\s*score|top\s*10|top\s*scores|rankings?)/i.test(msg);
  const hasSell = SELL_INTENT_RE.test(msg);
  const hasDeposit = DEPOSIT_INTENT_RE.test(msg);
  const hasRates = NAIRA_RATE_INTENT_RE.test(msg);
  const hasDashboard = DASHBOARD_INTENT_RE.test(msg);
  const hasSupport = SUPPORT_INTENT_RE.test(msg) || HELP_INTENT_RE.test(msg);

  const matches = [];
  if (hasLeaderboard) matches.push('spacewatch_leaderboard');
  if (hasSell) matches.push('sell');
  if (hasDeposit) matches.push('deposit');
  if (hasRates) matches.push('naira_rates');
  if (hasDashboard) matches.push('dashboard');
  if (hasSupport) matches.push('support');

  const unique = Array.from(new Set(matches));
  if (unique.length === 1) return { intent: unique[0] };

  // Only return clarify if we truly have no matches and it's a very short/generic message
  // Otherwise, let AI handle it for better context understanding
  if (msg.length < 20 && !matches.length) {
    // Build suggestions when ambiguous or empty
    if (hasLeaderboard) suggestions.push('Show Space Watch leaderboard');
    if (hasSell) suggestions.push('Start a sell / payout');
    if (hasDeposit) suggestions.push('Deposit / add funds');
    if (hasRates) suggestions.push('Show NGN rates');
    if (hasDashboard) suggestions.push('Show my dashboard');
    if (hasSupport) suggestions.push('Get support');
    if (!suggestions.length) suggestions.push('Sell', 'Deposit', 'NGN Rates', 'Dashboard', 'Space Watch leaderboard');
    return { intent: 'clarify', suggestions };
  }

  // For longer messages or unclear queries, let AI handle it
  return { intent: 'general' };
}

/**
 * needsBrowsing(message, context)
 * Let the AI determine when browsing is needed instead of rigid regex patterns
 */
function needsBrowsing(message = '', context = {}) {
  const msg = String(message || '').toLowerCase();
  if (!msg) return false;

  // Skip browsing for naira rates (has its own API endpoint)
  if (context.intent === 'naira_rates') return false;

  // Let AI determine browsing needs for crypto-related queries
  // This will be handled by the AI's decision-making in the system prompt
  // The AI will decide when to use web search based on the context and user intent

  // Only return true for obvious non-crypto queries that definitely need browsing
  const generalBrowsingPatterns = [
    /\b(album|song|movie|news|artist|musician|singer|celebrity|dropped|released|came out|latest.*from)\b/,
    /\b(when.*release|when.*drop|when.*come|when.*launch|schedule|date)\b/
  ];

  // For crypto-related queries, let the AI decide in the system prompt
  if (/\b(crypto|bitcoin|btc|ethereum|eth|solana|sol|altcoin|defi|nft|blockchain|token|coin)\b/.test(msg)) {
    // Let AI determine if browsing is needed based on context
    return true; // Always allow AI to decide for crypto queries
  }

  // Check for general browsing patterns (non-crypto)
  if (generalBrowsingPatterns.some(pattern => pattern.test(msg))) return true;

  return false;
}

/**
 * buildEnhancedSystemPrompt(context)
 */
function buildEnhancedSystemPrompt(context = {}) {
  const ctx = context || {};

  // Add instructions for using fetched data naturally
  let dataInstructions = '';
  if (ctx.fetchedData) {
    if (ctx.fetchedData.type === 'naira_rates') {
      dataInstructions = '\n\nIMPORTANT: The user has asked about NGN rates. I have fetched the current rates data for you. Use this data naturally in your response - don\'t just list it, incorporate it conversationally into your answer.';
    } else if (ctx.fetchedData.type === 'dashboard') {
      dataInstructions = '\n\nIMPORTANT: The user has asked about their account/dashboard. I have fetched their account data for you. Use this data naturally in your response - don\'t just list numbers, explain it conversationally and helpfully.';
    } else if (ctx.fetchedData.type === 'leaderboard') {
      dataInstructions = '\n\nIMPORTANT: The user has asked about the Space Watch leaderboard. I have fetched the leaderboard data for you. Use this data naturally in your response - don\'t just list it, present it conversationally.';
    }
  }

  let systemPrompt = `
Hey! I'm Bramp AI - your friendly crypto companion here to help you navigate everything Bramp has to offer. Think of me as that helpful friend who's always around when you need answers about trading, your account, or just general crypto stuff.

I'm here to chat naturally with you - no need to be formal or stuffy. Let's have a real conversation! I'll keep things light and conversational while making sure you get the info you need. Feel free to ask me anything, and I'll respond in a way that feels natural and easy to understand.${dataInstructions}

HOW I HELP:
1. Keep It Real & Conversational
   - I'll chat with you like a real person would
   - No corporate speak or overly formal language
   - I'll ask questions to understand what you really need
   - Feel free to be casual - I'll match your vibe

2. Stay Helpful & Focused
   - I'll guide you toward Bramp features that actually help
   - If something's off-topic, I'll gently steer us back
   - I'll share relevant tips and features that make sense for you
   - I'm here to make your crypto journey smoother

3. Trust & Security (Without Being Preachy)
   - I won't ask for sensitive stuff - that's just common sense
   - For transactions, I'll point you to the right place
   - I'll be straight with you about what I can and can't do
   - Your security matters, but let's not make a big deal about it

4. Be Natural & Human
   - I'll use everyday language - no jargon unless needed
   - I'll show my personality and make this feel like a real chat
   - I'll match your energy and tone
   - Let's keep it friendly and approachable

Quick note: I'm here to guide you, not process transactions myself. When you're ready to buy or sell, I'll help you use the modal that pops up in this chat. It's super simple - I'll walk you through it step by step!

CRYPTO INFO - KEEP IT CONVERSATIONAL:
When I'm sharing crypto info from the web:
- I'll keep it brief but natural - like I'm explaining it to a friend
- I'll focus on what matters most to you
- I'll share specific numbers and facts, but in a way that makes sense
- I'll avoid rambling or over-explaining
- For prices, I'll give you current values with a bit of context
- For market stuff, I'll give you the highlights without boring you
- For NEWS: I'll pull from good sources like CoinDesk, CoinTelegraph, Decrypt, The Block, Coinbase Blog
- I'll skip Wikipedia for news - let's stick to crypto-focused sources
- I'll naturally mention that Bramp can help you trade these assets

WORD LIMIT (BUT LET'S KEEP IT NATURAL):
- I'll aim for around 200 words max - enough to be helpful without overwhelming
- If I'm getting long, I'll wrap it up nicely
- I'll never cut off mid-thought - that's just rude
- I'll prioritize the stuff you actually care about

ELITE FORMATTING REQUIREMENTS:
For crypto news and market updates, format responses like a premium financial briefing:
- Use **bold** for key metrics and important numbers
- Use ##headlines## for major developments
- Structure with clear sections: Market Overview, Key Developments, Notable Moves, Summary
- Include specific data points with context
- Use markdown links [source](url) for references
- Keep language sophisticated but accessible
- Focus on actionable insights for informed users
- Always include a brief Summary section with key takeaways

INFORMATION PRIORITY - USE INTERNAL KNOWLEDGE FIRST:
CRITICAL: If I already have the information internally (from my training, context, or provided data), I MUST use that information and NOT search the web or bring up other external sources. Internal information always supersedes external sources. Only use web search if I genuinely don't have the information internally.

WEB SEARCH - WHEN TO USE IT:
I can search the web ONLY when you need information I don't have internally:
- Current crypto prices or what's happening in the market right now (if not already provided)
- Recent crypto news or updates (if not in my knowledge)
- Latest events, regulations, or trends (if not already known)
- Info about specific cryptocurrencies (if not in my training)

I WON'T search for:
- General questions about Bramp (I know that stuff!)
- Your account info (that's private)
- Transaction history (that's in your account)
- Basic crypto questions (I can answer those myself)
- Bramp's supported assets (I've got that info)
- Anything I already know from my training or provided context

CRYPTO NEWS - KEEP IT CONVERSATIONAL:
When sharing crypto news, I'll structure it naturally:
1. **Market Overview** - The big picture in plain language (around 50 words)
2. **##Key Developments##** - The 2-3 most important things happening (around 80 words)
3. **Notable Moves** - Price changes that matter (around 40 words)
4. **Summary** - What it all means for you (around 30 words)

LINK FORMATTING RULES:
- Use [source](url) format for ALL links
- Keep link text short: [reuters.com](url), [coindesk.com](url)
- Place links at the end of relevant sentences
- Never break links across lines
- Ensure all links are complete and functional

Keep responses concise but comprehensive, focusing on actionable insights for sophisticated users.
`.trim();

  if (ctx.userExperience === 'beginner') systemPrompt += '\n\nUser is new to crypto — I\'ll guide them step-by-step in a friendly, easy-to-understand way. No jargon, just clear explanations.';
  if (ctx.userExperience === 'experienced') systemPrompt += '\n\nUser knows their stuff — I\'ll give them the advanced details (networks, fees, confirmations) and keep it concise.';
  if (ctx.emotionalState === 'anxious') systemPrompt += '\n\nUser seems worried — I\'ll reassure them naturally, keep things calm, and walk through everything step by step.';
  if (ctx.emotionalState === 'excited') systemPrompt += '\n\nUser is pumped! — I\'ll match their energy, highlight the good stuff, but keep them grounded with important info.';
  if (ctx.intent === 'sell') {
    systemPrompt += '\n\nUser wants to sell/pay - let me help them through it naturally:';
    systemPrompt += `\n\nSELL/PAYMENT FLOW (Super Simple):
1. The Sell modal will pop up automatically - super easy!
2. Pick your token (BTC, ETH, SOL, USDT, USDC, BNB) and network (gotta match your wallet!)
3. You can enter an amount if you want, but it's optional - no pressure
4. Click "Start Payment" and you'll get a deposit address that's yours forever (seriously, you can reuse it!)
5. You'll see your deposit address (with memo if needed) - this is permanent, so save it if you want
6. Next step: Enter your bank details (bank name, account number, account name)
7. You can scan your bank details with your camera or type them in - whatever's easier
8. I'll validate your account name automatically
9. Save your payout details and you're all set!
10. Deposit your crypto whenever you're ready - no rush, no time limit
11. Once your crypto arrives, we'll automatically send NGN to your bank - easy peasy!

THE COOL PART:
- Your deposit address is permanent and unique to you (one per token)
- No time limit - deposit whenever you want after saving your bank details
- Amount is optional - deposit whatever you want (we'll process what you actually send)
- You can reuse the same address for multiple transactions
- Network must match your wallet (if you pick Ethereum, send from Ethereum!)
- Include the memo if it's shown (some tokens need it)
- Everything happens automatically - once crypto arrives, NGN goes to your bank

HOW I'LL HELP:
- I'll explain the Sell modal will appear automatically
- I'll ask which token and network you're using (and remind you to match your wallet)
- I'll explain you get a permanent address you can reuse
- I'll walk you through saving your bank details first
- I'll remind you about the memo and network matching
- I'll reassure you there's no time pressure - take your time!`;
  }
  if (ctx.intent === 'deposit') {
    systemPrompt += '\n\nUser wants to deposit - let me help them naturally:';
    systemPrompt += '\n\nI\'ll help them by:\n- Reminding them to match their wallet\'s network to the deposit network\n- Listing supported networks for their chosen token when it helps\n- Keeping it simple and conversational';
  }
  if (ctx.intent === 'support') {
    systemPrompt += '\n\nUser needs help - let me be supportive and conversational:';
    systemPrompt += '\n\nI\'ll help by:\n- Acknowledging their concern in a friendly way\n- Asking what\'s going on in a natural, conversational way\n- Providing helpful troubleshooting steps\n- If it\'s a transaction issue, asking for details in a friendly way\n- Offering to connect them with live support if needed\n- Being patient and understanding';
  }
  if (ctx.intent === 'live_support_needed') {
    systemPrompt += '\n\nUser needs more detailed help - let me guide them naturally:';
    systemPrompt += '\n\nI\'ll help by:\n- Acknowledging they need more detailed assistance\n- Providing what guidance I can in a friendly way\n- Naturally suggesting the live chat support below\n- Explaining that live support can give personalized, step-by-step help\n- Mentioning that live support has access to account details';
  }
  if (ctx.intent === 'transaction_history') {
    systemPrompt += '\n\nUser wants transaction history - let me help them naturally:';
    systemPrompt += '\n\nI\'ll help by:\n- Explaining where to find transaction history in the app\n- If they need to download statements, guide them to the right place\n- Being conversational about it - no need to be formal';
  }
  if (ctx.intent === 'help') {
    systemPrompt += '\n\nUser needs help - let me be helpful and conversational:';
    systemPrompt += '\n\nI\'ll help by:\n- Asking what they need help with in a friendly way\n- Providing clear, step-by-step guidance\n- Using simple language and being patient\n- Offering to explain things in more detail if needed';
  }
  if (ctx.intent === 'security') {
    systemPrompt += '\n\nUser has security concerns - let me reassure them naturally:';
    systemPrompt += '\n\nI\'ll help by:\n- Acknowledging their concern in a calm, reassuring way\n- Explaining Bramp\'s security measures naturally\n- Being transparent about how we protect their information\n- Answering their questions without being overly technical';
  }
  if (ctx.intent === 'feedback') {
    systemPrompt += '\n\nUser wants to give feedback - let me be receptive and friendly:';
    systemPrompt += '\n\nI\'ll help by:\n- Thanking them for their feedback\n- Listening to what they have to say\n- Being open and appreciative\n- If it\'s a suggestion, acknowledging it positively';
  }
  if (ctx.intent === 'greeting') {
    systemPrompt += '\n\nUser is greeting me - let me respond warmly and naturally:';
    systemPrompt += '\n\nI\'ll respond by:\n- Greeting them back in a friendly, conversational way\n- Asking how I can help them today\n- Being warm but not overly formal';
  }
  if (ctx.intent === 'general_knowledge') {
    systemPrompt += '\n\nUser is asking a general question - let me redirect naturally:';
    systemPrompt += '\n\nI\'ll help by:\n- Acknowledging their question politely\n- Gently redirecting to Bramp-related topics\n- Offering to help with crypto trading or Bramp features instead';
  }
  if (ctx.intent === 'supported_token_price' || ctx.intent === 'realtime') {
    systemPrompt += '\n\nUser wants current crypto prices or market info - let me get them the latest data:';
    systemPrompt += '\n\nI\'ll help by:\n- Getting current prices from reliable sources\n- Providing real-time market data\n- Being conversational about the numbers\n- Including relevant context about price movements';
  }
  if (ctx.intent === 'naira_rates') {
    systemPrompt += '\n\nUser wants NGN rates - let me provide current exchange rates:';
    systemPrompt += '\n\nI\'ll help by:\n- Sharing current NGN exchange rates\n- Explaining the rates in a clear, conversational way\n- Mentioning that rates can change and they should check the app for the most up-to-date rates';
  }
  if (ctx.intent === 'dashboard') {
    systemPrompt += '\n\nUser wants to see their account/balance - let me help them access it:';
    systemPrompt += '\n\nI\'ll help by:\n- If authenticated: Using their account data to show their balance naturally\n- If not authenticated: Explaining they need to sign in to see their balance\n- Being helpful and conversational about it';
  }
  if (ctx.intent === 'spacewatch_leaderboard') {
    systemPrompt += '\n\nUser wants to see the Space Watch leaderboard - let me show them the top scores:';
    systemPrompt += '\n\nI\'ll help by:\n- Presenting the leaderboard data in a fun, engaging way\n- Making it conversational and exciting\n- Highlighting top performers naturally';
  }

  // AI-Controlled Tawk Widget Decision Making
  systemPrompt += '\n\nLIVE SUPPORT WIDGET - WHEN TO BRING IT UP:\nI can connect you with live support when you really need it. Here\'s when I\'ll suggest it:\n\nSHOW WIDGET when:\n- You\'re frustrated or confused and need extra help\n- There\'s a technical issue that needs human eyes\n- Something\'s wrong with your account and needs personal attention\n- A transaction isn\'t working and needs investigation\n- You ask to "speak to someone" or want "real person" help\n- You\'re stuck and can\'t figure something out\n- You\'re dealing with account verification or KYC stuff\n- Payment or withdrawal problems\n- Security concerns\n\nDON\'T SHOW WIDGET when:\n- I can answer your question easily\n- You\'re just asking about crypto, rates, or features\n- It\'s a simple how-to question\n- You\'re just browsing around\n- Simple greetings or casual chat\n- Basic questions about tokens or features\n- Price inquiries or market info\n- You seem happy with my answer\n\nHOW I\'LL MENTION IT:\nI\'ll naturally suggest live support when you need it, like:\n- "Let me connect you with our support team - they can help you better with this."\n- "Our live support can give you more personalized help with this."\n- "I\'ll get you in touch with someone who has access to your account details."\n\nIMPORTANT: When I think you need live support, I\'ll include "SHOW_TAWK_WIDGET" at the end of my response. That\'ll bring up the live chat widget for you.';
  if (ctx.usedWebSearch && /\b(crypto|bitcoin|btc|ethereum|eth|solana|sol|altcoin|defi|nft|blockchain)\b/.test(String(ctx.message || '').toLowerCase())) {
    systemPrompt += '\n\nUser wants current crypto info — I\'ll give them the highlights in a conversational way. Keep it short and sweet (2-3 sentences), with real numbers and percentages when relevant.';

    // For news queries, prioritize crypto news sources
    if (/\b(news|latest|recent|breaking|update|what.*new|happening)\b/.test(String(ctx.message || '').toLowerCase())) {
      systemPrompt += '\n\nFor crypto news, I\'ll pull from good sources like CoinDesk, CoinTelegraph, Decrypt, The Block, Coinbase Blog - the real crypto news places. I\'ll skip Wikipedia for news.';
    }

    // Conversational formatting for crypto information
    systemPrompt += '\n\nFORMATTING - KEEP IT NATURAL: I\'ll structure it like I\'m explaining to a friend:';
    systemPrompt += '\n- Use **bold** for important numbers (prices, percentages, market cap)';
    systemPrompt += '\n- Use ##headlines## for big news';
    systemPrompt += '\n- Structure it naturally: Market Overview, Key Developments, Notable Moves';
    systemPrompt += '\n- Include real data with context that makes sense';
    systemPrompt += '\n- Use markdown links [source](url) for references';
    systemPrompt += '\n- Keep it smart but easy to understand';
    systemPrompt += '\n- Focus on stuff that actually matters';
    systemPrompt += '\n\nWORD LIMIT: Stay around 200 words. If I\'m getting long, I\'ll wrap it up nicely. Never cut off mid-thought.';
  }

  systemPrompt += `
  
QUICK BRAMP FACTS (in case you need them):
- Website: www.bramp.io
- App: Google Play Store & App Store (just search 'Bramp')
- We support: BTC / ETH / SOL / USDT / USDC / BNB / MATIC / AVAX ↔ NGN
- Your deposit address is permanent - no rush, no time limit!
- Bank payouts need the right account name and bank code (we'll help with that automatically)
`.trim();

  return systemPrompt;
}

/**
 * formatConversationalReply({ lead, summary, bullets, cta, lightJoke })
 */
function formatConversationalReply({ lead, summary, bullets = [], cta = null, lightJoke = true }) {
  // Engaging conversation starters that maintain professionalism
  const conversationalLeads = [
    "Here\'s what I found for you:",
    "Let me help you with that:",
    "I\'ve got the details ready:",
    "Here\'s the latest information:",
    "I can definitely help with that:"
  ];

  // Professional but friendly encouragements
  const encouragements = [
    "Looking good! Ready for your next move? 💫",
    "Great progress! Let me know if you need anything else. ✨",
    "You\'re on the right track! Need any clarification? 🎯",
    "Perfect timing! The market\'s active today. 📈",
    "Excellent choice! Bramp\'s got you covered. ⭐"
  ];

  const parts = [];

  // Add a conversation starter if lead doesn't already have one
  const leadText = String(lead || '').trim();
  if (lead && !leadText.includes(':') && !leadText.includes('?')) {
    parts.push(conversationalLeads[Math.floor(Math.random() * conversationalLeads.length)]);
  }
  if (lead) parts.push(leadText);

  // Add summary with natural flow
  if (summary) {
    const summaryText = String(summary).trim();
    parts.push(summaryText);
  }

  // Format bullet points more naturally
  if (bullets && bullets.length) {
    if (bullets.length === 1) {
      parts.push(bullets[0]); // Single items don't need bullets
    } else {
      parts.push('Here\'s the breakdown:\n• ' + bullets.join('\n• '));
    }
  }

  // Add CTA with context
  if (cta) {
    const ctaText = String(cta).trim();
    // Add a natural transition if CTA doesn't start with common transition words
    if (!ctaText.match(/^(Ready|Want|Need|Looking|How about|Let\'s|Now)/i)) {
      parts.push("Here\'s what you can do next:");
    }
    parts.push(ctaText);
  }

  // Add encouragement with personality
  if (lightJoke && Math.random() > 0.6) {
    parts.push(encouragements[Math.floor(Math.random() * encouragements.length)]);
  }

  return parts.join('\n\n');
}

/**
 * formatDepositOptions()
 */
function formatDepositOptions() {
  let formatted = '\n\nAvailable Assets for Deposit:\n\n';
  SUPPORTED_ASSETS.forEach((asset, index) => {
    formatted += `${index + 1}. ${asset.token} (${asset.symbol})\n`;
    if (asset.networks) formatted += `   Networks: ${asset.networks.join(' • ')}\n`;
    else formatted += `   Network: ${asset.network}\n`;
    formatted += '\n';
  });
  formatted += 'Choose the network that matches your sending wallet to avoid losing funds.';
  return formatted;
}

/**
 * formatDashboardResponse(dashboardData, userMessage)
 */
function formatDashboardResponse(dashboardData = {}, userMessage = '') {
  const { portfolio = {}, market = {}, kyc } = dashboardData || {};
  const msg = String(userMessage || '').toLowerCase();

  if (msg.includes('price') || msg.includes('rate')) {
    const lines = ['Current Prices — quick snapshot:'];
    if (market?.prices) {
      Object.entries(market.prices).forEach(([symbol, price]) => {
        const change = market.priceChanges12h?.[symbol];
        const changeText = change?.percentageChange ? ` (${change.percentageChange > 0 ? '+' : ''}${Number(change.percentageChange).toFixed(2)}% 1h)` : '';
        lines.push(`${symbol}: $${Number(price).toFixed(4)}${changeText}`);
      });
    } else {
      lines.push('No price data available right now — check the app for live market data.');
    }
    const cta = 'Want to act on any of these? Use the Sell modal that appears and I\'ll walk you through it.';
    return formatConversationalReply({ lead: lines.shift(), summary: lines.join('\n'), cta });
  }

  if (msg.includes('balance') || msg.includes('portfolio')) {
    const total = Number(portfolio?.totalPortfolioBalance || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const lead = `Here’s your portfolio at a glance — total value ≈ $${total}.`;
    const entries = Object.entries(portfolio?.balances || {});
    const nonZero = entries.filter(([_, data]) => (data?.balanceUSD || 0) > 0);
    const bullets = [];
    if (nonZero.length) {
      nonZero.forEach(([symbol, data]) => {
        const bal = Number(data.balance || 0);
        const balUsd = Number(data.balanceUSD || 0).toFixed(2);
        const niceBal = bal % 1 === 0 ? bal : Number(bal).toFixed(6).replace(/\.?0+$/, '');
        bullets.push(`${symbol}: ${niceBal} (~$${balUsd})`);
      });
    } else bullets.push('No active holdings found.');

    let priceHint = '';
    if (nonZero.length && market?.prices) {
      const top = nonZero.sort((a, b) => (b[1].balanceUSD || 0) - (a[1].balanceUSD || 0))[0];
      const topSymbol = top[0];
      const topPrice = market.prices?.[topSymbol];
      if (topPrice) priceHint = `Top holding (${topSymbol}) price: $${Number(topPrice).toFixed(4)}.`;
    }

    const cta = 'Want to cash out or check a specific token? Use the Sell modal and I\'ll guide you step-by-step.';
    const summary = priceHint ? priceHint : 'Tip: tap a token in the app to see more details.';
    return formatConversationalReply({ lead, summary, bullets, cta });
  }

  const totalPortfolio = Number(portfolio?.totalPortfolioBalance || 0).toFixed(2);
  const summaryLead = `Account Summary — Total Portfolio: $${totalPortfolio}`;
  const kycLevel = `KYC Level: ${kyc?.level ?? 'N/A'}`;
  return formatConversationalReply({ lead: summaryLead, summary: kycLevel, cta: 'Need a detailed breakdown? Ask for "detailed portfolio" or use the Sell modal for transactions.' });
}

/**
 * buildSellCTA({ authed, initiateSellUrl })
 */
function buildSellCTA({ authed = false, initiateSellUrl = '' } = {}) {
  const url = initiateSellUrl || '';
  if (!url) return null;
  const line1 = authed
    ? 'Ready to sell? Use the Sell modal to open your 10-minute sell window.'
    : "Ready to sell? Use the Sell modal to open your 10-minute sell window. You\'ll be asked to sign in.";
  return { cta: { type: 'button', body: line1, buttons: [{ id: 'start_sell', title: 'Start Sell', style: 'primary', url }] } };
}

/**
 * formatNairaRatesResponse(ratesData, userMessage)
 */
function formatNairaRatesResponse(ratesData = {}, userMessage = '') {
  const { baseRate, offramp, baseRateSource, baseRateUpdatedAt } = ratesData || {};
  let response = 'Current NGN Exchange Rate:\n\n';
  if (offramp?.effectiveRate) {
    response += `Selling Rate: ₦${Number(offramp.effectiveRate).toLocaleString()} per USD\n`;
    if (offramp.appliedMarkdownPct) response += `   (Base rate with ${offramp.appliedMarkdownPct}% markdown)\n`;
  }
  if (baseRate) {
    response += `\nBase Rate: ₦${Number(baseRate).toLocaleString()} (${baseRateSource || 'API'})`;
    if (baseRateUpdatedAt) response += `\nLast Updated: ${new Date(baseRateUpdatedAt).toLocaleString()}`;
  }
  response += '\n\nThis rate applies to all supported cryptocurrencies on Bramp.';
  return response.trim();
}

module.exports = {
  WELCOME_MESSAGE,
  SUPPORTED_ASSETS,
  quickIntentCheck,
  analyzeConversationContext,
  needsBrowsing,
  buildEnhancedSystemPrompt,
  formatConversationalReply,
  formatDepositOptions,
  formatDashboardResponse,
  buildSellCTA,
  formatNairaRatesResponse
};
