# Latency Optimization Options for Chatbot

## Current Issue
GPT-5-mini is experiencing high latency. Here are your options from easiest to most complex.

---

## 🚀 OPTION 1: Switch to Faster OpenAI Models (EASIEST - 5 minutes)

### **GPT-4o-mini** (Recommended for speed)
- **Speed**: ~200-400ms response time
- **Cost**: Very cheap ($0.15/$0.60 per 1M tokens)
- **Quality**: Good for conversational AI
- **Setup**: Just change model name in `.env`

```env
OPENAI_MODEL_PRIMARY=gpt-4o-mini
OPENAI_MODEL_FALLBACK=gpt-4o-mini
OPENAI_MODEL_WEB=gpt-4o-mini
```

**Pros**: Fast, cheap, good quality, no code changes needed
**Cons**: Slightly less intelligent than GPT-5-mini

### **GPT-4o** (Balanced)
- **Speed**: ~300-600ms response time
- **Cost**: Moderate ($2.50/$10 per 1M tokens)
- **Quality**: Excellent
- **Setup**: Change model name

```env
OPENAI_MODEL_PRIMARY=gpt-4o
```

**Pros**: Fast, excellent quality
**Cons**: More expensive than GPT-4o-mini

### **GPT-3.5-turbo** (Fastest OpenAI option)
- **Speed**: ~100-300ms response time
- **Cost**: Very cheap ($0.50/$1.50 per 1M tokens)
- **Quality**: Good for simple conversations
- **Setup**: Change model name

```env
OPENAI_MODEL_PRIMARY=gpt-3.5-turbo
```

**Pros**: Fastest OpenAI option, very cheap
**Cons**: Lower quality than GPT-4/5

---

## ⚡ OPTION 2: Use Groq (ULTRA-FAST - 10 minutes)

**Groq** provides ultra-fast inference with Llama models.

### Setup:
1. Sign up at https://console.groq.com
2. Get API key
3. Install: `npm install groq-sdk`
4. Update code to use Groq

**Speed**: ~50-150ms response time (FASTEST)
**Cost**: Free tier available, then pay-as-you-go
**Quality**: Good (uses Llama 3.1 70B or Mixtral)

**Pros**: Fastest option, free tier
**Cons**: Requires code changes, different API

---

## 🎯 OPTION 3: Use Google Gemini Flash (FAST - 10 minutes)

**Gemini 1.5 Flash** is optimized for speed.

### Setup:
1. Get API key from Google AI Studio
2. Install: `npm install @google/generative-ai`
3. Update code

**Speed**: ~200-400ms response time
**Cost**: Very cheap (free tier, then $0.075/$0.30 per 1M tokens)
**Quality**: Excellent

**Pros**: Fast, cheap, excellent quality
**Cons**: Requires code changes

---

## 🤖 OPTION 4: Use Anthropic Claude Haiku (FAST - 10 minutes)

**Claude 3.5 Haiku** is fast and intelligent.

### Setup:
1. Get API key from Anthropic
2. Install: `npm install @anthropic-ai/sdk`
3. Update code

**Speed**: ~300-500ms response time
**Cost**: Moderate ($0.25/$1.25 per 1M tokens)
**Quality**: Excellent

**Pros**: Fast, intelligent, good for chat
**Cons**: Requires code changes, more expensive

---

## 🔧 OPTION 5: Optimize Current Setup (NO MIGRATION - 5 minutes)

### A. Reduce Token Limits
```javascript
// In AI/Chatbot.js
const AI_OUTPUT_MAX_TOKENS = 150; // Reduce from 300
const AI_BROWSING_OUTPUT_TOKENS = 300; // Reduce from 600
```

### B. Use Minimal Reasoning (if using Responses API)
```javascript
reasoning: { effort: "minimal" },
text: { verbosity: "low" }
```

### C. Reduce Context Window
```javascript
// Only use last 5 messages instead of 10
...history.slice(-5).map(...)
```

### D. Add Response Caching
Cache common responses (rates, deposit info, etc.)

**Pros**: No migration needed
**Cons**: May reduce quality slightly

---

## 🎛️ OPTION 6: Hybrid Approach (SMART ROUTING - 15 minutes)

Route simple queries to fast model, complex ones to GPT-5-mini.

```javascript
// Simple intents → GPT-4o-mini (fast)
// Complex intents → GPT-5-mini (smart)
const model = ['greeting', 'naira_rates', 'deposit'].includes(intent)
  ? 'gpt-4o-mini'  // Fast for simple
  : 'gpt-5-mini';  // Smart for complex
```

**Pros**: Best of both worlds
**Cons**: Requires routing logic

---

## 📊 COMPARISON TABLE

| Option | Speed | Cost | Quality | Setup Time | Code Changes |
|--------|-------|------|---------|------------|--------------|
| **GPT-4o-mini** | ⚡⚡⚡ | 💰 | ⭐⭐⭐⭐ | 5 min | None |
| **GPT-4o** | ⚡⚡ | 💰💰 | ⭐⭐⭐⭐⭐ | 5 min | None |
| **GPT-3.5-turbo** | ⚡⚡⚡⚡ | 💰 | ⭐⭐⭐ | 5 min | None |
| **Groq** | ⚡⚡⚡⚡⚡ | 💰 | ⭐⭐⭐⭐ | 10 min | Yes |
| **Gemini Flash** | ⚡⚡⚡ | 💰 | ⭐⭐⭐⭐⭐ | 10 min | Yes |
| **Claude Haiku** | ⚡⚡ | 💰💰 | ⭐⭐⭐⭐⭐ | 10 min | Yes |
| **Optimize Current** | ⚡⚡ | - | ⭐⭐⭐⭐ | 5 min | Minor |
| **Hybrid Routing** | ⚡⚡⚡ | 💰💰 | ⭐⭐⭐⭐⭐ | 15 min | Yes |

---

## 🎯 RECOMMENDATION

**For fastest implementation**: Switch to **GPT-4o-mini** (Option 1)
- Just change `.env` file
- No code changes needed
- Fast and cheap
- Good quality for chat

**For best performance**: Use **Hybrid Approach** (Option 6)
- Simple queries → GPT-4o-mini (fast)
- Complex queries → GPT-5-mini (smart)
- Best user experience

**For ultra-fast**: Use **Groq** (Option 2)
- Fastest option available
- Free tier to test
- Requires code changes

---

## 🚀 QUICK START: Switch to GPT-4o-mini (Recommended)

1. Update `.env`:
```env
OPENAI_MODEL_PRIMARY=gpt-4o-mini
OPENAI_MODEL_FALLBACK=gpt-4o-mini
OPENAI_MODEL_WEB=gpt-4o-mini
FINANCIAL_ANALYSIS_MODEL=gpt-4o-mini
EXTRACTION_MODEL=gpt-4o-mini
SCAN_MODEL=gpt-4o-mini
```

2. Restart server
3. Test - should see ~200-400ms response times

**That's it!** No code changes needed because GPT-4o-mini uses `max_tokens` (not `max_completion_tokens`) and supports `temperature`.

---

## 📝 Notes

- GPT-4o-mini is currently the best balance of speed, cost, and quality
- All OpenAI models (except GPT-5) use `max_tokens` and support `temperature`
- Groq and Gemini require code changes but offer better speed
- Hybrid approach gives best UX but requires more work


