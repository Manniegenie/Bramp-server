"""
Zero-shot intent classification service using transformers pipeline
Provides accurate intent detection without regex patterns
"""
from transformers import pipeline
from typing import Dict, List, Optional
import os
import json

# Initialize the zero-shot classifier
# Using optimized model for production: faster and more accurate
# Options:
# - "MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli" (best accuracy, slower)
# - "facebook/bart-large-mnli" (balanced, good accuracy)
# - "typeform/distilbert-base-uncased-mnli" (fastest, good for production)
import os

MODEL_NAME = os.getenv("INTENT_MODEL", "MoritzLaurer/DeBERTa-v3-base-mnli-fever-anli")  # Best accuracy
USE_GPU = os.getenv("USE_GPU", "false").lower() == "true"
DEVICE = 0 if USE_GPU else -1

print(f"Loading intent classifier model: {MODEL_NAME} on {'GPU' if USE_GPU else 'CPU'}")

classifier = pipeline(
    "zero-shot-classification",
    model=MODEL_NAME,
    device=DEVICE
)

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


def classify_intent(message: str, history: Optional[List[Dict]] = None) -> Dict:
    """
    Classify user intent using zero-shot classification
    
    Args:
        message: User message to classify
        history: Optional conversation history for context
    
    Returns:
        Dict with intent, confidence, and alternative intents
    """
    if not message or not message.strip():
        return {
            "intent": "general",
            "confidence": 0.0,
            "all_scores": {}
        }
    
    # Build context if history provided
    context_message = message
    if history:
        # Include last 3 messages for context
        recent_history = history[-3:] if len(history) > 3 else history
        context = " ".join([h.get("text", "") for h in recent_history[-2:]])
        if context:
            context_message = f"{context} {message}"
    
    try:
        # Run zero-shot classification
        result = classifier(context_message, INTENT_LABELS, multi_label=False)
        
        # Get top intent
        top_intent_label = result["labels"][0]
        top_confidence = result["scores"][0]
        
        # Map to legacy intent name
        intent = INTENT_MAPPING.get(top_intent_label, "general")
        
        # Build all scores dict
        all_scores = {
            INTENT_MAPPING.get(label, label): score 
            for label, score in zip(result["labels"], result["scores"])
        }
        
        return {
            "intent": intent,
            "confidence": float(top_confidence),
            "all_scores": all_scores,
            "raw_label": top_intent_label
        }
        
    except Exception as e:
        print(f"Classification error: {e}")
        return {
            "intent": "general",
            "confidence": 0.0,
            "all_scores": {},
            "error": str(e)
        }


if __name__ == "__main__":
    # Test the classifier
    test_messages = [
        "what's the price of bitcoin?",
        "I want to sell 100 USDT",
        "show my balance",
        "hello",
        "how much is ethereum worth?"
    ]
    
    for msg in test_messages:
        result = classify_intent(msg)
        print(f"\nMessage: {msg}")
        print(f"Intent: {result['intent']} (confidence: {result['confidence']:.2f})")
        print(f"Top 3: {list(result['all_scores'].items())[:3]}")


