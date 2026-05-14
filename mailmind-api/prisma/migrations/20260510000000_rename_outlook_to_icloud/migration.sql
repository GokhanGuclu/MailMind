-- Rename MailProvider enum value: OUTLOOK -> ICLOUD
-- Outlook IMAP/SMTP serverleri stabil değil; iCloud (IMAP + app-specific
-- password) çoklu hesap için Outlook yerine konumlandırılıyor.
--
-- Production'da bu enum değerini fiilen kullanan satır olmadığından
-- ALTER TYPE ... RENAME VALUE yeterli; data migration gerekmez.

ALTER TYPE "MailProvider" RENAME VALUE 'OUTLOOK' TO 'ICLOUD';
