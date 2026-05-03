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
from .model_manager import model_kaydet, model_yukle
from .predictor import tahmin_yap
from .vectorizers import DualTfidfVectorizer

# Training modülleri (data_loader → pandas, model_trainer → matplotlib/xgboost)
# inference container'ında bulunmayabilir. Eksikse paket import'u patlamasın
# diye opsiyonel yüklenir; eğitim ortamında zaten hepsi vardır.
try:
    from .data_loader import veri_yukle  # type: ignore[unused-ignore]
except ImportError:
    veri_yukle = None  # type: ignore[assignment]

try:
    from .model_trainer import (  # type: ignore[unused-ignore]
        model_olustur,
        model_karsilastir,
        en_cok_karisik_kategoriler,
        ozellik_onemleri,
    )
except ImportError:
    model_olustur = None  # type: ignore[assignment]
    model_karsilastir = None  # type: ignore[assignment]
    en_cok_karisik_kategoriler = None  # type: ignore[assignment]
    ozellik_onemleri = None  # type: ignore[assignment]

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

