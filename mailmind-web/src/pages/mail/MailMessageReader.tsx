import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LuArchive,
  LuArrowLeft,
  LuBan,
  LuCalendar,
  LuChevronDown,
  LuCheck,
  LuFile,
  LuForward,
  LuInbox,
  LuListTodo,
  LuLoader,
  LuMail,
  LuMessagesSquare,
  LuReply,
  LuReplyAll,
  LuRotateCcw,
  LuSparkles,
  LuTrash2,
  LuX,
} from 'react-icons/lu';

import type { MailDashboardCopy } from './page.mock-data';
import type { MailReaderFolderVariant, MailReaderModel } from './mail-reader-model';
import { sanitizeMailHtml } from './sanitize-mail-html';
import { CategoryBadge } from './category-badge';
import { useAuth } from '../../shared/context/auth-context';
import {
  proposalsApi,
  type ProposalsList,
  type ProposalKind,
} from '../../shared/api/proposals';
import { messagesApi, type ApiThreadItem } from '../../shared/api/messages';

type Props = {
  model: MailReaderModel;
  copy: MailDashboardCopy;
  onClose: () => void;
  variant: MailReaderFolderVariant;
  /** Mailin id'si — verildiğinde sağ panelde AI önerileri yüklenir. */
  messageId?: string | null;
  onSummarize?: () => Promise<string | null>;
  onDelete?: () => void;
  onRestore?: () => void;
  onSpam?: () => void;
  /** Verilirse kategori rozetine tıklanarak değiştirilebilir. */
  onCategoryChange?: (next: string) => Promise<void> | void;
  /**
   * Okundu/okunmadı durumu değiştirildiğinde parent listeyi tazelesin diye.
   * Reader içeride API'yi çağırır; parent sadece liste reload yapar.
   */
  onReadStateChanged?: () => void;
  /**
   * Kalıcı silme tamamlandığında parent listeyi tazelesin + opsiyonel reader
   * kapatma. Sadece variant === 'trash' iken anlamlı.
   */
  onHardDeleted?: () => void;
  /**
   * Thread şeridinden başka mesaja geçiş. Parent isteğine göre setOpened
   * vs navigate yapabilir; verilmezse şerit gizlenir.
   */
  onPickThreadItem?: (item: ApiThreadItem) => void;
};

const TYPEWRITER_SPEED_MS = 18; // her karakter arası ms

// Bayt → insan okunabilir (KB/MB). Attachment chip'inde gösterilir.
function formatBytes(n: number): string {
  if (n == null || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function useTypewriter(text: string | null) {
  const [displayed, setDisplayed] = useState('');
  const rafRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!text) { setDisplayed(''); return; }
    setDisplayed('');
    let i = 0;
    function tick() {
      i++;
      setDisplayed(text!.slice(0, i));
      if (i < text!.length) {
        rafRef.current = setTimeout(tick, TYPEWRITER_SPEED_MS);
      }
    }
    rafRef.current = setTimeout(tick, TYPEWRITER_SPEED_MS);
    return () => { if (rafRef.current) clearTimeout(rafRef.current); };
  }, [text]);

  return displayed;
}

