import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import ChevronRight from 'lucide-react/dist/esm/icons/chevron-right.js';
import Info from 'lucide-react/dist/esm/icons/info.js';
import Loader2 from 'lucide-react/dist/esm/icons/loader-2.js';
import Mail from 'lucide-react/dist/esm/icons/mail.js';
import Server from 'lucide-react/dist/esm/icons/server.js';
import X from 'lucide-react/dist/esm/icons/x.js';
import gmailSvg from '../../assets/gmail.svg';
import icloudSvg from '../../assets/icloud.svg';
import outlookSvg from '../../assets/outlook.svg';
import { useUIContext } from '../../shared/context/ui-context';
import { useAuth } from '../../shared/context/auth-context';
import { integrationsApi } from '../../shared/api/integrations';
import { mailboxApi } from '../../shared/api/mailbox';
import { ApiError } from '../../shared/api/client';
import { connectMailPageContent } from './page.mock-data';
import './styles.css';

export function ConnectMailPage() {
  const { language, theme } = useUIContext();
  const t = connectMailPageContent[language];
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { accessToken, refreshMailboxAccounts, hasActiveMailbox } = useAuth();
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successEmail, setSuccessEmail] = useState<string | null>(null);
  const [icloudOpen, setIcloudOpen] = useState(false);
  const [imapOpen, setImapOpen] = useState(false);
  // ?add=1 → kullanıcı zaten aktif hesaba sahipken yeni bir hesap eklemek
  // için bilinçli geldi; bu modda hasActiveMailbox auto-redirect devre dışı.
  const isAddMode = searchParams.get('add') === '1';

  // Handle the OAuth callback redirect from the backend
  useEffect(() => {
    const status = searchParams.get('gmail');
    if (!status) return;

    if (status === 'connected') {
      const email = searchParams.get('email');
      setSuccessEmail(email);
      setError(null);
      // Clean the query string and refresh accounts
      void (async () => {
        await refreshMailboxAccounts();
        setSearchParams({}, { replace: true });
      })();
    } else if (status === 'error') {
      const reason = searchParams.get('reason') ?? 'unknown';
      setError(reason);
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, refreshMailboxAccounts, setSearchParams]);

  // Onboarding: ilk kez geliyorsa aktif hesap görünce /mail'e yolla.
  // Add-mode'da (?add=1) kullanıcı bilinçli yeni hesap eklemek için geldi —
  // mevcut aktif hesaba rağmen sayfada kalsın.
  useEffect(() => {
    if (hasActiveMailbox && !isAddMode) {
      navigate('/mail', { replace: true });
    }
  }, [hasActiveMailbox, navigate, isAddMode]);

  const handleGmail = async () => {
    if (isConnecting || !accessToken) return;
    setError(null);
    setIsConnecting(true);
    try {
      const { authorizeUrl } = await integrationsApi.startGoogleConnect(accessToken);
      // Full-page redirect to Google
      window.location.href = authorizeUrl;
    } catch (e) {
      const message = e instanceof ApiError ? e.message : 'Bağlantı başlatılamadı';
      setError(message);
      setIsConnecting(false);
    }
  };

  const handleIcloudConnected = async (email: string) => {
    setSuccessEmail(email);
    setError(null);
    setIcloudOpen(false);
    await refreshMailboxAccounts();
    if (isAddMode) {
      navigate('/mail', { replace: true });
    }
  };

  const handleImapConnected = async (email: string) => {
    setSuccessEmail(email);
    setError(null);
    setImapOpen(false);
    await refreshMailboxAccounts();
    if (isAddMode) {
      navigate('/mail', { replace: true });
    }
  };

  return (
    <main className={`page connect-mail-page theme-${theme}`}>
      <div className="connect-mail-wrap">
        <section className="connect-mail-card">
          <header className="connect-mail-card-head">
            <div className="connect-mail-card-head-icon" aria-hidden>
              <Mail size={22} strokeWidth={2} />
            </div>
            <div className="connect-mail-card-head-text">
              <h1>{t.title}</h1>
              <p>{t.subtitle}</p>
            </div>
          </header>

          <div className="connect-mail-card-body">
            {error && (
              <div className="connect-mail-alert connect-mail-alert--error" role="alert">
                {error}
              </div>
            )}
            {successEmail && !hasActiveMailbox && (
              <div className="connect-mail-alert connect-mail-alert--success" role="status">
                {successEmail} {language === 'tr' ? 'bağlanıyor...' : 'connecting...'}
              </div>
            )}
            <div className="connect-mail-rows">
              <button
                type="button"
                className="connect-mail-row connect-mail-row--gmail"
                onClick={handleGmail}
                disabled={isConnecting}
              >
                <div className="connect-mail-row-main">
                  <div className="connect-mail-logo-box">
                    <img src={gmailSvg} alt="" className="connect-mail-logo-img" />
                  </div>
                  <div className="connect-mail-row-copy">
                    <h2>{t.gmailTitle}</h2>
                    <p>{t.gmailDesc}</p>
                  </div>
                </div>
                <div className="connect-mail-row-trail" aria-hidden>
                  {isConnecting ? (
                    <Loader2 className="connect-mail-spinner" size={20} strokeWidth={2} />
                  ) : (
                    <ChevronRight className="connect-mail-chevron" size={20} strokeWidth={2} />
                  )}
                </div>
              </button>

              <button
                type="button"
                className="connect-mail-row connect-mail-row--icloud"
                onClick={() => setIcloudOpen(true)}
                disabled={isConnecting}
              >
                <div className="connect-mail-row-main">
                  <div className="connect-mail-logo-box">
                    <img src={icloudSvg} alt="" className="connect-mail-logo-img" />
                  </div>
                  <div className="connect-mail-row-copy">
                    <h2>{t.icloudTitle}</h2>
                    <p>{t.icloudDesc}</p>
                  </div>
                </div>
                <div className="connect-mail-row-trail" aria-hidden>
                  <ChevronRight className="connect-mail-chevron" size={20} strokeWidth={2} />
                </div>
              </button>

              <div className="connect-mail-row connect-mail-row--disabled" aria-disabled>
                <div className="connect-mail-row-main">
                  <div className="connect-mail-logo-box connect-mail-logo-box--muted">
                    <img src={outlookSvg} alt="" className="connect-mail-logo-img connect-mail-logo-img--muted" />
                  </div>
                  <div className="connect-mail-row-copy">
                    <h2>{t.outlookTitle}</h2>
                    <p>{t.outlookDesc}</p>
                  </div>
                </div>
                <span className="connect-mail-badge">{t.soonBadge}</span>
              </div>

              <button
                type="button"
                className="connect-mail-row connect-mail-row--imap"
                onClick={() => setImapOpen(true)}
                disabled={isConnecting}
              >
                <div className="connect-mail-row-main">
                  <div className="connect-mail-logo-box connect-mail-logo-box--imap">
                    <Server className="connect-mail-logo-imap-icon" size={22} strokeWidth={2} aria-hidden />
                  </div>
                  <div className="connect-mail-row-copy">
                    <h2>{t.imapTitle}</h2>
                    <p>{t.imapDesc}</p>
                  </div>
                </div>
                <div className="connect-mail-row-trail" aria-hidden>
                  <ChevronRight className="connect-mail-chevron" size={20} strokeWidth={2} />
                </div>
              </button>
            </div>
          </div>
        </section>

        <div className="connect-mail-info" role="note">
          <Info className="connect-mail-info-icon" size={20} strokeWidth={2} aria-hidden />
          <div className="connect-mail-info-text">
            <p className="connect-mail-info-title">{t.infoTitle}</p>
            <p className="connect-mail-info-body">{t.infoBody}</p>
          </div>
        </div>
      </div>

      {icloudOpen && accessToken && (
        <IcloudConnectModal
          accessToken={accessToken}
          onClose={() => setIcloudOpen(false)}
          onConnected={handleIcloudConnected}
          language={language}
        />
      )}

      {imapOpen && accessToken && (
        <ImapConnectModal
          accessToken={accessToken}
          onClose={() => setImapOpen(false)}
          onConnected={handleImapConnected}
          language={language}
        />
      )}
    </main>
  );
}

