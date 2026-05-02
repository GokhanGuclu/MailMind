import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../../../shared/infrastructure/prisma/prisma.service';
import { ImapProvider, FolderMeta } from '../imap/imap.provider';
import { MAX_ATTEMPTS, nextRetryDate } from '../../retry-policy';

/**
 * Cursor formatı: JSON string → { [folderPath]: maxUid }
 * Örnek: '{"INBOX":123,"SENT":45}'
 */
type SyncCursor = Record<string, number>;

@Injectable()
export class MailboxSyncWorkerService implements OnModuleInit {
  private readonly logger = new Logger(MailboxSyncWorkerService.name);
  private interval: NodeJS.Timeout | null = null;

  private readonly workersEnabled =
    (process.env.WORKERS_ENABLED ?? 'true').toLowerCase() === 'true';

  // Initial sync: her klasörden kaç mail çekilir
  private readonly INITIAL_FETCH_LIMIT = 100;

  // Stale RUNNING job eşiği: bundan eski RUNNING job'lar crashed kabul edilir
  private readonly STALE_RUNNING_MS = 5 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly imapProvider: ImapProvider,
  ) {}

  onModuleInit() {
    if (!this.workersEnabled) {
      this.logger.log('Workers disabled (WORKERS_ENABLED=false).');
      return;
    }

    const intervalMs = Number(process.env.MAILBOX_SYNC_WORKER_INTERVAL_MS ?? 1_000);
    this.interval = setInterval(() => {
      this.processOnce().catch((err) => {
        this.logger.error('Sync worker tick failed', err?.stack ?? String(err));
      });
    }, intervalMs);

    this.logger.log(`Mailbox sync worker started (interval=${intervalMs}ms).`);
  }

  /**
   * Idempotent: aynı mailbox için zaten PENDING/RUNNING job varsa yeni job açmaz.
   */
  async enqueueForMailbox(mailboxAccountId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.mailboxSyncJob.findFirst({
        where: { mailboxAccountId, status: { in: ['PENDING', 'RUNNING'] } },
      });
      if (existing) return;

      await tx.mailboxSyncJob.create({
        data: { mailboxAccountId, type: 'INITIAL', status: 'PENDING' },
      });
      this.logger.log(`Enqueued INITIAL sync for mailbox=${mailboxAccountId}`);
    });
  }

  /**
   * INCREMENTAL job tetikler — son DONE cursor'unu kullanır.
   * Idempotent (PENDING/RUNNING varsa atla). SMTP send sonrası "yeni mailim
   * SENT'te belirsin" gibi anlık tazeleme istekleri için.
   */
  async enqueueIncrementalForMailbox(mailboxAccountId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.mailboxSyncJob.findFirst({
        where: { mailboxAccountId, status: { in: ['PENDING', 'RUNNING'] } },
      });
      if (existing) return;

      const lastDone = await tx.mailboxSyncJob.findFirst({
        where: { mailboxAccountId, status: 'DONE' },
        orderBy: { finishedAt: 'desc' },
        select: { cursor: true },
      });

      await tx.mailboxSyncJob.create({
        data: {
          mailboxAccountId,
          type: 'INCREMENTAL',
          status: 'PENDING',
          cursor: lastDone?.cursor ?? null,
        },
      });
      this.logger.log(
        `Enqueued post-action INCREMENTAL sync for mailbox=${mailboxAccountId}`,
      );
    });
  }

  async processOnce(): Promise<void> {
    // 1) Stale RUNNING job'ları kurtar
    await this.recoverStaleRunningJobs();

    // 2) Süresi dolan hesaplar için incremental job aç
    await this.scheduleOverdueIncrementals();

    // 3) PENDING bir job seç (nextRetryAt vadesi geldiyse)
    const now = new Date();
    const job = await this.prisma.mailboxSyncJob.findFirst({
      where: {
        status: 'PENDING',
        OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!job) return;

    // Atomic claim
    const claimed = await this.prisma.mailboxSyncJob.updateMany({
      where: { id: job.id, status: 'PENDING' },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    if (claimed.count !== 1) return;

    try {
      const cursor = job.cursor ? this.parseCursor(job.cursor) : null;
      const newCursor = await this.syncAllFolders(job.mailboxAccountId, cursor);

      await this.prisma.mailboxSyncJob.update({
        where: { id: job.id },
        data: {
          status: 'DONE',
          finishedAt: new Date(),
          cursor: JSON.stringify(newCursor),
          // Başarı yolu: bir sonraki retry zamanlaması temizlensin
          nextRetryAt: null,
          errorMessage: null,
        },
      });
    } catch (err: any) {
      const errorMessage = String(err?.message ?? err);
      await this.handleSyncFailure(
        job.id,
        job.mailboxAccountId,
        job.attemptCount,
        errorMessage,
        err,
      );
    }
  }

  /**
   * Sync job hatası sonrası retry/backoff:
   * - attemptCount < MAX_ATTEMPTS → status PENDING + nextRetryAt = now + backoff
   * - >= MAX_ATTEMPTS → terminal FAILED (kullanıcı UI'dan / mailbox account'tan
   *   gerekirse manuel re-enqueue eder).
   *
   * Bu pattern olmadan IMAP credentials geçici eksik olduğu durumlarda her
   * saniye fail eden job log'u dolduruyordu.
   */
  private async handleSyncFailure(
    jobId: string,
    mailboxAccountId: string,
    currentAttemptCount: number,
    errorMessage: string,
    err: any,
  ): Promise<void> {
    const attemptCount = currentAttemptCount + 1;

    if (attemptCount >= MAX_ATTEMPTS) {
      await this.prisma.mailboxSyncJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          attemptCount,
          errorMessage,
        },
      });
      this.logger.error(
        `Sync job FAILED (terminal) id=${jobId} attempt=${attemptCount}/${MAX_ATTEMPTS}: ${errorMessage}`,
        err?.stack,
      );
      await this.maybeAutoPauseMailbox(mailboxAccountId);
      return;
    }

    const nextRetryAt = nextRetryDate(attemptCount);
    await this.prisma.mailboxSyncJob.update({
      where: { id: jobId },
      data: {
        status: 'PENDING',
        startedAt: null, // RUNNING damgası temizle (recovery query'sinden kurtul)
        attemptCount,
        nextRetryAt,
        errorMessage,
      },
    });
    this.logger.warn(
      `Sync retry scheduled id=${jobId} attempt=${attemptCount}/${MAX_ATTEMPTS} nextRetryAt=${nextRetryAt.toISOString()}: ${errorMessage}`,
    );
  }

  /**
   * Art arda N (default 3) FAILED terminal sync sonrası mailbox'ı otomatik
   * PAUSED'a çeker — credentials geçersizleşmiş / parola değişmiş hesaplar
   * her saatte bir tek kullanıcısız retry yapıp log spam'i yapmasın diye.
   *
   * - Sadece status='ACTIVE' iken devreye girer (idempotent updateMany).
   * - DONE araya girerse zincir kırılır → tekrar normalleşmiş demektir.
   * - Kullanıcı UI'dan "Devam ettir" diyince ACTIVE'e döner; sorun çözülmediyse
   *   3 fail sonra tekrar PAUSED olur.
   */
  private async maybeAutoPauseMailbox(mailboxAccountId: string): Promise<void> {
    const threshold = Number(process.env.MAILBOX_AUTO_PAUSE_THRESHOLD ?? 3);
    if (threshold <= 0) return;

    const recentTerminal = await this.prisma.mailboxSyncJob.findMany({
      where: {
        mailboxAccountId,
        status: { in: ['DONE', 'FAILED'] },
        finishedAt: { not: null },
      },
      orderBy: { finishedAt: 'desc' },
      take: threshold,
      select: { status: true },
    });

    if (recentTerminal.length < threshold) return;
    if (recentTerminal.some((j) => j.status !== 'FAILED')) return;

    const result = await this.prisma.mailboxAccount.updateMany({
      where: { id: mailboxAccountId, status: 'ACTIVE' },
      data: { status: 'PAUSED' },
    });

    if (result.count > 0) {
      this.logger.warn(
        `Auto-paused mailbox=${mailboxAccountId} after ${threshold} consecutive FAILED syncs.`,
      );
    }
  }

  /**
   * STALE_RUNNING_MS'den uzun süredir RUNNING durumunda olan job'ları PENDING'e
   * geri çeker. Worker crash sonrası kilitli kalan job'lar bu sayede bir sonraki
   * tick'te tekrar işlenir.
   */
  private async recoverStaleRunningJobs(): Promise<void> {
    const threshold = new Date(Date.now() - this.STALE_RUNNING_MS);

    const stale = await this.prisma.mailboxSyncJob.updateMany({
      where: {
        status: 'RUNNING',
        startedAt: { lt: threshold },
      },
      data: { status: 'PENDING', startedAt: null },
    });

    if (stale.count > 0) {
      this.logger.warn(`Recovered ${stale.count} stale RUNNING sync job(s).`);
    }
  }

  // ---------------------------------------------------------------------------

  private async syncAllFolders(
    mailboxAccountId: string,
    cursor: SyncCursor | null,
  ): Promise<SyncCursor> {
    const isInitial = cursor === null;

    // Klasörleri keşfet (IMAP'ten)
    let folders: FolderMeta[];
    try {
      folders = await this.imapProvider.discoverFolders(mailboxAccountId);
    } catch (err: any) {
      this.logger.warn(`Folder discovery failed, defaulting to INBOX only: ${err?.message}`);
      folders = [{ path: 'INBOX', type: 'INBOX' }];
    }

    const newCursor: SyncCursor = { ...(cursor ?? {}) };
    let totalFetched = 0;

    for (const folder of folders) {
      const sinceUid = cursor?.[folder.path];

      const { messages, maxUid } = await this.imapProvider.fetchFolder({
        mailboxAccountId,
        folder: folder.path,
        folderType: folder.type,
        sinceUid,
        limit: this.INITIAL_FETCH_LIMIT,
      });

      if (messages.length > 0) {
        const savedIds = await this.upsertMessages(mailboxAccountId, messages);
        totalFetched += messages.length;

        // AI analizi tetikle: yeni mesajlar için MESSAGE_SYNCED eventi
        await this.emitMessageSyncedEvent(mailboxAccountId, savedIds);
      }

      // Cursor'u güncelle (maxUid varsa veya zaten cursor'da değer varsa koru)
      if (maxUid !== null) newCursor[folder.path] = maxUid;
    }

    this.logger.log(
      `Sync complete mailbox=${mailboxAccountId} type=${isInitial ? 'INITIAL' : 'INCREMENTAL'} fetched=${totalFetched} folders=${folders.map(f => f.type).join(',')}`,
    );

    return newCursor;
  }

  /**
   * Mesajları DB'ye upsert eder.
   * Sadece CREATE edilen (yeni) mesajların id'lerini döner.
   * Update edilen mevcut mesajlar için AI analizi tekrar tetiklenmez.
   */
  private async upsertMessages(
    mailboxAccountId: string,
    messages: any[],
  ): Promise<string[]> {
    const newMessageIds: string[] = [];

    for (const m of messages) {
      // Önce var mı kontrol et
      const existing = await this.prisma.mailboxMessage.findUnique({
        where: {
          mailboxAccountId_providerMessageId: {
            mailboxAccountId,
            providerMessageId: m.providerMessageId,
          },
        },
        select: { id: true },
      });

      if (existing) {
        // Mevcut mesaj → sadece içerik güncelle, isRead dokunma
        await this.prisma.mailboxMessage.update({
          where: { id: existing.id },
          data: {
            folder: m.folder,
            from: m.from || null,
            to: (m.to ?? []).join(', '),
            subject: m.subject || null,
            date: m.date,
            snippet: m.snippet || null,
            bodyText: m.bodyText || null,
            bodyHtml: m.bodyHtml || null,
            icsRaw: m.icsRaw || null,
          },
        });
      } else {
        // Yeni mesaj → oluştur ve id kaydet
        const created = await this.prisma.mailboxMessage.create({
          data: {
            mailboxAccountId,
            providerMessageId: m.providerMessageId,
            folder: m.folder,
            from: m.from || null,
            to: (m.to ?? []).join(', '),
            subject: m.subject || null,
            date: m.date,
            snippet: m.snippet || null,
            bodyText: m.bodyText || null,
            bodyHtml: m.bodyHtml || null,
            icsRaw: m.icsRaw || null,
          },
          select: { id: true },
        });
        newMessageIds.push(created.id);
      }
    }

    return newMessageIds;
  }

  private async emitMessageSyncedEvent(
    mailboxAccountId: string,
    messageIds: string[],
  ): Promise<void> {
    if (messageIds.length === 0) return;

    // Mailbox'ın userId'sini al
    const account = await this.prisma.mailboxAccount.findUnique({
      where: { id: mailboxAccountId },
      select: { userId: true },
    });
    if (!account) return;

    await this.prisma.outboxEvent.create({
      data: {
        type: 'MESSAGE_SYNCED',
        payload: {
          mailboxAccountId,
          userId: account.userId,
          messageIds,
        },
      },
    });
  }

  /**
   * Tüm ACTIVE mailbox hesaplarını tarar.
   *
   * Son terminal job'a göre cooldown uygular:
   * - Son DONE → normal cooldown (30sn): yeni INCREMENTAL aç.
   * - Son FAILED → uzun cooldown (1 saat): credentials kaybolmuş hesaplar
   *   her saniye yeni FAILED job yaratıp log spam etmesin. Kullanıcı
   *   credentials'ı yeniden bağladığında bir sonraki tick'te devreye girer.
   * - Hiç job yok → atla (initial sync sadece activate akışında enqueue edilir).
   */
  private async scheduleOverdueIncrementals(): Promise<void> {
    const okCooldownMs = Number(process.env.MAILBOX_SYNC_COOLDOWN_MS ?? 30_000);
    const failedCooldownMs = Number(
      process.env.MAILBOX_SYNC_FAILED_COOLDOWN_MS ?? 60 * 60_000, // 1 saat
    );
    const now = Date.now();

    const accounts = await this.prisma.mailboxAccount.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true },
    });

    for (const account of accounts) {
      // Zaten PENDING veya RUNNING job varsa atla
      const hasPending = await this.prisma.mailboxSyncJob.findFirst({
        where: { mailboxAccountId: account.id, status: { in: ['PENDING', 'RUNNING'] } },
        select: { id: true },
      });
      if (hasPending) continue;

      // Son terminal job (DONE veya FAILED, en yenisi)
      const lastTerminal = await this.prisma.mailboxSyncJob.findFirst({
        where: {
          mailboxAccountId: account.id,
          status: { in: ['DONE', 'FAILED'] },
        },
        orderBy: { finishedAt: 'desc' },
        select: { status: true, finishedAt: true, cursor: true },
      });

      if (!lastTerminal?.finishedAt) continue; // hiç tamamlanmış sync yok

      const cooldownMs =
        lastTerminal.status === 'FAILED' ? failedCooldownMs : okCooldownMs;
      if (now - lastTerminal.finishedAt.getTime() < cooldownMs) continue;

      // Son cursor'u taşı (DONE'dan; FAILED'dan cursor güvenilmez bırakabiliriz
      // ama failed mailbox için son DONE cursor'unu da çek).
      const cursor =
        lastTerminal.status === 'DONE'
          ? lastTerminal.cursor
          : (
              await this.prisma.mailboxSyncJob.findFirst({
                where: { mailboxAccountId: account.id, status: 'DONE' },
                orderBy: { finishedAt: 'desc' },
                select: { cursor: true },
              })
            )?.cursor ?? null;

      await this.prisma.mailboxSyncJob.create({
        data: {
          mailboxAccountId: account.id,
          type: 'INCREMENTAL',
          status: 'PENDING',
          cursor,
        },
      });
      this.logger.log(
        `Scheduled INCREMENTAL sync for mailbox=${account.id}` +
          (lastTerminal.status === 'FAILED' ? ' (post-failure retry)' : ''),
      );
    }
  }

  private parseCursor(raw: string): SyncCursor {
    try {
      return JSON.parse(raw) as SyncCursor;
    } catch {
      return {};
    }
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      this.logger.log('Mailbox sync worker stopped.');
    }
  }
}
