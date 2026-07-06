import { apiRequest } from './client';

export type ApiMessageAttachment = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentId: string | null;
};

export type ApiThreadItem = {
  id: string;
  subject: string | null;
  from: string | null;
  to: string;
  date: string;
  snippet: string | null;
  isRead: boolean;
  folder: string;
  messageIdHeader: string | null;
};

export type ApiThreadResponse = {
  threadId: string | null;
  items: ApiThreadItem[];
};

export type ApiMessage = {
  id: string;
  mailboxAccountId: string;
  providerMessageId: string;
  /** RFC 5322 Message-ID — yanıt zinciri (In-Reply-To / References) için. */
  messageIdHeader: string | null;
  /** RFC 5322 In-Reply-To header'ı (`<id>`); yanıt zinciri ucu. */
  inReplyTo?: string | null;
  /** RFC 5322 References header'ı — boşlukla ayrılmış Message-ID listesi. */
  references?: string | null;
  /** Konuşma grup anahtarı — sync worker eklerken hesaplar; null ise tekil. */
  threadId?: string | null;
  folder: string; // INBOX | SENT | TRASH | SPAM
  from: string | null;
  to: string;
  /** Cc alıcıları (virgülle ayrılmış "Ad <e-posta>"). Reply-all için kullanılır. */
  cc?: string | null;
  /** Bcc — sadece SENT klasöründeki kendi maillerimiz için dolu. */
  bcc?: string | null;
  subject: string | null;
  date: string;
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  isRead: boolean;
  isStarred: boolean;
  category?: string | null;
  categoryConfidence?: number | null;
  aiSummary?: string | null;
  /** getOne sonucunda gelir — sadece metadata (içerik download endpoint'ten alınır). */
  attachments?: ApiMessageAttachment[];
  /** List endpoint'lerinde gelir — liste'de paperclip göstermek için. */
  _count?: { attachments: number };
  createdAt: string;
  updatedAt: string;
  /** Birleşik gelen kutusunda hangi hesaba ait olduğunu UI'da göstermek için
   *  /mailbox/messages endpoint'i bunu doldurur; per-account list'te yok. */
  mailboxAccount?: {
    id: string;
    email: string;
    provider: string;
    displayName: string | null;
  };
};

export type MessagesListResponse = {
  items: ApiMessage[];
  nextCursor: string | null;
  hasMore: boolean;
};

