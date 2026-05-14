"""
Eğitim runner'ı.

Akış:
  1) (opsiyonel) augment_security ile mailler_augmented.csv üret
  2) veri_yukle → temizleme + metrik çıkarımı
  3) model_karsilastir → NB / LR / Linear SVM / XGBoost karşılaştır
  4) En iyi modeli kaydet (model_kaydet)

Kullanım:
    python -m mail_classifier_model.train              # augmented varsa kullanır
    python -m mail_classifier_model.train --augment    # önce augmentation çalıştır
    python -m mail_classifier_model.train --raw        # orijinal mailler.csv ile eğit
"""
from __future__ import annotations

import argparse
import os
import sys

from .config import CSV_DOSYASI
from .data_loader import veri_yukle
from .model_trainer import model_karsilastir
from .model_manager import model_kaydet


def main() -> int:
    parser = argparse.ArgumentParser(description="MailMind sınıflandırıcı eğitim runner'ı")
    parser.add_argument("--augment", action="store_true",
                        help="Eğitimden önce augment_security'yi çalıştır")
    parser.add_argument("--raw", action="store_true",
                        help="mailler_augmented.csv'yi yok say, orijinal mailler.csv ile eğit")
    args = parser.parse_args()

    if args.augment:
        from .augment_security import main as augment_main
        print(">>> Augmentation çalıştırılıyor...")
        augment_main()
        print()

    csv_path = None
    if args.raw:
        csv_path = CSV_DOSYASI
        print(f">>> --raw modu: {csv_path}")

    X, y, X_metrikler, temizleyici, metrik_cikarici = veri_yukle(csv_dosyasi=csv_path)

    en_iyi_isim, model, vectorizer, scaler, temizleyici, metrik_cikarici = model_karsilastir(
        X, y, X_metrikler, temizleyici, metrik_cikarici
    )

    model_kaydet(model, vectorizer, scaler, temizleyici, metrik_cikarici)
    print(f"\n✓ Eğitim tamamlandı. En iyi model: {en_iyi_isim}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
