-- RFC 5322 Cc/Bcc alıcıları. Reply-all'ın doğru çalışması için Cc şart.
-- Bcc sadece kullanıcının kendi gönderdiği mailler için anlamlı (SENT
-- klasöründen senkron); gelen kutusunda her zaman null kalır.

ALTER TABLE "MailboxMessage"
    ADD COLUMN "cc" TEXT,
    ADD COLUMN "bcc" TEXT;
