import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LuChartBar, LuMail, LuPlus } from 'react-icons/lu';
import { MailAccountsPage } from './MailAccountsPage';
import { MailAiStatsPage } from './MailAiStatsPage';
import './mail-settings.css';

type SettingsTab = 'accounts' | 'ai-stats';

const TABS: Array<{ key: SettingsTab; label: string; icon: typeof LuMail }> = [
  { key: 'accounts', label: 'Hesaplar', icon: LuMail },
  { key: 'ai-stats', label: 'AI İstatistikleri', icon: LuChartBar },
];

/**
 * Settings sayfası — tek route altında tab nav ile mevcut alt sayfaları
 * (MailAccountsPage, MailAiStatsPage) gösterir. "Yeni Hesap Bağla" CTA'sı
 * Hesaplar tab'ının üstüne gömülüdür; tıklayınca mevcut /connect-email
 * akışına gider.
 *
 * Eski /mail/hesaplar ve /mail/ai-istatistik route'ları korunuyor — direkt
 * link bookmark'larını kırmamak için. Sidebar'da artık "Ayarlar" girişi var.
 */
export function MailSettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('accounts');
  const navigate = useNavigate();

  return (
    <div className="mail-settings-page">
      <nav className="mail-settings-page__tabs" role="tablist">
        {TABS.map((t) => {
          const active = t.key === tab;
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              className={`mail-settings-page__tab${active ? ' mail-settings-page__tab--active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              <Icon size={16} aria-hidden /> {t.label}
            </button>
          );
        })}
      </nav>

      <div className="mail-settings-page__panel">
        {tab === 'accounts' && (
          <>
            <div className="mail-settings-page__connect-cta">
              <div className="mail-settings-page__connect-cta-text">
                <h3 className="mail-settings-page__connect-cta-title">
                  Yeni hesap bağla
                </h3>
                <p className="mail-settings-page__connect-cta-desc">
                  Gmail, Outlook veya başka bir IMAP sağlayıcı hesabını MailMind'a
                  ekle. Bağlandıktan sonra mailler arka planda otomatik
                  senkronize edilir.
                </p>
              </div>
              <button
                type="button"
                className="mail-settings-page__connect-cta-btn"
                onClick={() => navigate('/connect-email')}
              >
                <LuPlus size={16} aria-hidden /> Hesap ekle
              </button>
            </div>
            <MailAccountsPage />
          </>
        )}
        {tab === 'ai-stats' && <MailAiStatsPage />}
      </div>
    </div>
  );
}
