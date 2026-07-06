-- Postgres native full-text search.
--
-- Generated tsvector kolonu (Postgres 12+): subject/from/to/snippet/bodyText
-- alanları üstünden ağırlıklı index. Trigger gerekmiyor; insert/update'te
-- otomatik hesaplanıyor.
--
-- 'simple' config: lowercase + delimitasyon, dile özel stemmer yok.
-- Türkçe için ideal değil ama vanilla Postgres'te Türkçe stemmer yok;
-- 'simple' güvenli ortak payda (kullanıcı "fatura" yazınca "Fatura"
-- ve "FATURA" bulunur; "faturalar" bulmaz — diacritic insensitive
-- olmadığından "fatura" → "fâtura" eşleşmez, ama bizim use case için kabul
-- edilebilir).
--
-- Ağırlıklar: A (subject) > B (from/to) > C (snippet) > D (bodyText).
-- ts_rank zorlandığında subject match'i body match'inden öne çıkar.

ALTER TABLE "MailboxMessage" ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("subject", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("from", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("to", '')), 'B') ||
    setweight(to_tsvector('simple', coalesce("snippet", '')), 'C') ||
    setweight(to_tsvector('simple', coalesce("bodyText", '')), 'D')
  ) STORED;

CREATE INDEX "MailboxMessage_searchVector_idx"
  ON "MailboxMessage" USING GIN ("searchVector");
