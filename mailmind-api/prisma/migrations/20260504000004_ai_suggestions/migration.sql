-- AiSuggestion: AI'ın "düşük güvenli" ya da "match yok" durumlarda susmak
-- yerine kullanıcıya soru olarak gösterdiği update önerileri.
-- Önceden EmailAnalyzerService.applyUpdates yalnızca log'a yazıp düşürüyordu.

CREATE TYPE "AiSuggestionKind" AS ENUM ('CANCEL', 'RESCHEDULE');
CREATE TYPE "AiSuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
CREATE TYPE "AiSuggestionDropReason" AS ENUM ('LOW_CONFIDENCE', 'NO_MATCH');

CREATE TABLE "AiSuggestion" (
  "id"              TEXT                       NOT NULL,
  "userId"          TEXT                       NOT NULL,
  "aiAnalysisId"    TEXT                       NOT NULL,
  "kind"            "AiSuggestionKind"         NOT NULL,
  "status"          "AiSuggestionStatus"       NOT NULL DEFAULT 'PENDING',
  "dropReason"      "AiSuggestionDropReason"   NOT NULL,
  "matchedEventId"  TEXT,
  "matchTitle"      TEXT,
  "originalStartAt" TIMESTAMP(3),
  "newStartAt"      TIMESTAMP(3),
  "newEndAt"        TIMESTAMP(3),
  "newLocation"     TEXT,
  "reason"          TEXT,
  "confidence"      DOUBLE PRECISION,
  "createdAt"       TIMESTAMP(3)               NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt"      TIMESTAMP(3),

  CONSTRAINT "AiSuggestion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiSuggestion_userId_status_createdAt_idx"
  ON "AiSuggestion"("userId", "status", "createdAt");
CREATE INDEX "AiSuggestion_aiAnalysisId_idx"
  ON "AiSuggestion"("aiAnalysisId");

ALTER TABLE "AiSuggestion"
  ADD CONSTRAINT "AiSuggestion_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "IamUser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AiSuggestion"
  ADD CONSTRAINT "AiSuggestion_aiAnalysisId_fkey"
  FOREIGN KEY ("aiAnalysisId") REFERENCES "AiAnalysis"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
