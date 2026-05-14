import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LuChevronDown,
  LuChevronLeft,
  LuChevronRight,
  LuEllipsisVertical,
  LuRefreshCw,
  LuRotateCcw,
  LuTrash2,
  LuX,
} from 'react-icons/lu';

import { useParams } from 'react-router-dom';
import { useUIContext } from '../../shared/context/ui-context';
import { useAuth } from '../../shared/context/auth-context';
import { messagesApi, type ApiMessage } from '../../shared/api/messages';
import { mailDashboardContent } from './page.mock-data';
import { MailMessageReader } from './MailMessageReader';
import type { MailReaderModel } from './mail-reader-model';

const TRASH_PAGE_SIZE = 50;

function parseSender(from: string | null): { name: string; email: string } {
  if (!from) return { name: '(unknown)', email: '' };
  const match = from.match(/^(.*?)\s*<(.+?)>\s*$/);
  if (match) {
    return { name: match[1].trim() || match[2], email: match[2] };
  }
  return { name: from, email: from };
}

function formatDate(dateStr: string, language: 'tr' | 'en'): string {
  const d = new Date(dateStr);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) {
    return d.toLocaleTimeString(language === 'tr' ? 'tr-TR' : 'en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return d.toLocaleDateString(language === 'tr' ? 'tr-TR' : 'en-US', {
    day: 'numeric',
    month: 'short',
  });
}

