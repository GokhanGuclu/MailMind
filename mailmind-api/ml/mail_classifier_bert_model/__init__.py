"""BERTurk tabanlı mail sınıflandırıcı paketi."""

from .config import (
    LABELS_10,
    LABELS_6,
    LABEL_REMAP_10_TO_6,
    MODEL_NAME,
    TrainConfig,
    model_dir,
    result_dir,
)

__all__ = [
    "TrainConfig",
    "MODEL_NAME",
    "LABELS_10",
    "LABELS_6",
    "LABEL_REMAP_10_TO_6",
    "model_dir",
    "result_dir",
]
