"""
Model eğitimi ve karşılaştırma fonksiyonları
"""

import numpy as np
import json
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
import os
from datetime import datetime
from time import time
from sklearn.model_selection import train_test_split
from scipy import sparse as sp
from sklearn.calibration import CalibratedClassifierCV
from sklearn.naive_bayes import MultinomialNB
from sklearn.svm import LinearSVC
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import (accuracy_score, classification_report, confusion_matrix,
                             f1_score, precision_score, recall_score)
import xgboost as xgb

from .config import (DEFAULT_NGRAM_RANGE, DEFAULT_MAX_FEATURES,
                     DEFAULT_MIN_DF, DEFAULT_MAX_DF,
                     METRIKLER_DOSYASI, OZELLIK_ONEM_DOSYASI,
                     RESULT_DIR)
from .vectorizers import DualTfidfVectorizer


def model_olustur(ngram_range=None, max_features=None):
    """
    TF-IDF vektörizasyon oluştur
    
    Args:
        ngram_range: N-gram aralığı (varsayılan: config'ten gelir)
        max_features: Maksimum özellik sayısı (varsayılan: config'ten gelir)
        
    Returns:
        TfidfVectorizer: TF-IDF vektörizer
    """
    if ngram_range is None:
        ngram_range = DEFAULT_NGRAM_RANGE
    if max_features is None:
        max_features = DEFAULT_MAX_FEATURES
        
    # Geriye dönük uyumluluk için tutuluyor (tek TF-IDF isteyenler)
    from sklearn.feature_extraction.text import TfidfVectorizer
    return TfidfVectorizer(
        max_features=max_features,
        ngram_range=ngram_range,
        min_df=DEFAULT_MIN_DF,
        max_df=DEFAULT_MAX_DF,
        sublinear_tf=True
    )


