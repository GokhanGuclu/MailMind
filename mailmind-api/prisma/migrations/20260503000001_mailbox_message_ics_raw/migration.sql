-- ICS (RFC 5545) ekli mailler için raw VCALENDAR içeriği. Outlook calendar
-- invite gibi mailler için AI yerine deterministik parse uygulanacak.
ALTER TABLE "MailboxMessage" ADD COLUMN "icsRaw" TEXT;
