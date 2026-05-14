import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import type { AiProviderPort, EmailContent } from './ports/ai-provider.port';
import { AI_PROVIDER_TOKEN } from './ports/ai-provider.port';
import { AnalysisResult, AnalysisUpdateResult } from '../domain/value-objects/analysis-result.vo';
import { AiResponseParseError } from '../domain/errors/ai.errors';
import { RecurrenceDetectorService } from './recurrence-detector.service';
import { EventMatcherService } from './event-matcher.service';
import { stripQuotedText } from './util/strip-quoted';
import { parseIcs, type IcsEventOut } from './util/parse-ics';
import type { CalendarEventResult } from '../domain/value-objects/analysis-result.vo';

/** Updates uygulanırken bir aksiyonun bağlanacağı minimum güven. Altında "öneri" kalır. */
const UPDATE_APPLY_CONFIDENCE = 0.6;

const BODY_MAX_CHARS = 2000;

/** Toplam denemenin üst sınırı (ilk + 2 retry = 3). */
export const MAX_ATTEMPTS = 3;
/** attemptCount=N başarısız olduğunda kullanılan beklemeler. */
const BACKOFF_MS: readonly number[] = [30_000, 120_000, 600_000]; // 30sn → 2dk → 10dk

@Injectable()
export class EmailAnalyzerService {
  private readonly logger = new Logger(EmailAnalyzerService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AI_PROVIDER_TOKEN)
    private readonly aiProvider: AiProviderPort,
    private readonly recurrence: RecurrenceDetectorService,
    private readonly eventMatcher: EventMatcherService,
  ) {}

  /**
   * Belirli bir AiAnalysis kaydını işler:
   * 1. Mesaj içeriğini yükle
   * 2. AI'a gönder
   * 3. Task + CalendarEvent kaydet
   * 4. AiAnalysis güncelle
   */
  async process(analysisId: string): Promise<void> {
    // Atomic claim: PENDING → PROCESSING + lockedAt damgası.
    // Bu damga stuck-job recovery'nin "5 dakikadır PROCESSING'de takılı" tespiti için.
    const claimed = await this.prisma.aiAnalysis.updateMany({
      where: { id: analysisId, status: 'PENDING' },
      data: { status: 'PROCESSING', lockedAt: new Date() },
    });
    if (claimed.count !== 1) return; // başka worker kapmış

    const analysis = await this.prisma.aiAnalysis.findUnique({
      where: { id: analysisId },
      select: {
        id: true,
        userId: true,
        mailboxMessageId: true,
        user: { select: { timezone: true } },
        message: {
          select: {
            mailboxAccountId: true,
            folder: true,
            subject: true,
            from: true,
            date: true,
            bodyText: true,
            snippet: true,
            icsRaw: true,
            category: true,
            categoryConfidence: true,
          },
        },
      },
    });

    if (!analysis) return;

    // INBOX → kullanıcıya gelen, perspektif "incoming" (kim ne istiyor / ne planlıyor).
    // SENT  → kullanıcının yazdığı, perspektif "outgoing" (kullanıcı ne söz veriyor / planlıyor).
    // Diğer klasörler (TRASH/SPAM) atlanır.
    let direction: 'incoming' | 'outgoing';
    switch (analysis.message.folder) {
      case 'INBOX':
        direction = 'incoming';
        break;
      case 'SENT':
        direction = 'outgoing';
        break;
      default:
        await this.markSkipped(analysisId);
        return;
    }

    const userTimezone = analysis.user?.timezone ?? 'Europe/Istanbul';
    // Quoted reply blokları + imza temizlenir; AI yalnızca yeni yazılmış kısmı
    // görür. Aksi halde Re: Re: thread'lerde aynı toplantı 3 kez geçtiği için
    // duplicate calendar event üretiliyordu.
    const rawBody = analysis.message.bodyText ?? analysis.message.snippet ?? '';

    const priorMessages = await this.fetchPriorThreadMessages(
      analysis.message.mailboxAccountId,
      analysis.message.from,
      analysis.message.subject,
      analysis.message.date,
      analysis.mailboxMessageId,
    );

    const content: EmailContent = {
      subject: analysis.message.subject ?? '(no subject)',
      from: analysis.message.from ?? 'unknown',
      date: analysis.message.date,
      bodyText: this.truncate(stripQuotedText(rawBody)),
      userTimezone,
      nowIso: new Date().toISOString(),
      direction,
      category: analysis.message.category ?? undefined,
      categoryConfidence: analysis.message.categoryConfidence ?? undefined,
      priorMessages: priorMessages.length > 0 ? priorMessages : undefined,
    };

    try {
      const providerOut = await this.aiProvider.analyzeEmail(content);

      // ICS merge: maile .ics ekliyse calendarEvents AI'dan değil deterministik
      // parser'dan gelir (Outlook calendar invite, Google davet vs.). AI'ın
      // tasks/reminders çıkarımı korunur. METHOD=CANCEL/STATUS=CANCELLED
      // davetler için event eklemeyiz; G2 (update/cancel) iş akışı eklendiğinde
      // mevcut kaydı CANCEL'a çekecek. ICS-sourced event'ler deterministik
      // olduğu için confidence=1.0 yazılır.
      const icsEvents = analysis.message.icsRaw ? parseIcs(analysis.message.icsRaw) : [];
      let mergedResult = providerOut.result;
      if (icsEvents.length > 0) {
        const liveIcs = icsEvents.filter((e) => !e.cancelled && e.method !== 'CANCEL');
        const cancelIcs = icsEvents.filter((e) => e.cancelled || e.method === 'CANCEL');
        const fromIcs = liveIcs.map((e) => this.icsToCalendarEventResult(e, userTimezone));

        // ICS METHOD=CANCEL / STATUS=CANCELLED davetler: deterministik olarak
        // mevcut event'i CANCEL'a çekecek update üretir. confidence=1.0.
        const icsUpdates: AnalysisUpdateResult[] = cancelIcs.map((e) => ({
          action: 'CANCEL',
          match: { title: e.summary, originalStartAt: e.startAt },
          newStartAt: null,
          newEndAt: null,
          newLocation: null,
          reason: 'ICS METHOD=CANCEL',
          confidence: 1.0,
        }));

        mergedResult = {
          ...providerOut.result,
          calendarEvents: fromIcs,
          updates: [...icsUpdates, ...providerOut.result.updates],
        };
        this.logger.log(
          `ICS detected for analysis=${analysisId}: ${icsEvents.length} VEVENT(s) (${liveIcs.length} live, ${cancelIcs.length} cancel); replacing AI calendarEvents.`,
        );
      }

      await this.persist(
        analysis.id,
        analysis.userId,
        mergedResult,
        userTimezone,
        {
          inputTokens: providerOut.inputTokens,
          outputTokens: providerOut.outputTokens,
          latencyMs: providerOut.latencyMs,
        },
      );

      // Updates (CANCEL/RESCHEDULE) — persist transaction'ından sonra ayrı uygulanır.
      // Reasoning: matching DB sorgusu gerektirir (kullanıcının diğer event'leri),
      // bu transaction içinde ayrı yapmak yerine eldeki transaction'dan sonra
      // serial uygulamak daha basit. Update'lerin atomicity'si bireysel — her
      // bir update'i kendi başına başarılı/başarısız uygula.
      const updateStats = await this.applyUpdates(
        analysis.userId,
        analysisId,
        mergedResult.updates,
      );

      this.logger.log(
        `Analysis done id=${analysisId} tasks=${mergedResult.tasks.length} events=${mergedResult.calendarEvents.length} reminders=${mergedResult.reminders.length} updates(applied/skipped/suggested)=${updateStats.applied}/${updateStats.skipped}/${updateStats.suggested}` +
          (icsEvents.length > 0 ? ` (ICS-sourced)` : '') +
          ` (${providerOut.latencyMs}ms` +
          (providerOut.inputTokens != null
            ? `, ${providerOut.inputTokens}→${providerOut.outputTokens ?? '?'} tokens`
            : '') +
          ')',
      );
    } catch (err: any) {
      const errorMessage = err instanceof AiResponseParseError
        ? `Parse error: ${err.raw.slice(0, 200)}`
        : (err?.message ?? String(err));

      await this.handleFailure(analysisId, errorMessage);
    }
  }

  /**
   * Stuck-job recovery: 5 dakikadan uzun süre PROCESSING'de kalmış kayıtları
   * tekrar PENDING'e çek (worker crash'leri için). attemptCount artırılır
   * ki sonsuz döngüye girmesin.
   */
  async recoverStuck(now: Date = new Date(), staleMs = 5 * 60_000): Promise<number> {
    const threshold = new Date(now.getTime() - staleMs);
    const stuck = await this.prisma.aiAnalysis.findMany({
      where: { status: 'PROCESSING', lockedAt: { lt: threshold } },
      select: { id: true, attemptCount: true },
      take: 50,
    });
    if (stuck.length === 0) return 0;

    for (const s of stuck) {
      const nextAttempt = s.attemptCount + 1;
      if (nextAttempt >= MAX_ATTEMPTS) {
        await this.prisma.aiAnalysis.update({
          where: { id: s.id },
          data: {
            status: 'FAILED',
            errorMessage: 'stuck in PROCESSING; max attempts exceeded',
            attemptCount: nextAttempt,
            lockedAt: null,
          },
        });
      } else {
        await this.prisma.aiAnalysis.update({
          where: { id: s.id },
          data: {
            status: 'PENDING',
            attemptCount: nextAttempt,
            nextRetryAt: new Date(now.getTime() + BACKOFF_MS[nextAttempt - 1]),
            lockedAt: null,
          },
        });
      }
    }
    this.logger.warn(`Recovered ${stuck.length} stuck PROCESSING records.`);
    return stuck.length;
  }

  /**
   * Hata sonrası atomik durum geçişi:
   * - attemptCount < MAX_ATTEMPTS → status PENDING + nextRetryAt = now+backoff(N)
   * - attemptCount >= MAX_ATTEMPTS → status FAILED (terminal)
   *
   * Her iki durumda da lockedAt temizlenir ve errorMessage tutulur.
   */
  private async handleFailure(analysisId: string, errorMessage: string): Promise<void> {
    // Mevcut attemptCount'u al
    const current = await this.prisma.aiAnalysis.findUnique({
      where: { id: analysisId },
      select: { attemptCount: true },
    });
    const attemptCount = (current?.attemptCount ?? 0) + 1;

    if (attemptCount >= MAX_ATTEMPTS) {
      await this.prisma.aiAnalysis.update({
        where: { id: analysisId },
        data: {
          status: 'FAILED',
          errorMessage,
          attemptCount,
          lockedAt: null,
        },
      });
      this.logger.error(
        `Analysis FAILED (terminal) id=${analysisId} attempt=${attemptCount}/${MAX_ATTEMPTS}: ${errorMessage}`,
      );
      return;
    }

    const backoffMs = BACKOFF_MS[attemptCount - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
    const nextRetryAt = new Date(Date.now() + backoffMs);

    await this.prisma.aiAnalysis.update({
      where: { id: analysisId },
      data: {
        status: 'PENDING',
        errorMessage,
        attemptCount,
        nextRetryAt,
        lockedAt: null,
      },
    });
    this.logger.warn(
      `Analysis retry scheduled id=${analysisId} attempt=${attemptCount}/${MAX_ATTEMPTS} nextRetryAt=${nextRetryAt.toISOString()}: ${errorMessage}`,
    );
  }

  // ---------------------------------------------------------------------------

  private async persist(
    analysisId: string,
    userId: string,
    result: AnalysisResult,
    userTimezone: string,
    telemetry: {
      inputTokens: number | null;
      outputTokens: number | null;
      latencyMs: number;
    },
  ): Promise<void> {
    const now = new Date();

    // Geçmiş aksiyonları drop et: AI eski mailleri analiz edebilir, ama o
    // mailde geçen tarih artık geçmişte ise kullanıcı için anlamsız.
    // - Calendar event: startAt < now → drop (rrule'lu olanlar muaf;
    //   tekrarlanan etkinlik gelecekteki occurrence'lar için hâlâ geçerli)
    // - Task: dueAt set ve dueAt < now → drop (dueAt boş task'lar genel iş)
    // - Reminder one-shot: fireAt < now → drop
    // - Reminder recurring: nextFireAt'ı RRULE'dan now sonrası hesapla.
    const skipped = { tasks: 0, calendarEvents: 0, reminders: 0 };

    const futureCalendarEvents = result.calendarEvents.filter((e) => {
      if (e.rrule) return true; // recurring → gelecekte tekrar edecek
      // All-day etkinlik için karşılaştırma "gün sonu" üzerinden:
      // 15 Mayıs all-day etkinliği 15 Mayıs 23:59'a kadar geçerli sayılır.
      const cutoff = e.isAllDay
        ? new Date(e.startAt.getFullYear(), e.startAt.getMonth(), e.startAt.getDate(), 23, 59, 59, 999)
        : e.startAt;
      if (cutoff < now) {
        skipped.calendarEvents++;
        return false;
      }
      return true;
    });

    const futureTasks = result.tasks.filter((t) => {
      if (!t.dueAt) return true; // dueAt yoksa hâlâ geçerli (genel iş)
      if (t.dueAt < now) {
        skipped.tasks++;
        return false;
      }
      return true;
    });

    await this.prisma.$transaction(async (tx) => {
      // AiAnalysis güncelle (lockedAt da temizleniyor — başarı yolu)
      await tx.aiAnalysis.update({
        where: { id: analysisId },
        data: {
          status: 'DONE',
          model: this.aiProvider.modelName,
          summary: result.summary,
          rawResult: result as any,
          processedAt: new Date(),
          lockedAt: null,
          inputTokens: telemetry.inputTokens,
          outputTokens: telemetry.outputTokens,
          latencyMs: telemetry.latencyMs,
        },
      });

      // Task'ları kaydet (rrule varsa doğrula). AI üretimi → PROPOSED.
      for (const t of futureTasks) {
        const taskRrule = this.safeRrule(t.rrule);
        await tx.task.create({
          data: {
            userId,
            aiAnalysisId: analysisId,
            title: t.title,
            notes: t.notes ?? null,
            dueAt: t.dueAt ?? null,
            rrule: taskRrule,
            priority: t.priority,
            status: 'PROPOSED',
            confidence: t.confidence ?? null,
          },
        });
      }

      // CalendarEvent'leri kaydet (rrule varsa doğrula)
      for (const e of futureCalendarEvents) {
        const eventRrule = this.safeRrule(e.rrule, e.startAt);
        // SİGORTA: LLM weekly recurring etkinliklerde BYDAY günü ile startAt'ın
        // gün-of-week'i eşleşmediği zaman tutarsız tarih döndürebiliyor
        // (örn BYDAY=TU yazıp Cuma startAt veriyor). Bu durumda startAt'ı
        // server-side recompute ediyoruz: saati LLM'den koru, bir sonraki
        // BYDAY gününe taşı. Llama 3.1:8b'nin gün matematiğine güvenmiyoruz.
        const alignedStartAt = alignRecurringStartAt(
          e.startAt,
          eventRrule,
          e.timezone ?? userTimezone,
          now,
        );
        if (alignedStartAt.getTime() !== e.startAt.getTime()) {
          this.logger.warn(
            `Realigned recurring event "${e.title}": ${e.startAt.toISOString()} → ${alignedStartAt.toISOString()} (rrule=${eventRrule})`,
          );
        }
        await tx.calendarEvent.create({
          data: {
            userId,
            aiAnalysisId: analysisId,
            title: e.title,
            startAt: alignedStartAt,
            endAt: e.endAt ?? null,
            isAllDay: e.isAllDay === true,
            location: e.location ?? null,
            attendees: e.attendees?.length ? JSON.stringify(e.attendees) : null,
            rrule: eventRrule,
            timezone: e.timezone ?? userTimezone,
            confidence: e.confidence ?? null,
            // status default olarak PROPOSED — kullanıcı onayı bekliyor
          },
        });
      }

      // Reminder'ları kaydet (RRULE doğrulaması: geçersizse PAUSED)
      for (const r of result.reminders) {
        if (!r.title || (!r.fireAt && !r.rrule)) continue;

        // Tek seferlik + geçmiş fireAt → drop
        if (!r.rrule && r.fireAt && r.fireAt < now) {
          skipped.reminders++;
          continue;
        }

        let nextFireAt: Date | null = r.fireAt ?? null;
        // AI üretimi → her zaman PROPOSED (onaylanınca ACTIVE'e geçer; rrule
        // geçersizse onaylama PAUSED'a düşer). Böylece scheduler PROPOSED'ları
        // tetiklemez, kullanıcı onayı şart.
        let status: 'PROPOSED' | 'PAUSED' = 'PROPOSED';
        let validatedRrule: string | null = null;

        if (r.rrule) {
          // Validate: dtstart=fireAt veya now (RRULE'un kendi semantiği için).
          const v = this.recurrence.validate(r.rrule, r.fireAt ?? now);
          if (v.ok) {
            validatedRrule = r.rrule.replace(/^RRULE:/i, '').trim();
            // ÖNEMLİ: nextFireAt scheduler için NOW sonrası hesaplanmalı.
            // Aksi halde "her gün" kuralı + 5 gün önceki dtstart → 5 gün
            // önceki bir occurrence kaydedilir, scheduler hemen ateşler.
            const futureNext = this.recurrence.computeNextFireAt(validatedRrule, now);
            if (futureNext === null) {
              // RRULE'un gelecek occurrence'ı yok (örn UNTIL geçmişte) → drop
              skipped.reminders++;
              continue;
            }
            nextFireAt = futureNext;
          } else {
            this.logger.warn(
              `Invalid rrule from LLM (analysis=${analysisId}): ${v.error}; reminder paused for review`,
            );
            status = 'PAUSED';
          }
        }

        await tx.reminder.create({
          data: {
            userId,
            aiAnalysisId: analysisId,
            title: r.title,
            notes: r.notes ?? null,
            fireAt: r.fireAt ?? null,
            rrule: validatedRrule,
            timezone: r.timezone ?? userTimezone,
            nextFireAt,
            status,
            confidence: r.confidence ?? null,
          },
        });
      }
    });

    if (skipped.tasks + skipped.calendarEvents + skipped.reminders > 0) {
      this.logger.log(
        `Filtered past actions for analysis=${analysisId}: ` +
          `tasks=${skipped.tasks} events=${skipped.calendarEvents} reminders=${skipped.reminders}`,
      );
    }
  }

  /**
   * AI'ın "updates" çıktısını gerçek event kayıtlarına uygular.
   *
   * Her update için:
   *  - confidence < eşik (0.6) → atla (tehlikeli, yanlış event silinebilir)
   *  - EventMatcherService eşleşme bulamazsa → atla
   *  - CANCEL → status=CANCELLED
   *  - RESCHEDULE → startAt/endAt/location güncelle (status korunur)
   *
   * ICS METHOD=CANCEL kaynaklı update'lerin confidence=1.0, ek bir doğrulama
   * gerekmez. AI çıkarımları için eşik altında kalanlar UI'da öneri olarak
   * gösterilebilir ama otomatik değişiklik YAPMAYIZ.
   */
  private async applyUpdates(
    userId: string,
    analysisId: string,
    updates: AnalysisUpdateResult[],
  ): Promise<{ applied: number; skipped: number; suggested: number }> {
    let applied = 0;
    let skipped = 0;
    let suggested = 0;
    for (const u of updates) {
      const conf = u.confidence ?? 0;
      if (conf < UPDATE_APPLY_CONFIDENCE) {
        // Sessiz drop yerine kullanıcıya soru olarak persist et.
        // matchedEventId burada bilmediğimizden null bırakılır; UI kullanıcıya
        // hangi event olduğunu sorar ya da belirsiz öneri olarak gösterir.
        await this.createSuggestion(userId, analysisId, u, 'LOW_CONFIDENCE', null);
        suggested++;
        this.logger.warn(
          `Update suggested (low confidence ${conf.toFixed(2)} < ${UPDATE_APPLY_CONFIDENCE}) analysis=${analysisId} action=${u.action} title="${u.match.title ?? ''}"`,
        );
        continue;
      }

      const match = await this.eventMatcher.findMatch(userId, u.match);
      if (!match) {
        // Yine sessiz değil — öneri kaydı.
        await this.createSuggestion(userId, analysisId, u, 'NO_MATCH', null);
        suggested++;
        this.logger.warn(
          `Update suggested (no match) analysis=${analysisId} action=${u.action} title="${u.match.title ?? ''}" original=${u.match.originalStartAt?.toISOString() ?? '-'}`,
        );
        continue;
      }

      if (u.action === 'CANCEL') {
        await this.prisma.calendarEvent.update({
          where: { id: match.id },
          data: { status: 'CANCELLED' },
        });
        applied++;
        this.logger.log(
          `Update applied: CANCEL event=${match.id} "${match.title}" (score=${match.score.toFixed(2)})`,
        );
      } else {
        // RESCHEDULE — newStartAt parser tarafından zorunlu kılındı, ama defensive.
        if (!u.newStartAt) {
          skipped++;
          continue;
        }
        await this.prisma.calendarEvent.update({
          where: { id: match.id },
          data: {
            startAt: u.newStartAt,
            endAt: u.newEndAt ?? null,
            ...(u.newLocation != null ? { location: u.newLocation } : {}),
          },
        });
        applied++;
        this.logger.log(
          `Update applied: RESCHEDULE event=${match.id} "${match.title}" → ${u.newStartAt.toISOString()} (score=${match.score.toFixed(2)})`,
        );
      }
    }
    return { applied, skipped, suggested };
  }

  /**
   * Sessiz drop edilmesi gereken bir update için öneri kaydı oluştur.
   * Kullanıcı UI'dan onaylar/reddeder. İdempotency: aynı (analysisId, kind,
   * matchTitle, originalStartAt) tuple'ı için zaten bir PENDING öneri varsa
   * yenisini ekleme — mailin tekrar analiz edildiği durumlarda duplicate'i
   * önler.
   */
  private async createSuggestion(
    userId: string,
    analysisId: string,
    u: AnalysisUpdateResult,
    dropReason: 'LOW_CONFIDENCE' | 'NO_MATCH',
    matchedEventId: string | null,
  ): Promise<void> {
    const existing = await this.prisma.aiSuggestion.findFirst({
      where: {
        aiAnalysisId: analysisId,
        kind: u.action,
        status: 'PENDING',
        matchTitle: u.match.title ?? null,
        originalStartAt: u.match.originalStartAt ?? null,
      },
      select: { id: true },
    });
    if (existing) return;

    await this.prisma.aiSuggestion.create({
      data: {
        userId,
        aiAnalysisId: analysisId,
        kind: u.action,
        status: 'PENDING',
        dropReason,
        matchedEventId,
        matchTitle: u.match.title ?? null,
        originalStartAt: u.match.originalStartAt ?? null,
        newStartAt: u.newStartAt ?? null,
        newEndAt: u.newEndAt ?? null,
        newLocation: u.newLocation ?? null,
        reason: u.reason ?? null,
        confidence: u.confidence ?? null,
      },
    });
  }

  /**
   * RRULE'ü doğrular; geçersizse null döner (kayıt yine yapılır ama recurrence olmaz).
   * CalendarEvent için kullanılan varyant: dtstart vermek RRULE doğruluk kontrolünü iyileştirir.
   */
  private safeRrule(raw: string | null | undefined, dtstart?: Date): string | null {
    if (!raw) return null;
    const v = this.recurrence.validate(raw, dtstart ?? new Date());
    if (!v.ok) {
      this.logger.warn(`Dropping invalid rrule: ${v.error}`);
      return null;
    }
    return raw.replace(/^RRULE:/i, '').trim();
  }

  private async markSkipped(analysisId: string): Promise<void> {
    await this.prisma.aiAnalysis.update({
      where: { id: analysisId },
      data: { status: 'DONE', summary: null, processedAt: new Date(), lockedAt: null },
    });
  }

  /**
   * Bir mailın AI analizini sıfırdan tekrar çalıştırır. Senaryolar:
   *  - Prompt değişti, eski sonuç eski versiyon
   *  - Model değişti
   *  - Kullanıcı "AI bunu kaçırmış" deyip manuel tetiklemek istiyor
   *
   * Davranış:
   *  - Önceki analize bağlı PROPOSED görev/etkinlik/anımsatıcılar SİLİNİR
   *    (yeni analiz tekrar üretecek; user henüz onaylamadığı için kayıp yok).
   *  - Onaylanmış (PENDING/ACTIVE/CONFIRMED) öğelere DOKUNULMAZ.
   *  - AiAnalysis kaydı status=PENDING'e döner; attempt sayacı sıfırlanır.
   *  - Worker normal akışla yeni analizi işler (eşzamanlı çalıştırmaya zorlanmaz).
   */
  async reanalyzeByAnalysisId(userId: string, analysisId: string): Promise<{ analysisId: string }> {
    const a = await this.prisma.aiAnalysis.findUnique({
      where: { id: analysisId },
      select: { id: true, userId: true, mailboxMessageId: true },
    });
    if (!a || a.userId !== userId) {
      throw new Error('Analysis not found or not owned by user');
    }
    return this.reanalyze(userId, a.mailboxMessageId);
  }

  /**
   * GEÇİCİ DEBUG: Kullanıcının TÜM AI analizlerini sıfırla.
   * - PROPOSED tasks/events/reminders/suggestions silinir (onaylanmışlar korunur).
   * - Tüm AiAnalysis kayıtları PENDING'e döner; worker hepsini sırayla işler.
   *
   * Onay akışındaki kayıpları önlemek için yalnızca PROPOSED ve PENDING
   * AiSuggestion (kullanıcı henüz karar vermediği) silinir.
   */
  async reanalyzeAllForUser(userId: string): Promise<{ count: number }> {
    return this.prisma.$transaction(async (tx) => {
      const analyses = await tx.aiAnalysis.findMany({
        where: { userId },
        select: { id: true },
      });
      const analysisIds = analyses.map((a) => a.id);
      if (analysisIds.length === 0) return { count: 0 };

      // Onaylanmamış AI çıkarımlarını temizle
      await tx.task.deleteMany({
        where: { aiAnalysisId: { in: analysisIds }, status: 'PROPOSED' },
      });
      await tx.calendarEvent.deleteMany({
        where: { aiAnalysisId: { in: analysisIds }, status: 'PROPOSED' },
      });
      await tx.reminder.deleteMany({
        where: { aiAnalysisId: { in: analysisIds }, status: 'PROPOSED' },
      });
      await tx.aiSuggestion.deleteMany({
        where: { aiAnalysisId: { in: analysisIds }, status: 'PENDING' },
      });

      // Analizleri yeniden işlenebilir hale getir
      await tx.aiAnalysis.updateMany({
        where: { id: { in: analysisIds } },
        data: {
          status: 'PENDING',
          attemptCount: 0,
          nextRetryAt: null,
          lockedAt: null,
          errorMessage: null,
          summary: null,
          rawResult: undefined as any,
          processedAt: null,
          inputTokens: null,
          outputTokens: null,
          latencyMs: null,
        },
      });

      this.logger.warn(
        `BULK RE-ANALYZE: reset ${analysisIds.length} analyses for user=${userId}`,
      );
      return { count: analysisIds.length };
    });
  }

  async reanalyze(userId: string, messageId: string): Promise<{ analysisId: string }> {
    const msg = await this.prisma.mailboxMessage.findUnique({
      where: { id: messageId },
      select: { id: true, mailboxAccount: { select: { userId: true } } },
    });
    if (!msg || msg.mailboxAccount.userId !== userId) {
      throw new Error('Message not found or not owned by user');
    }

    return this.prisma.$transaction(async (tx) => {
      let analysis = await tx.aiAnalysis.findUnique({
        where: { mailboxMessageId: messageId },
        select: { id: true },
      });

      if (analysis) {
        // PROPOSED türevleri sil — onaylanmamış AI çıkarımı, yenisi üretilecek
        await tx.task.deleteMany({ where: { aiAnalysisId: analysis.id, status: 'PROPOSED' } });
        await tx.calendarEvent.deleteMany({ where: { aiAnalysisId: analysis.id, status: 'PROPOSED' } });
        await tx.reminder.deleteMany({ where: { aiAnalysisId: analysis.id, status: 'PROPOSED' } });

        // Analizi yeniden işlenebilir hale getir
        await tx.aiAnalysis.update({
          where: { id: analysis.id },
          data: {
            status: 'PENDING',
            attemptCount: 0,
            nextRetryAt: null,
            lockedAt: null,
            errorMessage: null,
            // Eski DONE çıktısını boşalt; yenisi gelecek
            summary: null,
            rawResult: undefined as any,
            processedAt: null,
            inputTokens: null,
            outputTokens: null,
            latencyMs: null,
          },
        });
      } else {
        analysis = await tx.aiAnalysis.create({
          data: { userId, mailboxMessageId: messageId, status: 'PENDING' },
          select: { id: true },
        });
      }

      this.logger.log(`Re-analyze enqueued for message=${messageId} analysis=${analysis.id}`);
      return { analysisId: analysis.id };
    });
  }

  /** ICS VEVENT'i AI'ın CalendarEventResult VO formatına dönüştür. */
  private icsToCalendarEventResult(e: IcsEventOut, userTimezone: string): CalendarEventResult {
    return {
      title: e.summary,
      startAt: e.startAt,
      endAt: e.endAt,
      isAllDay: e.isAllDay,
      location: e.location,
      attendees: e.attendees,
      rrule: e.rrule,
      timezone: userTimezone,
      // ICS daveti deterministik bir kaynak — yorumlama gerektirmez.
      confidence: 1.0,
    };
  }

  private truncate(text: string): string {
    if (text.length <= BODY_MAX_CHARS) return text;
    return text.slice(0, BODY_MAX_CHARS) + '…';
  }

  /**
   * Heuristic thread-context fetcher: aynı mailbox + aynı gönderici adresi +
   * normalize edilmiş subject (Re:/Fwd: prefix'leri ve Türkçe varyantları
   * sıyrılır) + son 14 gün penceresi içinde, current mailden ÖNCEKİ tarihli
   * en yakın 3 maili getirir. Schema'ya `inReplyTo`/`messageId` kolonları
   * eklenmediği için thread bağı bu heuristic ile kuruluyor — IMAP header
   * persist'i eklenirse buradan istifade edilir.
   *
   * Eski mailler bağlam olarak LLM'e verilir; "8 Mayıs'taki toplantıyı 9'a
   * aldık" ve benzeri RESCHEDULE/CANCEL ifadelerini önceki mail içeriğine
   * bağlamak için.
   */
  private async fetchPriorThreadMessages(
    mailboxAccountId: string,
    fromRaw: string | null | undefined,
    subjectRaw: string | null | undefined,
    currentDate: Date,
    currentMessageId: string,
  ): Promise<Array<{ date: Date; subject: string; snippet: string }>> {
    if (!fromRaw || !subjectRaw) return [];
    const fromAddr = extractEmailAddress(fromRaw);
    if (!fromAddr) return [];
    const baseSubject = normalizeSubject(subjectRaw);
    if (!baseSubject) return [];

    const windowStart = new Date(currentDate.getTime() - 14 * 24 * 60 * 60 * 1000);
    const candidates = await this.prisma.mailboxMessage.findMany({
      where: {
        mailboxAccountId,
        date: { gte: windowStart, lt: currentDate },
        id: { not: currentMessageId },
        from: { contains: fromAddr, mode: 'insensitive' },
      },
      select: { id: true, date: true, subject: true, snippet: true, bodyText: true },
      orderBy: { date: 'desc' },
      take: 20,
    });

    const matched = candidates
      .filter((c) => c.subject && normalizeSubject(c.subject) === baseSubject)
      .slice(0, 3)
      .map((c) => ({
        date: c.date,
        subject: c.subject ?? '(no subject)',
        snippet: this.truncatePrior(stripQuotedText(c.bodyText ?? c.snippet ?? '')),
      }));

    return matched;
  }

  private truncatePrior(text: string): string {
    const max = 200;
    const t = text.replace(/\s+/g, ' ').trim();
    return t.length <= max ? t : t.slice(0, max) + '…';
  }
}

