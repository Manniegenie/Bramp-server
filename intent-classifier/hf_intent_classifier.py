"""
Hugging Face Inference API-based zero-shot intent classification
MUCH faster and more reliable than local transformers - no model loading!
Uses Hugging Face's managed infrastructure for production-ready classification
"""
import os
import requests
from typing import Dict, List, Optional
import json
import time

# Hugging Face Inference API configuration
HF_API_URL = os.getenv("HF_API_URL", "https://api-inference.huggingface.co/models")
# Best models for zero-shot classification (ranked by speed + accuracy):
# 1. "facebook/bart-large-mnli" - Fast, accurate (BEST FOR PRODUCTION)
# 2. "MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli" - Most accurate, slightly slower
# 3. "typeform/distilbert-base-uncased-mnli" - Fastest, good accuracy
HF_MODEL = os.getenv("HF_INTENT_MODEL", "facebook/bart-large-mnli")
HF_API_TOKEN = os.getenv("HF_API_TOKEN", "")  # Optional but recommended for rate limits

# Full API endpoint
CLASSIFIER_URL = f"{HF_API_URL}/{HF_MODEL}"

# Define all possible intents
INTENT_LABELS = [
    "sell_crypto",
    "deposit_crypto", 
    "check_balance",
    "check_portfolio",
    "get_crypto_price",
    "get_naira_rates",
    "transaction_history",
    "help",
    "support",
    "security_question",
    "feedback",
    "greeting",
    "spacewatch_leaderboard",
    "general_knowledge",
    "realtime_crypto_news"
]

# Intent mapping for backward compatibility
INTENT_MAPPING = {
    "sell_crypto": "sell",
    "deposit_crypto": "deposit",
    "check_balance": "dashboard",
    "check_portfolio": "dashboard",
    "get_crypto_price": "supported_token_price",
    "get_naira_rates": "naira_rates",
    "transaction_history": "transaction_history",
    "help": "help",
    "support": "support",
    "security_question": "security",
    "feedback": "feedback",
    "greeting": "greeting",
    "spacewatch_leaderboard": "spacewatch_leaderboard",
    "general_knowledge": "general_knowledge",
    "realtime_crypto_news": "realtime"
}


def classify_intent_hf(message: str, history: Optional[List[Dict]] = None, timeout: int = 5) -> Dict:
    """
    Classify user intent using Hugging Face Inference API (zero-shot classification)
    
    Advantages over local transformers:
    - No model loading (instant startup)
    - Faster inference (GPU-accelerated)
    - Auto-scaling (handles traffic spikes)
    - Always latest models
    - No infrastructure management
    
    Args:
        message: User message to classify
        history: Optional conversation history for context
        timeout: Request timeout in seconds
    
    Returns:
        Dict with intent, confidence, and alternative intents
    """
    if not message or not message.strip():
        return {
            "intent": "general",
            "confidence": 0.0,
            "all_scores": {},
            "source": "hf_api",
            "error": "Empty message"
        }
    
    # Build context if history provided
    context_message = message
    if history:
        recent_history = history[-3:] if len(history) > 3 else history
        context = " ".join([h.get("text", "") for h in recent_history[-2:]])
        if context:
            context_message = f"{context} {message}"
    
    try:
        # Prepare request payload for zero-shot classification
        payload = {
            "inputs": context_message,
            "parameters": {
                "candidate_labels": INTENT_LABELS,
                "multi_label": False
            }
        }
        
        # Add auth header if token provided
        headers = {
            "Content-Type": "application/json"
        }
        if HF_API_TOKEN:
            headers["Authorization"] = f"Bearer {HF_API_TOKEN}"
        
        # Make API request
        start_time = time.time()
        response = requests.post(
            CLASSIFIER_URL,
            json=payload,
            headers=headers,
            timeout=timeout
        )
        request_time = time.time() - start_time
        
        # Handle response
        if response.status_code == 503:
            # Model is loading, wait a bit and retry once
            print(f"Model loading, waiting 2s...")
            time.sleep(2)
            response = requests.post(
                CLASSIFIER_URL,
                json=payload,
                headers=headers,
                timeout=timeout
            )
        
        response.raise_for_status()
        result = response.json()
        
        # Extract classification results
        if isinstance(result, list) and len(result) > 0:
            result = result[0]
        
        if not isinstance(result, dict) or "labels" not in result:
            raise ValueError(f"Unexpected API response format: {result}")
        
        # Get top intent
        top_intent_label = result["labels"][0]
        top_confidence = result["scores"][0]
        
        # Map to legacy intent name
        intent = INTENT_MAPPING.get(top_intent_label, "general")
        
        # Build all scores dict
        all_scores = {
            INTENT_MAPPING.get(label, label): float(score)
            for label, score in zip(result["labels"], result["scores"])
        }
        
        return {
            "intent": intent,
            "confidence": float(top_confidence),
            "all_scores": all_scores,
            "raw_label": top_intent_label,
            "source": "hf_api",
            "request_time_ms": round(request_time * 1000, 2)
        }
        
    except requests.exceptions.Timeout:
        return {
            "intent": "general",
            "confidence": 0.0,
            "all_scores": {},
            "source": "hf_api",
            "error": "Request timeout"
        }
    except requests.exceptions.RequestException as e:
        print(f"HF API error: {e}")
        return {
            "intent": "general",
            "confidence": 0.0,
            "all_scores": {},
            "source": "hf_api",
            "error": str(e)
        }
    except Exception as e:
        print(f"Classification error: {e}")
        return {
            "intent": "general",
            "confidence": 0.0,
            "all_scores": {},
            "source": "hf_api",
            "error": str(e)
        }


if __name__ == "__main__":
    # Test the classifier
    print(f"Testing Hugging Face Inference API: {HF_MODEL}")
    print(f"URL: {CLASSIFIER_URL}\n")
    
    test_messages = [
        "what's the price of bitcoin?",
        "I want to sell 100 USDT",
        "show my balance",
        "hello",
        "how much is ethereum worth?",
        "check my portfolio",
        "what are the naira rates?"
    ]
    
    for msg in test_messages:
        result = classify_intent_hf(msg)
        print(f"\nMessage: {msg}")
        print(f"Intent: {result['intent']} (confidence: {result['confidence']:.2f})")
        print(f"Request time: {result.get('request_time_ms', 'N/A')}ms")
        if result.get('error'):
            print(f"Error: {result['error']}")
        else:
            print(f"Top 3: {list(result['all_scores'].items())[:3]}")



