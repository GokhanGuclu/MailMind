import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { EmailAnalyzerService } from '../../ai/application/email-analyzer.service';
import { ImapProvider, FolderType } from '../infrastructure/providers/imap/imap.provider';
import { ListMessagesDto } from './dto/list-messages.dto';

@Injectable()
export class MailboxMessagesService {
  private readonly logger = new Logger(MailboxMessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analyzer: EmailAnalyzerService,
    private readonly imap: ImapProvider,
  ) {}

  /**
   * Bir mailbox hesabına ait mesajları listeler.
   * Cursor-based pagination: cursor = son sayfanın en eski/en yeni mesajının date+id çifti.
   * Basit implementasyon: cursor = son mesajın `id`'si, skip+take yerine id-based keyset.
   */
  async list(userId: string, accountId: string, dto: ListMessagesDto) {
    await this.assertOwnership(userId, accountId);

    const limit = dto.limit ?? 50;
    const order = dto.order ?? 'desc';

    const where: any = { mailboxAccountId: accountId };
    if (dto.folder) where.folder = dto.folder;

    // Cursor-based pagination: cursor = mesajın `id`si
    // desc sıralamada: cursor'dan KÜÇÜK id'leri getir (daha eski)
    // asc sıralamada: cursor'dan BÜYÜK id'leri getir (daha yeni)
    if (dto.cursor) {
      const cursorMsg = await this.prisma.mailboxMessage.findUnique({
        where: { id: dto.cursor },
        select: { date: true },
      });
      if (cursorMsg) {
        if (order === 'desc') {
          where.date = { lt: cursorMsg.date };
        } else {
          where.date = { gt: cursorMsg.date };
        }
      }
    }

    const messages = await this.prisma.mailboxMessage.findMany({
      where,
      orderBy: { date: order },
      take: limit + 1, // bir fazla al → nextCursor var mı kontrol et
      select: {
        id: true,
        mailboxAccountId: true,
        providerMessageId: true,
        folder: true,
        from: true,
        to: true,
        subject: true,
        date: true,
        snippet: true,
        isRead: true,
        isStarred: true,
        category: true,
        categoryConfidence: true,
        createdAt: true,
      },
    });

    const hasMore = messages.length > limit;
    const items = hasMore ? messages.slice(0, limit) : messages;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    return { items, nextCursor, hasMore };
  }

  /**
   * Kullanıcının tüm mailbox hesaplarından gelen mesajları birleşik tek bir
   * listede döner ("Tüm Gelen Kutusu" görünümü). Cursor pagination tek
   * `date` keyset'i üstünden yürür; çok-hesaplı ortamda iki mesajın aynı
   * date'e sahip olma ihtimali ihmal edilebilir düzeydedir.
   *
   * Her item, hangi hesaba ait olduğunu UI'da rozet/etiket gösterebilmek
   * için `mailboxAccount: { id, email, provider, displayName }` içerir.
   */
  async listAll(userId: string, dto: ListMessagesDto) {
    const limit = dto.limit ?? 50;
    const order = dto.order ?? 'desc';

    const where: any = { mailboxAccount: { userId } };
    if (dto.folder) where.folder = dto.folder;

    // Serbest metin araması: from / to / subject / snippet üstünde
    // case-insensitive substring. Boş/whitespace ise yok say.
    const q = dto.q?.trim();
    if (q) {
      where.OR = [
        { from: { contains: q, mode: 'insensitive' } },
        { to: { contains: q, mode: 'insensitive' } },
        { subject: { contains: q, mode: 'insensitive' } },
        { snippet: { contains: q, mode: 'insensitive' } },
      ];
    }

    if (dto.cursor) {
      const cursorMsg = await this.prisma.mailboxMessage.findUnique({
        where: { id: dto.cursor },
        select: { date: true },
      });
      if (cursorMsg) {
        where.date = order === 'desc' ? { lt: cursorMsg.date } : { gt: cursorMsg.date };
      }
    }

    const messages = await this.prisma.mailboxMessage.findMany({
      where,
      orderBy: { date: order },
      take: limit + 1,
      select: {
        id: true,
        mailboxAccountId: true,
        providerMessageId: true,
        folder: true,
        from: true,
        to: true,
        subject: true,
        date: true,
        snippet: true,
        isRead: true,
        isStarred: true,
        category: true,
        categoryConfidence: true,
        createdAt: true,
        mailboxAccount: {
          select: { id: true, email: true, provider: true, displayName: true },
        },
      },
    });

    const hasMore = messages.length > limit;
    const items = hasMore ? messages.slice(0, limit) : messages;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    return { items, nextCursor, hasMore };
  }

