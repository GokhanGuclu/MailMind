import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';

/**
 * Bir AnalysisUpdateResult.match'i kullanıcının veritabanındaki gerçek
 * CalendarEvent'e bağlar. Matching kuralları:
 *
 *  - title overlap (Türkçe-aware token Jaccard) → en güçlü sinyal
 *  - originalStartAt verildiyse ±2 gün toleransla zaman yakınlığı
 *  - status CANCELLED olan event'ler dışarıda
 *  - Search penceresi: now-30gün .. now+60gün (follow-up'lar bu aralıkta olur)
 *
 * Skor 0..1; eşik altında null döner ki yanlış event silinmesin.
 */
@Injectable()
export class EventMatcherService {
  private readonly logger = new Logger(EventMatcherService.name);

  /** Skor eşiği — bunun altında match yok kabul edilir. */
  private static readonly MATCH_THRESHOLD = 0.45;
  /** Title-only fallback eşiği (originalStartAt yokken daha sıkı). */
  private static readonly TITLE_ONLY_THRESHOLD = 0.6;

  constructor(private readonly prisma: PrismaService) {}

  async findMatch(
    userId: string,
    hint: { title?: string | null; originalStartAt?: Date | null },
    now: Date = new Date(),
  ): Promise<{ id: string; title: string; startAt: Date; score: number } | null> {
    if (!hint.title && !hint.originalStartAt) return null;

    const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const windowEnd = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

    const candidates = await this.prisma.calendarEvent.findMany({
      where: {
        userId,
        status: { not: 'CANCELLED' },
        startAt: { gte: windowStart, lte: windowEnd },
      },
      select: { id: true, title: true, startAt: true },
      take: 200,
    });

    if (candidates.length === 0) return null;

    const hintTitle = hint.title ? normalize(hint.title) : null;
    let best: { id: string; title: string; startAt: Date; score: number } | null = null;

    for (const c of candidates) {
      const titleScore = hintTitle ? jaccard(hintTitle, normalize(c.title)) : 0;
      const dateScore = hint.originalStartAt
        ? proximityScore(hint.originalStartAt, c.startAt)
        : 0;

      // Ağırlıklar: hem title hem tarih varsa 0.6/0.4; sadece biri varsa o tek sinyal.
      let score: number;
      if (hintTitle && hint.originalStartAt) {
        score = titleScore * 0.6 + dateScore * 0.4;
      } else if (hintTitle) {
        score = titleScore;
      } else {
        score = dateScore;
      }

      if (!best || score > best.score) {
        best = { id: c.id, title: c.title, startAt: c.startAt, score };
      }
    }

    if (!best) return null;
    const threshold = hintTitle && !hint.originalStartAt
      ? EventMatcherService.TITLE_ONLY_THRESHOLD
      : EventMatcherService.MATCH_THRESHOLD;

    return best.score >= threshold ? best : null;
  }
}

/** Türkçe I/İ duyarlı küçük harf + diakritik temizleme. */
function normalize(s: string): string {
  return (s ?? '')
    .replace(/İ/g, 'i')
    .replace(/I/g, 'i')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9çğıöşü\s]/g, ' ');
}

/** 2+ karakterli tokenlar üzerinden Jaccard benzerliği (0..1). */
function jaccard(a: string, b: string): number {
  const ta = new Set(a.split(/\s+/).filter((t) => t.length >= 2));
  const tb = new Set(b.split(/\s+/).filter((t) => t.length >= 2));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** ±0 saat → 1.0, ±2 gün → 0.0 (lineer). */
function proximityScore(a: Date, b: Date): number {
  const diffMs = Math.abs(a.getTime() - b.getTime());
  const maxMs = 2 * 24 * 60 * 60 * 1000;
  if (diffMs >= maxMs) return 0;
  return 1 - diffMs / maxMs;
}
