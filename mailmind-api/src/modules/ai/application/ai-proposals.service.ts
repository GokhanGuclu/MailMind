import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';

export type ProposalKind = 'task' | 'calendar-event' | 'reminder';

/**
 * AI'ın ürettiği `*.status = 'PROPOSED'` kayıtları için human-in-the-loop akışı.
 *
 * Onaylama transition'ları:
 * - Task          PROPOSED → PENDING
 * - CalendarEvent PROPOSED → PENDING (ileride Google Calendar push'tan sonra CONFIRMED)
 * - Reminder      PROPOSED → ACTIVE  (scheduler artık tetikler)
 *
 * Reddetme: hepsi → CANCELLED.
 */
@Injectable()
export class AiProposalsService {
  constructor(private readonly prisma: PrismaService) {}

  // AI Önerileri sayfası ile inbox rozetlerinin aynı kaynaktan beslenmesi
  // için her iki uçta da `aiAnalysisId IS NOT NULL` filtresi uygulanır.
  // Aksi halde orphan/seed kayıtlar sayfada görünüyor ama mail listesinde
  // rozet olmuyor — kullanıcıya tutarsızlık olarak geliyor.
  private readonly aiSourceFilter = { aiAnalysisId: { not: null } } as const;

  async list(userId: string) {
    const [tasks, calendarEvents, reminders] = await Promise.all([
      this.prisma.task.findMany({
        where: { userId, status: 'PROPOSED', ...this.aiSourceFilter },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.calendarEvent.findMany({
        where: { userId, status: 'PROPOSED', ...this.aiSourceFilter },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.reminder.findMany({
        where: { userId, status: 'PROPOSED', ...this.aiSourceFilter },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return { tasks, calendarEvents, reminders };
  }

  async count(userId: string) {
    const [tasks, calendarEvents, reminders] = await Promise.all([
      this.prisma.task.count({ where: { userId, status: 'PROPOSED', ...this.aiSourceFilter } }),
      this.prisma.calendarEvent.count({ where: { userId, status: 'PROPOSED', ...this.aiSourceFilter } }),
      this.prisma.reminder.count({ where: { userId, status: 'PROPOSED', ...this.aiSourceFilter } }),
    ]);
    return {
      tasks,
      calendarEvents,
      reminders,
      total: tasks + calendarEvents + reminders,
    };
  }

  /**
   * mailboxMessage id → PROPOSED öneri sayıları haritası.
   * Inbox kart rozeti için kullanılır: `byMessage[mail.id]?.total > 0`.
   * AI üretimi olmayan (`aiAnalysisId IS NULL`) öneriler dışarıda tutulur —
   * onlar manuel "henüz onaylanmamış" değil, AI flow'una ait değil.
   */
  async byMessage(
    userId: string,
  ): Promise<
    Record<
      string,
      { tasks: number; calendarEvents: number; reminders: number; total: number }
    >
  > {
    const [tasks, events, reminders] = await Promise.all([
      this.prisma.task.findMany({
        where: { userId, status: 'PROPOSED', aiAnalysisId: { not: null } },
        select: { aiAnalysis: { select: { mailboxMessageId: true } } },
      }),
      this.prisma.calendarEvent.findMany({
        where: { userId, status: 'PROPOSED', aiAnalysisId: { not: null } },
        select: { aiAnalysis: { select: { mailboxMessageId: true } } },
      }),
      this.prisma.reminder.findMany({
        where: { userId, status: 'PROPOSED', aiAnalysisId: { not: null } },
        select: { aiAnalysis: { select: { mailboxMessageId: true } } },
      }),
    ]);

    type Bucket = { tasks: number; calendarEvents: number; reminders: number; total: number };
    const map: Record<string, Bucket> = {};
    const ensure = (mid: string): Bucket => {
      if (!map[mid]) map[mid] = { tasks: 0, calendarEvents: 0, reminders: 0, total: 0 };
      return map[mid];
    };

    for (const t of tasks) {
      const mid = t.aiAnalysis?.mailboxMessageId;
      if (!mid) continue;
      const b = ensure(mid);
      b.tasks++;
      b.total++;
    }
    for (const e of events) {
      const mid = e.aiAnalysis?.mailboxMessageId;
      if (!mid) continue;
      const b = ensure(mid);
      b.calendarEvents++;
      b.total++;
    }
    for (const r of reminders) {
      const mid = r.aiAnalysis?.mailboxMessageId;
      if (!mid) continue;
      const b = ensure(mid);
      b.reminders++;
      b.total++;
    }

    return map;
  }

  /**
   * Tek bir mail için PROPOSED durumdaki AI önerilerini döndürür
   * (reader sağ panelinde göstermek için).
   */
  async forMessage(userId: string, mailboxMessageId: string) {
    const analysisFilter = {
      aiAnalysis: { is: { mailboxMessageId, userId } },
    } as const;
    const [tasks, calendarEvents, reminders] = await Promise.all([
      this.prisma.task.findMany({
        where: { userId, status: 'PROPOSED', ...analysisFilter },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.calendarEvent.findMany({
        where: { userId, status: 'PROPOSED', ...analysisFilter },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.reminder.findMany({
        where: { userId, status: 'PROPOSED', ...analysisFilter },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return { tasks, calendarEvents, reminders };
  }

  async approve(userId: string, kind: ProposalKind, id: string) {
    switch (kind) {
      case 'task':
        return this.transitionTask(userId, id, 'PROPOSED', 'PENDING');
      case 'calendar-event':
        return this.transitionCalendarEvent(userId, id, 'PROPOSED', 'PENDING');
      case 'reminder':
        return this.transitionReminder(userId, id, 'PROPOSED', 'ACTIVE');
      default:
        throw new BadRequestException(`Unknown proposal kind: ${kind}`);
    }
  }

  async reject(userId: string, kind: ProposalKind, id: string) {
    switch (kind) {
      case 'task':
        return this.transitionTask(userId, id, 'PROPOSED', 'CANCELLED');
      case 'calendar-event':
        return this.transitionCalendarEvent(userId, id, 'PROPOSED', 'CANCELLED');
      case 'reminder':
        return this.transitionReminder(userId, id, 'PROPOSED', 'CANCELLED');
      default:
        throw new BadRequestException(`Unknown proposal kind: ${kind}`);
    }
  }

  // ─── Transitions ────────────────────────────────────────────────────────

  private async transitionTask(
    userId: string,
    id: string,
    from: 'PROPOSED',
    to: 'PENDING' | 'CANCELLED',
  ) {
    const updated = await this.prisma.task.updateMany({
      where: { id, userId, status: from },
      data: { status: to },
    });
    if (updated.count === 0) {
      throw new NotFoundException(
        `Task ${id} not found or not in PROPOSED state`,
      );
    }
    return this.prisma.task.findUniqueOrThrow({ where: { id } });
  }

  private async transitionCalendarEvent(
    userId: string,
    id: string,
    from: 'PROPOSED',
    to: 'PENDING' | 'CANCELLED',
  ) {
    const updated = await this.prisma.calendarEvent.updateMany({
      where: { id, userId, status: from },
      data: { status: to },
    });
    if (updated.count === 0) {
      throw new NotFoundException(
        `CalendarEvent ${id} not found or not in PROPOSED state`,
      );
    }
    return this.prisma.calendarEvent.findUniqueOrThrow({ where: { id } });
  }

  private async transitionReminder(
    userId: string,
    id: string,
    from: 'PROPOSED',
    to: 'ACTIVE' | 'CANCELLED',
  ) {
    const updated = await this.prisma.reminder.updateMany({
      where: { id, userId, status: from },
      data: { status: to },
    });
    if (updated.count === 0) {
      throw new NotFoundException(
        `Reminder ${id} not found or not in PROPOSED state`,
      );
    }
    return this.prisma.reminder.findUniqueOrThrow({ where: { id } });
  }
}