def model_karsilastir(X, y, X_metrikler, temizleyici, metrik_cikarici):
    """
    Farklı modelleri karşılaştır ve en iyisini seç
    
    Args:
        X: Temizlenmiş mail metinleri
        y: Kategori etiketleri
        X_metrikler: Ek metrikler
        temizleyici: MetinTemizleyici örneği
        metrik_cikarici: MetrikCikarici örneği
        
    Returns:
        tuple: (en_iyi_isim, en_iyi_model, vectorizer, scaler, temizleyici, metrik_cikarici)
    """
    print("\n" + "="*70)
    print("MODEL KARŞILAŞTIRMASI")
    print("="*70)
    
    # Veriyi train/test olarak ayır
    X_train, X_test, y_train, y_test, X_train_met, X_test_met = train_test_split(
        X, y, X_metrikler, test_size=0.2, random_state=42, stratify=y
    )
    
    # Vectorizer: kelime + char n-gram (temiz metin üzerinden)
    # Char n-gram özellikle benzer kategorilerde (Sosyal Medya vs Güvenlik/Uyarı gibi) ayrımı güçlendirir.
    vectorizer = DualTfidfVectorizer(
        word_max_features=DEFAULT_MAX_FEATURES,
        word_ngram_range=DEFAULT_NGRAM_RANGE,
        char_max_features=8000,
        char_ngram_range=(3, 5),
        min_df=DEFAULT_MIN_DF,
        max_df=DEFAULT_MAX_DF,
        sublinear_tf=True,
    )
    
    X_train_tfidf = vectorizer.fit_transform(X_train)
    X_test_tfidf = vectorizer.transform(X_test)
    
    # Metrikleri normalize et
    scaler = StandardScaler()
    X_train_met = scaler.fit_transform(X_train_met)
    X_test_met = scaler.transform(X_test_met)
    
    # TF-IDF (sparse) ve metrikleri (dense) birleştir (sparse kalacak şekilde)
    X_train_met_sparse = sp.csr_matrix(X_train_met)
    X_test_met_sparse = sp.csr_matrix(X_test_met)
    X_train_combined = sp.hstack([X_train_tfidf, X_train_met_sparse], format="csr")
    X_test_combined = sp.hstack([X_test_tfidf, X_test_met_sparse], format="csr")
    
    print(f"\nToplam özellik sayısı: {X_train_combined.shape[1]}")
    print(f"  - TF-IDF özellikleri: {X_train_tfidf.shape[1]}")
    print(f"  - Metrik özellikleri: {X_train_met.shape[1]}")
    
    # Label encoding for XGBoost
    unique_labels = np.unique(y_train)
    label_to_id = {label: i for i, label in enumerate(unique_labels)}
    y_train_encoded = np.array([label_to_id[label] for label in y_train])
    y_test_encoded = np.array([label_to_id[label] for label in y_test])
    
    # Modeller (hız ve performans dengesi için optimize edilmiş)
    modeller = {
        'Naive Bayes': MultinomialNB(alpha=0.1),
        'Logistic Regression': LogisticRegression(random_state=42, max_iter=300, class_weight='balanced', n_jobs=-1),
        'Linear SVM': LinearSVC(random_state=42, class_weight='balanced', max_iter=1000, dual=False),
        'XGBoost': xgb.XGBClassifier(random_state=42, n_jobs=-1, eval_metric='mlogloss', n_estimators=50, max_depth=5)
    }
    
    sonuclar = {}
    
    for isim, model in modeller.items():
        print(f"\n{isim} eğitiliyor...")
        start_time = time()
        
        # XGBoost için encoded labels kullan
        if isim == 'XGBoost':
            y_train_current = y_train_encoded
            y_test_current = y_test_encoded
        else:
            y_train_current = y_train
            y_test_current = y_test
        
        # Naive Bayes için sadece TF-IDF kullan (negatif değer alamaz)
        if isim == 'Naive Bayes':
            X_train_model = X_train_tfidf
            X_test_model = X_test_tfidf
            X_train_res, y_train_res = X_train_model, y_train_current
        else:
            X_train_model = X_train_combined
            X_test_model = X_test_combined
            X_train_res, y_train_res = X_train_combined, y_train_current
        
        # Modeli eğit
        model_to_fit = model
        # Olasılık vermeyen modeller için kalibrasyon (güven skorunu daha anlamlı yapar)
        if not hasattr(model_to_fit, 'predict_proba') and hasattr(model_to_fit, 'decision_function'):
            try:
                model_to_fit = CalibratedClassifierCV(estimator=model_to_fit, method='sigmoid', cv=3)
            except TypeError:
                # Eski sklearn sürümleri için
                model_to_fit = CalibratedClassifierCV(base_estimator=model_to_fit, method='sigmoid', cv=3)

        model_to_fit.fit(X_train_res, y_train_res)
        fit_time = time() - start_time
        print(f"  Eğitim süresi: {fit_time:.2f} saniye")
        
        # Tahmin yap
        y_pred = model_to_fit.predict(X_test_model)
        
        # XGBoost tahminlerini label'a çevir
        if isim == 'XGBoost':
            id_to_label = {i: label for label, i in label_to_id.items()}
            y_pred_labels = np.array([id_to_label[pred] for pred in y_pred])
        else:
            y_pred_labels = y_pred
            
        total_time = time() - start_time
        print(f"  Toplam süre: {total_time:.2f} saniye")
        
        # Metrikleri hesapla
        accuracy = accuracy_score(y_test, y_pred_labels)
        f1_macro = f1_score(y_test, y_pred_labels, average='macro')
        precision_macro = precision_score(y_test, y_pred_labels, average='macro')
        recall_macro = recall_score(y_test, y_pred_labels, average='macro')
        
        sonuclar[isim] = {
            'model': model_to_fit,
            'accuracy': accuracy,
            'f1_macro': f1_macro,
            'precision_macro': precision_macro,
            'recall_macro': recall_macro,
            'y_pred': y_pred_labels,
            'scaler': scaler
        }
        
        print(f"  Accuracy: {accuracy:.4f}")
        print(f"  F1-Macro: {f1_macro:.4f}")
        print(f"  Precision-Macro: {precision_macro:.4f}")
        print(f"  Recall-Macro: {recall_macro:.4f}")
    
    # En iyi modeli seç (F1 score'a göre)
    en_iyi_isim = max(sonuclar.items(), key=lambda x: x[1]['f1_macro'])[0]
    en_iyi_sonuc = sonuclar[en_iyi_isim]
    
    print(f"\n{'='*70}")
    print(f"EN İYİ MODEL: {en_iyi_isim}")
    print(f"  Accuracy: {en_iyi_sonuc['accuracy']:.4f}")
    print(f"  F1-Macro: {en_iyi_sonuc['f1_macro']:.4f}")
    print(f"  Precision-Macro: {en_iyi_sonuc['precision_macro']:.4f}")
    print(f"  Recall-Macro: {en_iyi_sonuc['recall_macro']:.4f}")
    print(f"{'='*70}")
    
    # Metrikleri kaydet
    metrikler_dict = {
        'model': en_iyi_isim,
        'accuracy': float(en_iyi_sonuc['accuracy']),
        'f1_macro': float(en_iyi_sonuc['f1_macro']),
        'precision_macro': float(en_iyi_sonuc['precision_macro']),
        'recall_macro': float(en_iyi_sonuc['recall_macro']),
        'tarih': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    }
    
    with open(METRIKLER_DOSYASI, 'w', encoding='utf-8') as f:
        json.dump(metrikler_dict, f, ensure_ascii=False, indent=2)

    # Sonuç klasörü (raporlar/grafikler)
    os.makedirs(RESULT_DIR, exist_ok=True)

    # Tüm modellerin karşılaştırma metrikleri (csv/json)
    summary_rows = []
    for isim, s in sonuclar.items():
        summary_rows.append({
            "model": isim,
            "accuracy": float(s["accuracy"]),
            "f1_macro": float(s["f1_macro"]),
            "precision_macro": float(s["precision_macro"]),
            "recall_macro": float(s["recall_macro"]),
        })
    df_summary = pd.DataFrame(summary_rows).sort_values("f1_macro", ascending=False)
    df_summary.to_csv(os.path.join(RESULT_DIR, "model_comparison_metrics.csv"), index=False, encoding="utf-8-sig")
    with open(os.path.join(RESULT_DIR, "model_comparison_metrics.json"), "w", encoding="utf-8") as f:
        json.dump(summary_rows, f, ensure_ascii=False, indent=2)

    # Model karşılaştırma grafiği (F1-Macro)
    plt.figure(figsize=(10, 5))
    sns.barplot(data=df_summary, x="model", y="f1_macro", color="#4C78A8")
    plt.title("Model Karşılaştırma - F1 Macro")
    plt.ylabel("F1 Macro")
    plt.xlabel("Model")
    plt.xticks(rotation=25, ha="right")
    plt.tight_layout()
    plt.savefig(os.path.join(RESULT_DIR, "model_comparison_f1_macro.png"), dpi=250, bbox_inches="tight")
    plt.close()
    
    # En iyi model için detaylı değerlendirme
    print("\nDetaylı Sınıflandırma Raporu:")
    print(classification_report(y_test, en_iyi_sonuc['y_pred']))

    # Classification report'u dosyaya yaz (csv/json)
    report_dict = classification_report(y_test, en_iyi_sonuc["y_pred"], output_dict=True)
    df_report = pd.DataFrame(report_dict).transpose()
    df_report.to_csv(os.path.join(RESULT_DIR, "classification_report.csv"), encoding="utf-8-sig")
    with open(os.path.join(RESULT_DIR, "classification_report.json"), "w", encoding="utf-8") as f:
        json.dump(report_dict, f, ensure_ascii=False, indent=2)

    # Sınıf bazlı F1 grafiği
    # (support/accuracy satırlarını çıkar)
    df_f1 = df_report.copy()
    df_f1 = df_f1[~df_f1.index.isin(["accuracy", "macro avg", "weighted avg"])].copy()
    if "f1-score" in df_f1.columns:
        df_f1 = df_f1.sort_values("f1-score", ascending=False)
        plt.figure(figsize=(10, 6))
        sns.barplot(x=df_f1.index, y=df_f1["f1-score"], color="#59A14F")
        plt.title(f"Sınıf Bazlı F1 Skoru - {en_iyi_isim}")
        plt.ylabel("F1")
        plt.xlabel("Kategori")
        plt.xticks(rotation=35, ha="right")
        plt.tight_layout()
        plt.savefig(os.path.join(RESULT_DIR, "per_class_f1.png"), dpi=250, bbox_inches="tight")
        plt.close()
    
    # Confusion Matrix
    cm = confusion_matrix(y_test, en_iyi_sonuc['y_pred'])
    # Confusion matrix CSV
    labels_sorted = np.unique(y)
    df_cm = pd.DataFrame(cm, index=labels_sorted, columns=labels_sorted)
    df_cm.to_csv(os.path.join(RESULT_DIR, "confusion_matrix_raw.csv"), encoding="utf-8-sig")
    
    # Confusion Matrix görselleştirme
    plt.figure(figsize=(14, 12))
    cm_normalized = cm.astype('float') / cm.sum(axis=1)[:, np.newaxis]
    
    sns.heatmap(cm_normalized, annot=True, fmt='.2f', cmap='Blues',
                xticklabels=np.unique(y), yticklabels=np.unique(y),
                cbar_kws={'label': 'Oran'})
    plt.title(f'Confusion Matrix (Normalized) - {en_iyi_isim}')
    plt.ylabel('Gerçek Kategori')
    plt.xlabel('Tahmin Edilen Kategori')
    plt.xticks(rotation=45, ha='right')
    plt.yticks(rotation=0)
    plt.tight_layout()
    plt.savefig('confusion_matrix_advanced.png', dpi=300, bbox_inches='tight')
    plt.savefig(os.path.join(RESULT_DIR, "confusion_matrix_normalized.png"), dpi=300, bbox_inches="tight")
    plt.close()
    print("\nConfusion Matrix 'confusion_matrix_advanced.png' olarak kaydedildi.")
    
    # En çok karıştırılan kategoriler
    en_cok_karisik_kategoriler(cm, np.unique(y))
    
    # Feature importance (eğer varsa)
    if hasattr(en_iyi_sonuc['model'], 'feature_importances_'):
        ozellik_onemleri(vectorizer, en_iyi_sonuc['model'], 'feature_importances_', np.unique(y))
    elif hasattr(en_iyi_sonuc['model'], 'coef_'):
        ozellik_onemleri(vectorizer, en_iyi_sonuc['model'], 'coef_', np.unique(y))
    
    return en_iyi_isim, en_iyi_sonuc['model'], vectorizer, en_iyi_sonuc['scaler'], temizleyici, metrik_cikarici


