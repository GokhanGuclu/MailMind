-- G6: AI çıkarımı her aksiyon için confidence (0..1) üretir; düşükse UI uyarır.
-- ICS-sourced (deterministik) event'ler için 1.0; manuel kayıtlar için NULL.
ALTER TABLE "Task"          ADD COLUMN "confidence" DOUBLE PRECISION;
ALTER TABLE "CalendarEvent" ADD COLUMN "confidence" DOUBLE PRECISION;
ALTER TABLE "Reminder"      ADD COLUMN "confidence" DOUBLE PRECISION;
