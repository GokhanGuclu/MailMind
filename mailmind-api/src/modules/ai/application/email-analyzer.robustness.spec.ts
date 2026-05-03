/**
 * Robustness davranışı (retry/backoff + stuck-job recovery) için odaklı testler.
 * Sadece hata yolunu test eder; persist/RRULE yolu email-analyzer'ın diğer
 * çağrılarında kapsanır.
 */
import { EmailAnalyzerService, MAX_ATTEMPTS } from './email-analyzer.service';
import { RecurrenceDetectorService } from './recurrence-detector.service';

describe('EmailAnalyzerService — robustness', () => {
  let aiAnalysis: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  let provider: { analyzeEmail: jest.Mock; modelName: string };
  let svc: EmailAnalyzerService;

  beforeEach(() => {
    aiAnalysis = {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    };
    provider = { analyzeEmail: jest.fn(), modelName: 'test-model' };
    const prisma = { aiAnalysis } as any;
    const eventMatcher = { findMatch: jest.fn().mockResolvedValue(null) } as any;
    svc = new EmailAnalyzerService(prisma, provider as any, new RecurrenceDetectorService(), eventMatcher);
  });

  // ─── handleFailure (private; via process) ──────────────────────────────

  describe('process() failure path', () => {
    function setupAnalysisExists(currentAttempt: number) {
      aiAnalysis.updateMany.mockResolvedValue({ count: 1 }); // PENDING→PROCESSING claim
      aiAnalysis.findUnique
        .mockResolvedValueOnce({
          id: 'a1',
          userId: 'u1',
          mailboxMessageId: 'm1',
          user: { timezone: 'Europe/Istanbul' },
          message: {
            folder: 'INBOX',
            subject: 's',
            from: 'f',
            date: new Date('2026-04-25T08:00:00Z'),
            bodyText: 'b',
            snippet: 'b',
          },
        })
        .mockResolvedValueOnce({ attemptCount: currentAttempt });
    }

    it('first failure (attempt=0 → 1) → PENDING + nextRetryAt set + lockedAt cleared', async () => {
      setupAnalysisExists(0);
      provider.analyzeEmail.mockRejectedValue(new Error('llm transient'));

      await svc.process('a1');

      const updates = aiAnalysis.update.mock.calls.map((c) => c[0].data);
      expect(updates.length).toBe(1);
      expect(updates[0]).toMatchObject({
        status: 'PENDING',
        attemptCount: 1,
        lockedAt: null,
      });
      expect(updates[0].nextRetryAt).toBeInstanceOf(Date);
      expect(updates[0].errorMessage).toContain('llm transient');
    });

    it('second failure (attempt=1 → 2) → still retried with longer backoff', async () => {
      setupAnalysisExists(1);
      provider.analyzeEmail.mockRejectedValue(new Error('still down'));

      const before = Date.now();
      await svc.process('a1');
      const data = aiAnalysis.update.mock.calls[0][0].data;
      const backoffMs = (data.nextRetryAt as Date).getTime() - before;

      expect(data.status).toBe('PENDING');
      expect(data.attemptCount).toBe(2);
      // 2. denemenin backoff'u 2dk = 120s; ilk denemenin 30s'inden büyük olmalı.
      expect(backoffMs).toBeGreaterThan(60_000);
    });

    it(`final failure (attempt=${MAX_ATTEMPTS - 1} → ${MAX_ATTEMPTS}) → terminal FAILED`, async () => {
      setupAnalysisExists(MAX_ATTEMPTS - 1);
      provider.analyzeEmail.mockRejectedValue(new Error('giving up'));

      await svc.process('a1');

      const data = aiAnalysis.update.mock.calls[0][0].data;
      expect(data.status).toBe('FAILED');
      expect(data.attemptCount).toBe(MAX_ATTEMPTS);
      expect(data.lockedAt).toBeNull();
      expect(data.nextRetryAt).toBeUndefined();
    });

    it('claim guard: if updateMany count !== 1 (already taken), early-return without provider call', async () => {
      aiAnalysis.updateMany.mockResolvedValue({ count: 0 });

      await svc.process('a1');

      expect(provider.analyzeEmail).not.toHaveBeenCalled();
      expect(aiAnalysis.update).not.toHaveBeenCalled();
    });
  });

  // ─── recoverStuck ──────────────────────────────────────────────────────

  describe('recoverStuck()', () => {
    const NOW = new Date('2026-04-29T12:00:00Z');

    it('returns 0 and does nothing when no stuck records', async () => {
      aiAnalysis.findMany.mockResolvedValue([]);
      const n = await svc.recoverStuck(NOW);
      expect(n).toBe(0);
      expect(aiAnalysis.update).not.toHaveBeenCalled();
    });

    it('queries for PROCESSING with lockedAt < now-staleMs', async () => {
      aiAnalysis.findMany.mockResolvedValue([]);
      await svc.recoverStuck(NOW, 5 * 60_000);
      const where = aiAnalysis.findMany.mock.calls[0][0].where;
      expect(where.status).toBe('PROCESSING');
      const threshold = where.lockedAt.lt as Date;
      expect(NOW.getTime() - threshold.getTime()).toBe(5 * 60_000);
    });

    it('stuck below MAX → PENDING with bumped attempt + scheduled retry', async () => {
      aiAnalysis.findMany.mockResolvedValue([
        { id: 's1', attemptCount: 0 },
      ]);

      await svc.recoverStuck(NOW);

      const data = aiAnalysis.update.mock.calls[0][0].data;
      expect(data.status).toBe('PENDING');
      expect(data.attemptCount).toBe(1);
      expect(data.lockedAt).toBeNull();
      expect(data.nextRetryAt).toBeInstanceOf(Date);
    });

    it(`stuck at attempt=${MAX_ATTEMPTS - 1} → terminal FAILED on recovery (no infinite loop)`, async () => {
      aiAnalysis.findMany.mockResolvedValue([
        { id: 's1', attemptCount: MAX_ATTEMPTS - 1 },
      ]);

      await svc.recoverStuck(NOW);

      const data = aiAnalysis.update.mock.calls[0][0].data;
      expect(data.status).toBe('FAILED');
      expect(data.attemptCount).toBe(MAX_ATTEMPTS);
      expect(data.errorMessage).toMatch(/stuck/i);
    });

    it('processes a batch (multiple stuck records)', async () => {
      aiAnalysis.findMany.mockResolvedValue([
        { id: 's1', attemptCount: 0 },
        { id: 's2', attemptCount: 1 },
      ]);

      const n = await svc.recoverStuck(NOW);

      expect(n).toBe(2);
      expect(aiAnalysis.update).toHaveBeenCalledTimes(2);
    });
  });
});
