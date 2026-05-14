import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LuArchive,
  LuChevronDown,
  LuChevronLeft,
  LuChevronRight,
  LuEllipsisVertical,
  LuRefreshCw,
  LuStar,
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

const PAGE_SIZE = 50;

/** Parse "Name <email>" into { name, email } */
function parseAddress(addr: string): { name: string; email: string } {
  const match = addr.match(/^(.*?)\s*<(.+?)>\s*$/);
  if (match) return { name: match[1].trim() || match[2], email: match[2] };
  return { name: addr, email: addr };
}

/**
 * Alici(lar)dan ilkini insan-okur biçimde döndür. Display name yoksa
 * email'in @ öncesi kısmını göster — tam mail adresi listede çirkin duruyor.
 */
function formatRecipients(toField: string | null | undefined): { display: string; full: string } {
  if (!toField) return { display: '(unknown)', full: '' };
  const parts = toField
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return { display: '(unknown)', full: '' };
  const first = parseAddress(parts[0]);
  // Display name yoksa name === email olur; o durumda local-part (@ öncesi) göster.
  const friendly =
    first.name && first.name !== first.email
      ? first.name
      : first.email.split('@')[0] || first.email;
  const display = parts.length > 1 ? `${friendly} +${parts.length - 1}` : friendly;
  return { display, full: parts.join(', ') };
}

function formatDate(dateStr: string, language: 'tr' | 'en'): string {
  const d = new Date(dateStr);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
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
  const { display, full } = formatRecipients(msg.to);
  // Sent klasoru: reader'da "Kime:" gosterilmesi icin ilk aliciyi ad+mail olarak gonderelim
  const firstAddr = (msg.to ?? '').split(',')[0]?.trim() ?? '';
  const parsed = parseAddress(firstAddr);
  return {
    subject: msg.subject ?? '(no subject)',
    bodyText: msg.bodyText ?? '',
    bodyHtml: msg.bodyHtml ?? null,
    displayName: parsed.name || display,
    displayEmail: parsed.email || full,
    showRecipientPrefix: true,
    timeDisplay: formatFullDate(msg.date, language),
    dateTimeIso: msg.date,
    attachmentNames: [],
    // Gonderilen postalarda AI ozeti gosterilmez
    aiSummary: '',
  };
}

export function MailSentPage() {
  const { language } = useUIContext();
  const { accessToken, mailboxAccounts } = useAuth();
  const copy = mailDashboardContent[language];

  const { accountId: scopedAccountId } = useParams();
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
      if (!accessToken || !activeAccount) return;
      setLoading(true);
      setError(null);
      try {
        const res = await messagesApi.list(accessToken, activeAccount.id, {
          folder: 'SENT',
          limit: PAGE_SIZE,
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
    [accessToken, activeAccount],
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
      if (accessToken && activeAccount) {
        try {
          const full = await messagesApi.getOne(accessToken, activeAccount.id, msg.id);
          setOpenedMessage(full);
        } catch {
          setOpenedMessage(msg);
        }
      } else {
        setOpenedMessage(msg);
      }
    },
    [accessToken, activeAccount],
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

  const masterCheckboxRef = useRef<HTMLInputElement>(null);
  const pageIds = useMemo(() => messages.map((m) => m.id), [messages]);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const someSelected = pageIds.some((id) => selectedIds.has(id)) && !allSelected;

  useEffect(() => {
    const el = masterCheckboxRef.current;
    if (!el) return;
    el.indeterminate = someSelected;
  }, [someSelected]);

  const toggleStar = useCallback(
    async (id: string) => {
      if (!accessToken || !activeAccount) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, isStarred: !m.isStarred } : m)),
      );
      try {
        await messagesApi.toggleStar(accessToken, activeAccount.id, id);
      } catch {
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, isStarred: !m.isStarred } : m)),
        );
      }
    },
    [accessToken, activeAccount],
  );

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
    const start = pageIndex * PAGE_SIZE + 1;
    const end = start + messages.length - 1;
    if (messages.length === 0) return copy.inboxPageRangeEmpty;
    return copy.inboxPageRangeTemplate
      .replace('{{start}}', String(start))
      .replace('{{end}}', String(end))
      .replace('{{total}}', hasMore ? `${end}+` : String(end));
  }, [copy, pageIndex, messages.length, hasMore]);

  if (!activeAccount) {
    return (
      <main className="mail-dash-main mail-dash-main--inbox-only">
        <div className="mail-inbox" style={{ padding: 32, textAlign: 'center', opacity: 0.6 }}>
          {language === 'tr' ? 'Aktif mail hesabı bulunamadı.' : 'No active mail account found.'}
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
                <div className="mail-inbox-toolbar" role="toolbar" aria-label={copy.sentToolbarAria}>
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
                        <div className="mail-inbox-toolbar__bulk-actions mail-inbox-toolbar__bulk-actions--sent">
                          <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.inboxBulkArchiveAria} title={copy.inboxBulkArchiveAria}>
                            <LuArchive size={18} strokeWidth={1.75} aria-hidden />
                          </button>
                          <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.inboxBulkDeleteAria} title={copy.inboxBulkDeleteAria}>
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
                      {language === 'tr'
                        ? 'Gönderilen mailiniz yok.'
                        : 'You have no sent messages.'}
                    </div>
                  ) : (
                    <ul className="mail-dash-widget__list mail-inbox-list" aria-label={copy.navSent}>
                      {messages.map((msg) => {
                        const { display: recipientName, full: recipientFull } = formatRecipients(msg.to);
                        const when = formatDate(msg.date, language);
                        const hasHtmlBody = Boolean(msg.bodyHtml?.trim());
                        const titleFull = `${msg.subject ?? ''} - ${msg.snippet ?? ''}`;
                        const isStarred = msg.isStarred ?? false;
                        const isSelected = selectedIds.has(msg.id);
                        const isOpen = openedMessage?.id === msg.id;
                        // Gonderilen mailler zaten "okundu" kabul edilir
                        const isRead = true;

                        return (
                          <li
                            key={msg.id}
                            className={[
                              'mail-dash-widget__list-item',
                              'mail-inbox-list__item',
                              isRead ? 'mail-inbox-list__item--read' : '',
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
                            <button
                              type="button"
                              className={
                                isStarred
                                  ? 'mail-inbox-list__star-btn mail-inbox-list__star-btn--starred'
                                  : 'mail-inbox-list__star-btn'
                              }
                              aria-label={copy.inboxStarRowAria}
                              aria-pressed={isStarred}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleStar(msg.id);
                              }}
                            >
                              <LuStar
                                size={18}
                                aria-hidden
                                fill={isStarred ? 'currentColor' : 'none'}
                                stroke="currentColor"
                                strokeWidth={isStarred ? 0 : 1.75}
                              />
                            </button>
                            <span className="mail-inbox-list__sender mail-inbox__from--sent" title={recipientFull}>
                              <span className="mail-inbox-list__to-prefix" aria-hidden>
                                {language === 'tr' ? 'Kime: ' : 'To: '}
                              </span>
                              {recipientName}
                            </span>
                            <div className="mail-inbox-list__mid" title={titleFull}>
                              <span className="mail-inbox-list__subject">
                                {msg.subject ?? '(no subject)'}
                                {hasHtmlBody ? (
                                  <span className="mail-inbox-list__html-badge" title={copy.inboxHtmlBadgeTitle}>
                                    HTML5
                                  </span>
                                ) : null}
                              </span>
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
                  variant="sent"
                  copy={copy}
                  onClose={closeMessage}
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
