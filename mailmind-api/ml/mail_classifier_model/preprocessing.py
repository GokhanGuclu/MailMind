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


# ─── Marka / güvenlik / phishing sözlükleri ─────────────────────────────────
# MetrikCikarici bu sözlükleri sayısal feature'lara çevirir; model "Apple/Google
# güvenlik mailini Spam'den ayır" sinyalini metin içinden alır (from alanı yok).

BRAND_DOMAIN_PATTERNS = (
    "apple.com", "icloud.com",
    "google.com", "accounts.google.com", "gmail.com",
    "microsoft.com", "live.com", "outlook.com", "office.com",
    "yahoo.com", "github.com", "amazon.com", "amazon.com.tr",
    "paypal.com", "linkedin.com", "dropbox.com", "slack.com",
    "facebook.com", "instagram.com", "twitter.com", "x.com",
    "garantibbva", "yapikredi", "isbank.com.tr", "akbank",
    "ziraatbank", "denizbank", "qnbfinansbank", "halkbank", "vakifbank",
)

BRAND_NAME_PATTERNS = (
    "apple", "icloud", "google", "gmail", "microsoft", "outlook",
    "yahoo", "github", "amazon", "paypal", "linkedin", "dropbox",
    "slack", "facebook", "instagram",
    "garanti bbva", "yapı kredi", "yapikredi", "iş bankası", "isbank",
    "akbank", "ziraat", "denizbank", "qnb", "halkbank", "vakıfbank",
)

SECURITY_KEYWORDS = (
    # Türkçe
    "hesabınıza giriş", "yeni cihaz", "yeni oturum", "doğrulama kodu",
    "iki adımlı doğrulama", "iki faktörlü", "şifre sıfırlama",
    "parola değişti", "parola sıfırlama", "olağandışı etkinlik",
    "olağandışı giriş", "kimliğinizi doğrulayın", "güvenlik uyarısı",
    "güvenlik bildirimi", "tek seferlik kod", "tek seferlik giriş",
    # İngilizce
    "sign-in", "sign in", "signed in", "verification code", "two-factor",
    "two-step", "password reset", "password changed", "security alert",
    "new device", "unusual activity", "unusual sign-in", "one-time code",
    "one-time password", "otp",
)

PHISHING_SIGNALS = (
    # Türkçe — ödül/kazanç tuzakları
    "kazandınız", "tebrikler kazand", "hediye çeki", "ödül kazand",
    "çekiliş", "büyük ikramiye", "bedava", "ücretsiz hediye",
    # Türkçe — sahte aciliyet
    "acil onayla", "hemen tıkla", "hemen onayla", "hemen doğrula",
    "süre doluyor", "son kez uyarı", "24 saat içinde",
    "hesabınız askıya alın", "hesabınız kapatılacak",
    "hesabınız bloke", "hesabınız sınırlandırıldı",
    "kimliğinizi hemen doğrulayın", "doğrulama yapmazsanız",
    # İngilizce — ödül
    "lottery", "you have won", "claim your prize", "free gift",
    # İngilizce — sahte aciliyet / hesap askıya alma
    "urgent action required", "click here to claim", "act now",
    "verify your account immediately", "verify immediately",
    "verify your identity within", "account suspended",
    "account has been suspended", "account will be closed",
    "account will be permanently", "limited account access",
    "unusual activity detected on your account", "confirm your account now",
    # Para transferi sinyalleri
    "wire transfer", "western union", "bitcoin transfer",
    "send btc to", "money gram",
)


def _count_any(text_lower: str, needles) -> int:
    """text_lower içinde needles'tan kaç tanesinin geçtiğini sayar."""
    return sum(1 for n in needles if n in text_lower)


class MetrikCikarici(BaseEstimator, TransformerMixin):
    """Metinden ek metrikler çıkaran custom transformer.

    Versiyon 2: temel istatistiklere ek olarak marka/güvenlik/phishing
    sinyallerini de feature olarak verir. Bu sayede model gönderen alanını
    görmese bile "Apple sign-in" ile "Apple promo / Apple kazandınız"
    arasındaki farkı yakalayabiliyor.
    """

    # Feature isimleri (debug + introspection için)
    FEATURE_NAMES = (
        "kelime_sayisi",
        "karakter_sayisi",
        "cumle_sayisi",
        "buyuk_harf",
        "unlem_sayisi",
        "soru_sayisi",
        "ort_kelime_uzunlugu",
        "brand_domain_count",
        "brand_name_count",
        "security_kw_count",
        "phishing_kw_count",
        "has_brand",
        "has_security_kw",
        "has_phishing_signal",
    )

    def fit(self, X, y=None):
        return self

    def transform(self, X):
        if isinstance(X, pd.Series):
            X = X.values

        metrikler = []
        for metin in X:
            if isinstance(metin, (list, tuple)):
                baslik = metin[0] if len(metin) > 0 else ''
                icerik = metin[1] if len(metin) > 1 else ''
                metin = f"{baslik} {icerik}"
            else:
                metin = str(metin)

            metin_lower = metin.lower()

            kelime_sayisi = len(metin.split())
            karakter_sayisi = len(metin)
            cumle_sayisi = len(re.split(r'[.!?]+', metin))
            buyuk_harf = sum(1 for c in metin if c.isupper())
            unlem_sayisi = metin.count('!')
            soru_sayisi = metin.count('?')
            ort_kelime_uzunlugu = (
                np.mean([len(k) for k in metin.split()]) if kelime_sayisi > 0 else 0
            )

            # Marka / güvenlik / phishing sinyalleri
            brand_domain_count = _count_any(metin_lower, BRAND_DOMAIN_PATTERNS)
            brand_name_count = _count_any(metin_lower, BRAND_NAME_PATTERNS)
            security_kw_count = _count_any(metin_lower, SECURITY_KEYWORDS)
            phishing_kw_count = _count_any(metin_lower, PHISHING_SIGNALS)
            has_brand = 1 if (brand_domain_count + brand_name_count) > 0 else 0
            has_security_kw = 1 if security_kw_count > 0 else 0
            has_phishing = 1 if phishing_kw_count > 0 else 0

            metrikler.append([
                kelime_sayisi,
                karakter_sayisi,
                cumle_sayisi,
                buyuk_harf,
                unlem_sayisi,
                soru_sayisi,
                ort_kelime_uzunlugu,
                brand_domain_count,
                brand_name_count,
                security_kw_count,
                phishing_kw_count,
                has_brand,
                has_security_kw,
                has_phishing,
            ])

        return np.array(metrikler, dtype=float)