/**
 * Weekly recurring etkinliklerde startAt'ı RRULE BYDAY günüyle hizala.
 *
 * Llama 3.1:8b sıkça "BYDAY=TU" yazıp startAt'ı yanlış güne (örn Cuma)
 * koyuyor. Bu fonksiyon: saati (HH:MM) LLM'den korur, ama bir sonraki
 * BYDAY gününe taşır. Server-side deterministik hesap → garantili doğru gün.
 *
 * Algoritma:
 *  1. RRULE'da BYDAY=XX,YY varsa parse et.
 *  2. Kullanıcı TZ'sinde startAt'ın gün-of-week'i zaten BYDAY'lerden biriyle
 *     eşleşiyor VE startAt > now ise: dokunma, LLM doğru çıkarmış.
 *  3. Eşleşmiyorsa: now veya startAt'tan büyük olanı baz al, en yakın BYDAY
 *     gününe yuvarla. Saati startAt'tan koru.
 *
 * Sınırlamalar: Sadece WEEKLY için anlamlı; FREQ olmadan ya da BYDAY'siz
 * RRULE'larda startAt aynen döner. DST geçişlerinde 1 saatlik kayma olabilir
 * (yılda 2 kez, kabul edilebilir).
 */
function alignRecurringStartAt(
  startAt: Date,
  rrule: string | null,
  timezone: string,
  now: Date,
): Date {
  if (!rrule) return startAt;
  // Yalnızca WEEKLY için. DAILY/MONTHLY zaten LLM'in doğru yapması daha kolay.
  if (!/FREQ=WEEKLY/i.test(rrule)) return startAt;

  const m = /BYDAY=([A-Z,]+)/i.exec(rrule);
  if (!m) return startAt;
  const dowMap: Record<string, number> = {
    SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6,
  };
  const targetDows = m[1]
    .split(',')
    .map((d) => dowMap[d.toUpperCase()])
    .filter((n) => n !== undefined);
  if (targetDows.length === 0) return startAt;

  const startDow = dayOfWeekInTz(startAt, timezone);
  if (targetDows.includes(startDow) && startAt > now) {
    return startAt; // LLM doğru hesaplamış, dokunma
  }

  // Bir sonraki BYDAY gününü bul (now'dan itibaren)
  const baseDow = dayOfWeekInTz(now, timezone);
  let bestOffset = Infinity;
  for (const target of targetDows) {
    let offset = (target - baseDow + 7) % 7;
    if (offset === 0) offset = 7; // bugün → bir sonraki haftanın aynı günü
    if (offset < bestOffset) bestOffset = offset;
  }
  if (!Number.isFinite(bestOffset)) return startAt;

  // now + bestOffset gün, saat startAt'tan korunur (UTC milisaniyeler ekleyerek)
  const result = new Date(now.getTime() + bestOffset * 24 * 60 * 60 * 1000);
  // Saat-of-day uyumlandırması: result'un günü doğru, ama saati now'un saati.
  // startAt'taki saati TZ-aware şekilde aktarmak gerek. Basit yöntem:
  // result'un UTC saatini, startAt ile aynı UTC saatine çek.
  result.setUTCHours(
    startAt.getUTCHours(),
    startAt.getUTCMinutes(),
    startAt.getUTCSeconds(),
    startAt.getUTCMilliseconds(),
  );
  // setUTCHours günü değiştirebilir (saat farkı + TZ etkileşimi); fallback olarak
  // sonuç hâlâ now'dan büyük olmalı, değilse 7 gün ekle.
  if (result <= now) {
    return new Date(result.getTime() + 7 * 24 * 60 * 60 * 1000);
  }
  return result;
}

