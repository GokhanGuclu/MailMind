"""
Güvenlik/Uyarı sınıfını "hesap güvenlik" mailleriyle (Apple/Google/Microsoft/...)
zenginleştirmek için sentetik örnek üreten + yanlış etiketli Spam satırlarını
Güvenlik/Uyarı'ya taşıyan augmentation script'i.

Çıktı: mailler_augmented.csv (orijinal mailler.csv'ye dokunmaz).

Kullanım:
    python -m mail_classifier_model.augment_security
"""
from __future__ import annotations

import os
import random
import re
from datetime import datetime, timedelta

import pandas as pd

from .config import CSV_DOSYASI
from .preprocessing import (
    BRAND_DOMAIN_PATTERNS as _BRAND_DOMAINS,
    BRAND_NAME_PATTERNS as _BRAND_NAMES,
    SECURITY_KEYWORDS as _SECURITY_KW,
    PHISHING_SIGNALS as _PHISHING_KW,
)

# Augment edilmiş çıktı dosyası — data_loader CSV_DOSYASI override edilerek bunu okuyacak
AUGMENTED_CSV = os.path.join(os.path.dirname(CSV_DOSYASI), "mailler_augmented.csv")

GUVENLIK_LABEL = "Güvenlik/Uyarı"
SPAM_LABEL = "Spam"

# ─── Marka katalogları ────────────────────────────────────────────────────
BRANDS = [
    {"name": "Apple", "domain": "apple.com", "service": "Apple ID", "device_hint": "iPhone"},
    {"name": "Google", "domain": "google.com", "service": "Google Hesabı", "device_hint": "Android"},
    {"name": "Google", "domain": "accounts.google.com", "service": "Google Hesabı", "device_hint": "Chrome"},
    {"name": "Microsoft", "domain": "microsoft.com", "service": "Microsoft hesabı", "device_hint": "Windows"},
    {"name": "Outlook", "domain": "outlook.com", "service": "Outlook", "device_hint": "Edge"},
    {"name": "Yahoo", "domain": "yahoo.com", "service": "Yahoo Hesabı", "device_hint": "Firefox"},
    {"name": "iCloud", "domain": "icloud.com", "service": "iCloud", "device_hint": "Mac"},
    {"name": "GitHub", "domain": "github.com", "service": "GitHub", "device_hint": "Linux"},
    {"name": "Amazon", "domain": "amazon.com", "service": "Amazon hesabı", "device_hint": "Safari"},
    {"name": "PayPal", "domain": "paypal.com", "service": "PayPal", "device_hint": "Chrome"},
    {"name": "LinkedIn", "domain": "linkedin.com", "service": "LinkedIn", "device_hint": "Android"},
    {"name": "Dropbox", "domain": "dropbox.com", "service": "Dropbox", "device_hint": "Windows"},
    {"name": "Slack", "domain": "slack.com", "service": "Slack çalışma alanı", "device_hint": "Mac"},
    {"name": "Garanti BBVA", "domain": "garantibbva.com.tr", "service": "Garanti BBVA İnternet Şubesi", "device_hint": "iPhone"},
    {"name": "Yapı Kredi", "domain": "yapikredi.com.tr", "service": "Yapı Kredi Mobil", "device_hint": "Android"},
    {"name": "İş Bankası", "domain": "isbank.com.tr", "service": "İşCep", "device_hint": "iPhone"},
    {"name": "Akbank", "domain": "akbank.com", "service": "Akbank Mobil", "device_hint": "Android"},
    {"name": "Ziraat Bankası", "domain": "ziraatbank.com.tr", "service": "Ziraat Mobil", "device_hint": "iPhone"},
]

CITIES = ["İstanbul", "Ankara", "İzmir", "Bursa", "Antalya", "Berlin", "London", "New York", "Frankfurt", "Amsterdam"]

# ─── Şablonlar ─────────────────────────────────────────────────────────────
TR_SUBJECTS = [
    "{service} hesabınıza yeni bir cihazdan giriş yapıldı",
    "{brand}: Yeni oturum açma uyarısı",
    "{service} doğrulama kodunuz: {code}",
    "{brand} güvenlik uyarısı: olağandışı etkinlik",
    "{service} şifre sıfırlama isteği",
    "{brand} hesabınızda iki adımlı doğrulama açıldı",
    "{service} - Yeni cihaz eklendi",
    "{brand}: Hesabınıza erişim girişimi",
    "{service} tek seferlik giriş kodunuz",
    "{brand} güvenlik bildirimi: parola değişti",
    "{service} oturumunuz başka bir konumdan açıldı",
    "{brand}: Kimliğinizi doğrulayın",
]

