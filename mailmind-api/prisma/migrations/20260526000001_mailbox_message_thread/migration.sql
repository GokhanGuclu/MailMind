-- Konuşma (thread) gruplaması için header ve thread anahtarı kolonları.
-- Mevcut kayıtlar için backfill yapılmaz; bir sonraki sync'te gelen mailler
-- doldurulur. Eski mailler `threadId = NULL` kalır ve list'te tekil görünür.

ALTER TABLE "MailboxMessage"
    ADD COLUMN "inReplyTo" TEXT,
    ADD COLUMN "references" TEXT,
    ADD COLUMN "threadId" TEXT;

CREATE INDEX "MailboxMessage_mailboxAccountId_threadId_date_idx"
    ON "MailboxMessage"("mailboxAccountId", "threadId", "date");
