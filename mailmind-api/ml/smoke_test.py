"""Eğitilen modelin gerçek hayattaki edge case'lerde nasıl tahmin ettiğini gösteren
smoke test. Beklenen kategoriyle karşılaştırma yapar, basit bir özet çıkarır."""
from __future__ import annotations

import sys
import os

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

from mail_classifier_model.predictor import tahmin_yap
from mail_classifier_model.model_manager import model_yukle


CASES = [
    # (beklenen kategori, başlık, içerik)
    # Backend 6 kategoriye sabit: İş/Acil, Kişisel, Bildirim, Güvenlik, Spam, Diğer
    # Hesap güvenlik mailleri → Güvenlik
    ("Güvenlik",
     "Apple ID hesabınıza yeni bir cihazdan giriş yapıldı",
     "Merhaba, Apple ID hesabınıza İstanbul'dan iPhone cihazıyla giriş yapıldı. Bu siz değilseniz appleid.apple.com adresinden hemen şifrenizi değiştirin."),
    ("Güvenlik",
     "Google Hesabınız: yeni oturum açıldı",
     "Yeni bir Windows cihazından Google Hesabınıza giriş yapıldı. Konum: Ankara. Bu siz değilseniz accounts.google.com adresinden cihazları kontrol edin."),
    ("Güvenlik",
     "Microsoft hesabı doğrulama kodunuz: 482910",
     "Microsoft hesabınız için tek seferlik doğrulama kodunuz: 482910. Bu kodu hiç kimseyle paylaşmayın."),
    ("Güvenlik",
     "GitHub: New sign-in to your account",
     "We noticed a new sign-in to your GitHub account from Berlin using a Linux device. If this wasn't you, reset your password at github.com immediately."),
    ("Güvenlik",
     "Garanti BBVA İnternet Şubesi - Yeni cihaz uyarısı",
     "Sayın müşterimiz, Garanti BBVA İnternet Şubesi'ne yeni bir cihazdan giriş yapıldı. İşlemi siz yapmadıysanız 444 0 333'ü arayın."),
    # Phishing → Spam beklenir
    ("Spam",
     "TEBRIKLER! 50.000 TL hediye çeki KAZANDINIZ — hemen tıklayın",
     "Acil onay gerekiyor! Hediye çekinizi almak için linke tıklayın. Bu fırsat 24 saat içinde sona erecek."),
    ("Spam",
     "Apple iCloud: account suspended — verify immediately",
     "Your iCloud account has been suspended. Click here to verify your identity within 24 hours or your account will be permanently closed. Wire transfer required."),
    # Pazarlama → Bildirim
    ("Bildirim",
     "Yeni sezon indirimleri başladı, kaçırmayın!",
     "Mağazamızda yaz koleksiyonu %50'ye varan indirimlerle. Sepetinizdeki ürünleri tamamlayın."),
    # Sosyal medya → Bildirim
    ("Bildirim",
     "Ahmet sizi LinkedIn'de takip etmeye başladı",
     "LinkedIn'de yeni bir takipçiniz var. Profilini görmek için tıklayın."),
    # Abonelik/Fatura → Bildirim
    ("Bildirim",
     "Netflix aboneliğiniz için fatura — 2026 Mayıs",
     "Sayın müşterimiz, Netflix Premium aboneliğiniz için 149,99 TL'lik faturanız hazır."),
    # İş/Acil
    ("İş/Acil",
     "ACİL: Yarınki sunum için son revizyon",
     "Merhaba, yarınki müşteri sunumu için son revizyonu bugün akşam 18:00'a kadar göndermen gerekiyor."),
    # Sağlık → Diğer
    ("Diğer",
     "Randevu hatırlatma: Doktor Yılmaz, yarın 14:00",
     "Sayın hasta, yarın saat 14:00'teki kardiyoloji randevunuzu hatırlatırız."),
]


def main() -> int:
    result = model_yukle()
    if not result or result[0] is None:
        print("Model yüklenemedi"); return 1
    model, vectorizer, scaler, temizleyici, metrik_cikarici = result[0:5]
    id_to_label = result[5] if len(result) > 5 else None
    label_to_id = result[6] if len(result) > 6 else None

    correct = 0
    print(f"{'OK':<3} {'BEKLENEN':<18} {'TAHMİN':<18} {'GÜVEN':<6} BAŞLIK")
    print("-" * 100)
    for expected, subject, body in CASES:
        kategori, olasiliklar = tahmin_yap(
            subject, body,
            model=model, vectorizer=vectorizer, scaler=scaler,
            temizleyici=temizleyici, metrik_cikarici=metrik_cikarici,
        )
        ok = kategori == expected
        correct += int(ok)
        conf = olasiliklar.get(kategori, 0.0) if olasiliklar else 0.0
        marker = "✓ " if ok else "✗ "
        print(f"{marker:<3} {expected:<18} {str(kategori):<18} {conf:<6.3f} {subject[:60]}")

    print("-" * 100)
    print(f"Doğruluk: {correct}/{len(CASES)} ({100*correct/len(CASES):.1f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
