"""
BERTurk mail sınıflandırıcısı için konfigürasyon.

Eski TF-IDF pipeline'ı (mail_classifier_model paketi) baseline olarak korunur;
bu paket transformer tabanlı yeni yaklaşımdır.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Dict

# ─── Dizinler ──────────────────────────────────────────────────────────────
_PAKET_KOKU = os.path.dirname(os.path.abspath(__file__))
PROJE_KOKU = os.path.dirname(_PAKET_KOKU)

# Veri
CSV_DOSYASI = os.path.join(PROJE_KOKU, "datasets", "mailler.csv")

# Model çıktı dizinleri (sınıf sayısına göre ayrı klasör)
def model_dir(num_classes: int) -> str:
    return os.path.join(PROJE_KOKU, f"model_bert_{num_classes}")

def result_dir(num_classes: int) -> str:
    return os.path.join(PROJE_KOKU, f"model_result_bert_{num_classes}")

# ─── Pretrained model ─────────────────────────────────────────────────────
# BERTurk: Türkçe için MDZ Digital Library tarafından eğitilmiş BERT-base.
# 110M parametre, 32k WordPiece sözlük, kasalı (cased) — büyük/küçük harf ayırır.
MODEL_NAME = "dbmdz/bert-base-turkish-cased"

# ─── Etiket eşleme ────────────────────────────────────────────────────────
# 10 sınıflı orijinal şema (CSV'deki haliyle)
LABELS_10 = [
    "İş/Acil",
    "Kişisel",
    "Güvenlik/Uyarı",
    "Spam",
    "Pazarlama",
    "Sosyal Medya",
    "Abonelik/Fatura",
    "Eğitim/Öğretim",
    "Sağlık",
    "Diğer",
]

# 6 sınıflı birleştirilmiş şema (eski sistemle birebir karşılaştırma için)
LABEL_REMAP_10_TO_6: Dict[str, str] = {
    "İş/Acil":         "İş/Acil",
    "Kişisel":         "Kişisel",
    "Güvenlik/Uyarı":  "Güvenlik",
    "Spam":            "Spam",
    "Pazarlama":       "Bildirim",
    "Sosyal Medya":    "Bildirim",
    "Abonelik/Fatura": "Bildirim",
    "Eğitim/Öğretim":  "Diğer",
    "Sağlık":          "Diğer",
    "Diğer":           "Diğer",
}

LABELS_6 = ["İş/Acil", "Kişisel", "Güvenlik", "Spam", "Bildirim", "Diğer"]


# ─── Eğitim hiperparametreleri ─────────────────────────────────────────────
@dataclass
class TrainConfig:
    num_classes: int = 10
    max_length: int = 256          # mailler tipik olarak < 256 token
    batch_size: int = 16           # RTX 3060 8GB için güvenli
    eval_batch_size: int = 32
    epochs: int = 4
    learning_rate: float = 2e-5    # standart BERT fine-tune LR
    weight_decay: float = 0.01
    warmup_ratio: float = 0.1
    fp16: bool = True              # 3060 fp16 destekler, ~2x hızlanma
    seed: int = 42
    test_size: float = 0.15
    val_size: float = 0.15         # train/val/test = 70/15/15
    early_stopping_patience: int = 2
    gradient_accumulation_steps: int = 1
    logging_steps: int = 25
    save_total_limit: int = 1      # disk dolmasın
    label_smoothing: float = 0.0   # opsiyonel: küçük datada hafif fayda
