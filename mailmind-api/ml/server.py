"""
MailMind Classifier — minimal FastAPI servisi.

Boot'ta model + tüm bileşenleri (vectorizer, scaler, temizleyici, metrik
çıkarıcı) belleğe yükler. POST /classify endpoint'i tek bir mailin
{subject, body} ikilisinden kategori tahmini döner.

NestJS backend HTTP üzerinden çağırır (env: MAIL_CLASSIFIER_URL).
"""
from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# Paket import'u: server.py klasöründen mail_classifier_model paketi importable
# olmalı. ml/ kökü sys.path'e eklenir.
HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from mail_classifier_model.predictor import tahmin_yap  # noqa: E402
from mail_classifier_model.model_manager import model_yukle  # noqa: E402

logger = logging.getLogger("classifier")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


# ─── State ─────────────────────────────────────────────────────────────────
class ModelState:
    model: Any = None
    vectorizer: Any = None
    scaler: Any = None
    temizleyici: Any = None
    metrik_cikarici: Any = None
    id_to_label: Optional[Dict[int, str]] = None
    label_to_id: Optional[Dict[str, int]] = None
    loaded: bool = False


state = ModelState()


def _load_model_into_state() -> None:
    """Boot'ta tek seferlik model yükleme. Hata durumunda servis ayağa kalkar
    ama /classify 503 döner — operatör logdan görür."""
    try:
        result = model_yukle()
        if not isinstance(result, tuple) or result[0] is None:
            logger.error("Model yüklenemedi (model_yukle None döndü).")
            return
        state.model = result[0]
        state.vectorizer = result[1]
        state.scaler = result[2]
        state.temizleyici = result[3]
        state.metrik_cikarici = result[4]
        if len(result) >= 7:
            state.id_to_label = result[5]
            state.label_to_id = result[6]
        state.loaded = True
        classes = getattr(state.model, "classes_", None)
        logger.info(
            "Model yüklendi: %s, %d kategori",
            type(state.model).__name__,
            len(classes) if classes is not None else 0,
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("Model yükleme istisnası: %s", e)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _load_model_into_state()
    yield


app = FastAPI(title="MailMind Classifier", version="1.0.0", lifespan=lifespan)


# ─── Schemas ───────────────────────────────────────────────────────────────
class ClassifyRequest(BaseModel):
    subject: str = Field(default="", description="E-posta konusu")
    body: str = Field(default="", description="E-posta gövdesi (text)")
    min_confidence: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Düşük güvenli tahminler için fallback eşiği. None ise eşik yok.",
    )


class ClassifyResponse(BaseModel):
    category: str
    confidence: float
    probabilities: Dict[str, float]


# ─── Endpoints ─────────────────────────────────────────────────────────────
@app.get("/health")
async def health() -> Dict[str, Any]:
    return {
        "ok": state.loaded,
        "model": type(state.model).__name__ if state.loaded else None,
        "categories": [str(c) for c in getattr(state.model, "classes_", [])] if state.loaded else [],
    }


@app.post("/classify", response_model=ClassifyResponse)
async def classify(req: ClassifyRequest) -> ClassifyResponse:
    if not state.loaded:
        raise HTTPException(status_code=503, detail="Model yüklenmedi")

    subject = (req.subject or "").strip()
    body = (req.body or "").strip()
    if not subject and not body:
        raise HTTPException(status_code=400, detail="subject ve body birlikte boş olamaz")

    try:
        kategori, olasiliklar = tahmin_yap(
            subject,
            body,
            model=state.model,
            vectorizer=state.vectorizer,
            scaler=state.scaler,
            temizleyici=state.temizleyici,
            metrik_cikarici=state.metrik_cikarici,
            min_guven=req.min_confidence,
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("Tahmin hatası")
        raise HTTPException(status_code=500, detail=f"Tahmin hatası: {e}")

    if kategori is None or olasiliklar is None:
        raise HTTPException(status_code=500, detail="Tahmin üretilemedi")

    probs = {str(k): float(v) for k, v in olasiliklar.items()}
    confidence = probs.get(str(kategori), 0.0)
    return ClassifyResponse(category=str(kategori), confidence=confidence, probabilities=probs)
