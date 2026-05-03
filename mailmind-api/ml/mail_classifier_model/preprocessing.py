"""
Ön işleme sınıfları: MetinTemizleyici ve MetrikCikarici
"""

import pandas as pd
import numpy as np
import re
import unicodedata
from sklearn.base import BaseEstimator, TransformerMixin

from .config import TURKCE_STOPWORDS


class MetinTemizleyici(BaseEstimator, TransformerMixin):
    """Metni temizleyen ve normalize eden custom transformer"""
    
    def __init__(self, remove_stopwords=True, min_length=3, turkce_lowercase=True):
        self.remove_stopwords = remove_stopwords
        self.min_length = min_length
        self.turkce_lowercase = turkce_lowercase
    
    def fit(self, X, y=None):
        return self
    
    def transform(self, X):
        if isinstance(X, pd.Series):
            X = X.values
        
        cleaned = []
        for metin in X:
            cleaned.append(self._temizle(metin))
        
        return np.array(cleaned)
    
    def _temizle(self, metin):
        """Metni temizle ve normalize et"""
        if pd.isna(metin):
            return ""
        
        metin = str(metin)
        # Unicode normalize (kombinasyon karakterlerini sadeleştirmek için)
        metin = unicodedata.normalize("NFKC", metin)
        
        # Küçük harfe çevir (Türkçe I/İ uyumlu)
        if self.turkce_lowercase:
            metin = metin.replace("İ", "i").replace("I", "ı").lower()
            # Bazı ortamlarda "İ" -> "i̇" (i + combining dot) kalabilir, düzelt
            metin = metin.replace("i̇", "i")
        else:
            metin = metin.lower()
        
        # URL'leri kaldır
        metin = re.sub(r'http[s]?://(?:[a-zA-Z]|[0-9]|[$-_@.&+]|[!*\\(\\),]|(?:%[0-9a-fA-F][0-9a-fA-F]))+', ' ', metin)
        
        # E-posta adreslerini kaldır
        metin = re.sub(r'\S+@\S+', ' ', metin)
        
        # Sayıları kaldır (telefon, sipariş no vs.)
        metin = re.sub(r'\d+', ' ', metin)
        
        # Özel karakterleri temizle (Türkçe karakterler hariç)
        metin = re.sub(r'[^\w\sçğıöşüÇĞIİÖŞÜ]', ' ', metin)
        # Altçizgi (underscore) çoğu zaman gürültü; boşluk yap
        metin = metin.replace("_", " ")
        
        # Tekrar eden boşlukları temizle
        metin = re.sub(r'\s+', ' ', metin)
        
        # Stopwords kaldır
        if self.remove_stopwords:
            kelimeler = metin.split()
            kelimeler = [k for k in kelimeler if k not in TURKCE_STOPWORDS and len(k) >= self.min_length]
            metin = ' '.join(kelimeler)
        
        return metin.strip()


class MetrikCikarici(BaseEstimator, TransformerMixin):
    """Metinden ek metrikler çıkaran custom transformer"""
    
    def fit(self, X, y=None):
        return self
    
    def transform(self, X):
        if isinstance(X, pd.Series):
            X = X.values
        
        metrikler = []
        for metin in X:
            if isinstance(metin, (list, tuple)):
                baslik, icerik = metin[0], metin[1] if len(metin) > 1 else ''
                metin = f"{baslik} {icerik}"
            else:
                metin = str(metin)
            
            # Kelime sayısı
            kelime_sayisi = len(metin.split())
            
            # Karakter sayısı
            karakter_sayisi = len(metin)
            
            # Cümle sayısı (basit tahmin)
            cumle_sayisi = len(re.split(r'[.!?]+', metin))
            
            # Büyük harf sayısı
            buyuk_harf = sum(1 for c in metin if c.isupper())
            
            # Ünlem ve soru işareti sayısı
            unlem_sayisi = metin.count('!')
            soru_sayisi = metin.count('?')
            
            # Ortalama kelime uzunluğu
            ort_kelime_uzunlugu = np.mean([len(k) for k in metin.split()]) if kelime_sayisi > 0 else 0
            
            metrikler.append([
                kelime_sayisi,
                karakter_sayisi,
                cumle_sayisi,
                buyuk_harf,
                unlem_sayisi,
                soru_sayisi,
                ort_kelime_uzunlugu
            ])
        
        return np.array(metrikler)

