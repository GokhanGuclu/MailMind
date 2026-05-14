import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../../shared/infrastructure/prisma/prisma.service';
import { MailboxSyncWorkerService } from '../providers/sync/mailbox-sync-worker.service';
import { MAX_ATTEMPTS, nextRetryDate } from '../retry-policy';

type OutboxEventType = 'MAILBOX_ACCOUNT_CONNECTED' | 'MESSAGE_SYNCED' | string;

const STUCK_RECOVERY_EVERY_N_TICKS = 60; // 1sn × 60 = 60sn'de bir recovery
const STUCK_THRESHOLD_MS = 5 * 60_000;

/**
 * AI analizi (özet + task/event çıkarımı) **otomatik olarak** yalnızca son 30
 * günün maillerine uygulanır. Initial sync'te yüzlerce eski mail tek seferde
 * Ollama'ya gönderildiğinde model kuyruğu çöküyordu; bir ayı geçen mailler
 * "soğuk arşiv" — özet/aksiyon değeri düşük. Kullanıcı eski bir maile manuel
 * "Özetle" basarsa controller endpoint'i yine çalışır; bu kısıt yalnızca
 * arka plan kuyruğu içindir.
 */
const AUTO_ANALYSIS_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

@Injectable()
export class OutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorkerService.name);

  private interval: NodeJS.Timeout | null = null;
  private tickCount = 0;

  private readonly workersEnabled =
    (process.env.WORKERS_ENABLED ?? 'true').toLowerCase() === 'true';

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailboxSyncWorker: MailboxSyncWorkerService,
  ) {}

  onModuleInit() {
    if (!this.workersEnabled) {
      this.logger.log('Outbox worker disabled (WORKERS_ENABLED=false).');
      return;
    }

    const intervalMs = Number(process.env.OUTBOX_WORKER_INTERVAL_MS ?? 1_000);

    this.interval = setInterval(() => {
      this.tick().catch((err) => {
        this.logger.error('Outbox worker tick failed', err?.stack ?? String(err));
      });
    }, intervalMs);

    this.logger.log(`Outbox worker started (interval=${intervalMs}ms).`);
  }

  onModuleDestroy() {
    this.stop();
  }

  /**
   * Tek tur: stuck recovery (her N tick'te bir) + bir PENDING event işle.
   */
  async tick(): Promise<void> {
    this.tickCount++;
    if (this.tickCount % STUCK_RECOVERY_EVERY_N_TICKS === 0) {
      await this.recoverStuck().catch((err) => {
        this.logger.error('Stuck recovery failed', err?.stack ?? String(err));
      });
    }
    await this.processOnce();
  }

  async processOnce(): Promise<void> {
    const now = new Date();
    const event = await this.prisma.outboxEvent.findFirst({
      where: {
        status: 'PENDING',
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
    });

    if (!event) return;

    // Atomic claim: PENDING → PROCESSING + lockedAt damgası.
    const claimed = await this.prisma.outboxEvent.updateMany({
      where: { id: event.id, status: 'PENDING' },
      data: { status: 'PROCESSING', lockedAt: new Date() },
    });

    if (claimed.count !== 1) {
      // başka bir worker kapmış ya da retry zamanı henüz gelmemiş
      return;
    }

    try {
      const type = event.type as OutboxEventType;
      this.logger.log(`Processing outbox event: ${event.id} (${type})`);

      switch (type) {
        case 'MAILBOX_ACCOUNT_CONNECTED': {
          const payload: any = event.payload;
          const mailboxAccountId =
            payload?.mailboxAccountId ?? payload?.mailboxId ?? payload?.id;
          if (!mailboxAccountId) {
            throw new Error('MAILBOX_ACCOUNT_CONNECTED: missing mailboxAccountId');
          }
          await this.mailboxSyncWorker.enqueueForMailbox(mailboxAccountId);
          break;
        }

        case 'MESSAGE_SYNCED': {
          const payload: any = event.payload;
          const { userId, messageIds } = payload as {
            userId: string;
            messageIds: string[];
          };

          if (!userId || !Array.isArray(messageIds) || messageIds.length === 0) {
            throw new Error('MESSAGE_SYNCED: missing userId or messageIds');
          }

          // Sadece INBOX + son 7 gün içindeki mesajları AI analizine sok.
          // SENT klasörü kasıtlı olarak hariç: kullanıcının kendi gönderdiği
          // mailler için özet/task çıkarımı değer üretmiyor, sadece kuyruğu
          // şişiriyor. Tarih filtresi mail'in kendi `date` alanına (gönderim
          // zamanı) göredir; initial sync'te çekilen eski mailler bu sayede
          // kuyruğa girmez.
          const since = new Date(Date.now() - AUTO_ANALYSIS_WINDOW_MS);
          const analyzable = await this.prisma.mailboxMessage.findMany({
            where: {
              id: { in: messageIds },
              folder: 'INBOX',
              date: { gte: since },
            },
            select: { id: true },
          });

          if (analyzable.length > 0) {
            // createMany + skipDuplicates: aynı outbox event'i iki kere
            // process edilse de (retry / race) AiAnalysis.mailboxMessageId
            // unique olduğu için ikinci girişim sessizce atlanır.
            const result = await this.prisma.aiAnalysis.createMany({
              data: analyzable.map(({ id: mailboxMessageId }) => ({
                userId,
                mailboxMessageId,
                status: 'PENDING' as const,
              })),
              skipDuplicates: true,
            });

            const skipped = messageIds.length - analyzable.length;
            this.logger.log(
              `Created ${result.count}/${messageIds.length} AiAnalysis records for userId=${userId}` +
                (result.count < analyzable.length
                  ? ` (${analyzable.length - result.count} already existed — idempotent retry)`
                  : '') +
                (skipped > 0 ? ` (skipped ${skipped}: non-INBOX or older than 7d)` : ''),
            );
          } else {
            this.logger.log(
              `No analyzable messages for userId=${userId} (all non-INBOX or older than 7d)`,
            );
          }
          break;
        }

        default:
          this.logger.warn(`Unknown outbox event type: ${type}`);
      }

      // Başarı: status DONE + lockedAt temizle.
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'DONE', sentAt: new Date(), lockedAt: null },
      });
    } catch (err: any) {
      const errorMessage = err?.message ?? String(err);
      await this.handleFailure(event.id, errorMessage);
    }
  }

  /**
   * Stuck-job recovery: STUCK_THRESHOLD_MS'den uzun süre PROCESSING'de kalmış
   * event'leri tekrar PENDING'e çek (worker crash'leri için).
   */
  async recoverStuck(now: Date = new Date()): Promise<number> {
    const threshold = new Date(now.getTime() - STUCK_THRESHOLD_MS);
    const stuck = await this.prisma.outboxEvent.findMany({
      where: { status: 'PROCESSING', lockedAt: { lt: threshold } },
      select: { id: true, attemptCount: true },
      take: 50,
    });
    if (stuck.length === 0) return 0;

    for (const s of stuck) {
      const nextAttempt = s.attemptCount + 1;
      if (nextAttempt >= MAX_ATTEMPTS) {
        await this.prisma.outboxEvent.update({
          where: { id: s.id },
          data: {
            status: 'FAILED',
            errorMessage: 'stuck in PROCESSING; max attempts exceeded',
            attemptCount: nextAttempt,
            lockedAt: null,
          },
        });
      } else {
        await this.prisma.outboxEvent.update({
          where: { id: s.id },
          data: {
            status: 'PENDING',
            attemptCount: nextAttempt,
            nextRetryAt: nextRetryDate(nextAttempt, now),
            lockedAt: null,
          },
        });
      }
    }
    this.logger.warn(`Recovered ${stuck.length} stuck PROCESSING outbox event(s).`);
    return stuck.length;
  }

  /**
   * Hata sonrası atomik durum geçişi:
   * - attemptCount < MAX_ATTEMPTS → PENDING + nextRetryAt = now + backoff
   * - >= MAX_ATTEMPTS → terminal FAILED
   */
  private async handleFailure(eventId: string, errorMessage: string): Promise<void> {
    const current = await this.prisma.outboxEvent.findUnique({
      where: { id: eventId },
      select: { attemptCount: true },
    });
    const attemptCount = (current?.attemptCount ?? 0) + 1;

    if (attemptCount >= MAX_ATTEMPTS) {
      await this.prisma.outboxEvent.update({
        where: { id: eventId },
        data: {
          status: 'FAILED',
          errorMessage,
          attemptCount,
          lockedAt: null,
        },
      });
      this.logger.error(
        `Outbox event FAILED (terminal) id=${eventId} attempt=${attemptCount}/${MAX_ATTEMPTS}: ${errorMessage}`,
      );
      return;
    }

    const nextRetryAt = nextRetryDate(attemptCount);
    await this.prisma.outboxEvent.update({
      where: { id: eventId },
      data: {
        status: 'PENDING',
        errorMessage,
        attemptCount,
        nextRetryAt,
        lockedAt: null,
      },
    });
    this.logger.warn(
      `Outbox retry scheduled id=${eventId} attempt=${attemptCount}/${MAX_ATTEMPTS} nextRetryAt=${nextRetryAt.toISOString()}: ${errorMessage}`,
    );
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      this.logger.log('Outbox worker stopped.');
    }
  }
}
