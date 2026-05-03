/**
 * persist() içindeki "geçmiş aksiyonu drop et" filtreleri için odaklı testler.
 *
 * Senaryo: AI eski mailleri analiz edebilir; o mailde geçen tarih artık
 * geçmişte ise kullanıcı için anlamsız → kayıt oluşturma.
 *
 * Kapsam:
 * - calendarEvents: rrule yoksa startAt < now → skip
 * - calendarEvents: rrule varsa startAt geçmişte olsa da kabul (recurring tekrarlanır)
 * - tasks: dueAt yoksa kabul (genel iş)
 * - tasks: dueAt < now → skip
 * - reminders one-shot: fireAt < now → skip
 * - reminders recurring: nextFireAt now sonrası hesaplanır (dtstart geçmişte
 *   olsa bile)
 */
import { EmailAnalyzerService } from './email-analyzer.service';
import { RecurrenceDetectorService } from './recurrence-detector.service';
import type { AnalysisResult } from '../domain/value-objects/analysis-result.vo';

describe('EmailAnalyzerService.persist — past-action filter', () => {
  let aiAnalysis: { findUnique: jest.Mock; updateMany: jest.Mock; update: jest.Mock };
  let task: { create: jest.Mock };
  let calendarEvent: { create: jest.Mock };
  let reminder: { create: jest.Mock };
  let provider: { analyzeEmail: jest.Mock; modelName: string };
  let svc: EmailAnalyzerService;
  let prisma: any;
  const NOW = new Date('2026-05-08T10:00:00Z');

  // Helper: message that's INBOX so analyzer doesn't markSkipped
  const fakeMessage = {
    id: 'a1',
    userId: 'u1',
    mailboxMessageId: 'm1',
    user: { timezone: 'Europe/Istanbul' },
    message: {
      folder: 'INBOX',
      subject: 's',
      from: 'f',
      date: new Date('2026-04-27T08:00:00Z'),
      bodyText: 'b',
      snippet: 'b',
    },
  };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);

    aiAnalysis = {
      findUnique: jest.fn().mockImplementation(async ({ select }) => {
        if (select?.attemptCount) return { attemptCount: 0 };
        return fakeMessage;
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    };
    task = { create: jest.fn().mockResolvedValue({}) };
    calendarEvent = { create: jest.fn().mockResolvedValue({}) };
    reminder = { create: jest.fn().mockResolvedValue({}) };

    prisma = {
      aiAnalysis,
      $transaction: jest.fn(async (cb: any) =>
        cb({
          aiAnalysis: { update: aiAnalysis.update },
          task,
          calendarEvent,
          reminder,
        }),
      ),
    };

    provider = { analyzeEmail: jest.fn(), modelName: 'test-model' };
    const eventMatcher = { findMatch: jest.fn().mockResolvedValue(null) } as any;
    svc = new EmailAnalyzerService(prisma, provider as any, new RecurrenceDetectorService(), eventMatcher);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function setLlmResult(result: Partial<AnalysisResult>) {
    provider.analyzeEmail.mockResolvedValue({
      result: {
        summary: 's',
        tasks: [],
        calendarEvents: [],
        reminders: [],
        updates: [],
        ...result,
      },
      inputTokens: 100,
      outputTokens: 50,
      latencyMs: 1234,
    });
  }

  describe('CalendarEvent filter', () => {
    it('drops one-shot event in the past (startAt < now, no rrule)', async () => {
      setLlmResult({
        calendarEvents: [
          {
            title: 'Past meeting',
            startAt: new Date('2026-05-05T09:00:00Z'), // 3 gün önce
          } as any,
        ],
      });

      await svc.process('a1');

      expect(calendarEvent.create).not.toHaveBeenCalled();
    });

    it('keeps future event', async () => {
      setLlmResult({
        calendarEvents: [
          {
            title: 'Future meeting',
            startAt: new Date('2026-05-15T09:00:00Z'), // 1 hafta sonra
          } as any,
        ],
      });

      await svc.process('a1');

      expect(calendarEvent.create).toHaveBeenCalledTimes(1);
      const data = calendarEvent.create.mock.calls[0][0].data;
      expect(data.title).toBe('Future meeting');
    });

    it('keeps recurring event even when startAt is in the past', async () => {
      // Tekrarlayan haftalık standup, ilk dtstart geçen hafta — yine de
      // gelecekteki occurrence'lar için anlamlı.
      setLlmResult({
        calendarEvents: [
          {
            title: 'Weekly standup',
            startAt: new Date('2026-05-04T09:00:00Z'), // 4 gün önce (Pzt)
            rrule: 'FREQ=WEEKLY;BYDAY=MO',
          } as any,
        ],
      });

      await svc.process('a1');

      expect(calendarEvent.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('Task filter', () => {
    it('keeps task with no dueAt (general action item)', async () => {
      setLlmResult({
        tasks: [{ title: 'Read docs', priority: 'MEDIUM' } as any],
      });

      await svc.process('a1');

      expect(task.create).toHaveBeenCalledTimes(1);
    });

    it('drops task with dueAt in the past', async () => {
      setLlmResult({
        tasks: [
          {
            title: 'Send report',
            dueAt: new Date('2026-05-01T17:00:00Z'), // 1 hafta önce
            priority: 'HIGH',
          } as any,
        ],
      });

      await svc.process('a1');

      expect(task.create).not.toHaveBeenCalled();
    });

    it('keeps task with future dueAt', async () => {
      setLlmResult({
        tasks: [
          {
            title: 'Send report',
            dueAt: new Date('2026-05-15T17:00:00Z'),
            priority: 'HIGH',
          } as any,
        ],
      });

      await svc.process('a1');

      expect(task.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('Reminder filter', () => {
    it('drops one-shot reminder with past fireAt', async () => {
      setLlmResult({
        reminders: [
          {
            title: 'Past reminder',
            fireAt: new Date('2026-05-05T09:00:00Z'),
          } as any,
        ],
      });

      await svc.process('a1');

      expect(reminder.create).not.toHaveBeenCalled();
    });

    it('keeps one-shot reminder with future fireAt', async () => {
      setLlmResult({
        reminders: [
          {
            title: 'Doctor visit',
            fireAt: new Date('2026-05-15T09:00:00Z'),
          } as any,
        ],
      });

      await svc.process('a1');

      expect(reminder.create).toHaveBeenCalledTimes(1);
    });

    it('recurring reminder with past dtstart: nextFireAt is computed from NOW, not past dtstart', async () => {
      // Critical bug fix verification: 'her gün ilaç' + dtstart 5 gün önce →
      // önceki kod r.fireAt'tan başlattığı için nextFireAt geçmişe düşerdi
      // ve scheduler onaylanır onaylanmaz hemen ateşlerdi.
      setLlmResult({
        reminders: [
          {
            title: 'Daily medication',
            fireAt: new Date('2026-05-03T08:00:00Z'), // 5 gün önce
            rrule: 'FREQ=DAILY',
          } as any,
        ],
      });

      await svc.process('a1');

      expect(reminder.create).toHaveBeenCalledTimes(1);
      const data = reminder.create.mock.calls[0][0].data;
      // nextFireAt now sonrası olmalı
      expect((data.nextFireAt as Date).getTime()).toBeGreaterThan(NOW.getTime());
      expect(data.rrule).toBe('FREQ=DAILY');
    });

    it('drops recurring reminder whose RRULE has no future occurrence (UNTIL in past)', async () => {
      setLlmResult({
        reminders: [
          {
            title: 'Expired daily',
            fireAt: new Date('2026-04-01T08:00:00Z'),
            rrule: 'FREQ=DAILY;UNTIL=20260420T000000Z', // bitmiş kural
          } as any,
        ],
      });

      await svc.process('a1');

      expect(reminder.create).not.toHaveBeenCalled();
    });
  });

  describe('All-filtered case', () => {
    it('AiAnalysis still marked DONE when every action is filtered out', async () => {
      setLlmResult({
        tasks: [{ title: 'Past', dueAt: new Date('2026-04-01T00:00:00Z'), priority: 'LOW' } as any],
        calendarEvents: [
          { title: 'Past', startAt: new Date('2026-04-01T00:00:00Z') } as any,
        ],
        reminders: [
          { title: 'Past', fireAt: new Date('2026-04-01T00:00:00Z') } as any,
        ],
      });

      await svc.process('a1');

      // Hiçbir alt-tablo'ya yazılmadı
      expect(task.create).not.toHaveBeenCalled();
      expect(calendarEvent.create).not.toHaveBeenCalled();
      expect(reminder.create).not.toHaveBeenCalled();

      // Ama AiAnalysis yine DONE'a geçmeli (tx içinde update çağrıldı)
      expect(aiAnalysis.update).toHaveBeenCalled();
      const data = aiAnalysis.update.mock.calls[0][0].data;
      expect(data.status).toBe('DONE');
    });
  });
});
