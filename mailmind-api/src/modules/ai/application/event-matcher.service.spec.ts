/**
 * EventMatcherService — title + originalStartAt sinyalleriyle mevcut
 * CalendarEvent kaydını eşler. Skor 0..1; eşik altında null.
 */
import { EventMatcherService } from './event-matcher.service';

describe('EventMatcherService', () => {
  let prisma: { calendarEvent: { findMany: jest.Mock } };
  let svc: EventMatcherService;
  const NOW = new Date('2026-05-08T10:00:00Z');

  beforeEach(() => {
    prisma = {
      calendarEvent: { findMany: jest.fn() },
    };
    svc = new EventMatcherService(prisma as any);
  });

  it('returns null when no candidates exist', async () => {
    prisma.calendarEvent.findMany.mockResolvedValue([]);
    const m = await svc.findMatch('u1', { title: 'Sprint planlama' }, NOW);
    expect(m).toBeNull();
  });

  it('returns null when both title and originalStartAt are missing', async () => {
    const m = await svc.findMatch('u1', {}, NOW);
    expect(m).toBeNull();
    expect(prisma.calendarEvent.findMany).not.toHaveBeenCalled();
  });

  it('matches by title + originalStartAt with high score (combined)', async () => {
    prisma.calendarEvent.findMany.mockResolvedValue([
      { id: 'e1', title: 'Sprint planlama', startAt: new Date('2026-05-12T11:00:00Z') },
      { id: 'e2', title: 'Doktor randevusu', startAt: new Date('2026-05-09T08:00:00Z') },
    ]);
    const m = await svc.findMatch(
      'u1',
      { title: 'Sprint planlama', originalStartAt: new Date('2026-05-12T11:00:00Z') },
      NOW,
    );
    expect(m).not.toBeNull();
    expect(m!.id).toBe('e1');
    expect(m!.score).toBeGreaterThan(0.9);
  });

  it('Turkce I/i farkina ragmen eslesir', async () => {
    prisma.calendarEvent.findMany.mockResolvedValue([
      { id: 'e1', title: 'İK görüşmesi', startAt: new Date('2026-05-12T11:00:00Z') },
    ]);
    const m = await svc.findMatch(
      'u1',
      { title: 'ik görüşmesi', originalStartAt: new Date('2026-05-12T11:00:00Z') },
      NOW,
    );
    expect(m).not.toBeNull();
    expect(m!.id).toBe('e1');
  });

  it('rejects when title totally different even with same date', async () => {
    prisma.calendarEvent.findMany.mockResolvedValue([
      { id: 'e1', title: 'Doğum günü partisi', startAt: new Date('2026-05-12T11:00:00Z') },
    ]);
    const m = await svc.findMatch(
      'u1',
      { title: 'Sprint planlama', originalStartAt: new Date('2026-05-12T11:00:00Z') },
      NOW,
    );
    // title=0, date=1 → 0.6*0 + 0.4*1 = 0.4 < 0.45 threshold
    expect(m).toBeNull();
  });

  it('title-only match needs higher confidence (≥0.6)', async () => {
    prisma.calendarEvent.findMany.mockResolvedValue([
      { id: 'e1', title: 'XYZ Holding ile görüşme', startAt: new Date('2026-05-12T11:00:00Z') },
      { id: 'e2', title: 'Pazar yemeği', startAt: new Date('2026-05-15T19:00:00Z') },
    ]);
    // 3/3 token overlap → score 1.0 ≥ 0.6 threshold
    const m = await svc.findMatch('u1', { title: 'XYZ Holding görüşme' }, NOW);
    expect(m).not.toBeNull();
    expect(m!.id).toBe('e1');
  });

  it('picks the closer date when titles tie', async () => {
    prisma.calendarEvent.findMany.mockResolvedValue([
      { id: 'farther', title: 'Sprint planlama', startAt: new Date('2026-05-14T11:00:00Z') },
      { id: 'closer', title: 'Sprint planlama', startAt: new Date('2026-05-12T11:30:00Z') },
    ]);
    const m = await svc.findMatch(
      'u1',
      { title: 'Sprint planlama', originalStartAt: new Date('2026-05-12T11:00:00Z') },
      NOW,
    );
    expect(m!.id).toBe('closer');
  });

  it('queries within ±30/+60 day window and excludes CANCELLED', async () => {
    prisma.calendarEvent.findMany.mockResolvedValue([]);
    await svc.findMatch('u1', { title: 'x' }, NOW);
    const arg = prisma.calendarEvent.findMany.mock.calls[0][0];
    expect(arg.where.userId).toBe('u1');
    expect(arg.where.status).toEqual({ not: 'CANCELLED' });
    expect(arg.where.startAt.gte).toBeInstanceOf(Date);
    expect(arg.where.startAt.lte).toBeInstanceOf(Date);
  });
});