export const messagesApi = {
  /** Tüm hesapların birleşik mesaj listesi (Tüm Gelen Kutusu). */
  listAll(
    accessToken: string,
    opts?: { folder?: string; cursor?: string; limit?: number; q?: string },
  ) {
    const params = new URLSearchParams();
    if (opts?.folder) params.set('folder', opts.folder);
    if (opts?.cursor) params.set('cursor', opts.cursor);
    if (opts?.limit) params.set('limit', String(opts.limit));
    if (opts?.q) params.set('q', opts.q);
    const qs = params.toString();
    return apiRequest<MessagesListResponse>(
      `/mailbox/messages${qs ? `?${qs}` : ''}`,
      { method: 'GET', token: accessToken },
    );
  },

  /** Tüm hesapların yıldızlı mesajları (birleşik). */
  listAllStarred(accessToken: string, opts?: { cursor?: string; limit?: number }) {
    const params = new URLSearchParams();
    if (opts?.cursor) params.set('cursor', opts.cursor);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return apiRequest<MessagesListResponse>(
      `/mailbox/messages/starred${qs ? `?${qs}` : ''}`,
      { method: 'GET', token: accessToken },
    );
  },

  list(accessToken: string, accountId: string, opts?: { folder?: string; cursor?: string; limit?: number }) {
    const params = new URLSearchParams();
    if (opts?.folder) params.set('folder', opts.folder);
    if (opts?.cursor) params.set('cursor', opts.cursor);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return apiRequest<MessagesListResponse>(
      `/mailbox/accounts/${accountId}/messages${qs ? `?${qs}` : ''}`,
      { method: 'GET', token: accessToken },
    );
  },

  getOne(accessToken: string, accountId: string, messageId: string) {
    return apiRequest<ApiMessage>(
      `/mailbox/accounts/${accountId}/messages/${messageId}`,
      { method: 'GET', token: accessToken },
    );
  },

  /** Account-agnostic tek mesaj — Yanıtla/Yönlendir akışında accountId bilinmeden hydrate için. */
  getOneById(accessToken: string, messageId: string) {
    return apiRequest<ApiMessage>(`/mailbox/messages/${messageId}`, {
      method: 'GET',
      token: accessToken,
    });
  },

  markAsRead(accessToken: string, accountId: string, messageId: string) {
    return apiRequest<ApiMessage>(
      `/mailbox/accounts/${accountId}/messages/${messageId}/read`,
      { method: 'PATCH', token: accessToken },
    );
  },

  /** Mesajı okunmamış olarak işaretler (yanlışlıkla açma sonrası geri alma). */
  markAsUnread(accessToken: string, accountId: string, messageId: string) {
    return apiRequest<ApiMessage>(
      `/mailbox/accounts/${accountId}/messages/${messageId}/unread`,
      { method: 'PATCH', token: accessToken },
    );
  },

  /**
   * Kalıcı silme — backend yalnızca TRASH'teki mesajları kabul eder.
   * UI tarafında onay alındıktan sonra çağırılmalı.
   */
  remove(accessToken: string, accountId: string, messageId: string) {
    return apiRequest<void>(
      `/mailbox/accounts/${accountId}/messages/${messageId}`,
      { method: 'DELETE', token: accessToken },
    );
  },

  /**
   * Bu mesajın bağlı olduğu konuşmanın tüm mesajları (özet alanlar).
   * threadId === null → tek başına mail (items uzunluğu 1).
   */
  getThread(accessToken: string, accountId: string, messageId: string) {
    return apiRequest<ApiThreadResponse>(
      `/mailbox/accounts/${accountId}/messages/${messageId}/thread`,
      { method: 'GET', token: accessToken },
    );
  },

  /**
   * Bir mail ekini tarayıcıda indirilir hale getirir. JWT URL'e yazılmaz;
   * fetch Authorization header'ı ile, sonra blob → geçici <a download>.
   * Hata fırlatır; çağıran try/catch yapmalı.
   */
  async downloadAttachment(
    accessToken: string,
    accountId: string,
    messageId: string,
    attachmentId: string,
    filename: string,
  ): Promise<void> {
    const baseUrl = (import.meta.env.VITE_API_URL as string | undefined) || 'http://localhost:4000';
    const res = await fetch(
      `${baseUrl}/mailbox/accounts/${accountId}/messages/${messageId}/attachments/${attachmentId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) throw new Error(`Attachment download failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'attachment';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },

  unreadCount(accessToken: string, accountId: string, folder?: string) {
    const qs = folder ? `?folder=${folder}` : '';
    return apiRequest<{ count: number }>(
      `/mailbox/accounts/${accountId}/messages/unread-count${qs}`,
      { method: 'GET', token: accessToken },
    );
  },

  move(
    accessToken: string,
    accountId: string,
    messageId: string,
    folder: 'INBOX' | 'SENT' | 'TRASH' | 'SPAM',
  ) {
    return apiRequest<{ id: string; folder: string }>(
      `/mailbox/accounts/${accountId}/messages/${messageId}/move`,
      { method: 'PATCH', token: accessToken, body: { folder } },
    );
  },

  toggleStar(accessToken: string, accountId: string, messageId: string) {
    return apiRequest<{ id: string; isStarred: boolean }>(
      `/mailbox/accounts/${accountId}/messages/${messageId}/star`,
      { method: 'PATCH', token: accessToken },
    );
  },

  listStarred(accessToken: string, accountId: string, opts?: { cursor?: string; limit?: number }) {
    const params = new URLSearchParams();
    if (opts?.cursor) params.set('cursor', opts.cursor);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return apiRequest<MessagesListResponse>(
      `/mailbox/accounts/${accountId}/messages/starred${qs ? `?${qs}` : ''}`,
      { method: 'GET', token: accessToken },
    );
  },

  updateCategory(
    accessToken: string,
    accountId: string,
    messageId: string,
    category: string,
  ) {
    return apiRequest<{ id: string; category: string; categoryConfidence: number }>(
      `/mailbox/accounts/${accountId}/messages/${messageId}/category`,
      { method: 'PATCH', token: accessToken, body: { category } },
    );
  },

  summarize(accessToken: string, accountId: string, messageId: string) {
    return apiRequest<{ analysisId: string; summary: string }>(
      `/mailbox/accounts/${accountId}/messages/${messageId}/summarize`,
      { method: 'POST', token: accessToken },
    );
  },

  send(
    accessToken: string,
    accountId: string,
    payload: {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject?: string;
      text?: string;
      html?: string;
      inReplyTo?: string;
      references?: string[];
      attachments?: Array<{ filename: string; contentBase64: string; contentType?: string }>;
    },
  ) {
    return apiRequest<{ messageId: string }>(
      `/mailbox/accounts/${accountId}/messages/send`,
      { method: 'POST', token: accessToken, body: payload },
    );
  },
};
