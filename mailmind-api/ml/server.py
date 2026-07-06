"""
MailMind Classifier — minimal FastAPI servisi.

İki backend destekler (env: MAIL_CLASSIFIER_BACKEND):
  - "tfidf" (varsayılan): eski TF-IDF + LinearSVC modeli (baseline)
  - "bert":               BERTurk fine-tune modeli (yeni, daha doğru)

BERT seçildiğinde MAIL_CLASSIFIER_NUM_CLASSES (6 veya 10) ile sınıf
sayısı seçilir; ilgili `model_bert_{N}/final/` klasörü yüklenir.

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

BACKEND = os.environ.get("MAIL_CLASSIFIER_BACKEND", "tfidf").lower()
BERT_NUM_CLASSES = int(os.environ.get("MAIL_CLASSIFIER_NUM_CLASSES", "10"))
# Opsiyonel: eğitilen modelin tam yolu. Boşsa ml/model_bert_{N}/final/ aranır.
BERT_MODEL_PATH = os.environ.get("MAIL_CLASSIFIER_BERT_PATH") or None

logger = logging.getLogger("classifier")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


# ─── State ─────────────────────────────────────────────────────────────────
class ModelState:
    backend: str = "tfidf"           # "tfidf" | "bert"
    tahmin_fn: Any = None            # backend'e göre tahmin fonksiyonu
    # TF-IDF backend alanları
    model: Any = None
    vectorizer: Any = None
    scaler: Any = None
    temizleyici: Any = None
    metrik_cikarici: Any = None
    id_to_label: Optional[Dict[int, str]] = None
    label_to_id: Optional[Dict[str, int]] = None
    # BERT backend alanı
    bert_classifier: Any = None
    loaded: bool = False


state = ModelState()


def _load_tfidf() -> None:
    from mail_classifier_model.predictor import tahmin_yap as _tahmin
    from mail_classifier_model.model_manager import model_yukle as _yukle

    result = _yukle()
    if not isinstance(result, tuple) or result[0] is None:
        logger.error("TF-IDF modeli yüklenemedi.")
        return
    state.model = result[0]
    state.vectorizer = result[1]
    state.scaler = result[2]
    state.temizleyici = result[3]
    state.metrik_cikarici = result[4]
    if len(result) >= 7:
        state.id_to_label = result[5]
        state.label_to_id = result[6]
    state.backend = "tfidf"
    state.tahmin_fn = _tahmin
    state.loaded = True
    classes = getattr(state.model, "classes_", None)
    logger.info(
        "TF-IDF modeli yüklendi: %s, %d kategori",
        type(state.model).__name__,
        len(classes) if classes is not None else 0,
    )


def _load_bert() -> None:
    from mail_classifier_bert_model.predictor import (  # noqa: E402
        model_yukle as _yukle,
        tahmin_yap as _tahmin,
    )

    clf = _yukle(num_classes=BERT_NUM_CLASSES, model_path=BERT_MODEL_PATH)
    state.bert_classifier = clf
    state.backend = "bert"
    state.tahmin_fn = _tahmin
    state.loaded = True
    logger.info(
        "BERT modeli yüklendi: %d kategori, cihaz=%s",
        len(clf.id2label), clf.device,
    )


def _load_model_into_state() -> None:
    """Boot'ta tek seferlik model yükleme. Hata durumunda servis ayağa kalkar
    ama /classify 503 döner — operatör logdan görür."""
    try:
        if BACKEND == "bert":
            _load_bert()
        else:
            _load_tfidf()
    except Exception as e:  # noqa: BLE001
        logger.exception("Model yükleme istisnası (backend=%s): %s", BACKEND, e)


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
    if not state.loaded:
        return {"ok": False, "backend": state.backend}
    if state.backend == "bert":
        cats = list(state.bert_classifier.id2label.values())
        return {"ok": True, "backend": "bert", "model": "BERTurk", "categories": cats}
    return {
        "ok": True,
        "backend": "tfidf",
        "model": type(state.model).__name__,
        "categories": [str(c) for c in getattr(state.model, "classes_", [])],
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
        if state.backend == "bert":
            kategori, olasiliklar = state.tahmin_fn(
                subject, body,
                classifier=state.bert_classifier,
                min_guven=req.min_confidence,
            )
        else:
            kategori, olasiliklar = state.tahmin_fn(
                subject, body,
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
