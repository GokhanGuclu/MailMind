export type ProviderMessage = {
  providerMessageId: string;
  folder: string;
  from: string;
  to: string[];
  subject: string;
  date: Date;
  snippet?: string;
  bodyText?: string;
  bodyHtml?: string;
  /** RFC 5545 .ics ekli mailler için ham VCALENDAR içeriği. */
  icsRaw?: string;
};

export interface MailProvider {
  fetchRecent(args: {
    mailboxAccountId: string;
    limit: number;
  }): Promise<ProviderMessage[]>;
}