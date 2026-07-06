"""
Test seti üzerinde değerlendirme ve görselleştirme.

Üretilen çıktılar (model_result_bert_{N}/ altına):
  - classification_report.txt   sınıf bazlı precision/recall/F1
  - confusion_matrix.png        karışıklık matrisi heatmap
  - training_curves.png         epoch başına loss & F1 grafiği
  - metrikler.json              özet skorlar (raporda kullanmak için)
"""

from __future__ import annotations

import json
import os
from typing import Dict, List

import matplotlib

matplotlib.use("Agg")  # GUI yok, dosyaya yazıyoruz
import matplotlib.pyplot as plt
import numpy as np
import seaborn as sns
from datasets import Dataset
from sklearn.metrics import (
    accuracy_score,
    classification_report,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
)
from transformers import Trainer

from .config import TrainConfig, result_dir
from .trainer import _tokenize_factory


def degerlendir(
    trainer: Trainer,
    tokenizer,
    test_ds: Dataset,
    id2label: Dict[int, str],
    cfg: TrainConfig,
) -> Dict[str, float]:
    """Test setinde tahmin yapar, raporları ve grafikleri kaydeder."""
    rdir = result_dir(cfg.num_classes)
    os.makedirs(rdir, exist_ok=True)

    tok_fn = _tokenize_factory(tokenizer, cfg.max_length)
    test_tok = test_ds.map(tok_fn, batched=True, remove_columns=["text"])

    pred_out = trainer.predict(test_tok)
    y_true = pred_out.label_ids
    y_pred = np.argmax(pred_out.predictions, axis=-1)

    target_names = [id2label[i] for i in range(cfg.num_classes)]

    # ─── Classification report ─────────────────────────────────────────────
    report_txt = classification_report(
        y_true, y_pred, target_names=target_names, digits=4, zero_division=0
    )
    print("\n" + "=" * 70)
    print("TEST SETİ — Sınıflandırma Raporu")
    print("=" * 70)
    print(report_txt)

    with open(os.path.join(rdir, "classification_report.txt"), "w", encoding="utf-8") as f:
        f.write(report_txt)

    # ─── Confusion matrix ──────────────────────────────────────────────────
    cm = confusion_matrix(y_true, y_pred, labels=list(range(cfg.num_classes)))
    fig, ax = plt.subplots(figsize=(max(7, cfg.num_classes), max(6, cfg.num_classes * 0.8)))
    sns.heatmap(
        cm, annot=True, fmt="d", cmap="Blues",
        xticklabels=target_names, yticklabels=target_names, ax=ax,
        cbar_kws={"label": "Örnek sayısı"},
    )
    ax.set_xlabel("Tahmin edilen")
    ax.set_ylabel("Gerçek")
    ax.set_title(f"Confusion Matrix — BERTurk ({cfg.num_classes} sınıf)")
    plt.xticks(rotation=30, ha="right")
    plt.yticks(rotation=0)
    plt.tight_layout()
    cm_path = os.path.join(rdir, "confusion_matrix.png")
    fig.savefig(cm_path, dpi=140)
    plt.close(fig)
    print(f"✓ Confusion matrix → {cm_path}")

    # ─── Eğitim eğrileri ───────────────────────────────────────────────────
    _egitim_egrileri_ciz(trainer, rdir, cfg.num_classes)

    # ─── Özet metrikler ────────────────────────────────────────────────────
    metrics = {
        "num_classes": cfg.num_classes,
        "accuracy": float(accuracy_score(y_true, y_pred)),
        "f1_macro": float(f1_score(y_true, y_pred, average="macro", zero_division=0)),
        "f1_weighted": float(f1_score(y_true, y_pred, average="weighted", zero_division=0)),
        "precision_macro": float(precision_score(y_true, y_pred, average="macro", zero_division=0)),
        "recall_macro": float(recall_score(y_true, y_pred, average="macro", zero_division=0)),
        "test_size": int(len(y_true)),
    }
    with open(os.path.join(rdir, "metrikler.json"), "w", encoding="utf-8") as f:
        json.dump(metrics, f, indent=2, ensure_ascii=False)

    print("\n→ Özet:")
    for k, v in metrics.items():
        if isinstance(v, float):
            print(f"   {k:20s} = {v:.4f}")
        else:
            print(f"   {k:20s} = {v}")

    return metrics


def _egitim_egrileri_ciz(trainer: Trainer, rdir: str, num_classes: int) -> None:
    """Trainer log history'den loss ve val F1 grafiği üretir."""
    hist = trainer.state.log_history
    train_loss = [(h["epoch"], h["loss"]) for h in hist if "loss" in h and "eval_loss" not in h]
    eval_loss = [(h["epoch"], h["eval_loss"]) for h in hist if "eval_loss" in h]
    eval_f1 = [(h["epoch"], h.get("eval_f1_macro")) for h in hist if "eval_f1_macro" in h]

    if not eval_f1:
        return

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 4.5))

    if train_loss:
        xs, ys = zip(*train_loss)
        ax1.plot(xs, ys, label="train loss", color="#1f77b4", alpha=0.7)
    if eval_loss:
        xs, ys = zip(*eval_loss)
        ax1.plot(xs, ys, label="val loss", color="#d62728", marker="o")
    ax1.set_xlabel("Epoch")
    ax1.set_ylabel("Loss")
    ax1.set_title("Eğitim / Validation Loss")
    ax1.legend()
    ax1.grid(alpha=0.3)

    xs, ys = zip(*eval_f1)
    ax2.plot(xs, ys, label="val F1-macro", color="#2ca02c", marker="o")
    ax2.set_xlabel("Epoch")
    ax2.set_ylabel("F1-macro")
    ax2.set_title("Validation F1-macro")
    ax2.set_ylim(0, 1)
    ax2.legend()
    ax2.grid(alpha=0.3)

    plt.suptitle(f"BERTurk Fine-Tune — {num_classes} sınıf", fontsize=12, y=1.02)
    plt.tight_layout()
    out = os.path.join(rdir, "training_curves.png")
    fig.savefig(out, dpi=140, bbox_inches="tight")
    plt.close(fig)
    print(f"✓ Eğitim eğrileri → {out}")
