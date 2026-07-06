import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { EmailAnalyzerService } from '../../ai/application/email-analyzer.service';
import { MailClassifierService } from '../../mail-classifier/mail-classifier.service';
import { ImapProvider, FolderType } from '../infrastructure/providers/imap/imap.provider';
import { ListMessagesDto } from './dto/list-messages.dto';

@Injectable()
export class MailboxMessagesService {
  private readonly logger = new Logger(MailboxMessagesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly analyzer: EmailAnalyzerService,
    private readonly classifier: MailClassifierService,
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
        // Liste'de paperclip ikonu için — bytea içerikleri yüklemeden
        // sadece sayım üzerinden hasAttachments türetiyoruz.
        _count: { select: { attachments: true } },
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

    const q = dto.q?.trim();

    // FTS path: `searchVector @@ websearch_to_tsquery(...)` — `websearch_to_tsquery`
    // doğal kullanıcı girdisi alır: tırnak içinde phrase, OR/AND operatörü,
    // - ile negate. Body text dahil ağırlıklı index taranır; sonuçlar
    // ts_rank ile rank'lanır, sonra date'e göre tie-break.
    //
    // Cursor pagination: FTS yolunda rank stable olmayabileceğinden saf
    // date keyset'i kullanıyoruz — son sayfanın "en yeni dönem" sonu cursor.
    if (q && q.length >= 2) {
      return this.searchAll(userId, dto, q, limit, order);
    }

    const where: any = { mailboxAccount: { userId } };
    if (dto.folder) where.folder = dto.folder;

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
        _count: { select: { attachments: true } },
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
   * FTS yolu — `searchVector @@ websearch_to_tsquery('simple', q)`.
   * `$queryRaw` ile çalışıyor: Prisma'nın `search` operatörü Postgres'te
   * tsvector kolonuna doğrudan match çıkarmıyor (functional index ister);
   * biz generated tsvector + GIN index üzerinden doğrudan operatörü
   * kullanıyoruz, optimizer'ın index seçeceği garantili.
   *
   * Dönüş şekli listAll'ın non-FTS path'i ile aynı: { items, nextCursor, hasMore }.
   * `mailboxAccount` ve `_count.attachments` ikinci query ile zenginleştirilir
   * (raw query'de relation join'i Prisma type-safe çıkmaz).
   */
  private async searchAll(
    userId: string,
    dto: ListMessagesDto,
    q: string,
    limit: number,
    order: 'asc' | 'desc',
  ) {
    const folder = dto.folder ?? null;
    const cursorDate = dto.cursor
      ? (await this.prisma.mailboxMessage.findUnique({
          where: { id: dto.cursor },
          select: { date: true },
        }))?.date ?? null
      : null;

    // Raw query — `$queryRaw` tagged template'i SQL injection'ı parametrize
    // ederek halleder. Folder ve cursorDate koşulu opsiyonel.
    type Row = { id: string; date: Date };
    const rows = await this.prisma.$queryRaw<Row[]>`
      SELECT m."id", m."date"
      FROM "MailboxMessage" m
      INNER JOIN "MailboxAccount" a ON a."id" = m."mailboxAccountId"
      WHERE a."userId" = ${userId}
        AND m."searchVector" @@ websearch_to_tsquery('simple', ${q})
        ${folder ? Prisma.sql`AND m."folder" = ${folder}` : Prisma.empty}
        ${
          cursorDate
            ? order === 'desc'
              ? Prisma.sql`AND m."date" < ${cursorDate}`
              : Prisma.sql`AND m."date" > ${cursorDate}`
            : Prisma.empty
        }
      ORDER BY
        ts_rank(m."searchVector", websearch_to_tsquery('simple', ${q})) DESC,
        m."date" ${order === 'desc' ? Prisma.sql`DESC` : Prisma.sql`ASC`}
      LIMIT ${limit + 1}
    `;

    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const ids = sliced.map((r) => r.id);

    // 2. faz: tam alanlarla yeniden çek. orderBy'ı manuel uygulayacağız çünkü
    // FTS rank sırasını korumalıyız.
    const fullMessages = await this.prisma.mailboxMessage.findMany({
      where: { id: { in: ids } },
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
        _count: { select: { attachments: true } },
        mailboxAccount: {
          select: { id: true, email: true, provider: true, displayName: true },
        },
      },
    });
    const byId = new Map(fullMessages.map((m) => [m.id, m]));
    const items = ids.map((id) => byId.get(id)).filter(Boolean);

    const nextCursor = hasMore ? ids[ids.length - 1] : null;
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
        // Liste'de paperclip ikonu için — bytea içerikleri yüklemeden
        // sadece sayım üzerinden hasAttachments türetiyoruz.
        _count: { select: { attachments: true } },
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

    const { bodyHtml, attachments } = await this.resolveInlineImages(
      messageId,
      message.bodyHtml,
    );

    return { ...message, bodyHtml, aiSummary: analysis?.summary ?? null, attachments };
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

    const { bodyHtml, attachments } = await this.resolveInlineImages(
      messageId,
      message.bodyHtml,
    );

    return { ...message, bodyHtml, aiSummary: analysis?.summary ?? null, attachments };
  }