function formatFullDate(dateStr: string, language: 'tr' | 'en'): string {
  const d = new Date(dateStr);
  return d.toLocaleDateString(language === 'tr' ? 'tr-TR' : 'en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function messageToReader(msg: ApiMessage, language: 'tr' | 'en'): MailReaderModel {
  const { name, email } = parseSender(msg.from);
  return {
    subject: msg.subject ?? '(no subject)',
    bodyText: msg.bodyText ?? '',
    bodyHtml: msg.bodyHtml ?? null,
    displayName: name,
    displayEmail: email,
    showRecipientPrefix: false,
    timeDisplay: formatFullDate(msg.date, language),
    dateTimeIso: msg.date,
    attachmentNames: [],
    aiSummary: msg.aiSummary ?? '',
  };
}

export function MailTrashPage() {
  const { language } = useUIContext();
  const { accessToken, mailboxAccounts } = useAuth();
  const copy = mailDashboardContent[language];

  const { accountId: scopedAccountId } = useParams();
  // Hesap-scoped (sidebar'da hesap altındaki Çöp Kutusu) ise sadece o hesap;
  // değilse (alt taraftaki ortak Çöp Kutusu) tüm hesapların birleşik trash'ı.
  const activeAccount = useMemo(() => {
    if (scopedAccountId) return mailboxAccounts.find((a) => a.id === scopedAccountId);
    return mailboxAccounts.find((a) => a.status === 'ACTIVE');
  }, [mailboxAccounts, scopedAccountId]);

  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cursors, setCursors] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [openedMessage, setOpenedMessage] = useState<ApiMessage | null>(null);

  const fetchMessages = useCallback(
    async (cursor?: string) => {
      if (!accessToken) return;
      if (scopedAccountId && !activeAccount) return;
      setLoading(true);
      setError(null);
      try {
        const res = scopedAccountId && activeAccount
          ? await messagesApi.list(accessToken, activeAccount.id, {
              folder: 'TRASH',
              limit: TRASH_PAGE_SIZE,
              cursor,
            })
          : await messagesApi.listAll(accessToken, {
              folder: 'TRASH',
              limit: TRASH_PAGE_SIZE,
              cursor,
            });
        setMessages(res.items);
        setHasMore(res.hasMore);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load messages');
      } finally {
        setLoading(false);
      }
    },
    [accessToken, activeAccount, scopedAccountId],
  );

  useEffect(() => {
    void fetchMessages();
  }, [fetchMessages]);

  const canPrev = pageIndex > 0;
  const canNext = hasMore;

  const goNext = useCallback(() => {
    if (!hasMore || messages.length === 0) return;
    const lastId = messages[messages.length - 1].id;
    setCursors((prev) => [...prev, lastId]);
    setPageIndex((p) => p + 1);
    void fetchMessages(lastId);
  }, [hasMore, messages, fetchMessages]);

  const goPrev = useCallback(() => {
    if (pageIndex <= 0) return;
    setCursors((prev) => {
      const next = [...prev];
      next.pop();
      const prevCursor = next.length > 0 ? next[next.length - 1] : undefined;
      void fetchMessages(prevCursor);
      return next;
    });
    setPageIndex((p) => Math.max(0, p - 1));
  }, [pageIndex, fetchMessages]);

  const refresh = useCallback(() => {
    setCursors([]);
    setPageIndex(0);
    void fetchMessages();
  }, [fetchMessages]);

  const openMessage = useCallback(
    async (msg: ApiMessage) => {
      if (accessToken) {
        try {
          const full = await messagesApi.getOne(accessToken, msg.mailboxAccountId, msg.id);
          setOpenedMessage(full);
        } catch {
          setOpenedMessage(msg);
        }
        if (!msg.isRead) {
          void messagesApi.markAsRead(accessToken, msg.mailboxAccountId, msg.id).then(() => {
            setMessages((prev) =>
              prev.map((m) => (m.id === msg.id ? { ...m, isRead: true } : m)),
            );
          });
        }
      } else {
        setOpenedMessage(msg);
      }
    },
    [accessToken],
  );

  const closeMessage = useCallback(() => {
    setOpenedMessage(null);
  }, []);

  useEffect(() => {
    if (!openedMessage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMessage();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openedMessage, closeMessage]);

  const restoreMessage = useCallback(
    async (id: string) => {
      if (!accessToken) return;
      const target = messages.find((m) => m.id === id);
      if (!target) return;
      setMessages((prev) => prev.filter((m) => m.id !== id));
      if (openedMessage?.id === id) setOpenedMessage(null);
      try {
        await messagesApi.move(accessToken, target.mailboxAccountId, id, 'INBOX');
      } catch {
        void fetchMessages();
      }
    },
    [accessToken, messages, openedMessage, fetchMessages],
  );

  const bulkRestore = useCallback(async () => {
    if (!accessToken || selectedIds.size === 0) return;
    const targets = messages.filter((m) => selectedIds.has(m.id));
    const ids = targets.map((m) => m.id);
    setMessages((prev) => prev.filter((m) => !selectedIds.has(m.id)));
    setSelectedIds(new Set());
    if (openedMessage && ids.includes(openedMessage.id)) setOpenedMessage(null);
    try {
      await Promise.all(
        targets.map((m) => messagesApi.move(accessToken, m.mailboxAccountId, m.id, 'INBOX')),
      );
    } catch {
      void fetchMessages();
    }
  }, [accessToken, messages, selectedIds, openedMessage, fetchMessages]);

  const masterCheckboxRef = useRef<HTMLInputElement>(null);
  const pageIds = useMemo(() => messages.map((m) => m.id), [messages]);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const someSelected = pageIds.some((id) => selectedIds.has(id)) && !allSelected;

  useEffect(() => {
    const el = masterCheckboxRef.current;
    if (!el) return;
    el.indeterminate = someSelected;
  }, [someSelected]);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allOnPage = pageIds.length > 0 && pageIds.every((id) => next.has(id));
      if (allOnPage) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  }, [pageIds]);

  const toggleRowSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const clearAllSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const hasSelection = selectedIds.size > 0;

  const pageRangeLabel = useMemo(() => {
    const start = pageIndex * TRASH_PAGE_SIZE + 1;
    const end = start + messages.length - 1;
    if (messages.length === 0) return copy.inboxPageRangeEmpty;
    return copy.inboxPageRangeTemplate
      .replace('{{start}}', String(start))
      .replace('{{end}}', String(end))
      .replace('{{total}}', hasMore ? `${end}+` : String(end));
  }, [copy, pageIndex, messages.length, hasMore]);

  if (scopedAccountId && !activeAccount) {
    return (
      <main className="mail-dash-main mail-dash-main--inbox-only">
        <div className="mail-inbox" style={{ padding: 32, textAlign: 'center', opacity: 0.6 }}>
          {language === 'tr' ? 'Hesap bulunamadı.' : 'Account not found.'}
        </div>
      </main>
    );
  }

  return (
    <main className="mail-dash-main mail-dash-main--inbox-only">
      <div className="mail-inbox">
        <div className="mail-dash-widget__body mail-dash-widget__body--inbox mail-inbox-list__wrap">
          <div
            className={
              openedMessage
                ? 'mail-inbox-list__panel mail-inbox-list__panel--with-reader'
                : 'mail-inbox-list__panel'
            }
          >
            <div className="mail-inbox-list__split">
              <div className="mail-inbox-list__list-column">
            <div className="mail-inbox-toolbar" role="toolbar" aria-label={copy.trashToolbarAria}>
              <div className="mail-inbox-toolbar__leading">
                <div className="mail-inbox-toolbar__select-morph">
                  <div
                    className={`mail-inbox-toolbar__morph-pane mail-inbox-toolbar__morph-pane--select ${!hasSelection ? 'mail-inbox-toolbar__morph-pane--active' : ''}`}
                    aria-hidden={hasSelection}
                  >
                    <div className="mail-inbox-toolbar__select-group">
                      <label className="mail-inbox-toolbar__select-label">
                        <input
                          ref={masterCheckboxRef}
                          type="checkbox"
                          className="mail-inbox-list__checkbox"
                          checked={allSelected}
                          onChange={toggleSelectAll}
                          aria-label={copy.inboxSelectAllAria}
                        />
                      </label>
                      <button
                        type="button"
                        className="mail-inbox-toolbar__caret"
                        aria-label={copy.inboxSelectionMenuAria}
                        aria-haspopup="menu"
                        title={copy.inboxSelectionMenuAria}
                        onClick={(e) => e.preventDefault()}
                      >
                        <LuChevronDown size={16} strokeWidth={2} aria-hidden />
                      </button>
                    </div>
                  </div>
                  <div
                    className={`mail-inbox-toolbar__morph-pane mail-inbox-toolbar__morph-pane--select ${hasSelection ? 'mail-inbox-toolbar__morph-pane--active' : ''}`}
                    aria-hidden={!hasSelection}
                  >
                    <button
                      type="button"
                      className="mail-inbox-toolbar__icon-btn mail-inbox-toolbar__clear-selection"
                      aria-label={copy.inboxClearSelectionAria}
                      title={copy.inboxClearSelectionAria}
                      onClick={clearAllSelection}
                    >
                      <LuX size={18} strokeWidth={2} aria-hidden />
                    </button>
                  </div>
                </div>
                <div className="mail-inbox-toolbar__actions-morph">
                  <div
                    className={`mail-inbox-toolbar__morph-pane mail-inbox-toolbar__morph-pane--actions ${!hasSelection ? 'mail-inbox-toolbar__morph-pane--active' : ''}`}
                    aria-hidden={hasSelection}
                  >
                    <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.inboxRefreshAria} onClick={refresh}>
                      <LuRefreshCw size={18} strokeWidth={1.75} aria-hidden />
                    </button>
                    <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.inboxMoreActionsAria}>
                      <LuEllipsisVertical size={18} strokeWidth={1.75} aria-hidden />
                    </button>
                  </div>
                  <div
                    className={`mail-inbox-toolbar__morph-pane mail-inbox-toolbar__morph-pane--actions ${hasSelection ? 'mail-inbox-toolbar__morph-pane--active' : ''}`}
                    aria-hidden={!hasSelection}
                  >
                    <div className="mail-inbox-toolbar__bulk-actions mail-inbox-toolbar__bulk-actions--trash">
                      <button
                        type="button"
                        className="mail-inbox-toolbar__icon-btn"
                        aria-label={copy.trashBulkRestoreAria}
                        title={copy.trashBulkRestoreAria}
                        onClick={bulkRestore}
                      >
                        <LuRotateCcw size={18} strokeWidth={1.75} aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="mail-inbox-toolbar__icon-btn"
                        aria-label={copy.trashBulkPermanentDeleteAria}
                        title={copy.trashBulkPermanentDeleteAria}
                      >
                        <LuTrash2 size={18} strokeWidth={1.75} aria-hidden />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <div className="mail-inbox-toolbar__pager">
                <button
                  type="button"
                  className="mail-inbox-toolbar__icon-btn"
                  aria-label={copy.inboxPagePrevAria}
                  disabled={!canPrev}
                  onClick={goPrev}
                >
                  <LuChevronLeft size={18} strokeWidth={1.75} aria-hidden />
                </button>
                <span className="mail-inbox-toolbar__page-range" aria-live="polite" title={pageRangeLabel}>
                  {pageRangeLabel}
                </span>
                <button
                  type="button"
                  className="mail-inbox-toolbar__icon-btn"
                  aria-label={copy.inboxPageNextAria}
                  disabled={!canNext}
                  onClick={goNext}
                >
                  <LuChevronRight size={18} strokeWidth={1.75} aria-hidden />
                </button>
              </div>
            </div>
            <div className="mail-dash-list-scroll">
              {loading && messages.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', opacity: 0.5 }}>
                  {language === 'tr' ? 'Yükleniyor...' : 'Loading...'}
                </div>
              ) : error ? (
                <div style={{ padding: 32, textAlign: 'center', color: '#ef4444' }}>{error}</div>
              ) : messages.length === 0 ? (
                <div style={{ padding: 32, textAlign: 'center', opacity: 0.5 }}>
                  {language === 'tr' ? 'Çöp kutunuz boş.' : 'Your trash is empty.'}
                </div>
              ) : (
              <ul className="mail-dash-widget__list mail-inbox-list" aria-label={copy.navTrash}>
              {messages.map((msg) => {
                const { name: senderName, email: senderEmail } = parseSender(msg.from);
                const when = formatDate(msg.date, language);
                const titleFull = `${msg.subject ?? ''} - ${msg.snippet ?? ''}`;
                const isSelected = selectedIds.has(msg.id);
                const isOpen = openedMessage?.id === msg.id;

                return (
                  <li
                    key={msg.id}
                    className={[
                      'mail-dash-widget__list-item',
                      'mail-inbox-list__item',
                      msg.isRead ? 'mail-inbox-list__item--read' : '',
                      isOpen ? 'mail-inbox-list__item--open' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => openMessage(msg)}
                  >
                    <label className="mail-inbox-list__check-wrap">
                      <input
                        type="checkbox"
                        className="mail-inbox-list__checkbox"
                        aria-label={copy.inboxSelectRowAria}
                        checked={isSelected}
                        onChange={() => toggleRowSelected(msg.id)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </label>
                    <span className="mail-inbox-list__sender" title={`${senderName} <${senderEmail}>`}>
                      {senderName}
                    </span>
                    <div className="mail-inbox-list__mid" title={titleFull}>
                      <span className="mail-inbox-list__subject">{msg.subject ?? '(no subject)'}</span>
                      <span className="mail-inbox-list__dash" aria-hidden>
                        {' '}
                        -{' '}
                      </span>
                      <span className="mail-inbox-list__preview">{msg.snippet ?? ''}</span>
                    </div>
                    <time className="mail-inbox-list__when" dateTime={msg.date}>
                      {when}
                    </time>
                  </li>
                );
              })}
              </ul>
              )}
            </div>
              </div>
              {openedMessage ? (
                <MailMessageReader
                  model={messageToReader(openedMessage, language)}
                  variant="trash"
                  copy={copy}
                  onClose={closeMessage}
                  onRestore={() => restoreMessage(openedMessage.id)}
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
