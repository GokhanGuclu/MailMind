"""
Konfigürasyon ve sabitler
"""

import os

# Model klasörü ve dosyaları (proje kök dizinine göre)
# Proje kök dizinini bul
_proje_koku = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# CSV dosyası
CSV_DOSYASI = os.path.join(_proje_koku, "mailler.csv")

MODEL_DIR = os.path.join(_proje_koku, "model")
RESULT_DIR = os.path.join(_proje_koku, "model_result")
MODEL_DOSYASI = os.path.join(MODEL_DIR, "mail_model_advanced.pkl")
VECTORIZER_DOSYASI = os.path.join(MODEL_DIR, "mail_vectorizer_advanced.pkl")
SCALER_DOSYASI = os.path.join(MODEL_DIR, "scaler_advanced.pkl")
TEMIZLEYICI_DOSYASI = os.path.join(MODEL_DIR, "temizleyici_advanced.pkl")
METRIK_CIKARICI_DOSYASI = os.path.join(MODEL_DIR, "metrik_cikarici_advanced.pkl")
LABEL_TO_ID_DOSYASI = os.path.join(MODEL_DIR, "label_to_id_advanced.npy")
ID_TO_LABEL_DOSYASI = os.path.join(MODEL_DIR, "id_to_label_advanced.npy")
METRIKLER_DOSYASI = os.path.join(MODEL_DIR, "metrikler_advanced.json")
OZELLIK_ONEM_DOSYASI = os.path.join(MODEL_DIR, "ozellik_onemleri.csv")

# Türkçe stopwords listesi
TURKCE_STOPWORDS = {
    've', 'ile', 'bir', 'bu', 'şu', 'o', 'da', 'de', 'ki', 'mi', 'mu', 'mü',
    'için', 'ile', 'gibi', 'kadar', 'daha', 'çok', 'az', 'en', 'hiç', 'her',
    'bazı', 'kendi', 'onu', 'ona', 'ondan', 'onun', 'bize', 'bizim', 'siz',
    'sizin', 'ben', 'benim', 'sen', 'senin', 'var', 'yok', 'olan', 'oldu',
    'olacak', 'olarak', 'olsa', 'olur', 'olmak', 'etmek', 'etmiş', 'etmişti',
    'gelmek', 'gelen', 'gelmiş', 'gidecek', 'gidiyor', 'yapmak', 'yapan',
    'yapılan', 'yapılacak', 'daha', 'çok', 'az', 'en', 'bir', 'iki', 'üç',
    'dört', 'beş'
}

# Model hiperparametreleri
DEFAULT_NGRAM_RANGE = (1, 3)
DEFAULT_MAX_FEATURES = 12000
DEFAULT_MIN_DF = 2
DEFAULT_MAX_DF = 0.95