EN_SUBJECTS = [
    "New sign-in to your {service}",
    "{brand}: Security alert for your account",
    "Your {service} verification code is {code}",
    "{brand} sign-in attempt from a new device",
    "Password reset requested for your {service}",
    "{brand}: Two-factor authentication enabled",
    "{service} – New device added",
    "Verify it's you: {brand} account",
    "{service} one-time login code",
    "{brand} security notification: password changed",
    "Your {service} was accessed from a new location",
    "{brand}: Confirm recent activity",
]

TR_BODIES = [
    "Merhaba,\n\n{service} hesabınıza {city}'dan {device} cihazıyla {time} tarihinde giriş yapıldı. Bu işlemi siz yaptıysanız bu e-postayı yok sayabilirsiniz. Aksi takdirde {domain} üzerinden hemen şifrenizi değiştirin.\n\nİyi günler,\n{brand} Güvenlik Ekibi",
    "Sayın kullanıcı,\n\n{service} hesabınız için bir doğrulama kodu istendi. Kodunuz: {code}\n\nKodu kimseyle paylaşmayın. Bu işlemi siz başlatmadıysanız {domain} adresinden hesabınızı güvene alın.",
    "{brand}: {service} hesabınızda olağandışı bir oturum açma denemesi tespit edildi. Konum: {city}. Tarayıcı: {device}.\n\nSiz değilseniz lütfen şifrenizi sıfırlayın.",
    "Merhaba,\n\n{service} hesabınızın şifresi az önce sıfırlandı. Bu işlemi siz yaptıysanız ek bir adım gerekmez. Yapmadıysanız {domain} üzerinden hesabınıza girip yeni bir şifre belirleyin.",
    "{service} hesabınıza yeni bir cihaz eklendi:\n- Cihaz: {device}\n- Konum: {city}\n- Tarih: {time}\n\nTanımadığınız bir cihazsa hemen oturumu kapatın ve şifrenizi değiştirin.",
    "Tek seferlik giriş kodunuz: {code}\nBu kod 10 dakika içinde geçersiz olacaktır. Kodu hiç kimseyle paylaşmayın.\n\n{brand} ekibi.",
    "Hesabınıza iki adımlı doğrulama eklendi. Artık {service} hesabınıza her giriş için bir doğrulama kodu istenecek. Bu adımı siz atmadıysanız {domain} adresinden ayarlarınızı kontrol edin.",
    "Merhaba,\n\n{service} hesabınızın parolası başarıyla değiştirildi. Eğer bu değişikliği siz yapmadıysanız hesabınızı geri almak için {domain} adresinden parola sıfırlama akışını kullanın.",
]

EN_BODIES = [
    "Hi,\n\nWe noticed a new sign-in to your {service} from {city} using {device} on {time}. If this was you, you can ignore this email. If not, please change your password at {domain} immediately.\n\nThanks,\nThe {brand} team",
    "Your {service} verification code is: {code}\n\nDon't share this code with anyone. If you didn't request it, secure your account at {domain}.",
    "{brand} detected an unusual sign-in attempt to your {service}. Location: {city}. Browser: {device}.\n\nIf this wasn't you, please reset your password.",
    "The password for your {service} was just reset. If you did this, no further action is needed. If you didn't, recover your account at {domain}.",
    "A new device was added to your {service}:\n- Device: {device}\n- Location: {city}\n- Time: {time}\n\nIf this device is unfamiliar, sign out and change your password.",
    "Your one-time sign-in code is: {code}\nThis code expires in 10 minutes. Never share it with anyone.\n\n{brand} team.",
    "Two-step verification was enabled on your {service}. From now on you'll be asked for a verification code on every sign-in. If this wasn't you, review your settings at {domain}.",
    "Hi,\n\nThe password for your {service} has been changed. If you didn't make this change, recover your account at {domain}.",
]


def _random_time(rng: random.Random) -> str:
    base = datetime(2026, 1, 1)
    delta = timedelta(days=rng.randint(0, 120), hours=rng.randint(0, 23), minutes=rng.randint(0, 59))
    return (base + delta).strftime("%d.%m.%Y %H:%M")


