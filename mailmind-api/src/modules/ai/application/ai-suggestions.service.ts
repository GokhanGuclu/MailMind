import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { EventMatcherService } from './event-matcher.service';

/**
 * AI'ın "düşük güven / match yok" yüzünden otomatik uygulayamadığı update'leri
 * kullanıcıya öneri olarak sunar. Onay → CANCEL/RESCHEDULE action'ı uygulanır.
 *
 * Approve akışı:
 *  - matchedEventId varsa: doğrudan onun üzerinde aksiyon uygula.
 *  - matchedEventId null ise (NO_MATCH durumu): kullanıcı UI'dan event seçmeden
 *    onaylarsa, son şans olarak EventMatcher'ı title-only modunda tekrar
 *    deneriz (eşik: TITLE_ONLY 0.6). Hâlâ yok ise 404 dönüyor — kullanıcı
 *    önce event'i belirtmeli (UI'da event picker eklenebilir, V2).
 */
@Injectable()
export class AiSuggestionsService {
  private readonly logger = new Logger(AiSuggestionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventMatcher: EventMatcherService,
  ) {}

  async list(userId: string) {
    const items = await this.prisma.aiSuggestion.findMany({
      where: { userId, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
      include: {
        aiAnalysis: {
          select: {
            mailboxMessageId: true,
            message: { select: { subject: true, from: true, date: true } },
          },
        },
      },
    });
    return items.map(serialize);
  }

  async count(userId: string): Promise<{ pending: number }> {
    const pending = await this.prisma.aiSuggestion.count({
      where: { userId, status: 'PENDING' },
    });
    return { pending };
  }

  async reject(userId: string, id: string) {
    const s = await this.findOwned(userId, id);
    await this.prisma.aiSuggestion.update({
      where: { id: s.id },
      data: { status: 'REJECTED', resolvedAt: new Date() },
    });
    return { id: s.id, status: 'REJECTED' as const };
  }

  /**
   * Onay → ilgili event üzerinde CANCEL/RESCHEDULE'ı uygula.
   * Başarısızlık halinde suggestion kaydı PENDING kalır; kullanıcı tekrar
   * deneyebilir.
   */
  async approve(userId: string, id: string, opts?: { eventId?: string }) {
    const s = await this.findOwned(userId, id);

    let eventId = opts?.eventId ?? s.matchedEventId;
    if (!eventId) {
      // NO_MATCH iken kullanıcı event seçmediyse: title-only matcher'ı son
      // bir kez deneyelim (matchTitle varsa).
      if (s.matchTitle) {
        const m = await this.eventMatcher.findMatch(userId, {
          title: s.matchTitle,
          originalStartAt: s.originalStartAt ?? null,
        });
        if (m) eventId = m.id;
      }
    }

    if (!eventId) {
      throw new NotFoundException(
        'Bu öneri bir etkinliğe bağlanamadı. Lütfen ilgili etkinliği seçin (eventId).',
      );
    }

    // Sahiplik kontrolü: event userId'ye ait olmalı
    const event = await this.prisma.calendarEvent.findUnique({
      where: { id: eventId },
      select: { id: true, userId: true, title: true },
    });
    if (!event || event.userId !== userId) {
      throw new NotFoundException('Etkinlik bulunamadı.');
    }

    if (s.kind === 'CANCEL') {
      await this.prisma.calendarEvent.update({
        where: { id: event.id },
        data: { status: 'CANCELLED' },
      });
      this.logger.log(
        `Suggestion approved: CANCEL event=${event.id} "${event.title}" via suggestion=${s.id}`,
      );
    } else {
      // RESCHEDULE — newStartAt zorunlu
      if (!s.newStartAt) {
        throw new NotFoundException(
          'RESCHEDULE önerisi yeni başlangıç zamanı içermiyor.',
        );
      }
      await this.prisma.calendarEvent.update({
        where: { id: event.id },
        data: {
          startAt: s.newStartAt,
          endAt: s.newEndAt ?? null,
          ...(s.newLocation != null ? { location: s.newLocation } : {}),
        },
      });
      this.logger.log(
        `Suggestion approved: RESCHEDULE event=${event.id} "${event.title}" → ${s.newStartAt.toISOString()} via suggestion=${s.id}`,
      );
    }

    await this.prisma.aiSuggestion.update({
      where: { id: s.id },
      data: {
        status: 'APPROVED',
        resolvedAt: new Date(),
        matchedEventId: event.id,
      },
    });

    return { id: s.id, status: 'APPROVED' as const, eventId: event.id };
  }

  private async findOwned(userId: string, id: string) {
    const s = await this.prisma.aiSuggestion.findUnique({ where: { id } });
    if (!s || s.userId !== userId) {
      throw new NotFoundException('Suggestion not found');
    }
    return s;
  }
}

function serialize(s: any) {
  return {
    id: s.id,
    kind: s.kind as 'CANCEL' | 'RESCHEDULE',
    status: s.status as 'PENDING' | 'APPROVED' | 'REJECTED',
    dropReason: s.dropReason as 'LOW_CONFIDENCE' | 'NO_MATCH',
    matchedEventId: s.matchedEventId ?? null,
    matchTitle: s.matchTitle ?? null,
    originalStartAt: s.originalStartAt?.toISOString() ?? null,
    newStartAt: s.newStartAt?.toISOString() ?? null,
    newEndAt: s.newEndAt?.toISOString() ?? null,
    newLocation: s.newLocation ?? null,
    reason: s.reason ?? null,
    confidence: s.confidence ?? null,
    createdAt: s.createdAt.toISOString(),
    aiAnalysisId: s.aiAnalysisId,
    mailboxMessageId: s.aiAnalysis?.mailboxMessageId ?? null,
    messageSubject: s.aiAnalysis?.message?.subject ?? null,
    messageFrom: s.aiAnalysis?.message?.from ?? null,
    messageDate: s.aiAnalysis?.message?.date?.toISOString() ?? null,
  };
}
