"""
Veri yükleme ve temizleme fonksiyonları
"""

import pandas as pd
import numpy as np
import os
from .config import CSV_DOSYASI, MODEL_DIR, LABEL_TO_ID_DOSYASI, ID_TO_LABEL_DOSYASI
from .preprocessing import MetinTemizleyici, MetrikCikarici


def veri_yukle(csv_dosyasi=None):
    """
    CSV dosyasından veriyi yükle ve temizle
    
    Args:
        csv_dosyasi: CSV dosya yolu (varsayılan: config'ten gelir)
        
    Returns:
        tuple: (X, y, X_metrikler, temizleyici, metrik_cikarici)
            X: Temizlenmiş mail metinleri
            y: Kategori etiketleri
            X_metrikler: Ek metrikler
            temizleyici: MetinTemizleyici örneği
            metrik_cikarici: MetrikCikarici örneği
    """
    if csv_dosyasi is None:
        csv_dosyasi = CSV_DOSYASI
    
    print("="*70)
    print("VERİ YÜKLEME VE ÖN İŞLEME")
    print("="*70)
    
    df = pd.read_csv(csv_dosyasi, encoding='utf-8-sig')
    
    print(f"\nToplam kayıt sayısı: {len(df)}")
    print(f"\nKategori dağılımı:")
    print(df['Kategori'].value_counts())
    
    # NaN değerleri temizle
    df = df.dropna(subset=['Kategori', 'Başlık', 'İçerik'])
    
    # Başlık ve İçeriği birleştir (ham metin)
    df['Mail_Metni'] = df['Başlık'].astype(str) + " " + df['İçerik'].astype(str)
    
    # Metni temizle (TF-IDF bunun üzerinden üretilecek)
    temizleyici = MetinTemizleyici(remove_stopwords=True, min_length=3, turkce_lowercase=True)
    df['Mail_Metni_Temiz'] = temizleyici.transform(df['Mail_Metni'].values)
    
    # Boş metinleri çıkar
    df = df[df['Mail_Metni_Temiz'].str.strip() != '']
    df = df[df['Mail_Metni_Temiz'].str.split().str.len() >= 3]  # En az 3 kelime
    
    # X: mail metinleri, y: kategoriler
    X = df['Mail_Metni_Temiz'].values
    y = df['Kategori'].values
    
    # Metrikler (ham metinden çıkarmak daha anlamlı: büyük harf/noktalama vb.)
    metrik_cikarici = MetrikCikarici()
    ham_ikili = list(zip(df['Başlık'].astype(str).values, df['İçerik'].astype(str).values))
    X_metrikler = metrik_cikarici.transform(ham_ikili)
    
    print(f"\nTemizlenmiş veri sayısı: {len(X)}")
    print(f"Kategori sayısı: {len(np.unique(y))}")
    print(f"Metrik özellik sayısı: {X_metrikler.shape[1]}")
    
    # Label encoding
    unique_labels = np.unique(y)
    label_to_id = {label: i for i, label in enumerate(unique_labels)}
    id_to_label = {i: label for label, i in label_to_id.items()}
    
    # Save label mappings (klasörü oluştur)
    os.makedirs(MODEL_DIR, exist_ok=True)
    np.save(LABEL_TO_ID_DOSYASI, label_to_id)
    np.save(ID_TO_LABEL_DOSYASI, id_to_label)
    
    return X, y, X_metrikler, temizleyici, metrik_cikarici

