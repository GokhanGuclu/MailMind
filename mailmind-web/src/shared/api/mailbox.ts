import { apiRequest } from './client';

export type MailboxAccountStatus = 'PENDING' | 'ACTIVE' | 'PAUSED' | 'REVOKED' | 'ERROR';

export type MailboxAccount = {
  id: string;
  userId: string;
  provider: string;
  email: string;
  displayName: string | null;
  status: MailboxAccountStatus;
  createdAt: string;
  updatedAt: string;
  /** Sadece /mailbox/accounts (list) içinde dolu; pause/resume yanıtında null. */
  lastSyncStatus?: 'DONE' | 'FAILED' | null;
  lastSyncError?: string | null;
  lastSyncAt?: string | null;
};

export type CreateMailboxAccountInput = {
  provider: 'GMAIL' | 'ICLOUD' | 'IMAP';
  email: string;
  displayName?: string;
};

export type ActivateMailboxAccountInput = {
  // OAuth (Gmail XOAUTH2)
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;

  // IMAP / iCloud — host/port/username iCloud için sunucuda otomatik doldurulur
  imapHost?: string;
  imapPort?: number;
  imapUsername?: string;
  imapPassword?: string;

  // SMTP — iCloud'da imapPassword'ün aynısı sunucuda mirror'lanır
  smtpHost?: string;
  smtpPort?: number;
  smtpUsername?: string;
  smtpPassword?: string;
};

export const mailboxApi = {
  listAccounts(accessToken: string) {
    return apiRequest<MailboxAccount[]>('/mailbox/accounts', {
      method: 'GET',
      token: accessToken,
    });
  },
  createAccount(accessToken: string, input: CreateMailboxAccountInput) {
    return apiRequest<MailboxAccount>('/mailbox/accounts', {
      method: 'POST',
      token: accessToken,
      body: input,
    });
  },
  activateAccount(accessToken: string, accountId: string, input: ActivateMailboxAccountInput) {
    return apiRequest<MailboxAccount>(`/mailbox/accounts/${accountId}/activate`, {
      method: 'POST',
      token: accessToken,
      body: input,
    });
  },
  pauseAccount(accessToken: string, accountId: string) {
    return apiRequest<MailboxAccount>(`/mailbox/accounts/${accountId}/pause`, {
      method: 'POST',
      token: accessToken,
    });
  },
  resumeAccount(accessToken: string, accountId: string) {
    return apiRequest<MailboxAccount>(`/mailbox/accounts/${accountId}/resume`, {
      method: 'POST',
      token: accessToken,
    });
  },
};
