"""
HuggingFace Trainer sarmalayıcısı. BERTurk fine-tuning.
"""

from __future__ import annotations

import os
from typing import Dict, Tuple

import numpy as np
import torch
from datasets import Dataset
from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score
from transformers import (
    AutoModelForSequenceClassification,
    AutoTokenizer,
    DataCollatorWithPadding,
    EarlyStoppingCallback,
    Trainer,
    TrainingArguments,
)

from .config import MODEL_NAME, TrainConfig, model_dir


def _tokenize_factory(tokenizer, max_length: int):
    def _fn(batch):
        return tokenizer(
            batch["text"], truncation=True, max_length=max_length, padding=False
        )
    return _fn


def _metrics_fn(eval_pred):
    logits, labels = eval_pred
    preds = np.argmax(logits, axis=-1)
    return {
        "accuracy": accuracy_score(labels, preds),
        "f1_macro": f1_score(labels, preds, average="macro", zero_division=0),
        "precision_macro": precision_score(labels, preds, average="macro", zero_division=0),
        "recall_macro": recall_score(labels, preds, average="macro", zero_division=0),
    }


def egit(
    train_ds: Dataset,
    val_ds: Dataset,
    label2id: Dict[str, int],
    id2label: Dict[int, str],
    cfg: TrainConfig,
) -> Tuple[Trainer, AutoTokenizer]:
    """BERTurk modelini verilen veri üzerinde fine-tune eder.

    Eğitim sonunda en iyi (val f1_macro) checkpoint yüklenir ve döner.
    Kaydetme `kaydet()` ile ayrıca yapılır.
    """
    out_dir = model_dir(cfg.num_classes)
    os.makedirs(out_dir, exist_ok=True)

    print(f"\n→ Cihaz: {'CUDA (' + torch.cuda.get_device_name(0) + ')' if torch.cuda.is_available() else 'CPU'}")
    print(f"→ Pretrained model: {MODEL_NAME}")
    print(f"→ Sınıf sayısı: {cfg.num_classes}")
    print(f"→ Epochs: {cfg.epochs}  |  Batch: {cfg.batch_size}  |  LR: {cfg.learning_rate}  |  fp16: {cfg.fp16}")

    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    model = AutoModelForSequenceClassification.from_pretrained(
        MODEL_NAME,
        num_labels=cfg.num_classes,
        id2label={int(k): v for k, v in id2label.items()},
        label2id=label2id,
    )

    tok_fn = _tokenize_factory(tokenizer, cfg.max_length)
    train_tok = train_ds.map(tok_fn, batched=True, remove_columns=["text"])
    val_tok = val_ds.map(tok_fn, batched=True, remove_columns=["text"])

    collator = DataCollatorWithPadding(tokenizer=tokenizer)

    args = TrainingArguments(
        output_dir=os.path.join(out_dir, "checkpoints"),
        num_train_epochs=cfg.epochs,
        per_device_train_batch_size=cfg.batch_size,
        per_device_eval_batch_size=cfg.eval_batch_size,
        gradient_accumulation_steps=cfg.gradient_accumulation_steps,
        learning_rate=cfg.learning_rate,
        weight_decay=cfg.weight_decay,
        warmup_ratio=cfg.warmup_ratio,
        fp16=cfg.fp16 and torch.cuda.is_available(),
        eval_strategy="epoch",
        save_strategy="epoch",
        logging_steps=cfg.logging_steps,
        load_best_model_at_end=True,
        metric_for_best_model="f1_macro",
        greater_is_better=True,
        save_total_limit=cfg.save_total_limit,
        seed=cfg.seed,
        report_to="none",
        label_smoothing_factor=cfg.label_smoothing,
        dataloader_num_workers=0,  # Windows uyumluluğu
    )

    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=train_tok,
        eval_dataset=val_tok,
        tokenizer=tokenizer,
        data_collator=collator,
        compute_metrics=_metrics_fn,
        callbacks=[EarlyStoppingCallback(early_stopping_patience=cfg.early_stopping_patience)],
    )

    trainer.train()
    return trainer, tokenizer


def kaydet(trainer: Trainer, tokenizer: AutoTokenizer, cfg: TrainConfig) -> str:
    """Final modeli ve tokenizer'ı `model_bert_{N}/final/` altına kaydeder."""
    out_dir = os.path.join(model_dir(cfg.num_classes), "final")
    os.makedirs(out_dir, exist_ok=True)
    trainer.save_model(out_dir)
    tokenizer.save_pretrained(out_dir)
    print(f"\n✓ Model kaydedildi: {out_dir}")
    return out_dir