/** Verilen Date'in IANA TZ'deki gün-of-week'ini 0=Sun..6=Sat olarak döner. */
function dayOfWeekInTz(date: Date, timeZone: string): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' })
    .format(date)
    .toUpperCase();
  const map: Record<string, number> = {
    SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
  };
  return map[wd] ?? 0;
}

/** "Ahmet Yılmaz <a@x.com>" → "a@x.com"; düz adres ise olduğu gibi. */
function extractEmailAddress(raw: string): string | null {
  const m = raw.match(/<([^>]+)>/);
  if (m) return m[1].trim().toLowerCase();
  const trimmed = raw.trim().toLowerCase();
  return trimmed.includes('@') ? trimmed : null;
}

/**
 * Subject normalize: leading "Re:", "Fwd:", "Fw:", Türkçe "Yan:", "İlt:" gibi
 * prefix'leri (tekrarlı olabilir: "Re: Re: Fwd:") sıyırır, lowercase yapar,
 * fazla boşlukları sadeleştirir. Boş kalırsa "" döner.
 */
function normalizeSubject(raw: string): string {
  let s = raw.trim();
  // Birden fazla prefix tekrarı olabilir.
  for (let i = 0; i < 5; i++) {
    const next = s.replace(/^(re|fw|fwd|yan|ilt|ilet)\s*:\s*/i, '');
    if (next === s) break;
    s = next;
  }
  return s.toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim();
}
