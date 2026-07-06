import { Injectable, Logger } from '@nestjs/common';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { PrismaService } from '../../../../../shared/infrastructure/prisma/prisma.service';
import { CredentialCipher } from '../../../../../shared/infrastructure/security/credential-cipher';
import { ProviderAttachment, ProviderMessage } from '../mail-provider.interface';
import { ImapCredentials } from './imap.types';
import { GoogleTokenService } from '../oauth/google-token.service';

export type FolderType = 'INBOX' | 'SENT' | 'TRASH' | 'SPAM';

export type FolderMeta = {
  path: string;   // gerçek IMAP yolu, örn: "[Gmail]/Sent Mail"
  type: FolderType;
};

export type FolderSyncResult = {
  messages: ProviderMessage[];
  maxUid: number | null;
};

type ImapConnectConfig =
  | { mode: 'password'; creds: ImapCredentials }
  | { mode: 'xoauth2'; host: string; port: number; email: string; accessToken: string };

@Injectable()
export class ImapProvider {
  private readonly logger = new Logger(ImapProvider.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly googleTokens: GoogleTokenService,
  ) {}

  async discoverFolders(mailboxAccountId: string): Promise<FolderMeta[]> {
    const config = await this.resolveImapConfig(mailboxAccountId);
    const client = this.createClient(config);
    await client.connect();

    try {
      const list = await client.list();
      return this.mapFolders(list);
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  async fetchFolder(args: {
    mailboxAccountId: string;
    folder: string;
    folderType: FolderType;
    sinceUid?: number;
    limit?: number;
  }): Promise<FolderSyncResult> {
    const { mailboxAccountId, folder, folderType, sinceUid, limit = 100 } = args;

    const config = await this.resolveImapConfig(mailboxAccountId);
    const client = this.createClient(config);
    await client.connect();

    try {
      let lock: any;
      try {
        lock = await client.getMailboxLock(folder);
      } catch {
        this.logger.warn(`Folder "${folder}" not accessible for mailbox=${mailboxAccountId}`);
        return { messages: [], maxUid: null };
      }

      try {
        const mailboxInfo = client.mailbox as any;
        const total: number = mailboxInfo?.exists ?? 0;

        if (total === 0) return { messages: [], maxUid: null };

        const messages: ProviderMessage[] = [];
        let maxUid: number | null = null;

        const useUid = sinceUid !== undefined;
        const range = useUid
          ? `${sinceUid + 1}:*`
          : `${Math.max(1, total - limit + 1)}:${total}`;

        for await (const msg of client.fetch(
          range,
          { uid: true, envelope: true, internalDate: true, source: true },
          { uid: useUid },
        )) {
          const uid = Number(msg.uid);
          if (useUid && uid <= sinceUid!) continue;

          if (maxUid === null || uid > maxUid) maxUid = uid;

          const date = msg.internalDate instanceof Date
            ? msg.internalDate
            : new Date(msg.internalDate ?? Date.now());

          let subject = msg.envelope?.subject ?? '';
          let from = '';
          let to: string[] = [];

          if (msg.envelope?.from?.length) {
            const f = msg.envelope.from[0];
            from = f.address ? `${f.name ?? ''} <${f.address}>`.trim() : (f.name ?? '');
          }
          const fmtAddrs = (list: any[] | undefined): string[] =>
            (list ?? [])
              .map((t: any) => t.address ? `${t.name ?? ''} <${t.address}>`.trim() : (t.name ?? ''))
              .filter(Boolean);

          if (msg.envelope?.to?.length) to = fmtAddrs(msg.envelope.to);
          const cc = fmtAddrs((msg.envelope as any)?.cc);
          const bcc = fmtAddrs((msg.envelope as any)?.bcc);

          let snippet: string | undefined;
          let bodyText: string | undefined;
          let bodyHtml: string | undefined;
          let icsRaw: string | undefined;
          let attachments: ProviderAttachment[] | undefined;

          if (msg.source) {
            try {
              const parsed = await simpleParser(msg.source);
              subject = parsed.subject ?? subject;
              if (!from && parsed.from?.text) from = parsed.from.text;
              if (!to.length && parsed.to?.text) to = parsed.to.text.split(',').map((s) => s.trim());
              bodyText = parsed.text ?? undefined;
              bodyHtml = parsed.html ? String(parsed.html) : undefined;
              snippet = this.makeSnippet(parsed.text ?? parsed.html ?? '');

              const rawAtts = parsed.attachments ?? [];

              // Calendar invite (.ics) — Outlook/Google/iCloud tarafından
              // text/calendar attachment'ı olarak gelir; deterministik parser
              // için raw içeriği saklıyoruz. Birden fazla varsa ardışık.
              const isIcs = (a: typeof rawAtts[number]) => {
                const ct = (a.contentType ?? '').toLowerCase();
                const fn = (a.filename ?? '').toLowerCase();
                return ct.startsWith('text/calendar') || ct.startsWith('application/ics') || fn.endsWith('.ics');
              };

              const icsAttachments = rawAtts.filter(isIcs);
              if (icsAttachments.length > 0) {
                icsRaw = icsAttachments
                  .map((a) => (a.content instanceof Buffer ? a.content.toString('utf8') : String(a.content ?? '')))
                  .filter(Boolean)
                  .join('\n');
              }

              // .ics olmayan ekler — DB'ye `MailboxAttachment` olarak yazılır.
              // Dosya başı cap (varsayılan 10 MB) ve mesaj başı toplam cap
              // (varsayılan 25 MB) uygulanır. Cap'i geçen ekler tamamen
              // atlanır (meta bile yazılmaz) — kullanıcı için "yok" gibi
              // davranır. İleride büyük ek desteği için blob storage gerekli.
              const perFileCap = Number(process.env.MAIL_ATTACHMENT_MAX_BYTES ?? 10 * 1024 * 1024);
              const perMessageCap = Number(process.env.MAIL_ATTACHMENT_TOTAL_MAX_BYTES ?? 25 * 1024 * 1024);
              let totalSize = 0;
              const collected: ProviderAttachment[] = [];
              let idx = 0;
              for (const a of rawAtts) {
                idx += 1;
                if (isIcs(a)) continue;
                const buf = a.content instanceof Buffer
                  ? a.content
                  : (a.content ? Buffer.from(String(a.content)) : null);
                if (!buf || buf.length === 0) continue;
                if (buf.length > perFileCap) {
                  this.logger.warn(
                    `attachment skip (per-file cap): uid=${uid} name=${a.filename ?? `attachment-${idx}`} size=${buf.length}`,
                  );
                  continue;
                }
                if (totalSize + buf.length > perMessageCap) {
                  this.logger.warn(
                    `attachment skip (message cap reached): uid=${uid} stopped at idx=${idx}`,
                  );
                  break;
                }
                totalSize += buf.length;
                collected.push({
                  filename: a.filename ?? `attachment-${idx}`,
                  contentType: a.contentType ?? 'application/octet-stream',
                  sizeBytes: buf.length,
                  content: buf,
                  contentId: a.contentId ?? null,
                });
              }
              if (collected.length > 0) attachments = collected;
            } catch {
              // parse fail → envelope verisiyle devam
            }
          }

          // RFC 5322 Message-ID — yanıt zinciri için (`In-Reply-To` /
          // `References`). ImapFlow envelope'ta `messageId` field'ı açılı
          // parantezsiz dönebilir; SMTP header tarafında parantez şart
          // olduğundan normalize ediyoruz.
          const rawMid = msg.envelope?.messageId ?? null;
          const messageIdHeader = rawMid
            ? rawMid.startsWith('<')
              ? rawMid
              : `<${rawMid}>`
            : null;

          // Envelope ImapFlow tarafında In-Reply-To içerir; References'ı ham
          // headers'tan parser ile çekiyoruz. Outlook/Apple bazen
          // References'ı vermez, sadece In-Reply-To gelir.
          const envInReplyTo: string | undefined = (msg.envelope as any)?.inReplyTo;
          let inReplyTo: string | null = envInReplyTo
            ? (envInReplyTo.startsWith('<') ? envInReplyTo : `<${envInReplyTo}>`)
            : null;
          let references: string | null = null;
          try {
            if (msg.source) {
              // simpleParser zaten yukarıda çağrıldıysa onun `parsed`'ından
              // alabilirdik; ama bu blok try/catch'in dışında — yeniden
              // çağırmak yerine kısa yoldan header'ları regex'le çekiyoruz.
              const head = msg.source.toString('utf8', 0, Math.min(msg.source.length, 8192));
              if (!inReplyTo) {
                const m = head.match(/^In-Reply-To:\s*(<[^>]+>)/im);
                if (m) inReplyTo = m[1];
              }
              const refM = head.match(/^References:\s*((?:<[^>]+>\s*)+)/im);
              if (refM) {
                references = refM[1].replace(/\s+/g, ' ').trim();
              }
            }
          } catch {
            // header parse fail → null'larla devam
          }

          messages.push({
            providerMessageId: `${folderType}:${uid}`,
            messageIdHeader,
            inReplyTo,
            references,
            folder: folderType,
            from,
            to,
            cc,
            bcc,
            subject,
            date,
            snippet,
            bodyText,
            bodyHtml,
            icsRaw,
            attachments,
          });
        }

        return { messages, maxUid };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  /**
   * Bir mesajı uzak IMAP sunucusunda \Seen bayrağı ile okundu olarak işaretler.
   * Gmail/IMAP'te bu bayrak "okundu" anlamına gelir, karşı tarafa da yansır.
   * `folderType` üzerinden gerçek klasör yolunu (ör. "[Gmail]/Sent Mail")
   * discoverFolders ile bulur — özellikle Gmail için INBOX harici klasörlerde şart.
   */
  async setReadFlag(args: {
    mailboxAccountId: string;
    folderType: FolderType;
    uid: number;
    isRead: boolean;
  }): Promise<void> {
    const { mailboxAccountId, folderType, uid, isRead } = args;

    const folders = await this.discoverFolders(mailboxAccountId);
    const target = folders.find((f) => f.type === folderType);
    const folderPath = target?.path ?? (folderType === 'INBOX' ? 'INBOX' : null);
    if (!folderPath) {
      throw new Error(`No folder path found for type=${folderType}`);
    }

    const config = await this.resolveImapConfig(mailboxAccountId);
    const client = this.createClient(config);
    await client.connect();

    try {
      let lock: any;
      try {
        lock = await client.getMailboxLock(folderPath);
      } catch (err) {
        this.logger.warn(
          `setReadFlag: folder "${folderPath}" not accessible for mailbox=${mailboxAccountId}`,
        );
        return;
      }

      try {
        const op = isRead ? 'messageFlagsAdd' : 'messageFlagsRemove';
        await (client as any)[op](String(uid), ['\\Seen'], { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  /**
   * Mesajı uzak IMAP sunucusundan kalıcı siler:
   *   1) `\Deleted` bayrağını ekle
   *   2) `expunge` ile bayraklı mesajları temizle
   *
   * Gmail için bu kombinasyon "Trash"e taşımak değil, hesap geneli silmektir
   * (Gmail'in özel All Mail/Trash semantiği nedeniyle UI'da yine de yalnızca
   * TRASH klasöründen tetikliyoruz). Klasör erişilemezse no-op + warn —
   * lokal DB silinmesini engellemiyor.
   */
  async deleteMessage(args: {
    mailboxAccountId: string;
    folderType: FolderType;
    uid: number;
  }): Promise<void> {
    const { mailboxAccountId, folderType, uid } = args;

    const folders = await this.discoverFolders(mailboxAccountId);
    const target = folders.find((f) => f.type === folderType);
    const folderPath = target?.path ?? (folderType === 'INBOX' ? 'INBOX' : null);
    if (!folderPath) {
      this.logger.warn(`deleteMessage: no folder path for type=${folderType}`);
      return;
    }

    const config = await this.resolveImapConfig(mailboxAccountId);
    const client = this.createClient(config);
    await client.connect();

    try {
      let lock: any;
      try {
        lock = await client.getMailboxLock(folderPath);
      } catch {
        this.logger.warn(
          `deleteMessage: folder "${folderPath}" not accessible (mailbox=${mailboxAccountId})`,
        );
        return;
      }

      try {
        await (client as any).messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true });
        // ImapFlow expunge'i sadece bayraklı mesajları siler. uid range
        // verirsek diğer bayraklı eski silmeler de tetiklenmez.
        await (client as any).messageDelete(String(uid), { uid: true });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------

  private createClient(config: ImapConnectConfig): ImapFlow {
    const isDev = (process.env.NODE_ENV ?? 'development') === 'development';
    const tls = isDev ? { rejectUnauthorized: false } : undefined;

    // Sunucudan ilk yanıt + idle socket için hard timeout. Bunlar olmadan
    // ölen TLS bağlantısı pending operation'ı sonsuza kadar tutuyor → job
    // 5dk recovery eşiğine kadar RUNNING'de kalıyor.
    const greetingTimeout = 30_000;
    const socketTimeout = 120_000;

    const opts =
      config.mode === 'xoauth2'
        ? {
            host: config.host,
            port: config.port,
            secure: true,
            auth: { user: config.email, accessToken: config.accessToken },
            logger: false,
            tls,
            greetingTimeout,
            socketTimeout,
          }
        : {
            host: config.creds.host,
            port: config.creds.port,
            secure: config.creds.secure,
            auth: { user: config.creds.username, pass: config.creds.password },
            logger: false,
            tls,
            greetingTimeout,
            socketTimeout,
          };

    const client = new ImapFlow(opts as any);

    // ImapFlow EventEmitter'dır. TLS socket koptuğunda (ECONNRESET vb.)
    // 'error' event yayar; listener yoksa Node tüm process'i çökertir →
    // worker yarım kalır, job RUNNING'de takılı kalır. Listener pending
    // operation promise'ini zaten reject ediyor; bizim için event sadece
    // log olsun yeter — bağımsız crash'i engelliyoruz.
    client.on('error', (err: any) => {
      this.logger.warn(`IMAP socket error: ${err?.code ?? ''} ${err?.message ?? err}`);
    });
    client.on('close', () => {
      // Beklenen logout sonrası da fırlar; sessiz tutuyoruz.
    });

    return client;
  }

  /**
   * Determines the connection mode based on the MailboxAccount provider.
   * - GMAIL → XOAUTH2 (access token from MailboxCredential, refresh if expired)
   * - ICLOUD / IMAP → standard password auth (iCloud için app-specific password)
   */
  private async resolveImapConfig(mailboxAccountId: string): Promise<ImapConnectConfig> {
    const account = await this.prisma.mailboxAccount.findUnique({
      where: { id: mailboxAccountId },
      select: { provider: true, email: true },
    });

    if (!account) throw new Error(`MailboxAccount not found: ${mailboxAccountId}`);

    if (account.provider === 'GMAIL') {
      return this.resolveGmailOAuth(mailboxAccountId, account.email);
    }

    // Fallback: standard IMAP password auth
    return { mode: 'password', creds: await this.loadImapCredentials(mailboxAccountId) };
  }

  private async resolveGmailOAuth(
    mailboxAccountId: string,
    email: string,
  ): Promise<ImapConnectConfig> {
    const accessToken = await this.googleTokens.getFreshAccessToken(mailboxAccountId);
    return {
      mode: 'xoauth2',
      host: 'imap.gmail.com',
      port: 993,
      email,
      accessToken,
    };
  }

  private mapFolders(list: any[]): FolderMeta[] {
    const result: FolderMeta[] = [];
    let hasInbox = false;

    for (const item of list) {
      const flags: Set<string> = item.flags ?? new Set();
      const path: string = item.path ?? item.name ?? '';

      if (flags.has('\\Noselect') || !path) continue;

      const upperPath = path.toUpperCase();
      const upperName = (item.name ?? '').toUpperCase();

      if (upperPath === 'INBOX') {
        result.push({ path, type: 'INBOX' });
        hasInbox = true;
      } else if (flags.has('\\Sent') || upperName === 'SENT' || upperName === 'SENT ITEMS' || upperName === 'SENT MESSAGES') {
        result.push({ path, type: 'SENT' });
      } else if (flags.has('\\Trash') || upperName === 'TRASH' || upperName === 'DELETED' || upperName === 'DELETED ITEMS') {
        result.push({ path, type: 'TRASH' });
      } else if (flags.has('\\Junk') || flags.has('\\Spam') || upperName === 'SPAM' || upperName === 'JUNK' || upperName === 'JUNK EMAIL') {
        result.push({ path, type: 'SPAM' });
      }
    }

    if (!hasInbox) result.unshift({ path: 'INBOX', type: 'INBOX' });

    return result;
  }

  private makeSnippet(input: string): string {
    // mailparser HTML→text dönüşümünde <img alt="X"> tag'lerini "[image: X]"
    // olarak yazıyor; inline cid referansları ve mailto/url referansları da
    // köşeli parantez içinde kalıyor. Snippet'te bu placeholder'lar bilgi
    // taşımıyor, gürültü oluşturuyor — temizliyoruz.
    const text = input
      .replace(/<\/?[^>]+(>|$)/g, '')          // HTML tag'lerini söküp at
      .replace(/\[image:[^\]]*\]/gi, '')        // [image: alt-text]
      .replace(/\[cid:[^\]]*\]/gi, '')          // [cid:...]
      .replace(/\s+/g, ' ')
      .trim();
    return text.length > 160 ? text.slice(0, 160) : text;
  }

  private async loadImapCredentials(mailboxAccountId: string): Promise<ImapCredentials> {
    const cred = await this.prisma.mailboxCredential.findUnique({
      where: { mailboxAccountId },
      select: { imapHost: true, imapPort: true, imapUsername: true, imapPasswordEnc: true },
    });

    if (!cred?.imapPasswordEnc) {
      throw new Error(`IMAP credentials not found for mailboxAccountId=${mailboxAccountId}`);
    }

    return {
      host: cred.imapHost ?? (() => { throw new Error('IMAP host missing'); })(),
      port: Number(cred.imapPort ?? 993),
      secure: true,
      username: cred.imapUsername ?? (() => { throw new Error('IMAP username missing'); })(),
      password: this.cipher.decrypt(cred.imapPasswordEnc),
    };
  }
}