def _gen_code(rng: random.Random) -> str:
    return f"{rng.randint(100000, 999999)}"


def generate_synthetic(n_per_lang: int = 110, seed: int = 42) -> list[dict]:
    """Türkçe ve İngilizce için n_per_lang adet sentetik 'hesap güvenlik' maili üret."""
    rng = random.Random(seed)
    out: list[dict] = []
    today = datetime(2026, 5, 10).strftime("%Y-%m-%d %H:%M:%S")

    for lang_subjects, lang_bodies in [(TR_SUBJECTS, TR_BODIES), (EN_SUBJECTS, EN_BODIES)]:
        for _ in range(n_per_lang):
            brand = rng.choice(BRANDS)
            ctx = {
                "brand": brand["name"],
                "service": brand["service"],
                "domain": brand["domain"],
                "device": brand["device_hint"],
                "city": rng.choice(CITIES),
                "time": _random_time(rng),
                "code": _gen_code(rng),
            }
            subject = rng.choice(lang_subjects).format(**ctx)
            body = rng.choice(lang_bodies).format(**ctx)
            out.append({
                "Kategori": GUVENLIK_LABEL,
                "Başlık": subject,
                "İçerik": body,
                "Tarih": today,
            })
    return out


# ─── Mislabeled Spam → Güvenlik/Uyarı taşıma ──────────────────────────────
# Tek kaynak: preprocessing.py. İki yerde duplicate listede tutmamak için.
BRAND_DOMAIN_PATTERNS = list(_BRAND_DOMAINS)
SECURITY_KEYWORDS = list(_SECURITY_KW)
PHISHING_SIGNALS = list(_PHISHING_KW)


def _has_any(text: str, needles: list[str]) -> bool:
    text = text.lower()
    return any(n.lower() in text for n in needles)


def relabel_misflagged_spam(df: pd.DataFrame) -> tuple[pd.DataFrame, int]:
    """Spam etiketli ama gerçekte 'hesap güvenlik' olduğu anlaşılan satırları
    Güvenlik/Uyarı'ya taşı. Phishing sinyali varsa Spam'de bırak."""
    moved = 0
    new_labels = df["Kategori"].astype(str).copy()
    for idx, row in df.iterrows():
        if str(row["Kategori"]).strip() != SPAM_LABEL:
            continue
        text = f"{row.get('Başlık', '')} {row.get('İçerik', '')}"
        if not (_has_any(text, BRAND_DOMAIN_PATTERNS) or _has_any(text, [b["name"] for b in BRANDS])):
            continue
        if not _has_any(text, SECURITY_KEYWORDS):
            continue
        if _has_any(text, PHISHING_SIGNALS):
            # Phishing kalıbı var → Spam'de kalsın
            continue
        new_labels.at[idx] = GUVENLIK_LABEL
        moved += 1
    df = df.copy()
    df["Kategori"] = new_labels
    return df, moved


# ─── Ana ──────────────────────────────────────────────────────────────────
def main() -> None:
    print(f"Orijinal CSV okunuyor: {CSV_DOSYASI}")
    df = pd.read_csv(CSV_DOSYASI, encoding="utf-8-sig")
    print(f"  Satır: {len(df)}, kategori: {df['Kategori'].nunique()}")
    print("\nBaşlangıç kategori dağılımı:")
    print(df["Kategori"].value_counts())

    # 1) Mislabeled Spam → Güvenlik/Uyarı
    df, moved = relabel_misflagged_spam(df)
    print(f"\n[Relabel] Spam → {GUVENLIK_LABEL}: {moved} satır")

    # 2) Sentetik örnekler ekle
    synth = generate_synthetic(n_per_lang=110, seed=42)
    print(f"[Synthetic] +{len(synth)} satır {GUVENLIK_LABEL} eklendi")
    df_synth = pd.DataFrame(synth)
    df_out = pd.concat([df, df_synth], ignore_index=True)

    print("\nSon kategori dağılımı:")
    print(df_out["Kategori"].value_counts())

    df_out.to_csv(AUGMENTED_CSV, index=False, encoding="utf-8-sig")
    print(f"\n✓ Yazıldı: {AUGMENTED_CSV}  (toplam {len(df_out)} satır)")


if __name__ == "__main__":
    main()
