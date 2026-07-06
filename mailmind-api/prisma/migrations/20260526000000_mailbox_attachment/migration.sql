-- Gelen mail ekleri için yeni tablo.
-- text/calendar (.ics) ekleri burada DEĞİL, MailboxMessage.icsRaw alanında
-- saklanmaya devam eder.

CREATE TABLE "MailboxAttachment" (
    "id" TEXT NOT NULL,
    "mailboxMessageId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "contentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailboxAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MailboxAttachment_mailboxMessageId_idx"
    ON "MailboxAttachment"("mailboxMessageId");

ALTER TABLE "MailboxAttachment"
    ADD CONSTRAINT "MailboxAttachment_mailboxMessageId_fkey"
    FOREIGN KEY ("mailboxMessageId") REFERENCES "MailboxMessage"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
