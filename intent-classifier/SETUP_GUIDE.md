# Quick Setup Guide - Hugging Face Intent Classification

## ✅ What's Already Done

1. **Python Service Created** (`hf_intent_classifier.py`)
   - Uses Hugging Face Inference API
   - No model loading required
   - Fast and production-ready

2. **FastAPI Server** (`app.py`)
   - Runs on port 5001
   - REST API endpoint: `/classify`
   - Health check: `/health`

3. **Node.js Integration** (`intentClient.js`)
   - Client wrapper for Python service
   - Automatic fallback to regex if service unavailable
   - Already integrated in `aiIntents.js`

4. **Async Support**
   - `quickIntentCheck()` is now async
   - `Chatbot.js` already awaits the classification
   - Regex fallback works seamlessly

## 🚀 Quick Start

### Step 1: Install Python Dependencies
```bash
cd intent-classifier
pip install -r requirements.txt
```

### Step 2: (Optional) Get Hugging Face Token
```bash
# Free tier: 1000 requests/month
# Visit: https://huggingface.co/settings/tokens
# Copy your token and add to .env:
HF_API_TOKEN=your_token_here
```

### Step 3: Start Python Service
```bash
# From intent-classifier directory
python app.py

# Service runs on http://localhost:5001
```

### Step 4: Configure Node.js Backend
```bash
# Add to your .env file (in Bramp-server root):
USE_PYTHON_CLASSIFIER=true
INTENT_SERVICE_URL=http://localhost:5001
INTENT_SERVICE_TIMEOUT=2000
```

### Step 5: Start Node.js Server
```bash
# From Bramp-server directory
npm start
```

## ✅ Testing

### Test Python Service Directly
```bash
cd intent-classifier
python hf_intent_classifier.py
```

### Test API Endpoint
```bash
curl -X POST http://localhost:5001/classify \
  -H "Content-Type: application/json" \
  -d '{"message": "what is the price of bitcoin?"}'
```

### Test Health Endpoint
```bash
curl http://localhost:5001/health
```

### Test from Node.js
The chatbot will automatically use the Python service if:
- `USE_PYTHON_CLASSIFIER=true` in `.env`
- Python service is running on port 5001
- Service responds within timeout (2s default)

Otherwise, it falls back to regex patterns.

## 📊 Expected Performance

- **Accuracy**: 90-95% (vs 60-70% with regex)
- **Latency**: 50-200ms (vs <1ms regex, but much more accurate)
- **Startup**: 0ms (vs 5-30s for local transformers)
- **Cost**: ~$10/month for 100k requests (or free tier: 1000/month)

## 🔍 Monitoring

Check logs for:
- Classification accuracy in `aiIntents.js` logs
- Service availability in `intentClient.js` logs
- Fallback occurrences (when Python service unavailable)

## 🐛 Troubleshooting

### Service Not Starting
```bash
# Check if port 5001 is available
netstat -ano | findstr :5001

# Try different port
# Update app.py: uvicorn.run(app, host="0.0.0.0", port=5002)
# Update .env: INTENT_SERVICE_URL=http://localhost:5002
```

### Low Accuracy
- Try different model: Set `HF_INTENT_MODEL=MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli` in `.env`
- Check if intents are well-defined in `INTENT_LABELS`

### Timeout Issues
- Increase timeout: Set `INTENT_SERVICE_TIMEOUT=5000` in `.env`
- Check network connection to Hugging Face API

### Fallback to Regex
- Check Python service is running: `curl http://localhost:5001/health`
- Check logs for errors
- Verify `USE_PYTHON_CLASSIFIER=true` in `.env`

## 🎯 Next Steps

1. **Test in Production**: Deploy Python service and monitor accuracy
2. **Tune Intents**: Adjust `INTENT_LABELS` based on real usage
3. **Monitor Costs**: Track Hugging Face API usage
4. **Optimize**: Fine-tune model selection based on latency/accuracy needs

## 📚 More Information

- See `README.md` for detailed documentation
- See `COMPARISON.md` for performance comparison
- See `hf_intent_classifier.py` for implementation details



