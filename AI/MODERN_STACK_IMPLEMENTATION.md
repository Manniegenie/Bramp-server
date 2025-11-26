# Modern LLM Stack Implementation

This document describes the modern LLM-powered frontend layer implementation for Bramp chatbot.

## Architecture Overview

This implementation follows the modern production pattern used by:
- OpenAI Assistants
- Anthropic Tools
- Replit AI Agents
- Vercel AI SDK Agents
- Google Gemini Function-Calling Workflows

### Stack Components (R1-R5)

1. **R1: Structured Prompts** - System prompts guide the LLM behavior
2. **R2: Function Calling / JSON Schemas** - LLM calls backend functions with structured parameters
3. **R3: Tool Router** - Maps intents to backend API endpoints
4. **R4: Memory / Context Management** - Session management with 2-minute timeout for sell intents
5. **R5: Backend APIs** - Direct API calls to Bramp backend endpoints

## Files Created/Modified

### New Files

1. **`AI/tools.js`** - Function definitions and tool execution
   - Defines all available tools (functions) with JSON schemas
   - Maps intents to backend API endpoints
   - Executes tool calls and returns results

2. **`AI/sellSessionManager.js`** - Sell session management
   - Creates 2-minute sessions for sell intents
   - Automatically expires sessions after 2 minutes
   - Restarts conversation when session expires

### Modified Files

1. **`AI/Chatbot.js`** - Simplified chatbot with function calling
   - Removed regex-based intent detection
   - Uses OpenAI function calling instead
   - Handles tool execution and responses
   - Manages sell sessions

## Transaction Intents Mapped

All transaction intents from the codebase are mapped to functions:

1. **`create_sell_transaction`** - Initiate sell (crypto to NGN)
   - Creates 2-minute session
   - Endpoint: `POST /sell/initiate`

2. **`get_sell_quote`** - Get sell quote (rate and NGN amount)
   - Endpoint: `POST /sell/initiate` (with amount)

3. **`create_buy_transaction`** - Initiate buy (NGN to crypto)
   - Endpoint: `POST /buy/initiate`

4. **`get_buy_quote`** - Get buy quote
   - Endpoint: `POST /buy/quote`

5. **`check_transaction_status`** - Check transaction status
   - Endpoint: `GET /history?paymentId={id}`

6. **`get_naira_rates`** - Get NGN/USD rates
   - Endpoint: `GET /rates/naira`

7. **`get_token_price`** - Get token price in USD
   - Endpoint: `GET /prices?token={token}` or from dashboard

8. **`get_dashboard`** - Get user dashboard
   - Endpoint: `GET /api/dashboard`

9. **`get_transaction_history`** - Get transaction history
   - Endpoint: `GET /history`

10. **`get_bank_details`** - Validate bank account
    - Endpoint: `POST /bankenquiry`

11. **`initiate_swap`** - Initiate token swap
    - Endpoint: `POST /swap/initiate`

12. **`get_quote_price`** - Get general price quote
    - Uses sell quote endpoint

## Sell Session Management

### 2-Minute Session Timeout

When a user initiates a sell transaction:

1. **Session Created** - A session is created with 2-minute timeout
2. **Session Active** - User can continue conversation within 2 minutes
3. **Session Expires** - After 2 minutes, session automatically expires
4. **Conversation Restarts** - Recent messages are cleared and conversation restarts

### Session Management API

- `GET /chat/sell-session/:sessionId` - Get session status
- Sessions are stored in-memory (can be extended to Redis)

## How It Works

### User Flow

1. User sends message: "I want to sell 0.1 BTC"
2. LLM detects intent and calls `create_sell_transaction` function
3. Function executes: `POST /sell/initiate` with `{token: 'BTC', network: 'BITCOIN', amount: 0.1}`
4. Backend returns deposit address and quote
5. Sell session created (2-minute timeout)
6. LLM responds with deposit address and instructions
7. User continues conversation within 2-minute window
8. After 2 minutes, session expires and conversation restarts

### Function Calling Flow

```
User → LLM → Detect Intent → Call Function → Execute API → Return Result → LLM → User
```

1. User message analyzed by LLM
2. LLM decides to call a function based on user intent
3. Function executed with parameters
4. API result returned to LLM
5. LLM formats response for user

## Benefits

### No Fine-Tuning Required

This stack uses:
- Structured prompts (R1)
- Function calling (R2)
- Tool routing (R3)

90% of products solve this without fine-tuning. Fine-tuning is only needed if intents are extremely custom or poorly separable.

### Simplified Code

- Removed complex regex-based intent detection
- Uses LLM intelligence for intent understanding
- Clean separation of concerns (tools, sessions, chat)

### Terminal Support

Users can initiate sell directly from terminal:
- Chatbot responds to sell commands
- Creates session automatically
- Handles 2-minute timeout
- Restarts conversation after timeout

## Environment Variables

Required:
- `OPENAI_API_KEY` - OpenAI API key
- `JWT_SECRET` - JWT secret for authentication
- `API_BASE_URL` - Base URL for backend API (default: `https://priscaai.online`)

Optional:
- `OPENAI_MODEL_PRIMARY` - Primary model (default: `gpt-4o`)
- `AI_OUTPUT_MAX_TOKENS` - Max tokens for responses (default: 500)

## Testing

### Test Sell Intent

```bash
curl -X POST https://priscaai.online/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "message": "I want to sell 0.1 BTC",
    "sessionId": "test-123"
  }'
```

### Check Sell Session

```bash
curl -X GET https://priscaai.online/chat/sell-session/test-123 \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Future Enhancements

1. **Redis Session Storage** - Move sessions to Redis for scalability
2. **Session Extension** - Allow session extension if needed
3. **More Tools** - Add more transaction intents as needed
4. **Rate Limiting** - Add rate limiting for tool calls
5. **Caching** - Cache tool results for better performance

## Migration Notes

The old `aiIntents.js` file is still present but no longer used by `Chatbot.js`. The new implementation:
- Uses function calling instead of regex
- Simplifies intent detection
- Adds session management
- Supports terminal-based sell initiation

The old code can be removed once the new implementation is fully tested and deployed.



