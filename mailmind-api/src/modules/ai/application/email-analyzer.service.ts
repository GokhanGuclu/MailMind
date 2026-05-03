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
            folder: true,
            subject: true,
            from: true,
            date: true,
            bodyText: true,
            snippet: true,
            icsRaw: true,
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
    const content: EmailContent = {
      subject: analysis.message.subject ?? '(no subject)',
      from: analysis.message.from ?? 'unknown',
      date: analysis.message.date,
      bodyText: this.truncate(stripQuotedText(rawBody)),
      userTimezone,
      nowIso: new Date().toISOString(),
      direction,
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
        `Analysis done id=${analysisId} tasks=${mergedResult.tasks.length} events=${mergedResult.calendarEvents.length} reminders=${mergedResult.reminders.length} updates(applied/skipped)=${updateStats.applied}/${updateStats.skipped}` +
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
        await tx.calendarEvent.create({
          data: {
            userId,
            aiAnalysisId: analysisId,
            title: e.title,
            startAt: e.startAt,
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
  ): Promise<{ applied: number; skipped: number }> {
    let applied = 0;
    let skipped = 0;
    for (const u of updates) {
      const conf = u.confidence ?? 0;
      if (conf < UPDATE_APPLY_CONFIDENCE) {
        skipped++;
        this.logger.warn(
          `Update skipped (low confidence ${conf.toFixed(2)} < ${UPDATE_APPLY_CONFIDENCE}) analysis=${analysisId} action=${u.action} title="${u.match.title ?? ''}"`,
        );
        continue;
      }

      const match = await this.eventMatcher.findMatch(userId, u.match);
      if (!match) {
        skipped++;
        this.logger.warn(
          `Update skipped (no match) analysis=${analysisId} action=${u.action} title="${u.match.title ?? ''}" original=${u.match.originalStartAt?.toISOString() ?? '-'}`,
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
    return { applied, skipped };
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
}
