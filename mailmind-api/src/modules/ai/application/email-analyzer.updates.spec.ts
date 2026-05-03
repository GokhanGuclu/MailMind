/**
 * G2: AnalysisUpdateResult uygulama testleri.
 *
 * applyUpdates() private; process() üzerinden test ederiz. Tüm testler
 * EventMatcherService'i mock'lar — gerçek matching event-matcher.spec'te.
 */
import { EmailAnalyzerService } from './email-analyzer.service';
import { RecurrenceDetectorService } from './recurrence-detector.service';
import type { AnalysisResult } from '../domain/value-objects/analysis-result.vo';

describe('EmailAnalyzerService.applyUpdates — CANCEL / RESCHEDULE', () => {
  let aiAnalysis: { findUnique: jest.Mock; updateMany: jest.Mock; update: jest.Mock };
  let calendarEventModel: { create: jest.Mock; update: jest.Mock };
  let task: { create: jest.Mock };
  let reminder: { create: jest.Mock };
  let provider: { analyzeEmail: jest.Mock; modelName: string };
  let eventMatcher: { findMatch: jest.Mock };
  let svc: EmailAnalyzerService;
  let prisma: any;
  const NOW = new Date('2026-05-08T10:00:00Z');

  const fakeMessage = {
    id: 'a1',
    userId: 'u1',
    mailboxMessageId: 'm1',
    user: { timezone: 'Europe/Istanbul' },
    message: {
      folder: 'INBOX',
      subject: 's',
      from: 'f',
      date: new Date('2026-05-07T08:00:00Z'),
      bodyText: 'b',
      snippet: 'b',
      icsRaw: null,
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
    calendarEventModel = {
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    };
    reminder = { create: jest.fn().mockResolvedValue({}) };

    prisma = {
      aiAnalysis,
      calendarEvent: calendarEventModel,
      $transaction: jest.fn(async (cb: any) =>
        cb({
          aiAnalysis: { update: aiAnalysis.update },
          task,
          calendarEvent: calendarEventModel,
          reminder,
        }),
      ),
    };

    provider = { analyzeEmail: jest.fn(), modelName: 'test-model' };
    eventMatcher = { findMatch: jest.fn() };
    svc = new EmailAnalyzerService(
      prisma,
      provider as any,
      new RecurrenceDetectorService(),
      eventMatcher as any,
    );
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

  it('CANCEL: matched event status set to CANCELLED', async () => {
    setLlmResult({
      updates: [
        {
          action: 'CANCEL',
          match: { title: 'Sprint planlama', originalStartAt: new Date('2026-05-12T11:00:00Z') },
          confidence: 0.9,
        },
      ],
    });
    eventMatcher.findMatch.mockResolvedValue({
      id: 'e1',
      title: 'Sprint planlama',
      startAt: new Date('2026-05-12T11:00:00Z'),
      score: 0.95,
    });

    await svc.process('a1');

    expect(calendarEventModel.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { status: 'CANCELLED' },
    });
  });

  it('RESCHEDULE: updates startAt/endAt/location on matched event', async () => {
    const newStart = new Date('2026-05-13T10:00:00Z');
    setLlmResult({
      updates: [
        {
          action: 'RESCHEDULE',
          match: { title: 'Sprint planlama', originalStartAt: new Date('2026-05-12T11:00:00Z') },
          newStartAt: newStart,
          newEndAt: null,
          newLocation: 'Oda B',
          confidence: 0.9,
        },
      ],
    });
    eventMatcher.findMatch.mockResolvedValue({
      id: 'e1',
      title: 'Sprint planlama',
      startAt: new Date('2026-05-12T11:00:00Z'),
      score: 0.95,
    });

    await svc.process('a1');

    expect(calendarEventModel.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { startAt: newStart, endAt: null, location: 'Oda B' },
    });
  });

  it('skips update with confidence below threshold (0.6)', async () => {
    setLlmResult({
      updates: [
        {
          action: 'CANCEL',
          match: { title: 'X', originalStartAt: new Date('2026-05-12T11:00:00Z') },
          confidence: 0.4,
        },
      ],
    });

    await svc.process('a1');

    expect(eventMatcher.findMatch).not.toHaveBeenCalled();
    expect(calendarEventModel.update).not.toHaveBeenCalled();
  });

  it('skips when matcher returns null (no candidate event)', async () => {
    setLlmResult({
      updates: [
        {
          action: 'CANCEL',
          match: { title: 'X', originalStartAt: new Date('2026-05-12T11:00:00Z') },
          confidence: 0.9,
        },
      ],
    });
    eventMatcher.findMatch.mockResolvedValue(null);

    await svc.process('a1');

    expect(calendarEventModel.update).not.toHaveBeenCalled();
  });

  it('ICS METHOD=CANCEL produces a synthetic high-confidence update', async () => {
    // ICS content with METHOD=CANCEL
    const icsRaw =
      'BEGIN:VCALENDAR\nMETHOD:CANCEL\nBEGIN:VEVENT\nUID:1@a\nSUMMARY:Sprint planlama\n' +
      'DTSTART:20260512T110000Z\nSTATUS:CANCELLED\nEND:VEVENT\nEND:VCALENDAR';
    aiAnalysis.findUnique.mockImplementation(async ({ select }: any) => {
      if (select?.attemptCount) return { attemptCount: 0 };
      return { ...fakeMessage, message: { ...fakeMessage.message, icsRaw } };
    });
    setLlmResult({ updates: [] });
    eventMatcher.findMatch.mockResolvedValue({
      id: 'e1',
      title: 'Sprint planlama',
      startAt: new Date('2026-05-12T11:00:00Z'),
      score: 0.95,
    });

    await svc.process('a1');

    expect(eventMatcher.findMatch).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ title: 'Sprint planlama' }),
    );
    expect(calendarEventModel.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { status: 'CANCELLED' },
    });
    // CANCEL davet → calendarEvent eklenmemeli (live olmadığı için)
    expect(calendarEventModel.create).not.toHaveBeenCalled();
  });
});
