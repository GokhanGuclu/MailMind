"""
Model kaydetme ve yükleme fonksiyonları
"""

import os
import sys
import joblib
import numpy as np
from .config import (MODEL_DIR, MODEL_DOSYASI, VECTORIZER_DOSYASI, SCALER_DOSYASI,
                     TEMIZLEYICI_DOSYASI, METRIK_CIKARICI_DOSYASI)
from .config import LABEL_TO_ID_DOSYASI, ID_TO_LABEL_DOSYASI


def model_kaydet(model, vectorizer, scaler, temizleyici, metrik_cikarici):
    """
    En iyi modeli ve tüm bileşenleri kaydet
    
    Args:
        model: Eğitilmiş model
        vectorizer: TF-IDF vektörizer
        scaler: StandardScaler
        temizleyici: MetinTemizleyici
        metrik_cikarici: MetrikCikarici
    """
    # Model klasörünü oluştur (eğer yoksa)
    os.makedirs(MODEL_DIR, exist_ok=True)
    
    print(f"\nModel kaydediliyor...")
    joblib.dump(model, MODEL_DOSYASI)
    joblib.dump(vectorizer, VECTORIZER_DOSYASI)
    joblib.dump(scaler, SCALER_DOSYASI)
    joblib.dump(temizleyici, TEMIZLEYICI_DOSYASI)
    joblib.dump(metrik_cikarici, METRIK_CIKARICI_DOSYASI)
    print(f"✓ Model: {MODEL_DOSYASI}")
    print(f"✓ Vectorizer: {VECTORIZER_DOSYASI}")
    print(f"✓ Scaler: {SCALER_DOSYASI}")
    print(f"✓ Temizleyici: {TEMIZLEYICI_DOSYASI}")
    print(f"✓ Metrik Çıkarıcı: {METRIK_CIKARICI_DOSYASI}")


def model_yukle():
    """
    Kaydedilmiş modeli ve tüm bileşenleri yükle
    
    Returns:
        tuple: (model, vectorizer, scaler, temizleyici, metrik_cikarici)
            Veya (None, None, None, None, None) hata durumunda
    """
    try:
        # Pickle için modül referansını düzelt
        # Mevcut modülü __main__'e eşle (geriye dönük uyumluluk için)
        import mail_classifier_model.preprocessing as mcp
        sys.modules['__main__'] = mcp
        
        model = joblib.load(MODEL_DOSYASI)
        vectorizer = joblib.load(VECTORIZER_DOSYASI)
        scaler = joblib.load(SCALER_DOSYASI)
        temizleyici = joblib.load(TEMIZLEYICI_DOSYASI)
        metrik_cikarici = joblib.load(METRIK_CIKARICI_DOSYASI)
        # Try to load label mappings if present
        id_to_label = None
        label_to_id = None
        try:
            if os.path.exists(ID_TO_LABEL_DOSYASI):
                id_to_label = np.load(ID_TO_LABEL_DOSYASI, allow_pickle=True).item()
            if os.path.exists(LABEL_TO_ID_DOSYASI):
                label_to_id = np.load(LABEL_TO_ID_DOSYASI, allow_pickle=True).item()
        except Exception:
            # If loading mappings fails, continue without them
            id_to_label = None
            label_to_id = None

        # Return components plus optional mappings
        return model, vectorizer, scaler, temizleyici, metrik_cikarici, id_to_label, label_to_id
    except FileNotFoundError as e:
        print(f"Model bulunamadı! Önce eğitim yapmalısınız. Hata: {e}")
        return None, None, None, None, None
    except Exception as e:
        print(f"Model yükleme hatası: {e}")
        print("Not: Eski modeller farklı bir yapıda kaydedilmiş olabilir.")
        return None, None, None, None, None

