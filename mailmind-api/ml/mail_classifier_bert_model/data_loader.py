"""
CSV'yi HuggingFace Dataset'e çeviren yükleyici.

Önemli farklar (TF-IDF baseline'a göre):
- Stopword temizliği YOK. Transformer bağlamı kendi öğrenir; "ve/için" gibi
  kelimeler attention için anlamlıdır.
- Sayı/URL temizliği YOK. "fatura no 12345" örüntüsü sınıflandırma için sinyal.
- Sadece Başlık+İçerik birleştirilip [KONU] ... [GÖVDE] ... formatında verilir
  ki encoder konu satırının önemini ayırt edebilsin.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

import pandas as pd
from datasets import Dataset
from sklearn.model_selection import train_test_split

from .config import CSV_DOSYASI, LABELS_10, LABELS_6, LABEL_REMAP_10_TO_6, TrainConfig
from .text_utils import mail_metni_olustur as _mail_metni_olustur


def label_listesi(num_classes: int) -> List[str]:
    if num_classes == 10:
        return list(LABELS_10)
    if num_classes == 6:
        return list(LABELS_6)
    raise ValueError(f"num_classes 6 veya 10 olmalı, alındı: {num_classes}")


def veri_yukle(cfg: TrainConfig) -> Tuple[Dataset, Dataset, Dataset, Dict[str, int], Dict[int, str]]:
    """CSV'yi okur, train/val/test split yapar, HuggingFace Dataset döner.

    Returns:
        train_ds, val_ds, test_ds, label2id, id2label
    """
    df = pd.read_csv(CSV_DOSYASI, encoding="utf-8-sig")
    df = df.dropna(subset=["Kategori", "Başlık", "İçerik"])

    # 10 → 6 birleşimi (opsiyonel)
    if cfg.num_classes == 6:
        df["Kategori"] = df["Kategori"].map(lambda v: LABEL_REMAP_10_TO_6.get(v, "Diğer"))
    elif cfg.num_classes == 10:
        # Bilinmeyen etiket varsa düşür
        df = df[df["Kategori"].isin(LABELS_10)]
    else:
        raise ValueError(f"num_classes 6 veya 10 olmalı, alındı: {cfg.num_classes}")

    df["text"] = [
        _mail_metni_olustur(b, i)
        for b, i in zip(df["Başlık"].astype(str), df["İçerik"].astype(str))
    ]
    df = df[df["text"].str.len() > 10].reset_index(drop=True)

    labels = label_listesi(cfg.num_classes)
    label2id = {lbl: i for i, lbl in enumerate(labels)}
    id2label = {i: lbl for lbl, i in label2id.items()}
    df["label"] = df["Kategori"].map(label2id)

    # train / val / test = 70 / 15 / 15 (stratified)
    train_df, temp_df = train_test_split(
        df, test_size=cfg.test_size + cfg.val_size,
        stratify=df["label"], random_state=cfg.seed,
    )
    rel_val = cfg.val_size / (cfg.test_size + cfg.val_size)
    val_df, test_df = train_test_split(
        temp_df, test_size=1 - rel_val,
        stratify=temp_df["label"], random_state=cfg.seed,
    )

    def _to_ds(d: pd.DataFrame) -> Dataset:
        return Dataset.from_pandas(d[["text", "label"]].reset_index(drop=True))

    print(f"Toplam: {len(df)}  →  train: {len(train_df)}  val: {len(val_df)}  test: {len(test_df)}")
    print(f"Sınıf dağılımı (train):")
    print(train_df["Kategori"].value_counts().to_string())

    return _to_ds(train_df), _to_ds(val_df), _to_ds(test_df), label2id, id2label
