"""
Eğitilmiş BERTurk modeliyle tek-mail tahmini.

Eski `mail_classifier_model.predictor.tahmin_yap` ile aynı imza:
  tahmin_yap(subject, body, ...) -> (kategori, {label: prob})

Bu sayede FastAPI server'da minimum değişiklikle drop-in olur.
"""

from __future__ import annotations

import os
from typing import Dict, Optional, Tuple

import numpy as np
import torch
from transformers import AutoModelForSequenceClassification, AutoTokenizer

from .config import TrainConfig, model_dir
from .text_utils import mail_metni_olustur as _mail_metni_olustur


class BertClassifier:
    """Model + tokenizer'ı tek noktada tutan inference sarmalayıcısı.
    Boot'ta bir kere yüklenir, sonra `tahmin` defalarca çağrılır."""

    def __init__(self, model_path: str, max_length: int = 256, device: Optional[str] = None):
        if device is None:
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = torch.device(device)
        self.tokenizer = AutoTokenizer.from_pretrained(model_path)
        self.model = AutoModelForSequenceClassification.from_pretrained(model_path)
        self.model.to(self.device)
        self.model.eval()
        self.max_length = max_length
        # id2label config içinden gelir
        self.id2label = {int(k): v for k, v in self.model.config.id2label.items()}
        self.label2id = {v: int(k) for k, v in self.id2label.items()}

    @torch.inference_mode()
    def tahmin(self, subject: str, body: str) -> Tuple[str, Dict[str, float]]:
        metin = _mail_metni_olustur(subject, body)
        enc = self.tokenizer(
            metin,
            truncation=True,
            max_length=self.max_length,
            padding=False,
            return_tensors="pt",
        ).to(self.device)
        logits = self.model(**enc).logits[0]
        probs = torch.softmax(logits, dim=-1).cpu().numpy()
        olasiliklar = {self.id2label[i]: float(probs[i]) for i in range(len(probs))}
        en_iyi = max(olasiliklar.items(), key=lambda kv: kv[1])[0]
        return en_iyi, olasiliklar


# ─── Singleton + eski API ile uyumlu fonksiyon ───────────────────────────
_CLASSIFIER: Optional[BertClassifier] = None


def model_yukle(num_classes: int = 10, model_path: Optional[str] = None) -> BertClassifier:
    """Boot'ta çağrılır. Verilen sınıf sayısına göre `model_bert_{N}/final/` yükler.
    `model_path` verilirse direkt o yol kullanılır."""
    global _CLASSIFIER
    if model_path is None:
        model_path = os.path.join(model_dir(num_classes), "final")
    if not os.path.isdir(model_path):
        raise FileNotFoundError(
            f"BERT model bulunamadı: {model_path}\n"
            f"Önce eğitim yapın:  python mail_classifier_bert.py --num-classes {num_classes}"
        )
    _CLASSIFIER = BertClassifier(model_path)
    return _CLASSIFIER


def tahmin_yap(
    subject: str,
    body: str,
    *,
    classifier: Optional[BertClassifier] = None,
    min_guven: Optional[float] = None,
    fallback_label: str = "Diğer",
) -> Tuple[Optional[str], Optional[Dict[str, float]]]:
    """Eski API ile uyumlu tahmin. `classifier` verilmezse global singleton kullanılır."""
    clf = classifier or _CLASSIFIER
    if clf is None:
        raise RuntimeError("BERT sınıflandırıcı yüklenmedi. Önce model_yukle() çağırın.")

    kategori, olasiliklar = clf.tahmin(subject, body)

    if min_guven is not None and olasiliklar[kategori] < min_guven:
        if fallback_label in olasiliklar:
            kategori = fallback_label
        # fallback sınıf yoksa orijinal tahmini bırak

    return kategori, olasiliklar
