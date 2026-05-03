"""
Tahmin fonksiyonları
"""

import numpy as np
from scipy import sparse as sp
from .model_manager import model_yukle


def tahmin_yap(baslik, icerik, model=None, vectorizer=None, scaler=None, 
                temizleyici=None, metrik_cikarici=None, min_guven=None, fallback_label="Diğer"):
    """
    Verilen başlık ve içerik için kategori tahmini yap
    
    Args:
        baslik: E-posta başlığı
        icerik: E-posta içeriği
        model: Eğitilmiş model (opsiyonel, None ise yüklenir)
        vectorizer: TF-IDF vektörizer (opsiyonel)
        scaler: StandardScaler (opsiyonel)
        temizleyici: MetinTemizleyici (opsiyonel)
        metrik_cikarici: MetrikCikarici (opsiyonel)
        
    Returns:
        tuple: (tahmin, olasiliklar)
            tahmin: En yüksek olasılıklı kategori
            olasiliklar: Tüm kategoriler için olasılıklar dict'i
    """
    # Model yüklenmemişse yükle
    id_to_label = None
    label_to_id = None
    if model is None:
        result = model_yukle()
        # model_yukle may return 5 or 7 items (we updated it to return mappings when available)
        if isinstance(result, tuple) and len(result) >= 5:
            model = result[0]
            vectorizer = result[1]
            scaler = result[2]
            temizleyici = result[3]
            metrik_cikarici = result[4]
            if len(result) >= 7:
                id_to_label = result[5]
                label_to_id = result[6]
        else:
            # Unexpected result
            model = None
            vectorizer = None
            scaler = None
            temizleyici = None
            metrik_cikarici = None
    
    if model is None or vectorizer is None:
        return None, None
    
    # Metni birleştir ve temizle
    metin = baslik + " " + icerik
    metin_temiz = temizleyici.transform([metin])[0]
    
    # Vectorize et
    X_tfidf = vectorizer.transform([metin_temiz])
    
    # Metrikleri çıkar ve normalize et
    X_metrik = metrik_cikarici.transform([metin])
    X_metrik = scaler.transform(X_metrik)
    
    # Birleştir (sparse + dense -> sparse)
    X_combined = sp.hstack([X_tfidf, sp.csr_matrix(X_metrik)], format="csr")
    
    # Tahmin yap
    if hasattr(model, 'predict_proba'):
        olasilik = model.predict_proba(X_combined)[0]
    else:
        # LinearSVC gibi olasılık vermeyen modeller için
        # decision_function kullan ve normalize et
        decision_scores = model.decision_function(X_combined)[0]
        # Softmax benzeri normalizasyon
        exp_scores = np.exp(decision_scores - np.max(decision_scores))
        olasilik = exp_scores / np.sum(exp_scores)
    
    # Kategoriler ve olasılıkları eşleştir
    kategoriler = model.classes_

    # If model was trained on numeric labels (e.g., XGBoost encoded labels),
    # try to map them back to original string labels using id_to_label mapping.
    mapped_categories = None
    try:
        # model.classes_ may already be strings; if numeric and id_to_label exists, map
        if id_to_label and all(isinstance(c, (int, np.integer)) for c in kategoriler):
            mapped_categories = [id_to_label.get(int(c), str(c)) for c in kategoriler]
        else:
            mapped_categories = [str(c) for c in kategoriler]
    except Exception:
        mapped_categories = [str(c) for c in kategoriler]

    olasiliklar = {kategori: prob for kategori, prob in zip(mapped_categories, olasilik)}
    
    # En yüksek olasılıklı kategoriyi seç
    tahmin, tahmin_prob = max(olasiliklar.items(), key=lambda x: x[1])

    # Opsiyonel güven eşiği: düşük güvenli tahminleri fallback'e düşür
    if min_guven is not None:
        try:
            if float(tahmin_prob) < float(min_guven):
                tahmin = fallback_label
        except Exception:
            # Eşik kontrolü başarısızsa tahmini değiştirme
            pass
    
    return tahmin, olasiliklar