type IcloudConnectModalProps = {
  accessToken: string;
  onClose: () => void;
  onConnected: (email: string) => void | Promise<void>;
  language: 'tr' | 'en';
};

function IcloudConnectModal({
  accessToken,
  onClose,
  onConnected,
  language,
}: IcloudConnectModalProps) {
  const t = connectMailPageContent[language];
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [appPassword, setAppPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedPassword = appPassword.trim();
    const trimmedDisplay = displayName.trim();

    if (!trimmedEmail || !trimmedPassword) {
      setFormError(language === 'tr' ? 'E-posta ve parola zorunludur.' : 'Email and password are required.');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const account = await mailboxApi.createAccount(accessToken, {
        provider: 'ICLOUD',
        email: trimmedEmail,
        displayName: trimmedDisplay || undefined,
      });
      await mailboxApi.activateAccount(accessToken, account.id, {
        imapPassword: trimmedPassword,
      });
      await onConnected(trimmedEmail);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : language === 'tr' ? 'Bağlanamadı' : 'Connection failed';
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="icloud-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="icloud-modal" onClick={(e) => e.stopPropagation()}>
        <header className="icloud-modal-head">
          <div className="icloud-modal-head-text">
            <h2>{t.icloudModalTitle}</h2>
            <p>{t.icloudModalSubtitle}</p>
          </div>
          <button
            type="button"
            className="icloud-modal-close"
            onClick={onClose}
            aria-label={t.icloudCancel}
          >
            <X size={18} strokeWidth={2} aria-hidden />
          </button>
        </header>

        <form className="icloud-modal-form" onSubmit={handleSubmit}>
          <label className="icloud-modal-field">
            <span className="icloud-modal-label">{t.icloudEmailLabel}</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t.icloudEmailPlaceholder}
              disabled={submitting}
            />
          </label>

          <label className="icloud-modal-field">
            <span className="icloud-modal-label">{t.icloudDisplayNameLabel}</span>
            <input
              type="text"
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t.icloudDisplayNamePlaceholder}
              disabled={submitting}
            />
          </label>

          <label className="icloud-modal-field">
            <span className="icloud-modal-label">{t.icloudAppPasswordLabel}</span>
            <input
              type="password"
              required
              autoComplete="off"
              value={appPassword}
              onChange={(e) => setAppPassword(e.target.value)}
              placeholder={t.icloudAppPasswordPlaceholder}
              disabled={submitting}
            />
          </label>

          <div className="icloud-modal-help">
            <Info size={16} strokeWidth={2} aria-hidden />
            <div>
              <p className="icloud-modal-help-title">{t.icloudAppPasswordHelpTitle}</p>
              <p className="icloud-modal-help-body">{t.icloudAppPasswordHelpBody}</p>
              <a
                href="https://support.apple.com/en-us/102654"
                target="_blank"
                rel="noopener noreferrer"
                className="icloud-modal-help-link"
              >
                {t.icloudAppPasswordHelpLink} ↗
              </a>
            </div>
          </div>

          {formError && (
            <div className="icloud-modal-error" role="alert">
              {formError}
            </div>
          )}

          <footer className="icloud-modal-actions">
            <button
              type="button"
              className="icloud-modal-btn icloud-modal-btn--secondary"
              onClick={onClose}
              disabled={submitting}
            >
              {t.icloudCancel}
            </button>
            <button
              type="submit"
              className="icloud-modal-btn icloud-modal-btn--primary"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <Loader2 className="connect-mail-spinner" size={16} strokeWidth={2} />
                  {t.icloudConnecting}
                </>
              ) : (
                t.icloudConnect
              )}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

