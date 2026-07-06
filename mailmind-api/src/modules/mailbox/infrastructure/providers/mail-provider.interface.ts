export type ProviderAttachment = {
  filename: string;
  contentType: string;
  sizeBytes: number;
  content: Buffer;
  /** RFC 2392 Content-ID (`<cid:...>`). Inline resim referansları için. */
  contentId?: string | null;
};

export type ProviderMessage = {
  providerMessageId: string;
  /**
   * RFC 5322 Message-ID header (`<abc@host>`). Yanıt zinciri (In-Reply-To /
   * References) için kullanılır; bazı sunucular envelope'ta vermez → null
   * olabilir.
   */
  messageIdHeader?: string | null;
  /**
   * RFC 5322 `In-Reply-To` header değeri (`<abc@host>`). Cevap zinciri için.
   */
  inReplyTo?: string | null;
  /**
   * RFC 5322 `References` header — boşlukla ayrılmış Message-ID listesi.
   * Eski → yeni sırada; ilk eleman genellikle thread'in kök mesajı.
   */
  references?: string | null;
  folder: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  date: Date;
  snippet?: string;
  bodyText?: string;
  bodyHtml?: string;
  /** RFC 5545 .ics ekli mailler için ham VCALENDAR içeriği. */
  icsRaw?: string;
  /**
   * .ics dışındaki ekler. Cap aşan dosyalar provider tarafında atlanır;
   * burası DB'ye yazılacak nihai liste.
   */
  attachments?: ProviderAttachment[];
};

export interface MailProvider {
  fetchRecent(args: {
    mailboxAccountId: string;
    limit: number;
  }): Promise<ProviderMessage[]>;
}