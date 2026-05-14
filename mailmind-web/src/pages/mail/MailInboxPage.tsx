import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams, useParams } from 'react-router-dom';
import { Link } from 'react-router-dom';
import {
  LuArchive,
  LuBan,
  LuBell,
  LuCalendar,
  LuChevronDown,
  LuChevronLeft,
  LuChevronRight,
  LuEllipsisVertical,
  LuListTodo,
  LuMailOpen,
  LuRefreshCw,
  LuStar,
  LuTrash2,
  LuX,
} from 'react-icons/lu';

import { useUIContext } from '../../shared/context/ui-context';
import { useAuth } from '../../shared/context/auth-context';
import { messagesApi, type ApiMessage } from '../../shared/api/messages';
import { useProposalsByMessage } from '../../shared/hooks/useProposalsByMessage';
import { InboxAttachmentChips } from './InboxAttachmentChips';
import { mailDashboardContent } from './page.mock-data';
import { formatMailPageRange } from './format-mail-page-range';
import { MailMessageReader } from './MailMessageReader';
import type { MailReaderModel } from './mail-reader-model';
import { CategoryBadge, normalizeCategory } from './category-badge';
import { CategoryFilterDropdown } from './CategoryFilterDropdown';

const INBOX_PAGE_SIZE = 50;

/** Parse "Name <email>" into { name, email } */
function parseSender(from: string | null): { name: string; email: string } {
  if (!from) return { name: '(unknown)', email: '' };
  const match = from.match(/^(.*?)\s*<(.+?)>\s*$/);
  if (match) {
    return { name: match[1].trim() || match[2], email: match[2] };
  }
  return { name: from, email: from };
}

/** Snippet'ten mailparser placeholder'larını ayıkla.
 * Eski kayıtlarda backend temizliği yokken üretilmiş "[image: …]" / "[cid:…]"
 * artıkları kalmış olabiliyor — UI tarafında da süpürelim. */
function cleanSnippet(s: string | null | undefined): string {
  if (!s) return '';
  return s
    .replace(/\[image:[^\]]*\]/gi, '')
    .replace(/\[cid:[^\]]*\]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
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
    category: msg.category ?? null,
    categoryConfidence: msg.categoryConfidence ?? null,
  };
}