  /**
   * Mail body HTML'inde `<img src="cid:xxx">` referanslarını DB'deki
   * `MailboxAttachment.contentId` ile eşleştirip `data:<mime>;base64,...`
   * URI'ye çevirir. Inline image olarak gömülen ekler dönen attachment
   * listesinden de çıkarılır — mail istemcilerinin yaptığı gibi imza/logo
   * gibi gömülü resimleri "ek" olarak göstermeyiz.
   *
   * Tasarım:
   *  - Önce yalnız metadata sorgusu — body'de cid: yoksa veya hiç image
   *    aday ek yoksa erken çık (bytea content okunmaz, kullanıcının
   *    indirme ihtimali olan büyük ekler boşuna belleğe yüklenmez).
   *  - cid match'i `<...>` parantezlerine bakılmaksızın yapılır (mail'de
   *    bazen `cid:abc@host`, header'da `<abc@host>` olabilir).
   *  - Bir ek inline olarak kullanıldı mı → replace fonksiyonu match
   *    bulduysa id'yi `usedIds` set'ine ekler.
   */
  private async resolveInlineImages(
    messageId: string,
    bodyHtml: string | null,
  ): Promise<{
    bodyHtml: string | null;
    attachments: Array<{
      id: string;
      filename: string;
      contentType: string;
      sizeBytes: number;
      contentId: string | null;
    }>;
  }> {
    const allMeta = await this.prisma.mailboxAttachment.findMany({
      where: { mailboxMessageId: messageId },
      select: { id: true, filename: true, contentType: true, sizeBytes: true, contentId: true },
      orderBy: { createdAt: 'asc' },
    });

    if (!bodyHtml || !/src\s*=\s*["']\s*cid:/i.test(bodyHtml)) {
      return { bodyHtml, attachments: allMeta };
    }

    const candidates = allMeta.filter(
      (a) => a.contentId && a.contentType.toLowerCase().startsWith('image/'),
    );
    if (candidates.length === 0) {
      return { bodyHtml, attachments: allMeta };
    }

    const withContent = await this.prisma.mailboxAttachment.findMany({
      where: { id: { in: candidates.map((c) => c.id) } },
      select: { id: true, contentId: true, contentType: true, content: true },
    });

    const stripBrackets = (s: string | null) => (s ?? '').replace(/^<|>$/g, '').trim().toLowerCase();
    type Loaded = { id: string; contentType: string; b64: string };
    const byCid = new Map<string, Loaded>();
    for (const c of withContent) {
      const cid = stripBrackets(c.contentId);
      if (!cid) continue;
      const buf = Buffer.isBuffer(c.content) ? c.content : Buffer.from(c.content as any);
      byCid.set(cid, { id: c.id, contentType: c.contentType, b64: buf.toString('base64') });
    }

    const usedIds = new Set<string>();
    const rewritten = bodyHtml.replace(
      /src\s*=\s*(["'])\s*cid:([^"']+?)\s*\1/gi,
      (match, quote: string, rawCid: string) => {
        const cid = stripBrackets(rawCid);
        const loaded = byCid.get(cid);
        if (!loaded) return match;
        usedIds.add(loaded.id);
        return `src=${quote}data:${loaded.contentType};base64,${loaded.b64}${quote}`;
      },
    );

    const attachments = allMeta.filter((a) => !usedIds.has(a.id));
    return { bodyHtml: rewritten, attachments };
  }

  /**
   * Mesajın bağlı olduğu thread'in tüm mesajlarını tarih sırasına göre döner.
   *
   * Anchor mesajın `threadId`'i null ise (eski kayıt veya tek başına mail)
   * sadece o mesajı dönen tek elemanlı liste verilir — UI "konuşma yok,
   * tek mesaj" olarak gösterebilir.
   *
   * Body alanları döner ki UI accordion açtığında ayrı getOne çağrısına
   * gerek kalmasın; ama büyük çıktı oluşmaması için bytea attachments
   * dahil edilmez (kullanıcı belirli bir mesajı açtığında getOne çağırır).
   */
  async getThread(userId: string, accountId: string, messageId: string) {
    await this.assertOwnership(userId, accountId);

    const anchor = await this.prisma.mailboxMessage.findUnique({
      where: { id: messageId },
      select: { id: true, mailboxAccountId: true, threadId: true },
    });
    if (!anchor) throw new NotFoundException('Message not found.');
    if (anchor.mailboxAccountId !== accountId) throw new ForbiddenException();

    if (!anchor.threadId) {
      // Thread bilgisi yok → sadece kendisini dön. UI tarafı "konuşma yok"
      // yorumlayabilir.
      const single = await this.prisma.mailboxMessage.findUnique({
        where: { id: messageId },
        select: {
          id: true, subject: true, from: true, to: true, date: true,
          snippet: true, isRead: true, folder: true, messageIdHeader: true,
        },
      });
      return { threadId: null, items: single ? [single] : [] };
    }

    const items = await this.prisma.mailboxMessage.findMany({
      where: { mailboxAccountId: accountId, threadId: anchor.threadId },
      orderBy: { date: 'asc' },
      select: {
        id: true, subject: true, from: true, to: true, date: true,
        snippet: true, isRead: true, folder: true, messageIdHeader: true,
      },
    });

    return { threadId: anchor.threadId, items };
  }

  /**
   * Bir mesaj ekinin meta + ham içeriğini döner. Controller stream eder.
   * Ownership: önce mesaj kullanıcının hesabına bağlı mı kontrol edilir;
   * `accountId` verildiyse o hesaba ait olmasını da zorlar (path tutarlılığı).
   * Bulunamaz / yetkisiz → null.
   */
  async getAttachment(
    userId: string,
    messageId: string,
    attachmentId: string,
    accountId?: string,
  ): Promise<{ filename: string; contentType: string; content: Buffer } | null> {
    const att = await this.prisma.mailboxAttachment.findFirst({
      where: {
        id: attachmentId,
        mailboxMessageId: messageId,
        mailboxMessage: {
          mailboxAccount: { userId, ...(accountId ? { id: accountId } : {}) },
        },
      },
      select: { filename: true, contentType: true, content: true },
    });
    if (!att) return null;
    // Prisma `Bytes` → Node Buffer
    return {
      filename: att.filename,
      contentType: att.contentType,
      content: Buffer.isBuffer(att.content) ? att.content : Buffer.from(att.content as any),
    };
  }

  /**
   * Mesajın okundu/okunmadı durumunu set eder. Idempotent: hedef state zaten
   * sağlanmışsa DB/IMAP'e dokunulmaz. IMAP \Seen bayrağı fire-and-forget olarak
   * uzak sunucuya yansıtılır — ağ hatası lokal state'i bozmaz.
   */
  async setReadState(
    userId: string,
    accountId: string,
    messageId: string,
    isRead: boolean,
  ) {
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
    if (message.isRead === isRead) return { id: message.id, isRead }; // idempotent

    await this.prisma.mailboxMessage.update({
      where: { id: messageId },
      data: { isRead },
    });

    void this.syncReadFlagToRemote(accountId, message.providerMessageId, message.folder, isRead);

    return { id: messageId, isRead };
  }

  /** Geriye uyumluluk: markAsRead → setReadState(true). */
  async markAsRead(userId: string, accountId: string, messageId: string) {
    return this.setReadState(userId, accountId, messageId, true);
  }

  /** Mesajı okunmamış olarak işaretler (kullanıcı yanlışlıkla açtıysa geri alma). */
  async markAsUnread(userId: string, accountId: string, messageId: string) {
    return this.setReadState(userId, accountId, messageId, false);
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

    // Spam'a alınınca: maili SPAM klasörüne taşı + bekleyen AI analizini
    // iptal et + bu mesajdan üretilmiş PROPOSED önerileri (Task / CalendarEvent /
    // Reminder) otomatik reddet. Frontend onay modalını çoktan göstermiş
    // olduğundan burada ek konfirmasyon istemiyoruz.
    if (category === 'Spam') {
      await this.prisma.$transaction(async (tx) => {
        await tx.mailboxMessage.update({
          where: { id: messageId },
          data: { category, categoryConfidence: 1, folder: 'SPAM' },
        });

        // PENDING analizleri sil (henüz işlenmemiş — silmek en temizi).
        // PROCESSING/DONE/FAILED kalır; PROCESSING'in bitişi ne olursa olsun
        // ürettiği önerileri aşağıda CANCELLED'a çekiyoruz.
        await tx.aiAnalysis.deleteMany({
          where: { mailboxMessageId: messageId, status: 'PENDING' },
        });

        // Bu mesajdan üretilmiş PROPOSED öneriler reddedilmiş sayılsın.
        const analyses = await tx.aiAnalysis.findMany({
          where: { mailboxMessageId: messageId },
          select: { id: true },
        });
        const analysisIds = analyses.map((a) => a.id);
        if (analysisIds.length > 0) {
          await tx.task.updateMany({
            where: { aiAnalysisId: { in: analysisIds }, status: 'PROPOSED' },
            data: { status: 'CANCELLED' },
          });
          await tx.calendarEvent.updateMany({
            where: { aiAnalysisId: { in: analysisIds }, status: 'PROPOSED' },
            data: { status: 'CANCELLED' },
          });
          await tx.reminder.updateMany({
            where: { aiAnalysisId: { in: analysisIds }, status: 'PROPOSED' },
            data: { status: 'CANCELLED' },
          });
        }
      });

      return { id: messageId, category, categoryConfidence: 1, folder: 'SPAM' };
    }

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
  /**
   * Mesajı KALICI siler — hem uzak IMAP sunucusundan hem lokal DB'den.
   *
   * Güvenlik: sadece `folder === 'TRASH'` mesajlarda kabul edilir. Kullanıcı
   * önce Çöp'e taşımak zorunda; çift-tıklamayla gelen kutusundan kaybolmasın.
   * (UI tarafında da bu kural uygulanıyor.)
   *
   * IMAP silme başarısız olursa (ağ/auth hatası) lokal DB silinmesi yine
   * yapılır — kullanıcının "sildim" beklentisini bozmayalım. Bir sonraki
   * incremental sync zaten o UID'i göremeyeceği için tutarsızlık olmaz.
   * Cascade (Prisma schema): MailboxAttachment + AiAnalysis otomatik düşer.
   */
  async hardDelete(userId: string, accountId: string, messageId: string) {
    await this.assertOwnership(userId, accountId);

    const message = await this.prisma.mailboxMessage.findUnique({
      where: { id: messageId },
      select: {
        id: true,
        mailboxAccountId: true,
        providerMessageId: true,
        folder: true,
      },
    });
    if (!message) throw new NotFoundException('Message not found.');
    if (message.mailboxAccountId !== accountId) throw new ForbiddenException();
    if (message.folder !== 'TRASH') {
      throw new ForbiddenException('Mesaj kalıcı silinmeden önce Çöp Kutusu\'na taşınmalı.');
    }

    // IMAP — fire-but-await: hata logla, devam et.
    try {
      const [folderType, uidStr] = message.providerMessageId.split(':');
      const uid = Number(uidStr);
      if (folderType && Number.isFinite(uid)) {
        await this.imap.deleteMessage({
          mailboxAccountId: accountId,
          folderType: folderType as FolderType,
          uid,
        });
      } else {
        this.logger.warn(
          `hardDelete: malformed providerMessageId="${message.providerMessageId}" — IMAP atlandı`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `hardDelete IMAP failed (mailbox=${accountId}, msg=${messageId}): ${err?.message ?? err}`,
      );
    }

    await this.prisma.mailboxMessage.delete({ where: { id: messageId } });

    return { id: messageId, deleted: true };
  }

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
        // Liste'de paperclip ikonu için — bytea içerikleri yüklemeden
        // sadece sayım üzerinden hasAttachments türetiyoruz.
        _count: { select: { attachments: true } },
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

    // Mevcut DONE ve gerçek summary varsa onu döndür — yeniden işleme gerek yok.
    const existing = await this.prisma.aiAnalysis.findFirst({
      where: { mailboxMessageId: messageId, userId, status: 'DONE' },
      select: { id: true, summary: true },
    });
    if (existing?.summary) {
      return { analysisId: existing.id, summary: existing.summary };
    }

    // Bu mail için herhangi bir AiAnalysis var mı? (mailboxMessageId @unique
    // olduğundan en fazla bir kayıt olur.) Varsa PENDING'e resetle; yoksa oluştur.
    // Aksi halde ikinci tıklamada unique-violation → 500 dönerdi.
    let analysisId: string;
    const any = await this.prisma.aiAnalysis.findFirst({
      where: { mailboxMessageId: messageId, userId },
      select: { id: true },
    });
    if (any) {
      await this.prisma.aiAnalysis.update({
        where: { id: any.id },
        data: { status: 'PENDING', errorMessage: null, summary: null, lockedAt: null },
      });
      analysisId = any.id;
    } else {
      const created = await this.prisma.aiAnalysis.create({
        data: { userId, mailboxMessageId: messageId, status: 'PENDING' },
      });
      analysisId = created.id;
    }

    // Process synchronously — kullanıcı manuel istediği için folder filtresini
    // bypass et (SPAM/TRASH mailler de özetlenebilsin).
    try {
      await this.analyzer.process(analysisId, { skipFolderFilter: true });
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

  /**
   * Kullanıcının TÜM mailbox hesaplarındaki TÜM mesajları sınıflandırıcıya
   * yeniden gönderir ve `category` + `categoryConfidence` alanlarını günceller.
   *
   * Kullanım: model yenilendiğinde (örn. TF-IDF → BERTurk geçişi) eski
   * kategorileri gerçek veri üzerinde sıfırdan üretmek.
   *
   * Tasarım:
   *  - Mesajlar küçük chunk'larda (CONCURRENCY adet) paralel sınıflandırılır.
   *    BERT inference sunucusu tek model üzerinden çalıştığı için aşırı
   *    paralellik fayda etmez; 5 yeterli.
   *  - `force=false` (varsayılan): manuel düzeltilen mesajlar
   *    (categoryConfidence === 1) atlanır — kullanıcı eli değmiş etiketi
   *    modelin ezmesi yanlış olur.
   *  - `force=true`: hiçbir şey atlanmaz, TÜM mesajlar yeniden etiketlenir.
   *    Manuel düzeltmeleri sıfırlamak için kullanılır.
   *  - Body olarak `bodyText` yoksa `snippet` kullanılır (sync worker'la aynı).
   */
  async reclassifyAllForUser(userId: string, force = false): Promise<{
    total: number;
    classified: number;
    skipped: number;
    failed: number;
    durationMs: number;
  }> {
    const startedAt = Date.now();
    const CONCURRENCY = 5;

    const messages = await this.prisma.mailboxMessage.findMany({
      where: { mailboxAccount: { userId } },
      select: { id: true, subject: true, bodyText: true, snippet: true, from: true, categoryConfidence: true },
    });

    const total = messages.length;
    let classified = 0;
    let skipped = 0;
    let failed = 0;

    this.logger.log(`reclassifyAll: user=${userId} total=${total} concurrency=${CONCURRENCY}`);

    const processOne = async (m: (typeof messages)[number]) => {
      // force=false ise manuel düzeltilmiş mesajları atla
      if (!force && m.categoryConfidence === 1) {
        skipped += 1;
        return;
      }
      const body = m.bodyText ?? m.snippet ?? null;
      const result = await this.classifier.classify({ subject: m.subject ?? null, body, from: m.from ?? null });
      if (!result) {
        failed += 1;
        return;
      }
      try {
        await this.prisma.mailboxMessage.update({
          where: { id: m.id },
          data: { category: result.category, categoryConfidence: result.confidence },
        });
        classified += 1;
      } catch (err: any) {
        this.logger.warn(`reclassify update failed for ${m.id}: ${err?.message ?? err}`);
        failed += 1;
      }
    };

    // CONCURRENCY adet paralel chunk'larla işle
    for (let i = 0; i < messages.length; i += CONCURRENCY) {
      const chunk = messages.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(processOne));
    }

    const durationMs = Date.now() - startedAt;
    this.logger.log(
      `reclassifyAll: done user=${userId} total=${total} classified=${classified} skipped=${skipped} failed=${failed} duration=${durationMs}ms`,
    );

    return { total, classified, skipped, failed, durationMs };
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
