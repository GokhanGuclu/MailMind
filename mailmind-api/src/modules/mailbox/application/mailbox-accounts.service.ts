import { PrismaService } from '../../../shared/infrastructure/prisma/prisma.service';
import { CredentialCipher } from '../../../shared/infrastructure/security/credential-cipher';
import { CreateMailboxAccountDto } from './dto/create-mailbox-account.dto';
import { BadRequestException, ForbiddenException, NotFoundException, Injectable, ConflictException } from '@nestjs/common';
import { ActivateMailboxAccountDto } from './dto/activate-mailbox-account.dto';
import { MailProvider } from '@prisma/client';

/**
 * Provider'a göre varsayılan IMAP/SMTP host/port/username bilgileri.
 * iCloud kullanıcısı sadece app-specific password girer; host/port'u
 * kendimiz doldururuz. Gmail XOAUTH2 ile gittiği için burada listelenmez.
 */
type ProviderDefaults = {
  imapHost?: string;
  imapPort?: number;
  imapUsername?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUsername?: string;
  /** true ise: kullanıcı sadece imapPassword girdiyse aynısı SMTP'ye mirror'lanır. */
  mirrorImapPasswordToSmtp?: boolean;
};

function providerDefaults(provider: MailProvider, email: string): ProviderDefaults | null {
  if (provider === 'ICLOUD') {
    return {
      imapHost: 'imap.mail.me.com',
      imapPort: 993,
      imapUsername: email,
      smtpHost: 'smtp.mail.me.com',
      smtpPort: 587,
      smtpUsername: email,
      mirrorImapPasswordToSmtp: true,
    };
  }
  return null;
}

