-- 10 sınıflık eski sınıflandırıcı etiketlerini 6 sınıflık yeni etiketlere remap et.
-- Mantık: data_loader.LABEL_REMAP_10_TO_6 ile birebir aynıdır. Yeni model
-- artık bu etiketleri üretiyor; eski mailler de UI'da tutarlı görünsün diye
-- tek seferlik geri-doldurma yapıyoruz.
--
-- Idempotent: eski etiket kalmadıysa hiçbir satır etkilenmez. Yeni etiketler
-- (zaten 6 sınıflık olan kayıtlar) dokunulmaz.

UPDATE "MailboxMessage" SET "category" = 'Güvenlik' WHERE "category" = 'Güvenlik/Uyarı';
UPDATE "MailboxMessage" SET "category" = 'Bildirim' WHERE "category" IN ('Pazarlama', 'Sosyal Medya', 'Abonelik/Fatura');
UPDATE "MailboxMessage" SET "category" = 'Diğer'    WHERE "category" IN ('Eğitim/Öğretim', 'Sağlık');
