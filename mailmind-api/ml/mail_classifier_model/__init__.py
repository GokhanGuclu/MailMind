"""
Mail Classifier Model - Modüler Mail Kategori Sınıflandırma Sistemi

Bu paket, gelişmiş makine öğrenmesi teknikleri ile e-posta kategorilerini
tahmin etmek için gerekli tüm bileşenleri içerir.
"""

from .config import (
    CSV_DOSYASI,
    MODEL_DIR,
    MODEL_DOSYASI,
    VECTORIZER_DOSYASI,
    SCALER_DOSYASI,
    TEMIZLEYICI_DOSYASI,
    METRIK_CIKARICI_DOSYASI,
    LABEL_TO_ID_DOSYASI,
    ID_TO_LABEL_DOSYASI,
    METRIKLER_DOSYASI,
    OZELLIK_ONEM_DOSYASI,
    TURKCE_STOPWORDS,
    DEFAULT_NGRAM_RANGE,
    DEFAULT_MAX_FEATURES
)

from .preprocessing import MetinTemizleyici, MetrikCikarici
from .data_loader import veri_yukle
from .model_trainer import (
    model_olustur,
    model_karsilastir,
    en_cok_karisik_kategoriler,
    ozellik_onemleri
)
from .model_manager import model_kaydet, model_yukle
from .predictor import tahmin_yap
from .vectorizers import DualTfidfVectorizer

__version__ = "1.0.0"
__author__ = "Mail Classifier Team"

__all__ = [
    # Config
    'CSV_DOSYASI',
    'MODEL_DIR',
    'MODEL_DOSYASI',
    'VECTORIZER_DOSYASI',
    'SCALER_DOSYASI',
    'TEMIZLEYICI_DOSYASI',
    'METRIK_CIKARICI_DOSYASI',
    'LABEL_TO_ID_DOSYASI',
    'ID_TO_LABEL_DOSYASI',
    'METRIKLER_DOSYASI',
    'OZELLIK_ONEM_DOSYASI',
    'TURKCE_STOPWORDS',
    'DEFAULT_NGRAM_RANGE',
    'DEFAULT_MAX_FEATURES',
    # Preprocessing
    'MetinTemizleyici',
    'MetrikCikarici',
    # Data loading
    'veri_yukle',
    # Model training
    'model_olustur',
    'model_karsilastir',
    'en_cok_karisik_kategoriler',
    'ozellik_onemleri',
    # Model management
    'model_kaydet',
    'model_yukle',
    # Prediction
    'tahmin_yap',
    # Vectorizers
    'DualTfidfVectorizer'
]

