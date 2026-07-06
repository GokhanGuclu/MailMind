import type { LanguageMode } from '../../shared/types/ui';
import type { DraftMockRow, GeneralInboxRow, InboxMockRow } from './page.mock-data';
import type { ApiMessageAttachment } from '../../shared/api/messages';
import { formatInboxFullDateTime, formatInboxSenderLabel, resolveInboxSentDate } from './inbox-list-utils';

export type MailReaderFolderVariant = 'inbox' | 'spam' | 'sent' | 'drafts' | 'trash';

export type MailReaderModel = {
  subject: string;
  bodyText: string;
  /** Gelen kutusu: HTML gövde (sanitize edilerek gösterilir) */
  bodyHtml?: string | null;
  displayName: string;
  displayEmail: string | null;
  /** Gönderilmiş / taslak: "Kime:" öneki */
  showRecipientPrefix: boolean;
  timeDisplay: string;
  dateTimeIso?: string;
  /**
   * Eski (mock) yol: yalnız dosya adları. Backend'den gelen gerçek maillerde
   * `attachments` doldurulur ve UI o yolu tercih eder; isim listesi mock'lar
   * için geriye dönük uyumluluk amacıyla korunuyor.
   */
  attachmentNames: string[];
  /** Backend'den gelen gerçek ek meta-verisi (içerik DB'de, ayrı endpoint indirir). */
  attachments?: ApiMessageAttachment[];
  /** Okuyucu üstünde renkli AI özet kutusu */
  aiSummary: string;
  /** Sınıflandırıcının ürettiği kategori (örn. "İş/Acil"). */
  category?: string | null;
  /** Sınıflandırıcı güven skoru (0..1). */
  categoryConfidence?: number | null;
  /** CC alıcıları — virgülle ayrılmış "Ad <e-posta>" listesi. Reply-all + meta. */
  cc?: string | null;
  /** BCC — sadece SENT klasöründeki kendi maillerimizde dolu. */
  bcc?: string | null;
  /** Folder — hard delete kontrolü için (sadece TRASH'te kalıcı sil aktif). */
  folder?: string | null;
  /** Okundu durumu — toggle butonun başlangıç state'i için. */
  isRead?: boolean;
  /** Hangi hesabın postası — thread/attachment endpoint'leri için. */
  accountId?: string | null;
  /** Konuşma anahtarı (sync worker hesaplar); null ise thread şeridi gizlenir. */
  threadId?: string | null;
};

function pickAiSummary(subject: string, preview: string, explicit?: string | null): string {
  const t = explicit?.trim();
  if (t) return t;
  const p = preview.trim();
  if (p) {
    if (p.length <= 240) return p;
    return `${p.slice(0, 237)}…`;
  }
  const s = subject.trim();
  return s || '—';
}

export function readerFromGeneralInbox(row: GeneralInboxRow, language: LanguageMode): MailReaderModel {
  const sent = resolveInboxSentDate(row);
  return {
    subject: row.subject,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml ?? null,
    displayName: formatInboxSenderLabel(row),
    displayEmail: row.senderEmail,
    showRecipientPrefix: false,
    timeDisplay: formatInboxFullDateTime(sent, language),
    dateTimeIso: sent.toISOString(),
    attachmentNames: row.attachmentNames?.filter(Boolean) ?? [],
    aiSummary: pickAiSummary(row.subject, row.preview, row.aiSummary),
  };
}

function bodyFromMockPreview(preview: string, footer: string): string {
  const p = preview.trim();
  return p ? `${p}\n\n${footer}` : footer;
}

export function readerFromInboxMock(row: InboxMockRow, opts?: { recipientMode?: boolean }): MailReaderModel {
  const recipientMode = opts?.recipientMode ?? false;
  const footer = recipientMode ? '(Mock)' : '(Mock içerik)';
  const body = row.bodyText?.trim() || bodyFromMockPreview(row.preview, footer);
  return {
    subject: row.subject,
    bodyText: body,
    displayName: row.from.trim(),
    displayEmail: null,
    showRecipientPrefix: recipientMode,
    timeDisplay: row.time,
    attachmentNames: row.attachmentNames?.filter(Boolean) ?? [],
    aiSummary: pickAiSummary(row.subject, row.preview, row.aiSummary),
  };
}

export function readerFromDraft(row: DraftMockRow, draftsPlaceholder: string): MailReaderModel {
  const footer = '(Taslak)';
  const body = row.bodyText?.trim() || bodyFromMockPreview(row.preview, footer);
  const to = row.toEmail?.trim();
  const primary = to || draftsPlaceholder;
  return {
    subject: row.subject,
    bodyText: body,
    displayName: primary,
    displayEmail: null,
    showRecipientPrefix: true,
    timeDisplay: row.time,
    attachmentNames: row.attachmentNames?.filter(Boolean) ?? [],
    aiSummary: pickAiSummary(row.subject, row.preview, row.aiSummary),
  };
}
