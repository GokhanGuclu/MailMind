import { Navigate, Route, Routes } from 'react-router-dom';
import { HomePage } from '../pages/home/HomePage';
import { AuthSplitPage } from '../pages/auth/AuthSplitPage';
import { ConnectMailPage } from '../pages/connect-mail/ConnectMailPage';
import { MailLayout } from '../pages/mail/MailLayout';
import { MailInboxPage } from '../pages/mail/MailInboxPage';
import { MailCalendarPage } from '../pages/mail/MailCalendarPage';
import { MailDashboardPage } from '../pages/mail/MailDashboardPage';
import { MailSpamPage } from '../pages/mail/MailSpamPage';
import { MailSentPage } from '../pages/mail/MailSentPage';
import { MailDraftsPage } from '../pages/mail/MailDraftsPage';
import { MailTrashPage } from '../pages/mail/MailTrashPage';
import { MailStarredPage } from '../pages/mail/MailStarredPage';
import { MailComposePage } from '../pages/mail/MailComposePage';
import { MailProposalsPage } from '../pages/mail/MailProposalsPage';
import { MailRemindersPage } from '../pages/mail/MailRemindersPage';
import { MailTasksPage } from '../pages/mail/MailTasksPage';
import { MailAiStatsPage } from '../pages/mail/MailAiStatsPage';
import { MailAccountsPage } from '../pages/mail/MailAccountsPage';
import { MailSettingsPage } from '../pages/mail/MailSettingsPage';
import { CookieConsentBanner } from '../shared/components/CookieConsentBanner';
import { ProtectedRoute } from '../shared/components/ProtectedRoute';
import { MailboxGuard } from '../shared/components/MailboxGuard';

export function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Navigate to="/home" replace />} />
        <Route path="/home" element={<HomePage />} />
        <Route path="/login" element={<AuthSplitPage />} />
        <Route path="/register" element={<AuthSplitPage />} />
        <Route
          path="/connect-email"
          element={
            <ProtectedRoute>
              <ConnectMailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/mail"
          element={
            <ProtectedRoute>
              <MailboxGuard>
                <MailLayout />
              </MailboxGuard>
            </ProtectedRoute>
          }
        >
          <Route index element={<MailInboxPage />} />
          <Route path="yildizlilar" element={<MailStarredPage />} />
          <Route path="pano" element={<MailDashboardPage />} />
          <Route path="takvim" element={<MailCalendarPage />} />
          <Route path="spam" element={<MailSpamPage />} />
          <Route path="gonderilen" element={<MailSentPage />} />
          <Route path="taslaklar" element={<MailDraftsPage />} />
          <Route path="cop-kutusu" element={<MailTrashPage />} />
          <Route path="oneriler" element={<MailProposalsPage />} />
          <Route path="animsaticilar" element={<MailRemindersPage />} />
          <Route path="gorevler" element={<MailTasksPage />} />
          <Route path="ai-istatistik" element={<MailAiStatsPage />} />
          <Route path="hesaplar" element={<MailAccountsPage />} />
          <Route path="ayarlar" element={<MailSettingsPage />} />
          <Route path="new" element={<MailComposePage />} />
          <Route path="hesap/:accountId/gelen" element={<MailInboxPage />} />
          <Route path="hesap/:accountId/spam" element={<MailSpamPage />} />
          <Route path="hesap/:accountId/gonderilen" element={<MailSentPage />} />
          <Route path="hesap/:accountId/cop-kutusu" element={<MailTrashPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
      <CookieConsentBanner />
    </>
  );
}
