-- MailboxMessage: classifier (Linear SVM) çıktısı için kategori + güven skoru.
ALTER TABLE "MailboxMessage" ADD COLUMN "category" TEXT;
ALTER TABLE "MailboxMessage" ADD COLUMN "categoryConfidence" DOUBLE PRECISION;

CREATE INDEX "MailboxMessage_mailboxAccountId_category_idx"
  ON "MailboxMessage"("mailboxAccountId", "category");
