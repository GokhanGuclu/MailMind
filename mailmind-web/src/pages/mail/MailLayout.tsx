import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  LuBan,
  LuCalendar,
  LuChevronDown,
  LuChevronRight,
  LuFilePen,
  LuInbox,
  LuLayoutGrid,
  LuListTodo,
  LuLogOut,
  LuMail,
  LuMailPlus,
  LuSearch,
  LuSend,
  LuSettings,
  LuSparkles,
  LuStar,
  LuTrash2,
  LuUserRound,
} from 'react-icons/lu';
import { useUIContext } from '../../shared/context/ui-context';
import { useAuth } from '../../shared/context/auth-context';
import { mailDashboardContent, type MailDashboardCopy } from './page.mock-data';
import { NotificationsBell } from './NotificationsBell';
import { useProposalsCount } from '../../shared/hooks/useProposalsCount';
import type { MailboxAccount } from '../../shared/api/mailbox';
import { messagesApi, type ApiMessage } from '../../shared/api/messages';
import './mail-dashboard.css';

function mailNavbarTitle(
  pathname: string,
  copy: MailDashboardCopy,
  accounts: MailboxAccount[],
): string {
  // Hesap-scoped path: /mail/hesap/:accountId/<folder>
  const accountMatch = pathname.match(/\/mail\/hesap\/([^/]+)\/([^/]+)/);
  if (accountMatch) {
    const [, accountId, folder] = accountMatch;
    const acc = accounts.find((a) => a.id === accountId);
    const label =
      folder === 'gelen' ? copy.navGeneralInbox
      : folder === 'spam' ? copy.navSpam
      : folder === 'gonderilen' ? copy.navSent
      : folder === 'cop-kutusu' ? copy.navTrash
      : folder;
    return acc ? `${label} — ${acc.email}` : label;
  }

  if (pathname.endsWith('/pano')) return copy.navDashboard;
  if (pathname.endsWith('/yildizlilar')) return copy.navStarred;
  if (pathname.endsWith('/takvim')) return copy.navCalendar;
  if (pathname.endsWith('/spam')) return copy.navSpam;
  if (pathname.endsWith('/gonderilen')) return copy.navSent;
  if (pathname.endsWith('/taslaklar')) return copy.navDrafts;
  if (pathname.endsWith('/cop-kutusu')) return copy.navTrash;
  if (pathname.endsWith('/oneriler')) return 'AI Önerileri';
  if (pathname.endsWith('/animsaticilar')) return 'Anımsatıcılar';
  if (pathname.endsWith('/gorevler')) return 'Görevler';
  if (pathname.endsWith('/ai-istatistik')) return 'AI İstatistikleri';
  if (pathname.endsWith('/hesaplar')) return 'Mailbox Hesapları';
  if (pathname.endsWith('/ayarlar')) return 'Ayarlar';
  if (pathname.endsWith('/new')) return copy.navNewMail;
  return copy.navGeneralInbox;
}

