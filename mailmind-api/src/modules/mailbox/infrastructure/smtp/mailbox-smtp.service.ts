import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { PrismaService } from '../../../../shared/infrastructure/prisma/prisma.service';
import { CredentialCipher } from '../../../../shared/infrastructure/security/credential-cipher';
import { SendMessageDto } from '../../application/dto/send-message.dto';
import { MailboxSyncWorkerService } from '../providers/sync/mailbox-sync-worker.service';
import { GoogleTokenService } from '../providers/oauth/google-token.service';

@Injectable()
export class MailboxSmtpService {
  private readonly logger = new Logger(MailboxSmtpService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly syncWorker: MailboxSyncWorkerService,
    private readonly googleTokens: GoogleTokenService,
  ) {}

  async send(userId: string, accountId: string, dto: SendMessageDto): Promise<{ messageId: string }> {
    // Sahiplik kontrolü
    const account = await this.prisma.mailboxAccount.findUnique({
      where: { id: accountId },
      select: { userId: true, email: true, displayName: true, status: true, provider: true },
    });
    if (!account) throw new NotFoundException('Mailbox account not found.');
    if (account.userId !== userId) throw new ForbiddenException();
    if (account.status !== 'ACTIVE') {
      throw new BadRequestException(
        `Cannot send: mailbox account is ${account.status.toLowerCase()}. Resume the account first.`,
      );
    }

    this.logger.log(
      `Send requested: accountId=${accountId} provider=${account.provider} email=${account.email}`,
    );

    const transporter =
      account.provider === 'GMAIL'
        ? await this.buildGmailTransporter(accountId, account.email)
        : await this.buildPasswordTransporter(accountId);

    const fromAddress = account.displayName
      ? `${account.displayName} <${account.email}>`
      : account.email;

    const attachments = dto.attachments?.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.contentBase64, 'base64'),
      contentType: a.contentType,
    }));

    // Yanıt zinciri: `In-Reply-To` orijinal mailin Message-ID'si; `References`
    // tüm zincirin Message-ID'leri (boşlukla ayrılmış). nodemailer her ikisini
    // de array kabul eder, kendi join'ler.
    const info = await transporter.sendMail({
      from: fromAddress,
      to: dto.to.join(', '),
      cc: dto.cc?.join(', '),
      bcc: dto.bcc?.join(', '),
      subject: dto.subject ?? '(no subject)',
      text: dto.text,
      html: dto.html,
      inReplyTo: dto.inReplyTo,
      references: dto.references && dto.references.length > 0 ? dto.references : undefined,
      attachments,
    });

    this.logger.log(`Mail sent: messageId=${info.messageId} from=${account.email} to=${dto.to.join(',')}`);

    // SMTP send başarılı olur olmaz IMAP SENT klasöründe mail HEMEN
    // belirmeyebilir — özellikle Gmail'de SMTP submission ile IMAP SENT
    // yansıması arasında 2–10 sn'lik gecikme olur. Bu yüzden 0/5/15 sn'de
    // üç ayrı INCREMENTAL tetik atıyoruz; ilki muhtemelen fetched=0
    // dönecek ama 5–15 sn aralığında SENT klasörüne yansıyan mail
    // kullanıcıya 30 sn'lik normal cooldown'u beklemeden görünür.
    this.scheduleSentFolderRefresh(accountId);

    return { messageId: info.messageId };
  }

  private scheduleSentFolderRefresh(accountId: string): void {
    const trigger = async (label: string) => {
      try {
        await this.syncWorker.enqueueIncrementalForMailbox(accountId);
      } catch (err: any) {
        // Sync tetiklemesi best-effort; send başarılı, mail karşı tarafa gitti.
        this.logger.warn(
          `Post-send sync trigger (${label}) failed (non-fatal) for mailbox=${accountId}: ${err?.message ?? String(err)}`,
        );
      }
    };

    void trigger('immediate');
    setTimeout(() => void trigger('+5s'), 5_000).unref();
    setTimeout(() => void trigger('+15s'), 15_000).unref();
  }

  /**
   * Gmail XOAUTH2 transport — IMAP tarafıyla aynı access token akışını kullanır.
   * Google OAuth bağlanması sırasında `https://mail.google.com/` scope'u alındığı
   * için SMTP submission da aynı token ile çalışır.
   */
  private async buildGmailTransporter(
    mailboxAccountId: string,
    email: string,
  ): Promise<Transporter> {
    const accessToken = await this.googleTokens.getFreshAccessToken(mailboxAccountId);
    return nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        type: 'OAuth2',
        user: email,
        accessToken,
      },
    });
  }

  /** iCloud / generic IMAP: kullanıcı/şifre tabanlı SMTP submission. */
  private async buildPasswordTransporter(mailboxAccountId: string): Promise<Transporter> {
    const cred = await this.prisma.mailboxCredential.findUnique({
      where: { mailboxAccountId },
      select: {
        smtpHost: true,
        smtpPort: true,
        smtpUsername: true,
        smtpPasswordEnc: true,
      },
    });

    if (!cred?.smtpHost || !cred.smtpUsername || !cred.smtpPasswordEnc) {
      throw new BadRequestException(
        'SMTP credentials not configured for this account. Please re-activate with SMTP settings.',
      );
    }

    const smtpPassword = this.cipher.decrypt(cred.smtpPasswordEnc);
    const port = cred.smtpPort ?? 587;

    return nodemailer.createTransport({
      host: cred.smtpHost,
      port,
      secure: port === 465,
      auth: { user: cred.smtpUsername, pass: smtpPassword },
    });
  }
}