def en_cok_karisik_kategoriler(cm, kategoriler):
    """En çok karıştırılan kategorileri bul"""
    print("\n" + "="*70)
    print("EN ÇOK KARIŞTIRILAN KATEGORİLER")
    print("="*70)
    
    hatalar = []
    for i in range(len(kategoriler)):
        for j in range(len(kategoriler)):
            if i != j and cm[i, j] > 0:
                gercek_kategori = kategoriler[i]
                yanlis_kategori = kategoriler[j]
                hata_sayisi = cm[i, j]
                hatalar.append({
                    'gercek': gercek_kategori,
                    'yanlis': yanlis_kategori,
                    'hata_sayisi': hata_sayisi,
                    'oran': hata_sayisi / cm[i].sum() if cm[i].sum() > 0 else 0
                })
    
    # En çok hata yapılanları sırala
    hatalar_sorted = sorted(hatalar, key=lambda x: x['hata_sayisi'], reverse=True)[:10]
    
    for idx, hata in enumerate(hatalar_sorted, 1):
        print(f"{idx}. {hata['gercek']} → {hata['yanlis']}: {hata['hata_sayisi']} hata (%{hata['oran']*100:.1f})")


def ozellik_onemleri(vectorizer, model, importance_type, kategoriler):
    """En önemli özellikleri (kelimeleri) göster"""
    print("\n" + "="*70)
    print("EN ÖNEMLİ ÖZELLİKLER (TOP 20)")
    print("="*70)
    
    # Feature names
    feature_names = np.array(vectorizer.get_feature_names_out())
    
    # Feature importance al
    if importance_type == 'feature_importances_':
        importances = model.feature_importances_
        # Sadece TF-IDF özelliklerini al (metrikleri hariç tut)
        importances = importances[:len(feature_names)]
    else:  # coef_
        # Coef için her sınıf için ortalama al
        importances = np.abs(model.coef_).mean(axis=0)
        importances = importances[:len(feature_names)]
    
    # En önemli özellikleri sırala
    indices = np.argsort(importances)[::-1][:20]
    
    print("\nEn önemli 20 kelime/özellik:")
    for idx, i in enumerate(indices, 1):
        print(f"{idx:2d}. {feature_names[i]:30s} - Önem: {importances[i]:.4f}")
    
    # CSV olarak kaydet
    df_importance = pd.DataFrame({
        'kelime': feature_names[indices],
        'onem': importances[indices]
    })
    df_importance.to_csv(OZELLIK_ONEM_DOSYASI, index=False, encoding='utf-8-sig')
    print(f"\nÖzellik önemleri '{OZELLIK_ONEM_DOSYASI}' olarak kaydedildi.")

