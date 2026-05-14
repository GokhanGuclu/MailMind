import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  LuArchive,
  LuArrowLeft,
  LuBan,
  LuCalendar,
  LuCheck,
  LuForward,
  LuInbox,
  LuListTodo,
  LuLoader,
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
};

const TYPEWRITER_SPEED_MS = 18; // her karakter arası ms

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

export function MailMessageReader({ model, copy, onClose, variant, messageId, onSummarize, onDelete, onRestore, onSpam, onCategoryChange }: Props) {
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

  // ── AI önerileri (sağ panel) ─────────────────────────────────────────────
  const { accessToken } = useAuth();
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
              <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.trashBulkPermanentDeleteAria} title={copy.trashBulkPermanentDeleteAria}>
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

          {files.length > 0 ? (
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