export function MailLayout() {
  const { language, theme } = useUIContext();
  const copy = mailDashboardContent[language];
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout, mailboxAccounts, accessToken } = useAuth();
  const { count: proposalsCount } = useProposalsCount();

  // Hesap sırası — kullanıcı sidebar'da drag&drop ile yeniden sıralayabilir.
  // localStorage'da accountId dizisi tutuyoruz; listede olmayan id'ler arkaya eklenir.
  const ACCOUNTS_ORDER_KEY = 'mailmind_sidebar_account_order';
  const [accountOrder, setAccountOrder] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(ACCOUNTS_ORDER_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  });
  const persistOrder = (next: string[]) => {
    setAccountOrder(next);
    try {
      localStorage.setItem(ACCOUNTS_ORDER_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  };
  const accountsForSidebar = useMemo(() => {
    const byId = new Map(mailboxAccounts.map((a) => [a.id, a]));
    const ordered: MailboxAccount[] = [];
    const seen = new Set<string>();
    for (const id of accountOrder) {
      const acc = byId.get(id);
      if (acc) {
        ordered.push(acc);
        seen.add(id);
      }
    }
    for (const acc of mailboxAccounts) {
      if (!seen.has(acc.id)) ordered.push(acc);
    }
    return ordered;
  }, [mailboxAccounts, accountOrder]);

  const [draggingAccountId, setDraggingAccountId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const handleAccountDrop = (targetId: string) => {
    if (!draggingAccountId || draggingAccountId === targetId) {
      setDraggingAccountId(null);
      setDropTargetId(null);
      return;
    }
    const currentIds = accountsForSidebar.map((a) => a.id);
    const fromIdx = currentIds.indexOf(draggingAccountId);
    const toIdx = currentIds.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) {
      setDraggingAccountId(null);
      setDropTargetId(null);
      return;
    }
    const next = [...currentIds];
    const [moved] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, moved);
    persistOrder(next);
    setDraggingAccountId(null);
    setDropTargetId(null);
  };

  const navbarTitle = useMemo(
    () => mailNavbarTitle(location.pathname, copy, mailboxAccounts),
    [location.pathname, copy, mailboxAccounts],
  );

  // Hesap grubu aç/kapa (sidebar'da hangi hesabın folder'ları görünür).
  // localStorage'a kaydederek refresh sonrası korunur.
  const ACCOUNTS_COLLAPSED_KEY = 'mailmind_sidebar_collapsed_accounts';
  const [collapsedAccounts, setCollapsedAccounts] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(ACCOUNTS_COLLAPSED_KEY);
      if (!raw) return new Set();
      return new Set(JSON.parse(raw) as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleAccount = (accountId: string) => {
    setCollapsedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      try {
        localStorage.setItem(ACCOUNTS_COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  };

  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const profileWrapRef = useRef<HTMLDivElement>(null);

  // ─── Navbar arama ─── from / to / subject / snippet üzerinde backend ILIKE.
  // Sonuç tıklanınca /mail?open=<id> ile mesaj inbox'ta açılır.
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<ApiMessage[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const searchReqIdRef = useRef(0);

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || !accessToken) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    const reqId = ++searchReqIdRef.current;
    setSearchLoading(true);
    const timer = setTimeout(async () => {
      try {
        const res = await messagesApi.listAll(accessToken, { q, limit: 10 });
        // Yarışı önle: yalnızca son istek state'i yazsın.
        if (reqId !== searchReqIdRef.current) return;
        setSearchResults(res.items);
      } catch {
        if (reqId !== searchReqIdRef.current) return;
        setSearchResults([]);
      } finally {
        if (reqId === searchReqIdRef.current) setSearchLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [searchQuery, accessToken]);

  useEffect(() => {
    if (!searchOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!searchWrapRef.current) return;
      if (!searchWrapRef.current.contains(event.target as Node)) {
        setSearchOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSearchOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [searchOpen]);

  const openSearchHit = (msg: ApiMessage) => {
    setSearchOpen(false);
    setSearchQuery('');
    // Inbox'a yönlendir; ?open=<id> auto-open mantığı zaten MailInboxPage'de var.
    // Sent/Trash/Spam'deki mesaj olsa da inbox sayfası listede bulamayabilir;
    // bu durumda kullanıcı yine de doğru hesap kutusuna gidip arayabilir.
    navigate(`/mail?open=${encodeURIComponent(msg.id)}`);
  };

  const formatSearchDate = (iso: string) => {
    const d = new Date(iso);
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
  };

  const parseFromName = (from: string | null): string => {
    if (!from) return '(unknown)';
    const m = from.match(/^(.*?)\s*<(.+?)>\s*$/);
    if (m) return m[1].trim() || m[2];
    return from;
  };

  const parseFromFull = (from: string | null): { name: string; email: string } => {
    if (!from) return { name: '(unknown)', email: '' };
    const m = from.match(/^(.*?)\s*<(.+?)>\s*$/);
    if (m) return { name: m[1].trim() || m[2], email: m[2] };
    return { name: from, email: from };
  };

  // Arama sonuçlarındaki "from" alanından sorguyla eşleşen tekil kişileri çıkar.
  // Sadece görüntüleme; tıklanamaz.
  const searchContacts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q || searchResults.length === 0) return [] as { name: string; email: string }[];
    const seen = new Map<string, { name: string; email: string }>();
    for (const msg of searchResults) {
      const { name, email } = parseFromFull(msg.from);
      const key = email.toLowerCase() || name.toLowerCase();
      if (!key) continue;
      const matches = name.toLowerCase().includes(q) || email.toLowerCase().includes(q);
      if (!matches) continue;
      if (!seen.has(key)) seen.set(key, { name, email });
    }
    return [...seen.values()].slice(0, 5);
  }, [searchResults, searchQuery]);

  useEffect(() => {
    if (!profileMenuOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!profileWrapRef.current) return;
      if (!profileWrapRef.current.contains(event.target as Node)) {
        setProfileMenuOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProfileMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [profileMenuOpen]);

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
      navigate('/login', { replace: true });
    } finally {
      setLoggingOut(false);
      setProfileMenuOpen(false);
    }
  };

  return (
    <div className={`mail-dash-page theme-${theme}`}>
      <header className="mail-dash-navbar">
        <div className="mail-dash-navbar__left">
          <span className="mail-dash-navbar__logo" aria-hidden>
            <LuMail size={22} />
          </span>
          <span className="mail-dash-navbar__product">MailMind</span>
          <span className="mail-dash-navbar__sep" aria-hidden>
            /
          </span>
          <h1 className="mail-dash-navbar__title">{navbarTitle}</h1>
        </div>
        <div className="mail-dash-navbar__search" ref={searchWrapRef}>
          <label className="mail-dash-navbar__search-field">
            <span className="mail-dash-navbar__search-icon" aria-hidden>
              <LuSearch size={18} />
            </span>
            <input
              type="search"
              className="mail-dash-navbar__search-input"
              placeholder={copy.navSearchPlaceholder}
              autoComplete="off"
              spellCheck={false}
              aria-label={copy.navSearchPlaceholder}
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                if (!searchOpen) setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
            />
          </label>
          {searchOpen && searchQuery.trim().length > 0 && (
            <div className="mail-dash-navbar__search-dropdown" role="listbox">
              {searchLoading && searchResults.length === 0 ? (
                <div className="mail-dash-navbar__search-state">
                  {language === 'tr' ? 'Aranıyor…' : 'Searching…'}
                </div>
              ) : searchResults.length === 0 ? (
                <div className="mail-dash-navbar__search-state">
                  {language === 'tr' ? 'Sonuç yok' : 'No results'}
                </div>
              ) : (
                <>
                  <ul className="mail-dash-navbar__search-list">
                    {searchResults.map((msg) => (
                      <li key={msg.id}>
                        <button
                          type="button"
                          className="mail-dash-navbar__search-hit"
                          onClick={() => openSearchHit(msg)}
                          role="option"
                          aria-selected={false}
                        >
                          <span className="mail-dash-navbar__search-hit-from">
                            {parseFromName(msg.from)}
                          </span>
                          <span className="mail-dash-navbar__search-hit-subject">
                            {msg.subject || (language === 'tr' ? '(konu yok)' : '(no subject)')}
                          </span>
                          <span className="mail-dash-navbar__search-hit-snippet">
                            {msg.snippet ?? ''}
                          </span>
                          <span className="mail-dash-navbar__search-hit-when">
                            {formatSearchDate(msg.date)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {searchContacts.length > 0 && (
                    <div className="mail-dash-navbar__search-section">
                      <div className="mail-dash-navbar__search-section-title">
                        {language === 'tr' ? 'KİŞİLER' : 'PEOPLE'}
                      </div>
                      <ul className="mail-dash-navbar__search-contacts">
                        {searchContacts.map((c) => (
                          <li
                            key={c.email || c.name}
                            className="mail-dash-navbar__search-contact"
                            aria-disabled="true"
                            title={c.email}
                          >
                            <span className="mail-dash-navbar__search-contact-avatar" aria-hidden>
                              {(c.name || c.email || '?').trim().charAt(0).toUpperCase()}
                            </span>
                            <span className="mail-dash-navbar__search-contact-text">
                              <span className="mail-dash-navbar__search-contact-name">{c.name}</span>
                              {c.email && c.email !== c.name && (
                                <span className="mail-dash-navbar__search-contact-email">{c.email}</span>
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
        <div className="mail-dash-navbar__right">
          <NotificationsBell />
          <div className="mail-dash-navbar__profile-wrap" ref={profileWrapRef}>
            <button
              type="button"
              className="mail-dash-navbar__profile"
              aria-label={copy.navProfile}
              title={copy.navProfile}
              aria-haspopup="menu"
              aria-expanded={profileMenuOpen}
              onClick={() => setProfileMenuOpen((open) => !open)}
            >
              <LuUserRound size={22} aria-hidden />
            </button>
            {profileMenuOpen && (
              <div className="mail-dash-navbar__profile-menu" role="menu">
                {user && (
                  <div className="mail-dash-navbar__profile-email" title={user.email}>
                    {user.email}
                  </div>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="mail-dash-navbar__profile-action"
                  onClick={() => {
                    setProfileMenuOpen(false);
                    navigate('/connect-email?add=1');
                  }}
                >
                  <LuMailPlus size={16} aria-hidden />
                  E-posta bağla
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="mail-dash-navbar__profile-action"
                  onClick={() => {
                    setProfileMenuOpen(false);
                    navigate('/mail/hesaplar');
                  }}
                >
                  <LuMail size={16} aria-hidden />
                  Bağlı hesaplar
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="mail-dash-navbar__profile-action"
                  onClick={handleLogout}
                  disabled={loggingOut}
                >
                  <LuLogOut size={16} aria-hidden />
                  {copy.navLogout}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="mail-dash-body">
        <aside className="mail-dash-sidebar" aria-label={copy.sidebarBrand}>
          <div className="mail-dash-sidebar__brand">
            <span className="mail-dash-sidebar__logo" aria-hidden>
              <LuLayoutGrid size={18} />
            </span>
            <span className="mail-dash-sidebar__title">{copy.mailSidebarTitle}</span>
          </div>
          <NavLink
            to="/mail/new"
            className={({ isActive }) =>
              `mail-dash-sidebar__new-mail ${isActive ? 'mail-dash-sidebar__new-mail--active' : ''}`
            }
          >
            <LuMailPlus size={18} strokeWidth={2} aria-hidden />
            {copy.navNewMail}
          </NavLink>
          <nav className="mail-dash-sidebar__nav">
            {/* ─── Üst: birleşik / genel ─── */}
            <NavLink
              to="/mail/pano"
              className={({ isActive }) =>
                `mail-dash-sidebar__link ${isActive ? 'mail-dash-sidebar__link--active' : ''}`
              }
            >
              <LuLayoutGrid size={18} aria-hidden />
              {copy.navDashboard}
            </NavLink>
            <NavLink
              to="/mail"
              end
              className={({ isActive }) =>
                `mail-dash-sidebar__link ${isActive ? 'mail-dash-sidebar__link--active' : ''}`
              }
            >
              <LuInbox size={18} aria-hidden />
              {copy.navGeneralInbox}
            </NavLink>
            <NavLink
              to="/mail/takvim"
              className={({ isActive }) =>
                `mail-dash-sidebar__link ${isActive ? 'mail-dash-sidebar__link--active' : ''}`
              }
            >
              <LuCalendar size={18} aria-hidden />
              {copy.navCalendar}
            </NavLink>
            <NavLink
              to="/mail/oneriler"
              className={({ isActive }) =>
                `mail-dash-sidebar__link ${isActive ? 'mail-dash-sidebar__link--active' : ''}`
              }
            >
              <LuSparkles size={18} aria-hidden />
              <span className="mail-dash-sidebar__link-label">AI Önerileri</span>
              {proposalsCount.total > 0 && (
                <span className="mail-dash-sidebar__link-badge">
                  {proposalsCount.total > 99 ? '99+' : proposalsCount.total}
                </span>
              )}
            </NavLink>
            <NavLink
              to="/mail/gorevler"
              className={({ isActive }) =>
                `mail-dash-sidebar__link ${isActive ? 'mail-dash-sidebar__link--active' : ''}`
              }
            >
              <LuListTodo size={18} aria-hidden />
              Görevler
            </NavLink>
            <NavLink
              to="/mail/yildizlilar"
              className={({ isActive }) =>
                `mail-dash-sidebar__link ${isActive ? 'mail-dash-sidebar__link--active' : ''}`
              }
            >
              <LuStar size={18} aria-hidden />
              {copy.navStarred}
            </NavLink>

            {/* ─── Orta: hesap bazlı klasörler ─── */}
            {accountsForSidebar.map((acc) => {
              const isCollapsed = collapsedAccounts.has(acc.id);
              const isDragging = draggingAccountId === acc.id;
              const isDropTarget = dropTargetId === acc.id && draggingAccountId !== acc.id;
              return (
                <div
                  key={acc.id}
                  className={[
                    'mail-dash-sidebar__account',
                    isDragging ? 'mail-dash-sidebar__account--dragging' : '',
                    isDropTarget ? 'mail-dash-sidebar__account--drop-target' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  draggable
                  onDragStart={(e) => {
                    setDraggingAccountId(acc.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', acc.id);
                  }}
                  onDragEnd={() => {
                    setDraggingAccountId(null);
                    setDropTargetId(null);
                  }}
                  onDragOver={(e) => {
                    if (!draggingAccountId || draggingAccountId === acc.id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (dropTargetId !== acc.id) setDropTargetId(acc.id);
                  }}
                  onDragLeave={() => {
                    if (dropTargetId === acc.id) setDropTargetId(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    handleAccountDrop(acc.id);
                  }}
                >
                  <button
                    type="button"
                    className="mail-dash-sidebar__account-header"
                    title={acc.email}
                    aria-expanded={!isCollapsed}
                    aria-controls={`mail-account-folders-${acc.id}`}
                    onClick={() => toggleAccount(acc.id)}
                  >
                    {isCollapsed ? (
                      <LuChevronRight size={14} aria-hidden />
                    ) : (
                      <LuChevronDown size={14} aria-hidden />
                    )}
                    <span className="mail-dash-sidebar__account-email">{acc.email}</span>
                  </button>
                  {!isCollapsed && (
                    <div id={`mail-account-folders-${acc.id}`}>
                      <NavLink
                        to={`/mail/hesap/${acc.id}/gelen`}
                        className={({ isActive }) =>
                          `mail-dash-sidebar__link mail-dash-sidebar__link--sub ${isActive ? 'mail-dash-sidebar__link--active' : ''}`
                        }
                      >
                        <LuInbox size={16} aria-hidden />
                        {copy.navGeneralInbox}
                      </NavLink>
                      <NavLink
                        to={`/mail/hesap/${acc.id}/spam`}
                        className={({ isActive }) =>
                          `mail-dash-sidebar__link mail-dash-sidebar__link--sub ${isActive ? 'mail-dash-sidebar__link--active' : ''}`
                        }
                      >
                        <LuBan size={16} aria-hidden />
                        {copy.navSpam}
                      </NavLink>
                      <NavLink
                        to={`/mail/hesap/${acc.id}/gonderilen`}
                        className={({ isActive }) =>
                          `mail-dash-sidebar__link mail-dash-sidebar__link--sub ${isActive ? 'mail-dash-sidebar__link--active' : ''}`
                        }
                      >
                        <LuSend size={16} aria-hidden />
                        {copy.navSent}
                      </NavLink>
                      <NavLink
                        to={`/mail/hesap/${acc.id}/cop-kutusu`}
                        className={({ isActive }) =>
                          `mail-dash-sidebar__link mail-dash-sidebar__link--sub ${isActive ? 'mail-dash-sidebar__link--active' : ''}`
                        }
                      >
                        <LuTrash2 size={16} aria-hidden />
                        {copy.navTrash}
                      </NavLink>
                    </div>
                  )}
                </div>
              );
            })}

            {/* ─── Alt: tüm hesaplar için ortak ─── */}
            <div className="mail-dash-sidebar__divider" aria-hidden />
            <NavLink
              to="/mail/taslaklar"
              className={({ isActive }) =>
                `mail-dash-sidebar__link ${isActive ? 'mail-dash-sidebar__link--active' : ''}`
              }
            >
              <LuFilePen size={18} aria-hidden />
              {copy.navDrafts}
            </NavLink>
            <NavLink
              to="/mail/cop-kutusu"
              className={({ isActive }) =>
                `mail-dash-sidebar__link ${isActive ? 'mail-dash-sidebar__link--active' : ''}`
              }
            >
              <LuTrash2 size={18} aria-hidden />
              {copy.navTrash}
            </NavLink>
            <NavLink
              to="/mail/ayarlar"
              className={({ isActive }) =>
                `mail-dash-sidebar__link ${isActive ? 'mail-dash-sidebar__link--active' : ''}`
              }
            >
              <LuSettings size={18} aria-hidden />
              Ayarlar
            </NavLink>
          </nav>
        </aside>

        <Outlet />
      </div>
    </div>
  );
}
