import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../../shared/infrastructure/prisma/prisma.service';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Gmail XOAUTH2 access-token sağlayıcısı. Hem IMAP (ImapProvider) hem SMTP
 * (MailboxSmtpService) aynı refresh akışını kullanır; token erken yenilenir
 * ve MailboxCredential'a kalıcı yazılır.
 */
@Injectable()
export class GoogleTokenService {
  private readonly logger = new Logger(GoogleTokenService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Account için taze access token döner; gerekirse refresh eder. */
  async getFreshAccessToken(mailboxAccountId: string): Promise<string> {
    const cred = await this.prisma.mailboxCredential.findUnique({
      where: { mailboxAccountId },
      select: { accessToken: true, refreshToken: true, tokenExpiresAt: true },
    });

    if (!cred?.accessToken || !cred?.refreshToken) {
      throw new Error(`Gmail OAuth credentials not found for mailbox=${mailboxAccountId}`);
    }

    const isExpired = cred.tokenExpiresAt
      ? cred.tokenExpiresAt.getTime() < Date.now() + REFRESH_BUFFER_MS
      : true;

    if (!isExpired) return cred.accessToken;

    this.logger.log(`Refreshing expired Google access token for mailbox=${mailboxAccountId}`);
    return this.refresh(mailboxAccountId, cred.refreshToken);
  }

  private async refresh(mailboxAccountId: string, refreshToken: string): Promise<string> {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error('GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET not set');
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google token refresh failed: ${res.status} ${text}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    const expiresAt = new Date(Date.now() + data.expires_in * 1000);

    await this.prisma.mailboxCredential.update({
      where: { mailboxAccountId },
      data: { accessToken: data.access_token, tokenExpiresAt: expiresAt },
    });

    return data.access_token;
  }
}