@Injectable()
export class MailboxAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
  ) {}


  async activate(userId: string, accountId: string, dto: ActivateMailboxAccountDto) {
    const acc = await this.prisma.mailboxAccount.findUnique({
      where: { id: accountId },
      select: { id: true, userId: true, provider: true, email: true },
    });
    if (!acc) throw new NotFoundException('Mailbox account not found.');
    if (acc.userId !== userId) throw new ForbiddenException();

    const hasOauth = !!dto.accessToken || !!dto.refreshToken;
    const hasImap = !!dto.imapHost || !!dto.imapUsername || !!dto.imapPassword;

    if (!hasOauth && !hasImap) {
      throw new BadRequestException('Provide OAuth tokens or IMAP credentials.');
    }

    // iCloud için: kullanıcı sadece app-specific password (+ opsiyonel email) verir;
    // host/port/username alanlarını sunucu otomatik doldurur. Apple ID = IMAP/SMTP
    // username, app password hem IMAP hem SMTP için aynıdır.
    const defaults = providerDefaults(acc.provider, acc.email);
    const imapHost = dto.imapHost ?? defaults?.imapHost ?? null;
    const imapPort = dto.imapPort ?? defaults?.imapPort ?? null;
    const imapUsername = dto.imapUsername ?? defaults?.imapUsername ?? null;
    const smtpHost = dto.smtpHost ?? defaults?.smtpHost ?? null;
    const smtpPort = dto.smtpPort ?? defaults?.smtpPort ?? null;
    const smtpUsername = dto.smtpUsername ?? defaults?.smtpUsername ?? null;
    const smtpPasswordPlain = dto.smtpPassword ?? (defaults?.mirrorImapPasswordToSmtp ? dto.imapPassword : undefined);

    const tokenExpiresAt = dto.tokenExpiresAt ? new Date(dto.tokenExpiresAt) : null;
    const imapPasswordEnc = dto.imapPassword ? this.cipher.encrypt(dto.imapPassword) : null;
    const smtpPasswordEnc = smtpPasswordPlain ? this.cipher.encrypt(smtpPasswordPlain) : null;

    return this.prisma.$transaction(async (tx) => {
      await tx.mailboxCredential.upsert({
        where: { mailboxAccountId: acc.id },
        create: {
          mailboxAccountId: acc.id,
          accessToken: dto.accessToken ?? null,
          refreshToken: dto.refreshToken ?? null,
          tokenExpiresAt,
          imapHost,
          imapPort,
          imapUsername,
          imapPasswordEnc,
          smtpHost,
          smtpPort,
          smtpUsername,
          smtpPasswordEnc,
        },
        update: {
          accessToken: dto.accessToken ?? undefined,
          refreshToken: dto.refreshToken ?? undefined,
          tokenExpiresAt: tokenExpiresAt ?? undefined,
          imapHost: imapHost ?? undefined,
          imapPort: imapPort ?? undefined,
          imapUsername: imapUsername ?? undefined,
          imapPasswordEnc: imapPasswordEnc ?? undefined,
          smtpHost: smtpHost ?? undefined,
          smtpPort: smtpPort ?? undefined,
          smtpUsername: smtpUsername ?? undefined,
          smtpPasswordEnc: smtpPasswordEnc ?? undefined,
        },
      });

      const updated = await tx.mailboxAccount.update({
        where: { id: acc.id },
        data: { status: 'ACTIVE' },
        select: {
          id: true,
          userId: true,
          provider: true,
          email: true,
          displayName: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await tx.outboxEvent.create({
        data: {
          type: 'MAILBOX_ACCOUNT_CONNECTED',
          payload: { mailboxAccountId: acc.id, userId: acc.userId, provider: acc.provider, email: acc.email },
        },
      });

      return updated;
    });
  }

  /**
   * Kullanıcı UI'dan bozuk/yorgun bir hesabı geçici olarak duraklatır.
   * Sync worker `status='ACTIVE'` filtresine baktığı için PAUSED hesaplar
   * otomatik atlanır → "FAILED retry" log spam'i durur, credential silinmez.
   */
  async pause(userId: string, accountId: string) {
    const acc = await this.prisma.mailboxAccount.findUnique({
      where: { id: accountId },
      select: { id: true, userId: true, status: true },
    });
    if (!acc) throw new NotFoundException('Mailbox account not found.');
    if (acc.userId !== userId) throw new ForbiddenException();
    if (acc.status === 'REVOKED') {
      throw new BadRequestException('Cannot pause a revoked account.');
    }
    if (acc.status === 'PAUSED') {
      // idempotent
      return this.prisma.mailboxAccount.findUniqueOrThrow({
        where: { id: acc.id },
        select: this.accountSelect,
      });
    }

    return this.prisma.mailboxAccount.update({
      where: { id: acc.id },
      data: { status: 'PAUSED' },
      select: this.accountSelect,
    });
  }

  async resume(userId: string, accountId: string) {
    const acc = await this.prisma.mailboxAccount.findUnique({
      where: { id: accountId },
      select: { id: true, userId: true, status: true },
    });
    if (!acc) throw new NotFoundException('Mailbox account not found.');
    if (acc.userId !== userId) throw new ForbiddenException();
    if (acc.status !== 'PAUSED') {
      throw new BadRequestException(`Cannot resume from ${acc.status}.`);
    }

    return this.prisma.mailboxAccount.update({
      where: { id: acc.id },
      data: { status: 'ACTIVE' },
      select: this.accountSelect,
    });
  }

  private readonly accountSelect = {
    id: true,
    userId: true,
    provider: true,
    email: true,
    displayName: true,
    status: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  async revoke(userId: string, accountId: string) {
    const acc = await this.prisma.mailboxAccount.findUnique({
      where: { id: accountId },
      select: { id: true, userId: true, provider: true, email: true },
    });
    if (!acc) throw new NotFoundException('Mailbox account not found.');
    if (acc.userId !== userId) throw new ForbiddenException();

    return this.prisma.$transaction(async (tx) => {
      // credential temizle (istersen saklarsın ama revoke için temizlemek mantıklı)
      await tx.mailboxCredential.deleteMany({ where: { mailboxAccountId: acc.id } });

      const updated = await tx.mailboxAccount.update({
        where: { id: acc.id },
        data: { status: 'REVOKED' },
        select: {
          id: true,
          userId: true,
          provider: true,
          email: true,
          displayName: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      await tx.outboxEvent.create({
        data: {
          type: 'MAILBOX_ACCOUNT_REVOKED',
          payload: { mailboxAccountId: acc.id, userId: acc.userId, provider: acc.provider, email: acc.email },
        },
      });

      return updated;
    });
  }

  async list(userId: string) {
    const rows = await this.prisma.mailboxAccount.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        ...this.accountSelect,
        // Son terminal sync (DONE/FAILED) — auto-pause sebebini UI'da göstermek için.
        syncJobs: {
          where: { status: { in: ['DONE', 'FAILED'] }, finishedAt: { not: null } },
          orderBy: { finishedAt: 'desc' },
          take: 1,
          select: { status: true, errorMessage: true, finishedAt: true },
        },
      },
    });

    return rows.map(({ syncJobs, ...rest }) => {
      const last = syncJobs[0] ?? null;
      return {
        ...rest,
        lastSyncStatus: last?.status ?? null,
        lastSyncError: last?.errorMessage ?? null,
        lastSyncAt: last?.finishedAt ?? null,
      };
    });
  }
  async create(userId: string, dto: CreateMailboxAccountDto) {
    try {
      return await this.prisma.mailboxAccount.create({
        data: {
          userId,
          provider: dto.provider,
          email: dto.email.toLowerCase(),
          displayName: dto.displayName ?? null,
          status: 'PENDING',
        },
        select: {
          id: true,
          userId: true,
          provider: true,
          email: true,
          displayName: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    } catch (e: any) {
      // unique(provider,email)
      if (e?.code === 'P2002') {
        throw new ConflictException('This mailbox account is already linked.');
      }
      throw e;
    }
  }
}