export function MailInboxPage() {
  const { language } = useUIContext();
  const { accessToken, mailboxAccounts } = useAuth();
  const copy = mailDashboardContent[language];
  const [searchParams, setSearchParams] = useSearchParams();
  const { accountId: scopedAccountId } = useParams();

  // Hesap-scoped (/mail/hesap/:accountId/gelen) ise sadece o hesabın inbox'ı;
  // değilse birleşik (tüm hesaplar). Per-mesaj `mailboxAccountId` her item'da
  // dolu olduğundan mark-read / star / move / getOne çağrılarında onu kullanıyoruz.
  const hasAnyAccount = mailboxAccounts.length > 0;

  const { byMessage: aiByMessage } = useProposalsByMessage();
  const [messages, setMessages] = useState<ApiMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cursors, setCursors] = useState<string[]>([]);  // cursor stack for paging
  const [hasMore, setHasMore] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [openedMessage, setOpenedMessage] = useState<ApiMessage | null>(null);
  // Boş set = "Tümü". Backend henüz kategori filtresi sunmuyor; sayfaya
  // yüklenmiş mailler üstünden client-side süzüyoruz. Kullanıcı genelde
  // 50 mail/sayfa görür, bu pratikte yeterli.
  const [categoryFilter, setCategoryFilter] = useState<Set<string>>(() => new Set());

  const fetchMessages = useCallback(
    async (cursor?: string) => {
      if (!accessToken) return;
      setLoading(true);
      setError(null);
      try {
        const res = scopedAccountId
          ? await messagesApi.list(accessToken, scopedAccountId, {
              folder: 'INBOX',
              limit: INBOX_PAGE_SIZE,
              cursor,
            })
          : await messagesApi.listAll(accessToken, {
              folder: 'INBOX',
              limit: INBOX_PAGE_SIZE,
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
    [accessToken, scopedAccountId],
  );

  // Initial load
  useEffect(() => {
    void fetchMessages();
  }, [fetchMessages]);

  // Otomatik refresh: ilk sayfadayken her 30s'de silent sync
  useEffect(() => {
    const POLL_MS = 30_000;
    const id = setInterval(() => {
      // Sadece ilk sayfadaysak ve reader açık değilse refresh yap
      if (pageIndex === 0 && !openedMessage) {
        void fetchMessages();
      }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [fetchMessages, pageIndex, openedMessage]);

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
      next.pop(); // remove current cursor
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
      // Fetch full message with body
      if (accessToken) {
        try {
          const full = await messagesApi.getOne(accessToken, msg.mailboxAccountId, msg.id);
          setOpenedMessage(full);
        } catch {
          // Fallback to list data if getOne fails
          setOpenedMessage(msg);
        }

        // Mark as read
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
    // Açıkken panodan navigasyonla geldiysek URL'deki ?open= param'ını temizle
    if (searchParams.has('open')) {
      const next = new URLSearchParams(searchParams);
      next.delete('open');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Panodan yönlendirme: ?open=<messageId> varsa mesajı doğrudan aç.
  // Birleşik kutuda mesajın hangi hesaba ait olduğunu bilmemiz lazım;
  // mevcut sayfadaki messages listesinden mailboxAccountId'yi türetiyoruz.
  // Listede yoksa sessizce yoksay (eski davranış korunuyor).
  const autoOpenId = searchParams.get('open');
  const [autoOpenedId, setAutoOpenedId] = useState<string | null>(null);
  useEffect(() => {
    if (!autoOpenId || !accessToken) return;
    if (autoOpenedId === autoOpenId) return; // aynı id için tekrar açma
    const hit = messages.find((m) => m.id === autoOpenId);
    if (!hit) return; // mesaj henüz listede değil — bir sonraki render'da dene
    let cancelled = false;
    (async () => {
      try {
        const full = await messagesApi.getOne(accessToken, hit.mailboxAccountId, autoOpenId);
        if (cancelled) return;
        setOpenedMessage(full);
        setAutoOpenedId(autoOpenId);
        if (!full.isRead) {
          void messagesApi.markAsRead(accessToken, hit.mailboxAccountId, autoOpenId).then(() => {
            setMessages((prev) =>
              prev.map((m) => (m.id === autoOpenId ? { ...m, isRead: true } : m)),
            );
          });
        }
      } catch {
        // sessizce yoksay — kullanıcı listeden seçebilir
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [autoOpenId, autoOpenedId, accessToken, messages]);

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
      if (!accessToken) return;
      const target = messages.find((m) => m.id === id);
      if (!target) return;
      // Optimistic update
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, isStarred: !m.isStarred } : m)),
      );
      try {
        await messagesApi.toggleStar(accessToken, target.mailboxAccountId, id);
      } catch {
        // Revert on error
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, isStarred: !m.isStarred } : m)),
        );
      }
    },
    [accessToken, messages],
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

  const deleteMessage = useCallback(
    async (id: string) => {
      if (!accessToken) return;
      const target = messages.find((m) => m.id === id);
      if (!target) return;
      setMessages((prev) => prev.filter((m) => m.id !== id));
      if (openedMessage?.id === id) setOpenedMessage(null);
      try {
        await messagesApi.move(accessToken, target.mailboxAccountId, id, 'TRASH');
      } catch {
        void fetchMessages();
      }
    },
    [accessToken, messages, openedMessage, fetchMessages],
  );

  const bulkDelete = useCallback(async () => {
    if (!accessToken || selectedIds.size === 0) return;
    const ids = [...selectedIds];
    const targets = messages.filter((m) => ids.includes(m.id));
    setMessages((prev) => prev.filter((m) => !ids.includes(m.id)));
    setSelectedIds(new Set());
    if (openedMessage && ids.includes(openedMessage.id)) setOpenedMessage(null);
    try {
      await Promise.all(
        targets.map((m) => messagesApi.move(accessToken, m.mailboxAccountId, m.id, 'TRASH')),
      );
    } catch {
      void fetchMessages();
    }
  }, [accessToken, messages, selectedIds, openedMessage, fetchMessages]);

  const markAsSpam = useCallback(
    async (id: string) => {
      if (!accessToken) return;
      const target = messages.find((m) => m.id === id);
      if (!target) return;
      setMessages((prev) => prev.filter((m) => m.id !== id));
      if (openedMessage?.id === id) setOpenedMessage(null);
      try {
        await messagesApi.move(accessToken, target.mailboxAccountId, id, 'SPAM');
      } catch {
        void fetchMessages();
      }
    },
    [accessToken, messages, openedMessage, fetchMessages],
  );

  const bulkMarkAsSpam = useCallback(async () => {
    if (!accessToken || selectedIds.size === 0) return;
    const ids = [...selectedIds];
    const targets = messages.filter((m) => ids.includes(m.id));
    setMessages((prev) => prev.filter((m) => !ids.includes(m.id)));
    setSelectedIds(new Set());
    if (openedMessage && ids.includes(openedMessage.id)) setOpenedMessage(null);
    try {
      await Promise.all(
        targets.map((m) => messagesApi.move(accessToken, m.mailboxAccountId, m.id, 'SPAM')),
      );
    } catch {
      void fetchMessages();
    }
  }, [accessToken, messages, selectedIds, openedMessage, fetchMessages]);

  const hasSelection = selectedIds.size > 0;

  const pageRangeLabel = useMemo(() => {
    const start = pageIndex * INBOX_PAGE_SIZE + 1;
    const end = start + messages.length - 1;
    if (messages.length === 0) return copy.inboxPageRangeEmpty;
    return copy.inboxPageRangeTemplate
      .replace('{{start}}', String(start))
      .replace('{{end}}', String(end))
      .replace('{{total}}', hasMore ? `${end}+` : String(end));
  }, [copy, pageIndex, messages.length, hasMore]);

  if (!hasAnyAccount) {
    return (
      <main className="mail-dash-main mail-dash-main--inbox-only">
        <div className="mail-inbox" style={{ padding: 32, textAlign: 'center', opacity: 0.6 }}>
          {language === 'tr' ? 'Bağlı mail hesabı bulunamadı.' : 'No mail account connected.'}
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
            <div className="mail-inbox-toolbar" role="toolbar" aria-label={copy.inboxToolbarAria}>
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
                    <div className="mail-inbox-toolbar__bulk-actions">
                      <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.inboxBulkArchiveAria} title={copy.inboxBulkArchiveAria}>
                        <LuArchive size={18} strokeWidth={1.75} aria-hidden />
                      </button>
                      <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.inboxBulkDeleteAria} title={copy.inboxBulkDeleteAria} onClick={bulkDelete}>
                        <LuTrash2 size={18} strokeWidth={1.75} aria-hidden />
                      </button>
                      <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.inboxBulkSpamAria} title={copy.inboxBulkSpamAria} onClick={bulkMarkAsSpam}>
                        <LuBan size={18} strokeWidth={1.75} aria-hidden />
                      </button>
                      <button type="button" className="mail-inbox-toolbar__icon-btn" aria-label={copy.inboxBulkMarkReadAria} title={copy.inboxBulkMarkReadAria}>
                        <LuMailOpen size={18} strokeWidth={1.75} aria-hidden />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              <CategoryFilterDropdown
                language={language}
                value={categoryFilter}
                onChange={setCategoryFilter}
              />
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
                  {language === 'tr' ? 'Gelen kutunuz boş.' : 'Your inbox is empty.'}
                </div>
              ) : (() => {
                const visibleMessages =
                  categoryFilter.size > 0
                    ? messages.filter((m) => {
                        const c = normalizeCategory(m.category);
                        return c != null && categoryFilter.has(c);
                      })
                    : messages;
                if (visibleMessages.length === 0) {
                  const selected = Array.from(categoryFilter).join(', ');
                  return (
                    <div style={{ padding: 32, textAlign: 'center', opacity: 0.5 }}>
                      {language === 'tr'
                        ? `Bu kategoride mail yok: ${selected}`
                        : `No mail in this category: ${selected}`}
                    </div>
                  );
                }
                return (
              <ul className="mail-dash-widget__list mail-inbox-list" aria-label={copy.navGeneralInbox}>
              {visibleMessages.map((msg) => {
                const { name: senderName, email: senderEmail } = parseSender(msg.from);
                const when = formatDate(msg.date, language);
                const hasHtmlBody = Boolean(msg.bodyHtml?.trim());
                const cleanedSnippet = cleanSnippet(msg.snippet);
                const titleFull = `${msg.subject ?? ''} - ${cleanedSnippet}`;
                const isStarred = msg.isStarred ?? false;
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
                    <span className="mail-inbox-list__sender" title={`${senderName} <${senderEmail}>`}>
                      {senderName}
                    </span>
                    <span className="mail-inbox-list__category-cell">
                      <CategoryBadge
                        category={msg.category}
                        confidence={msg.categoryConfidence}
                        className="mail-inbox-list__category-badge mail-category-badge"
                      />
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
                      <span className="mail-inbox-list__preview">{cleanedSnippet}</span>
                    </div>
                    <span className="mail-inbox-list__ai-cell" aria-hidden={!aiByMessage[msg.id]}>
                      {(() => {
                        const ai = aiByMessage[msg.id];
                        if (!ai || ai.total === 0) return null;
                        return (
                          <>
                            {ai.tasks > 0 ? (
                              <Link
                                to="/mail/oneriler"
                                className="mail-inbox-list__ai-badge mail-inbox-list__ai-badge--task"
                                title={`AI önerisi: ${ai.tasks} görev — incelemek için tıkla`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <LuListTodo size={11} aria-hidden /> {ai.tasks}
                              </Link>
                            ) : null}
                            {ai.calendarEvents > 0 ? (
                              <Link
                                to="/mail/oneriler"
                                className="mail-inbox-list__ai-badge mail-inbox-list__ai-badge--event"
                                title={`AI önerisi: ${ai.calendarEvents} etkinlik — incelemek için tıkla`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <LuCalendar size={11} aria-hidden /> {ai.calendarEvents}
                              </Link>
                            ) : null}
                            {ai.reminders > 0 ? (
                              <Link
                                to="/mail/oneriler"
                                className="mail-inbox-list__ai-badge mail-inbox-list__ai-badge--reminder"
                                title={`AI önerisi: ${ai.reminders} anımsatıcı — incelemek için tıkla`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <LuBell size={11} aria-hidden /> {ai.reminders}
                              </Link>
                            ) : null}
                          </>
                        );
                      })()}
                    </span>
                    <time className="mail-inbox-list__when" dateTime={msg.date}>
                      {when}
                    </time>
                  </li>
                );
              })}
              </ul>
                );
              })()}
            </div>
              </div>
              {openedMessage ? (
                <MailMessageReader
                  model={messageToReader(openedMessage, language)}
                  variant="inbox"
                  copy={copy}
                  messageId={openedMessage.id}
                  onClose={closeMessage}
                  onDelete={() => deleteMessage(openedMessage.id)}
                  onSpam={() => markAsSpam(openedMessage.id)}
                  onSummarize={
                    accessToken
                      ? async () => {
                          const res = await messagesApi.summarize(
                            accessToken,
                            openedMessage.mailboxAccountId,
                            openedMessage.id,
                          );
                          return res.summary || null;
                        }
                      : undefined
                  }
                  onCategoryChange={
                    accessToken
                      ? async (next: string) => {
                          const res = await messagesApi.updateCategory(
                            accessToken,
                            openedMessage.mailboxAccountId,
                            openedMessage.id,
                            next,
                          );
                          setOpenedMessage((prev) =>
                            prev && prev.id === res.id
                              ? { ...prev, category: res.category, categoryConfidence: res.categoryConfidence }
                              : prev,
                          );
                          setMessages((prev) =>
                            prev.map((m) =>
                              m.id === res.id
                                ? { ...m, category: res.category, categoryConfidence: res.categoryConfidence }
                                : m,
                            ),
                          );
                        }
                      : undefined
                  }
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
