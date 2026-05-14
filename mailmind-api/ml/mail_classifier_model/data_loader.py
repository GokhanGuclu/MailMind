"""
Veri yükleme ve temizleme fonksiyonları
"""

import pandas as pd
import numpy as np
import os
from .config import CSV_DOSYASI, MODEL_DIR, LABEL_TO_ID_DOSYASI, ID_TO_LABEL_DOSYASI
from .preprocessing import MetinTemizleyici, MetrikCikarici


# Dataset'te 10 kategori var ama backend (UpdateCategoryDto.MESSAGE_CATEGORIES)
# kasıtlı 6 kategoriye sabitlenmiş. Eğitim öncesi etiketleri buraya göre
# daraltıyoruz; SQL migration `20260504000003_remap_message_categories_10_to_6`
# da eski kayıtları aynı kurala göre dönüştürüyor — tek doğruluk kaynağı bu sabit.
LABEL_REMAP_10_TO_6 = {
    # Olduğu gibi kalanlar (mapping listede yer alsın diye eksplisit yazıldı)
    "İş/Acil": "İş/Acil",
    "Kişisel": "Kişisel",
    "Spam": "Spam",
    # Daraltmalar
    "Güvenlik/Uyarı": "Güvenlik",
    "Pazarlama": "Bildirim",
    "Sosyal Medya": "Bildirim",
    "Abonelik/Fatura": "Bildirim",
    "Eğitim/Öğretim": "Diğer",
    "Sağlık": "Diğer",
    "Diğer": "Diğer",
}


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
        # Augmented dataset varsa onu tercih et (eğitim için zenginleştirilmiş veri).
        # Yoksa orijinal CSV'ye düş.
        augmented = os.path.join(os.path.dirname(CSV_DOSYASI), "mailler_augmented.csv")
        csv_dosyasi = augmented if os.path.exists(augmented) else CSV_DOSYASI
        print(f"  Veri kaynağı: {os.path.basename(csv_dosyasi)}")
    
    print("="*70)
    print("VERİ YÜKLEME VE ÖN İŞLEME")
    print("="*70)
    
    df = pd.read_csv(csv_dosyasi, encoding='utf-8-sig')

    print(f"\nToplam kayıt sayısı: {len(df)}")
    print(f"\nHam kategori dağılımı (remap öncesi):")
    print(df['Kategori'].value_counts())

    # 10 → 6 remap: backend bu 6 kategoriye sabit. Mapping'de olmayan etiket
    # olursa olduğu gibi bırakıyoruz (yeni etiket eklenirse görünsün diye).
    df['Kategori'] = df['Kategori'].map(lambda k: LABEL_REMAP_10_TO_6.get(str(k).strip(), k))
    print(f"\nRemap sonrası kategori dağılımı (6 sınıf):")
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