  /**
   * Kullanıcının tüm hesaplarındaki yıldızlı mesajları birleşik döner.
   */
  async listAllStarred(userId: string, dto: ListMessagesDto) {
    const limit = dto.limit ?? 50;
    const order = dto.order ?? 'desc';

    const where: any = { mailboxAccount: { userId }, isStarred: true };

    if (dto.cursor) {
      const cursorMsg = await this.prisma.mailboxMessage.findUnique({
        where: { id: dto.cursor },
        select: { date: true },
      });
      if (cursorMsg) {
        where.date = order === 'desc' ? { lt: cursorMsg.date } : { gt: cursorMsg.date };
      }
    }

    const messages = await this.prisma.mailboxMessage.findMany({
      where,
      orderBy: { date: order },
      take: limit + 1,
      select: {
        id: true,
        mailboxAccountId: true,
        providerMessageId: true,
        folder: true,
        from: true,
        to: true,
        subject: true,
        date: true,
        snippet: true,
        isRead: true,
        isStarred: true,
        category: true,
        categoryConfidence: true,
        createdAt: true,
        mailboxAccount: {
          select: { id: true, email: true, provider: true, displayName: true },
        },
      },
    });

    const hasMore = messages.length > limit;
    const items = hasMore ? messages.slice(0, limit) : messages;
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1].id : null,
      hasMore,
    };
  }

  /**
   * Tekil mesaj detayı (bodyText + bodyHtml dahil).
   * Okundu olarak işaretlemez — kullanıcı açıkça PATCH yapar.
   */
  async getOne(userId: string, accountId: string, messageId: string) {
    await this.assertOwnership(userId, accountId);

    const message = await this.prisma.mailboxMessage.findUnique({
      where: { id: messageId },
    });

    if (!message) throw new NotFoundException('Message not found.');
    if (message.mailboxAccountId !== accountId) throw new ForbiddenException();

    // Mevcut DONE AI özetini ekle
    const analysis = await this.prisma.aiAnalysis.findFirst({
      where: { mailboxMessageId: messageId, userId, status: 'DONE' },
      select: { summary: true },
      orderBy: { processedAt: 'desc' },
    });

    return { ...message, aiSummary: analysis?.summary ?? null };
  }

  /**
   * accountId bilinmeden tek mesaj getir. Compose'da Yanıtla/Yönlendir akışı
   * orijinal mailin hangi hesaba ait olduğunu bilmeden URL üzerinden hidrate
   * yapabilsin diye var. Mesajın sahibi olduğumuz hesaba ait olduğunu
   * MailboxAccount.userId join'i ile doğruluyoruz; başka kullanıcının
   * mesajıysa null döner (controller 404 atar).
   */
  async getOneByIdForUser(userId: string, messageId: string) {
    const message = await this.prisma.mailboxMessage.findFirst({
      where: { id: messageId, mailboxAccount: { userId } },
    });
    if (!message) return null;

    const analysis = await this.prisma.aiAnalysis.findFirst({
      where: { mailboxMessageId: messageId, userId, status: 'DONE' },
      select: { summary: true },
      orderBy: { processedAt: 'desc' },
    });
    return { ...message, aiSummary: analysis?.summary ?? null };
  }

  /**
   * Mesajı okundu olarak işaretler.
   */
  async markAsRead(userId: string, accountId: string, messageId: string) {
    await this.assertOwnership(userId, accountId);

    const message = await this.prisma.mailboxMessage.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        mailboxAccountId: true,
        isRead: true,
        providerMessageId: true,
        folder: true,
      },
    });

    if (!message) throw new NotFoundException('Message not found.');
    if (message.mailboxAccountId !== accountId) throw new ForbiddenException();
    if (message.isRead) return { id: message.id, isRead: true }; // idempotent

    await this.prisma.mailboxMessage.update({
      where: { id: messageId },
      data: { isRead: true },
    });

    // Karşı tarafı (Gmail / IMAP sunucusu) da okundu olarak işaretle.
    // Fire-and-forget: ağ sorunu yaşasak bile yerel DB state'i tutarlı kalsın.
    void this.syncReadFlagToRemote(accountId, message.providerMessageId, message.folder, true);

    return { id: messageId, isRead: true };
  }

  /**
   * providerMessageId formatı: `${folderType}:${uid}` (bkz. ImapProvider.fetchFolder).
   * Bu fonksiyon UID'yi ayıklayıp uzak IMAP sunucusuna \Seen bayrağını yansıtır.
   */
  private async syncReadFlagToRemote(
    mailboxAccountId: string,
    providerMessageId: string,
    folder: string,
    isRead: boolean,
  ): Promise<void> {
    try {
      const [folderType, uidStr] = providerMessageId.split(':');
      const uid = Number(uidStr);
      if (!folderType || !Number.isFinite(uid)) {
        this.logger.warn(
          `syncReadFlagToRemote: malformed providerMessageId="${providerMessageId}"`,
        );
        return;
      }
      await this.imap.setReadFlag({
        mailboxAccountId,
        folderType: folderType as FolderType,
        uid,
        isRead,
      });
    } catch (err: any) {
      this.logger.warn(
        `syncReadFlagToRemote failed (mailbox=${mailboxAccountId}, pmid=${providerMessageId}): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Okunmamış mesaj sayısını döner (badge için kullanışlı).
   */
  async unreadCount(userId: string, accountId: string, folder?: string) {
    await this.assertOwnership(userId, accountId);

    const where: any = { mailboxAccountId: accountId, isRead: false };
    if (folder) where.folder = folder;

    const count = await this.prisma.mailboxMessage.count({ where });
    return { count };
  }

  /**
   * Mesajın yıldız durumunu değiştirir (toggle).
   */
  async toggleStar(userId: string, accountId: string, messageId: string) {
    await this.assertOwnership(userId, accountId);

    const message = await this.prisma.mailboxMessage.findUnique({
      where: { id: messageId },
      select: { id: true, mailboxAccountId: true, isStarred: true },
    });

    if (!message) throw new NotFoundException('Message not found.');
    if (message.mailboxAccountId !== accountId) throw new ForbiddenException();

    const newValue = !message.isStarred;
    await this.prisma.mailboxMessage.update({
      where: { id: messageId },
      data: { isStarred: newValue },
    });

    return { id: messageId, isStarred: newValue };
  }

  /**
   * Mesajın kategorisini manuel olarak günceller. Kullanıcı, sınıflandırıcının
   * yanlış tahminini düzeltebilir. `categoryConfidence` 1.0'a sabitlenir
   * (kullanıcı eli değdi → tam güven), böylece UI'da modelin güven yüzdesinden
   * ayırt edilebilir.
   */
  async updateCategory(
    userId: string,
    accountId: string,
    messageId: string,
    category: string,
  ) {
    await this.assertOwnership(userId, accountId);

    const message = await this.prisma.mailboxMessage.findUnique({
      where: { id: messageId },
      select: { id: true, mailboxAccountId: true },
    });
    if (!message) throw new NotFoundException('Message not found.');
    if (message.mailboxAccountId !== accountId) throw new ForbiddenException();

    await this.prisma.mailboxMessage.update({
      where: { id: messageId },
      data: { category, categoryConfidence: 1 },
    });

    return { id: messageId, category, categoryConfidence: 1 };
  }

  /**
   * Mesajı başka bir klasöre taşır (ör. INBOX → TRASH, TRASH → INBOX).
   * Silme ve geri alma akışlarının tek kapısı.
   */
  async moveToFolder(
    userId: string,
    accountId: string,
    messageId: string,
    folder: 'INBOX' | 'SENT' | 'TRASH' | 'SPAM',
  ) {
    await this.assertOwnership(userId, accountId);

    const message = await this.prisma.mailboxMessage.findUnique({
      where: { id: messageId },
      select: { id: true, mailboxAccountId: true, folder: true },
    });
    if (!message) throw new NotFoundException('Message not found.');
    if (message.mailboxAccountId !== accountId) throw new ForbiddenException();

    if (message.folder === folder) {
      return { id: messageId, folder };
    }

    await this.prisma.mailboxMessage.update({
      where: { id: messageId },
      data: { folder },
    });

    return { id: messageId, folder };
  }

  /**
   * Yıldızlı mesajları listeler (cursor-based pagination).
   */
  async listStarred(userId: string, accountId: string, dto: ListMessagesDto) {
    await this.assertOwnership(userId, accountId);

    const limit = dto.limit ?? 50;
    const order = dto.order ?? 'desc';

    const where: any = { mailboxAccountId: accountId, isStarred: true };

    if (dto.cursor) {
      const cursorMsg = await this.prisma.mailboxMessage.findUnique({
        where: { id: dto.cursor },
        select: { date: true },
      });
      if (cursorMsg) {
        where.date = order === 'desc' ? { lt: cursorMsg.date } : { gt: cursorMsg.date };
      }
    }

    const messages = await this.prisma.mailboxMessage.findMany({
      where,
      orderBy: { date: order },
      take: limit + 1,
      select: {
        id: true,
        mailboxAccountId: true,
        providerMessageId: true,
        folder: true,
        from: true,
        to: true,
        subject: true,
        date: true,
        snippet: true,
        isRead: true,
        isStarred: true,
        category: true,
        categoryConfidence: true,
        createdAt: true,
      },
    });

    const hasMore = messages.length > limit;
    const items = hasMore ? messages.slice(0, limit) : messages;
    const nextCursor = hasMore ? items[items.length - 1].id : null;

    return { items, nextCursor, hasMore };
  }

  /**
   * Mesaj için AI özeti üretir. Mevcut DONE analiz varsa onu döner.
   * PENDING/FAILED varsa resetler ve tekrar dener. Yoksa yeni oluşturur.
   */
  async summarize(userId: string, accountId: string, messageId: string) {
    await this.assertOwnership(userId, accountId);

    const message = await this.prisma.mailboxMessage.findUnique({
      where: { id: messageId },
      select: { id: true, mailboxAccountId: true },
    });
    if (!message) throw new NotFoundException('Message not found.');
    if (message.mailboxAccountId !== accountId) throw new ForbiddenException();

    // Check for existing DONE analysis
    const existing = await this.prisma.aiAnalysis.findFirst({
      where: { mailboxMessageId: messageId, userId, status: 'DONE' },
      select: { id: true, summary: true },
    });
    if (existing?.summary) {
      return { analysisId: existing.id, summary: existing.summary };
    }

    // Find or create a PENDING analysis
    let analysisId: string;
    const prev = await this.prisma.aiAnalysis.findFirst({
      where: { mailboxMessageId: messageId, userId, status: { in: ['PENDING', 'FAILED'] } },
      select: { id: true },
    });

    if (prev) {
      await this.prisma.aiAnalysis.update({
        where: { id: prev.id },
        data: { status: 'PENDING', errorMessage: null },
      });
      analysisId = prev.id;
    } else {
      const created = await this.prisma.aiAnalysis.create({
        data: { userId, mailboxMessageId: messageId, status: 'PENDING' },
      });
      analysisId = created.id;
    }

    // Process synchronously
    try {
      await this.analyzer.process(analysisId);
    } catch (err: any) {
      throw new InternalServerErrorException(`AI analysis failed: ${err?.message ?? err}`);
    }

    const result = await this.prisma.aiAnalysis.findUnique({
      where: { id: analysisId },
      select: { id: true, summary: true, status: true, errorMessage: true },
    });

    if (result?.status === 'FAILED') {
      throw new InternalServerErrorException(result.errorMessage ?? 'AI analysis failed');
    }

    return { analysisId: result?.id, summary: result?.summary ?? '' };
  }

  // ---------------------------------------------------------------------------

  private async assertOwnership(userId: string, accountId: string) {
    const account = await this.prisma.mailboxAccount.findUnique({
      where: { id: accountId },
      select: { userId: true },
    });
    if (!account) throw new NotFoundException('Mailbox account not found.');
    if (account.userId !== userId) throw new ForbiddenException();
  }
}