type ImapConnectModalProps = {
  accessToken: string;
  onClose: () => void;
  onConnected: (email: string) => void | Promise<void>;
  language: 'tr' | 'en';
};

function ImapConnectModal({
  accessToken,
  onClose,
  onConnected,
  language,
}: ImapConnectModalProps) {
  const t = connectMailPageContent[language];
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('993');
  const [imapUsername, setImapUsername] = useState('');
  const [imapPassword, setImapPassword] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('587');
  const [smtpUsername, setSmtpUsername] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [mirrorPassword, setMirrorPassword] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedDisplay = displayName.trim();
    const trimmedImapHost = imapHost.trim();
    const trimmedImapUser = imapUsername.trim() || trimmedEmail;
    const trimmedImapPass = imapPassword;
    const trimmedSmtpHost = smtpHost.trim();
    const trimmedSmtpUser = smtpUsername.trim() || trimmedEmail;
    const finalSmtpPass = mirrorPassword ? trimmedImapPass : smtpPassword;

    if (!trimmedEmail || !trimmedImapHost || !trimmedImapPass || !trimmedSmtpHost) {
      setFormError(
        language === 'tr'
          ? 'E-posta, IMAP sunucu/parola ve SMTP sunucu zorunludur.'
          : 'Email, IMAP server/password and SMTP server are required.',
      );
      return;
    }

    const imapPortNum = Number(imapPort);
    const smtpPortNum = Number(smtpPort);
    if (!Number.isFinite(imapPortNum) || imapPortNum < 1 || !Number.isFinite(smtpPortNum) || smtpPortNum < 1) {
      setFormError(language === 'tr' ? 'Port değerleri geçersiz.' : 'Port values are invalid.');
      return;
    }

    setSubmitting(true);
    setFormError(null);
    try {
      const account = await mailboxApi.createAccount(accessToken, {
        provider: 'IMAP',
        email: trimmedEmail,
        displayName: trimmedDisplay || undefined,
      });
      await mailboxApi.activateAccount(accessToken, account.id, {
        imapHost: trimmedImapHost,
        imapPort: imapPortNum,
        imapUsername: trimmedImapUser,
        imapPassword: trimmedImapPass,
        smtpHost: trimmedSmtpHost,
        smtpPort: smtpPortNum,
        smtpUsername: trimmedSmtpUser,
        smtpPassword: finalSmtpPass,
      });
      await onConnected(trimmedEmail);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : language === 'tr' ? 'Bağlanamadı' : 'Connection failed';
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="icloud-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="icloud-modal" onClick={(e) => e.stopPropagation()}>
        <header className="icloud-modal-head">
          <div className="icloud-modal-head-text">
            <h2>{t.imapModalTitle}</h2>
            <p>{t.imapModalSubtitle}</p>
          </div>
          <button
            type="button"
            className="icloud-modal-close"
            onClick={onClose}
            aria-label={t.icloudCancel}
          >
            <X size={18} strokeWidth={2} aria-hidden />
          </button>
        </header>

        <form className="icloud-modal-form" onSubmit={handleSubmit}>
          <label className="icloud-modal-field">
            <span className="icloud-modal-label">{t.icloudEmailLabel}</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ornek@domain.com"
              disabled={submitting}
            />
          </label>

          <label className="icloud-modal-field">
            <span className="icloud-modal-label">{t.icloudDisplayNameLabel}</span>
            <input
              type="text"
              autoComplete="name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t.icloudDisplayNamePlaceholder}
              disabled={submitting}
            />
          </label>

          <h3 className="icloud-modal-section">{t.imapSectionImap}</h3>

          <div className="icloud-modal-row">
            <label className="icloud-modal-field icloud-modal-field--grow">
              <span className="icloud-modal-label">{t.imapHostLabel}</span>
              <input
                type="text"
                required
                value={imapHost}
                onChange={(e) => setImapHost(e.target.value)}
                placeholder="imap.example.com"
                disabled={submitting}
              />
            </label>
            <label className="icloud-modal-field icloud-modal-field--port">
              <span className="icloud-modal-label">{t.imapPortLabel}</span>
              <input
                type="number"
                required
                value={imapPort}
                onChange={(e) => setImapPort(e.target.value)}
                disabled={submitting}
              />
            </label>
          </div>

          <label className="icloud-modal-field">
            <span className="icloud-modal-label">{t.imapUsernameLabel}</span>
            <input
              type="text"
              value={imapUsername}
              onChange={(e) => setImapUsername(e.target.value)}
              placeholder={email || 'username'}
              disabled={submitting}
            />
          </label>

          <label className="icloud-modal-field">
            <span className="icloud-modal-label">{t.imapPasswordLabel}</span>
            <input
              type="password"
              required
              autoComplete="off"
              value={imapPassword}
              onChange={(e) => setImapPassword(e.target.value)}
              disabled={submitting}
            />
          </label>

          <h3 className="icloud-modal-section">{t.imapSectionSmtp}</h3>

          <div className="icloud-modal-row">
            <label className="icloud-modal-field icloud-modal-field--grow">
              <span className="icloud-modal-label">{t.smtpHostLabel}</span>
              <input
                type="text"
                required
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                placeholder="smtp.example.com"
                disabled={submitting}
              />
            </label>
            <label className="icloud-modal-field icloud-modal-field--port">
              <span className="icloud-modal-label">{t.smtpPortLabel}</span>
              <input
                type="number"
                required
                value={smtpPort}
                onChange={(e) => setSmtpPort(e.target.value)}
                disabled={submitting}
              />
            </label>
          </div>

          <label className="icloud-modal-field">
            <span className="icloud-modal-label">{t.smtpUsernameLabel}</span>
            <input
              type="text"
              value={smtpUsername}
              onChange={(e) => setSmtpUsername(e.target.value)}
              placeholder={email || 'username'}
              disabled={submitting}
            />
          </label>

          <label className="icloud-modal-checkbox">
            <input
              type="checkbox"
              checked={mirrorPassword}
              onChange={(e) => setMirrorPassword(e.target.checked)}
              disabled={submitting}
            />
            <span>{t.imapMirrorPasswordLabel}</span>
          </label>

          {!mirrorPassword && (
            <label className="icloud-modal-field">
              <span className="icloud-modal-label">{t.smtpPasswordLabel}</span>
              <input
                type="password"
                required
                autoComplete="off"
                value={smtpPassword}
                onChange={(e) => setSmtpPassword(e.target.value)}
                disabled={submitting}
              />
            </label>
          )}

          {formError && (
            <div className="icloud-modal-error" role="alert">
              {formError}
            </div>
          )}

          <footer className="icloud-modal-actions">
            <button
              type="button"
              className="icloud-modal-btn icloud-modal-btn--secondary"
              onClick={onClose}
              disabled={submitting}
            >
              {t.icloudCancel}
            </button>
            <button
              type="submit"
              className="icloud-modal-btn icloud-modal-btn--primary"
              disabled={submitting}
            >
              {submitting ? (
                <>
                  <Loader2 className="connect-mail-spinner" size={16} strokeWidth={2} />
                  {t.icloudConnecting}
                </>
              ) : (
                t.icloudConnect
              )}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}
