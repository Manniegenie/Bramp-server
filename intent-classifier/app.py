"""
FastAPI server for intent classification service
Can be called from Node.js backend via HTTP
Uses Hugging Face Inference API for fast, production-ready classification
"""
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Optional
from hf_intent_classifier import classify_intent_hf
import uvicorn

app = FastAPI(title="Intent Classification Service", version="2.0.0")


class ClassificationRequest(BaseModel):
    message: str
    history: Optional[List[Dict]] = None


class ClassificationResponse(BaseModel):
    intent: str
    confidence: float
    all_scores: Dict[str, float]
    raw_label: Optional[str] = None
    error: Optional[str] = None


@app.post("/classify", response_model=ClassificationResponse)
async def classify(request: ClassificationRequest):
    """
    Classify user message intent using Hugging Face Inference API
    
    POST /classify
    Body: { "message": "what's the price of bitcoin?", "history": [...] }
    
    Uses HF Inference API for:
    - Fast inference (no model loading)
    - GPU acceleration
    - Auto-scaling
    - Production reliability
    """
    try:
        result = classify_intent_hf(request.message, request.history)
        return ClassificationResponse(**result)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/health")
async def health():
    """Health check endpoint"""
    return {"status": "healthy", "service": "intent-classifier"}


if __name__ == "__main__":
    # Run on port 5001 (avoid conflict with main Node.js server on 3000)
    uvicorn.run(app, host="0.0.0.0", port=5001)


