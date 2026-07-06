"""Inference ve training arasında paylaşılan metin yardımcıları.
Bu modül pandas/datasets/sklearn'e bağımlı DEĞİL — predictor sadece bunu
import ederek minimal inference bağımlılığıyla çalışır."""

from __future__ import annotations

import re

_HTML_RE = re.compile(r"<[^>]+>")
# URL'leri yakala — Apple/Google tracking link'leri 200-500 karakter olabilir
# ve modeli "Spam" yönüne çekiyor (eğitim verisinde URL pratik olarak yoktu).
# Bunları [LINK] placeholder'ıyla değiştir → model URL noise'a takılmaz.
_URL_RE = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
# Uzun base64/şifreli token'lar (40+ karakter alfanumerik + /=+%) — CDN/track
# parametreleri. URL'den ayrı kalmış olsalar bile ezilsin.
_LONG_TOKEN_RE = re.compile(r"[A-Za-z0-9/+=%]{40,}")
# E-posta adresleri → [EMAIL]. Modelin spesifik adrese odaklanmasını engeller.
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_WS_RE = re.compile(r"\s+")


def hafif_temizle(metin: str) -> str:
    """HTML etiketleri sökülür, URL/e-posta/uzun token'lar placeholder'a çevrilir,
    fazla boşluklar sıkıştırılır. Noktalama, sayı, büyük/küçük harf KORUNUR."""
    if not isinstance(metin, str):
        return ""
    metin = _HTML_RE.sub(" ", metin)
    metin = _URL_RE.sub(" [LINK] ", metin)
    metin = _EMAIL_RE.sub(" [EMAIL] ", metin)
    metin = _LONG_TOKEN_RE.sub(" [TOKEN] ", metin)
    metin = _WS_RE.sub(" ", metin).strip()
    return metin


def mail_metni_olustur(baslik: str, icerik: str) -> str:
    """Konu ve gövdeyi ayırt edilebilir biçimde birleştirir.
    Modelin konu satırının önemini öğrenmesini kolaylaştırır."""
    return f"[KONU] {hafif_temizle(baslik)} [GÖVDE] {hafif_temizle(icerik)}"