export function MailMessageReader({
  model, copy, onClose, variant, messageId,
  onSummarize, onDelete, onRestore, onSpam, onCategoryChange,
  onReadStateChanged, onHardDeleted, onPickThreadItem,
}: Props) {
  const navigate = useNavigate();
  const canReply = !!messageId && (variant === 'inbox' || variant === 'sent');
  const goCompose = (mode: 'reply' | 'replyAll' | 'forward') => {
    if (!messageId) return;
    navigate(`/mail/new?${mode}=${encodeURIComponent(messageId)}`);
  };

  const htmlBody = model.bodyHtml?.trim() ? sanitizeMailHtml(model.bodyHtml.trim()) : '';
  const paragraphs = model.bodyText.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const files = model.attachmentNames;
  const isSpamFolder = variant === 'spam';
  const isTr = copy.readerAiSummaryLabel === 'AI Özeti:';

  // AI summary state
  const [localSummary, setLocalSummary] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState(false);
  const [summarizeError, setSummarizeError] = useState<string | null>(null);

  const effectiveSummary = localSummary ?? model.aiSummary?.trim() ?? '';
  const hasSummary = Boolean(effectiveSummary);

  // Typewriter: sadece yeni gelen özet için çalıştır
  const typedSummary = useTypewriter(localSummary);
  // Modelden gelen önceden var olan özeti direk göster
  const displayedSummary = localSummary ? typedSummary : effectiveSummary;

  const canSummarize = !isSpamFolder && !hasSummary && Boolean(onSummarize);
  // Spam için de kart göster
  const showAiCard = isSpamFolder || hasSummary || canSummarize || summarizing;

  // ── Auth + iç eylem state'leri ───────────────────────────────────────────
  const { accessToken } = useAuth();

  // Okundu durumunu local olarak da tutuyoruz ki butona basıldığında ikon
  // anında değişsin; parent reload eninde sonunda model'i tazeler.
  const [localIsRead, setLocalIsRead] = useState<boolean | undefined>(model.isRead);
  useEffect(() => { setLocalIsRead(model.isRead); }, [model.isRead]);
  const [readBusy, setReadBusy] = useState(false);

  const toggleReadState = async () => {
    if (!accessToken || !messageId || !model.accountId || readBusy) return;
    const wantUnread = localIsRead !== false; // true ya da undefined → unread'e çek
    setReadBusy(true);
    try {
      if (wantUnread) {
        await messagesApi.markAsUnread(accessToken, model.accountId, messageId);
        setLocalIsRead(false);
      } else {
        await messagesApi.markAsRead(accessToken, model.accountId, messageId);
        setLocalIsRead(true);
      }
      onReadStateChanged?.();
    } catch {
      // sessizce yut — kullanıcı tekrar deneyebilir
    } finally {
      setReadBusy(false);
    }
  };

  // Kalıcı silme — sadece variant === 'trash' iken aktif.
  const [deleteBusy, setDeleteBusy] = useState(false);
  const hardDelete = async () => {
    if (!accessToken || !messageId || !model.accountId || deleteBusy) return;
    if (variant !== 'trash') return;
    const ok = window.confirm(isTr
      ? "Bu mesaj sunucudan kalıcı olarak silinecek. Devam edilsin mi?"
      : "This will permanently delete the message from the server. Continue?");
    if (!ok) return;
    setDeleteBusy(true);
    try {
      await messagesApi.remove(accessToken, model.accountId, messageId);
      onHardDeleted?.();
      onClose();
    } catch (err: any) {
      window.alert(err?.message ?? (isTr ? 'Silinemedi' : 'Delete failed'));
    } finally {
      setDeleteBusy(false);
    }
  };

  // Thread şeridi — başka mesajları getOne çağırmadan göstermek için.
  const [threadItems, setThreadItems] = useState<ApiThreadItem[]>([]);
  const [threadOpen, setThreadOpen] = useState(false);
  useEffect(() => {
    if (!accessToken || !messageId || !model.accountId || !model.threadId) {
      setThreadItems([]);
      return;
    }
    let cancelled = false;
    messagesApi
      .getThread(accessToken, model.accountId, messageId)
      .then((res) => {
        if (cancelled) return;
        // Anchor (mevcut açık mesaj) listede gözükmesin.
        setThreadItems(res.items.filter((it) => it.id !== messageId));
      })
      .catch(() => {
        if (!cancelled) setThreadItems([]);
      });
    return () => { cancelled = true; };
  }, [accessToken, messageId, model.accountId, model.threadId]);

  // ── AI önerileri (sağ panel) ─────────────────────────────────────────────
  const [proposals, setProposals] = useState<ProposalsList | null>(null);
  const [proposalsLoading, setProposalsLoading] = useState(false);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const proposalsAvailable = Boolean(messageId) && variant === 'inbox';

  useEffect(() => {
    if (!proposalsAvailable || !accessToken || !messageId) {
      setProposals(null);
      return;
    }
    let cancelled = false;
    setProposalsLoading(true);
    proposalsApi
      .forMessage(accessToken, messageId)
      .then((res) => {
        if (!cancelled) setProposals(res);
      })
      .catch(() => {
        if (!cancelled) setProposals({ tasks: [], calendarEvents: [], reminders: [] });
      })
      .finally(() => {
        if (!cancelled) setProposalsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [proposalsAvailable, accessToken, messageId]);

  const handleProposalAction = async (
    kind: ProposalKind,
    id: string,
    action: 'approve' | 'reject',
  ) => {
    if (!accessToken || pendingActionId) return;
    setPendingActionId(id);
    try {
      if (action === 'approve') {
        await proposalsApi.approve(accessToken, kind, id);
      } else {
        await proposalsApi.reject(accessToken, kind, id);
      }
      setProposals((prev) => {
        if (!prev) return prev;
        return {
          tasks: prev.tasks.filter((t) => t.id !== id),
          calendarEvents: prev.calendarEvents.filter((e) => e.id !== id),
          reminders: prev.reminders.filter((r) => r.id !== id),
        };
      });
    } catch {
      // sessizce yut — kullanıcı tekrar deneyebilir
    } finally {
      setPendingActionId(null);
    }
  };

  const proposalsTotal = proposals
    ? proposals.tasks.length + proposals.calendarEvents.length + proposals.reminders.length
    : 0;
  const showProposalsPanel = proposalsAvailable && (proposalsLoading || proposalsTotal > 0);

  const handleSummarize = async () => {
    if (!onSummarize || summarizing) return;
    setSummarizing(true);
    setSummarizeError(null);
    try {
      const result = await onSummarize();
      if (result?.trim()) {
        setLocalSummary(result.trim());
      } else {
        setSummarizeError(isTr ? 'Özetleme başarısız oldu.' : 'Summarization failed.');
      }
    } catch (err: any) {
      setSummarizeError(err?.message ?? 'Error');
    } finally {
      setSummarizing(false);
    }
  };

  return (
    <section className="mail-inbox-reader" aria-label={copy.inboxMessageReaderRegionAria}>
      <header className="mail-inbox-reader__toolbar">
        <button
          type="button"
          className="mail-inbox-reader__back"
          onClick={onClose}
          aria-label={copy.inboxBackToListAria}
          title={copy.inboxBackToListAria}
        >
          <LuArrowLeft size={20} strokeWidth={2} aria-hidden />
        </button>
        <h1 className="mail-inbox-reader__toolbar-title" title={model.subject}>
          {model.subject}
        </h1>
        <div className="mail-inbox-reader__toolbar-actions" role="group" aria-label={copy.inboxReaderMessageActionsAria}>
          {canReply ? (
            <>
              <button
                type="button"
                className="mail-inbox-toolbar__icon-btn"
                aria-label={isTr ? 'Yanıtla' : 'Reply'}
                title={isTr ? 'Yanıtla' : 'Reply'}
                onClick={() => goCompose('reply')}
              >
                <LuReply size={18} strokeWidth={1.75} aria-hidden />
              </button>
              <button
                type="button"
                className="mail-inbox-toolbar__icon-btn"
                aria-label={isTr ? 'Tümünü yanıtla' : 'Reply all'}
                title={isTr ? 'Tümünü yanıtla' : 'Reply all'}
                onClick={() => goCompose('replyAll')}
              >
                <LuReplyAll size={18} strokeWidth={1.75} aria-hidden />
              </button>
              <button
                type="button"
                className="mail-inbox-toolbar__icon-btn"
                aria-label={isTr ? 'Yönlendir' : 'Forward'}
                title={isTr ? 'Yönlendir' : 'Forward'}
                onClick={() => goCompose('forward')}
              >
                <LuForward size={18} strokeWidth={1.75} aria-hidden />
              </button>
            </>
          ) : null}
          {messageId && model.accountId ? (
            <button
              type="button"
              className="mail-inbox-toolbar__icon-btn"
              aria-label={
                localIsRead === false
                  ? (isTr ? 'Okundu olarak işaretle' : 'Mark as read')
                  : (isTr ? 'Okunmadı olarak işaretle' : 'Mark as unread')
              }
              title={
                localIsRead === false
                  ? (isTr ? 'Okundu olarak işaretle' : 'Mark as read')
                  : (isTr ? 'Okunmadı olarak işaretle' : 'Mark as unread')
              }
              onClick={toggleReadState}
              disabled={readBusy}
              style={localIsRead === false ? { color: 'var(--accent, #2563eb)' } : undefined}
            >
              <LuMail size={18} strokeWidth={1.75} aria-hidden />
            </button>
          ) : null}
          {variant === 'inbox' ? (
            <>
              <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.inboxBulkArchiveAria} title={copy.inboxBulkArchiveAria}>
                <LuArchive size={18} strokeWidth={1.75} aria-hidden />
              </button>
              <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.inboxBulkSpamAria} title={copy.inboxBulkSpamAria} onClick={onSpam}>
                <LuBan size={18} strokeWidth={1.75} aria-hidden />
              </button>
              <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.inboxBulkDeleteAria} title={copy.inboxBulkDeleteAria} onClick={onDelete}>
                <LuTrash2 size={18} strokeWidth={1.75} aria-hidden />
              </button>
            </>
          ) : null}
          {variant === 'spam' ? (
            <>
              <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.spamBulkNotSpamLabel} title={copy.spamBulkNotSpamLabel} onClick={onRestore}>
                <LuInbox size={18} strokeWidth={1.75} aria-hidden />
              </button>
              <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.inboxBulkDeleteAria} title={copy.inboxBulkDeleteAria} onClick={onDelete}>
                <LuTrash2 size={18} strokeWidth={1.75} aria-hidden />
              </button>
            </>
          ) : null}
          {variant === 'sent' ? (
            <>
              <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.inboxBulkArchiveAria} title={copy.inboxBulkArchiveAria}>
                <LuArchive size={18} strokeWidth={1.75} aria-hidden />
              </button>
              <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.inboxBulkDeleteAria} title={copy.inboxBulkDeleteAria} onClick={onDelete}>
                <LuTrash2 size={18} strokeWidth={1.75} aria-hidden />
              </button>
            </>
          ) : null}
          {variant === 'drafts' ? (
            <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.inboxBulkDeleteAria} title={copy.inboxBulkDeleteAria} onClick={onDelete}>
              <LuTrash2 size={18} strokeWidth={1.75} aria-hidden />
            </button>
          ) : null}
          {variant === 'trash' ? (
            <>
              <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.trashBulkRestoreAria} title={copy.trashBulkRestoreAria} onClick={onRestore}>
                <LuRotateCcw size={18} strokeWidth={1.75} aria-hidden />
              </button>
              <button
                type="button"
                className="mail-inbox-toolbar__icon-btn"
                aria-label={copy.trashBulkPermanentDeleteAria}
                title={copy.trashBulkPermanentDeleteAria}
                onClick={hardDelete}
                disabled={deleteBusy || !messageId || !model.accountId}
                style={{ color: 'var(--danger, #dc2626)' }}
              >
                <LuTrash2 size={18} strokeWidth={1.75} aria-hidden />
              </button>
            </>
          ) : null}
        </div>
      </header>

      <div className="mail-inbox-reader__main">
        <div className="mail-inbox-reader__scroll">
          {/* AI özet kartı — her zaman görünür (spam / özet var / buton) */}
          {showAiCard ? (
            <div
              className={`mail-inbox-reader__ai-wrap${isSpamFolder ? ' mail-inbox-reader__ai-wrap--spam' : ''}`}
              role="region"
              aria-label={isSpamFolder ? copy.readerSpamAiSummaryAria : copy.readerAiSummaryAria}
            >
              <div className="mail-inbox-reader__ai-card">
                <div className="mail-inbox-reader__ai-head">
                  {isSpamFolder ? (
                    <LuBan className="mail-inbox-reader__ai-sparkle mail-inbox-reader__ai-sparkle--spam" size={18} strokeWidth={2} aria-hidden />
                  ) : (
                    <LuSparkles className="mail-inbox-reader__ai-sparkle" size={18} strokeWidth={2} aria-hidden />
                  )}
                  <span className={`mail-inbox-reader__ai-label${isSpamFolder ? ' mail-inbox-reader__ai-label--spam' : ''}`}>
                    {copy.readerAiSummaryLabel}
                  </span>
                </div>

                {/* İçerik: buton / yükleniyor / özet metni */}
                {isSpamFolder ? (
                  <p className="mail-inbox-reader__ai-text mail-inbox-reader__ai-text--spam">
                    {copy.readerSpamNoAiSummaryText}
                  </p>
                ) : hasSummary ? (
                  <p className="mail-inbox-reader__ai-text">
                    {displayedSummary}
                    {/* Yazım devam ediyorsa imleç */}
                    {localSummary && displayedSummary.length < localSummary.length ? (
                      <span className="mail-inbox-reader__ai-cursor" aria-hidden>▋</span>
                    ) : null}
                  </p>
                ) : summarizing ? (
                  <div className="mail-inbox-reader__ai-loading">
                    <LuLoader className="mail-inbox-reader__summarize-spinner" size={15} strokeWidth={2.5} aria-hidden />
                    <span>{isTr ? 'Özetleniyor...' : 'Summarizing...'}</span>
                  </div>
                ) : (
                  <div className="mail-inbox-reader__ai-btn-wrap">
                    <button
                      type="button"
                      className="mail-inbox-reader__summarize-btn"
                      onClick={handleSummarize}
                    >
                      <LuSparkles size={14} strokeWidth={2} aria-hidden />
                      <span>{isTr ? 'AI Özetle' : 'AI Summarize'}</span>
                    </button>
                    {summarizeError ? (
                      <p className="mail-inbox-reader__summarize-error">{summarizeError}</p>
                    ) : null}
                  </div>
                )}
              </div>
            </div>
          ) : null}

          <div className="mail-inbox-reader__meta">
            <div className="mail-inbox-reader__from-line">
              {model.showRecipientPrefix ? (
                <><span className="mail-inbox-reader__to-prefix">{copy.readerToPrefix}</span>{' '}</>
              ) : null}
              <span className="mail-inbox-reader__from-name">{model.displayName}</span>
              {model.displayEmail ? (
                <span className="mail-inbox-reader__from-email">&lt;{model.displayEmail}&gt;</span>
              ) : null}
              {model.category || onCategoryChange ? (
                <CategoryBadge
                  category={model.category}
                  confidence={model.categoryConfidence}
                  className="mail-inbox-reader__category-badge mail-category-badge"
                  onChange={onCategoryChange}
                />
              ) : null}
            </div>
            <time className="mail-inbox-reader__when" {...(model.dateTimeIso ? { dateTime: model.dateTimeIso } : {})}>
              {model.timeDisplay}
            </time>
          </div>

          {/* CC / BCC bilgisi — backend dolduruyorsa göster. BCC sadece SENT'te. */}
          {model.cc ? (
            <div className="mail-inbox-reader__cc-line" style={{ fontSize: 12, color: 'var(--fg-muted, #6b7280)', marginTop: 4 }}>
              <strong style={{ marginRight: 6 }}>Cc:</strong>
              <span style={{ color: 'var(--fg-subtle, #9ca3af)' }}>{model.cc}</span>
            </div>
          ) : null}
          {model.bcc && model.folder === 'SENT' ? (
            <div className="mail-inbox-reader__cc-line" style={{ fontSize: 12, color: 'var(--fg-muted, #6b7280)', marginTop: 2 }}>
              <strong style={{ marginRight: 6 }}>Bcc:</strong>
              <span style={{ color: 'var(--fg-subtle, #9ca3af)' }}>{model.bcc}</span>
            </div>
          ) : null}

          {/* Konuşma şeridi — sadece thread'de başka mesaj varsa */}
          {threadItems.length > 0 ? (
            <div className="mail-inbox-reader__thread" style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={() => setThreadOpen((o) => !o)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  padding: '6px 10px', borderRadius: 999, cursor: 'pointer',
                  background: 'var(--bg-elev, #f5f5f7)',
                  border: '1px solid var(--border, #e5e7eb)',
                  color: 'var(--fg-muted, #6b7280)', font: 'inherit', fontSize: 12,
                }}
              >
                <LuMessagesSquare size={12} aria-hidden />
                <span>
                  {isTr
                    ? `Konuşma (${threadItems.length + 1} mesaj)`
                    : `Conversation (${threadItems.length + 1} messages)`}
                </span>
                <LuChevronDown size={12} style={{ transform: threadOpen ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }} aria-hidden />
              </button>
              {threadOpen ? (
                <div style={{
                  marginTop: 8, padding: 8, display: 'flex', flexDirection: 'column', gap: 4,
                  background: 'var(--bg-elev, #f5f5f7)',
                  border: '1px solid var(--border, #e5e7eb)', borderRadius: 10,
                }}>
                  {threadItems.map((it) => (
                    <button
                      key={it.id}
                      type="button"
                      onClick={() => onPickThreadItem?.(it)}
                      style={{
                        display: 'grid', gridTemplateColumns: '140px 1fr auto', gap: 10,
                        padding: '8px 10px', borderRadius: 6, background: 'transparent', border: 'none',
                        color: 'var(--fg, #1f2937)', font: 'inherit', fontSize: 12.5,
                        textAlign: 'left', cursor: onPickThreadItem ? 'pointer' : 'default',
                        fontWeight: it.isRead ? 400 : 600,
                      }}
                    >
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {it.from ?? (isTr ? '(bilinmiyor)' : '(unknown)')}
                      </span>
                      <span style={{ color: 'var(--fg-muted, #6b7280)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {it.snippet ?? it.subject ?? ''}
                      </span>
                      <span style={{ color: 'var(--fg-subtle, #9ca3af)', fontSize: 11 }}>
                        {new Date(it.date).toLocaleDateString()}
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className={htmlBody ? 'mail-inbox-reader__body mail-inbox-reader__body--html' : 'mail-inbox-reader__body'}>
            {htmlBody ? (
              <div
                className="mail-inbox-reader__html-root mail-inbox-reader__html-root--marketing"
                // eslint-disable-next-line react/no-danger -- sanitizeMailHtml ile temizlenir
                dangerouslySetInnerHTML={{ __html: htmlBody }}
              />
            ) : (
              paragraphs.map((block, i) => (
                <p key={i} className="mail-inbox-reader__para">
                  {block.split('\n').map((line, j, arr) => (
                    <span key={j}>
                      {line}
                      {j < arr.length - 1 ? <br /> : null}
                    </span>
                  ))}
                </p>
              ))
            )}
          </div>

          {/* Gerçek backend ekleri (varsa) — indirilebilir chip listesi. Mock yol
              (attachmentNames) yalnız test/mock veride kullanılır. */}
          {model.attachments && model.attachments.length > 0 ? (
            <div className="mail-inbox-reader__attachments" role="group" aria-label={copy.inboxAttachmentsLabel}>
              <ul className="mail-inbox-reader__attach-list">
                {model.attachments.map((att) => (
                  <li key={att.id} className="mail-inbox-reader__attach-item">
                    <button
                      type="button"
                      onClick={async () => {
                        if (!accessToken || !model.accountId || !messageId) return;
                        try {
                          await messagesApi.downloadAttachment(
                            accessToken, model.accountId, messageId, att.id, att.filename,
                          );
                        } catch (err: any) {
                          window.alert(err?.message ?? (isTr ? 'İndirilemedi' : 'Download failed'));
                        }
                      }}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 8,
                        padding: '6px 10px', border: '1px solid var(--border, #e5e7eb)',
                        borderRadius: 8, background: 'var(--bg-elev, #f9fafb)',
                        color: 'var(--fg, #1f2937)', font: 'inherit', fontSize: 12.5,
                        cursor: 'pointer',
                      }}
                      title={isTr ? 'İndir' : 'Download'}
                    >
                      <LuFile size={14} aria-hidden />
                      <span>{att.filename}</span>
                      <span style={{ color: 'var(--fg-subtle, #9ca3af)', fontSize: 11 }}>
                        {formatBytes(att.sizeBytes)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : files.length > 0 ? (
            <div className="mail-inbox-reader__attachments" role="group" aria-label={copy.inboxAttachmentsLabel}>
              <ul className="mail-inbox-reader__attach-list">
                {files.map((name) => (
                  <li key={name} className="mail-inbox-reader__attach-item">{name}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {showProposalsPanel ? (
          <aside
            className="mail-inbox-reader__proposals"
            aria-label={isTr ? 'AI önerileri' : 'AI suggestions'}
          >
            <div className="mail-inbox-reader__proposals-head">
              <LuSparkles size={16} strokeWidth={2} aria-hidden />
              <span className="mail-inbox-reader__proposals-title">
                {isTr ? 'AI Önerileri' : 'AI Suggestions'}
              </span>
              {proposalsTotal > 0 ? (
                <span className="mail-inbox-reader__proposals-count">{proposalsTotal}</span>
              ) : null}
            </div>

            {proposalsLoading ? (
              <div className="mail-inbox-reader__proposals-loading">
                <LuLoader size={14} strokeWidth={2.5} aria-hidden />
                <span>{isTr ? 'Yükleniyor...' : 'Loading...'}</span>
              </div>
            ) : proposalsTotal === 0 ? (
              <p className="mail-inbox-reader__proposals-empty">
                {isTr
                  ? 'Bu mail için bekleyen AI önerisi yok.'
                  : 'No pending AI suggestions for this email.'}
              </p>
            ) : (
              <ul className="mail-inbox-reader__proposals-list">
                {proposals?.tasks.map((t) => (
                  <li key={t.id} className="mail-inbox-reader__proposal-item">
                    <div className="mail-inbox-reader__proposal-head">
                      <LuListTodo size={14} strokeWidth={2} aria-hidden />
                      <span className="mail-inbox-reader__proposal-kind">
                        {isTr ? 'Görev' : 'Task'}
                      </span>
                    </div>
                    <p className="mail-inbox-reader__proposal-title">{t.title}</p>
                    {t.dueAt ? (
                      <p className="mail-inbox-reader__proposal-meta">
                        {isTr ? 'Son tarih: ' : 'Due: '}
                        {new Date(t.dueAt).toLocaleString(isTr ? 'tr-TR' : 'en-US', {
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    ) : null}
                    {t.notes ? (
                      <p className="mail-inbox-reader__proposal-notes">{t.notes}</p>
                    ) : null}
                    <div className="mail-inbox-reader__proposal-actions">
                      <button
                        type="button"
                        className="mail-inbox-reader__proposal-btn mail-inbox-reader__proposal-btn--approve"
                        onClick={() => handleProposalAction('task', t.id, 'approve')}
                        disabled={pendingActionId === t.id}
                      >
                        <LuCheck size={13} strokeWidth={2.5} aria-hidden />
                        <span>{isTr ? 'Onayla' : 'Approve'}</span>
                      </button>
                      <button
                        type="button"
                        className="mail-inbox-reader__proposal-btn mail-inbox-reader__proposal-btn--reject"
                        onClick={() => handleProposalAction('task', t.id, 'reject')}
                        disabled={pendingActionId === t.id}
                      >
                        <LuX size={13} strokeWidth={2.5} aria-hidden />
                        <span>{isTr ? 'Reddet' : 'Reject'}</span>
                      </button>
                    </div>
                  </li>
                ))}
                {proposals?.calendarEvents.map((e) => (
                  <li key={e.id} className="mail-inbox-reader__proposal-item">
                    <div className="mail-inbox-reader__proposal-head">
                      <LuCalendar size={14} strokeWidth={2} aria-hidden />
                      <span className="mail-inbox-reader__proposal-kind">
                        {isTr ? 'Etkinlik' : 'Event'}
                      </span>
                    </div>
                    <p className="mail-inbox-reader__proposal-title">{e.title}</p>
                    <p className="mail-inbox-reader__proposal-meta">
                      {new Date(e.startAt).toLocaleString(isTr ? 'tr-TR' : 'en-US', {
                        day: 'numeric',
                        month: 'short',
                        hour: e.isAllDay ? undefined : '2-digit',
                        minute: e.isAllDay ? undefined : '2-digit',
                      })}
                      {e.location ? ` · ${e.location}` : ''}
                    </p>
                    {e.description ? (
                      <p className="mail-inbox-reader__proposal-notes">{e.description}</p>
                    ) : null}
                    <div className="mail-inbox-reader__proposal-actions">
                      <button
                        type="button"
                        className="mail-inbox-reader__proposal-btn mail-inbox-reader__proposal-btn--approve"
                        onClick={() => handleProposalAction('calendar-event', e.id, 'approve')}
                        disabled={pendingActionId === e.id}
                      >
                        <LuCheck size={13} strokeWidth={2.5} aria-hidden />
                        <span>{isTr ? 'Onayla' : 'Approve'}</span>
                      </button>
                      <button
                        type="button"
                        className="mail-inbox-reader__proposal-btn mail-inbox-reader__proposal-btn--reject"
                        onClick={() => handleProposalAction('calendar-event', e.id, 'reject')}
                        disabled={pendingActionId === e.id}
                      >
                        <LuX size={13} strokeWidth={2.5} aria-hidden />
                        <span>{isTr ? 'Reddet' : 'Reject'}</span>
                      </button>
                    </div>
                  </li>
                ))}
                {proposals?.reminders.map((r) => (
                  <li key={r.id} className="mail-inbox-reader__proposal-item">
                    <div className="mail-inbox-reader__proposal-head">
                      <LuSparkles size={14} strokeWidth={2} aria-hidden />
                      <span className="mail-inbox-reader__proposal-kind">
                        {isTr ? 'Hatırlatıcı' : 'Reminder'}
                      </span>
                    </div>
                    <p className="mail-inbox-reader__proposal-title">{r.title}</p>
                    {r.fireAt ? (
                      <p className="mail-inbox-reader__proposal-meta">
                        {new Date(r.fireAt).toLocaleString(isTr ? 'tr-TR' : 'en-US', {
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    ) : null}
                    {r.notes ? (
                      <p className="mail-inbox-reader__proposal-notes">{r.notes}</p>
                    ) : null}
                    <div className="mail-inbox-reader__proposal-actions">
                      <button
                        type="button"
                        className="mail-inbox-reader__proposal-btn mail-inbox-reader__proposal-btn--approve"
                        onClick={() => handleProposalAction('reminder', r.id, 'approve')}
                        disabled={pendingActionId === r.id}
                      >
                        <LuCheck size={13} strokeWidth={2.5} aria-hidden />
                        <span>{isTr ? 'Onayla' : 'Approve'}</span>
                      </button>
                      <button
                        type="button"
                        className="mail-inbox-reader__proposal-btn mail-inbox-reader__proposal-btn--reject"
                        onClick={() => handleProposalAction('reminder', r.id, 'reject')}
                        disabled={pendingActionId === r.id}
                      >
                        <LuX size={13} strokeWidth={2.5} aria-hidden />
                        <span>{isTr ? 'Reddet' : 'Reject'}</span>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
