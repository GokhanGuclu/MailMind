type ConnectMailText = {
  title: string;
  subtitle: string;
  gmailTitle: string;
  gmailDesc: string;
  outlookTitle: string;
  outlookDesc: string;
  icloudTitle: string;
  icloudDesc: string;
  imapTitle: string;
  imapDesc: string;
  soonBadge: string;
  infoTitle: string;
  infoBody: string;
  // iCloud connect modal
  icloudModalTitle: string;
  icloudModalSubtitle: string;
  icloudEmailLabel: string;
  icloudEmailPlaceholder: string;
  icloudDisplayNameLabel: string;
  icloudDisplayNamePlaceholder: string;
  icloudAppPasswordLabel: string;
  icloudAppPasswordPlaceholder: string;
  icloudAppPasswordHelpTitle: string;
  icloudAppPasswordHelpBody: string;
  icloudAppPasswordHelpLink: string;
  icloudCancel: string;
  icloudConnect: string;
  icloudConnecting: string;
  // IMAP connect modal
  imapModalTitle: string;
  imapModalSubtitle: string;
  imapSectionImap: string;
  imapSectionSmtp: string;
  imapHostLabel: string;
  imapPortLabel: string;
  imapUsernameLabel: string;
  imapPasswordLabel: string;
  smtpHostLabel: string;
  smtpPortLabel: string;
  smtpUsernameLabel: string;
  smtpPasswordLabel: string;
  imapMirrorPasswordLabel: string;
};

export const connectMailPageContent: Record<'tr' | 'en', ConnectMailText> = {
  tr: {
    title: 'E-posta Hesabınızı Bağlayın',
    subtitle: "MailMind'i kullanmaya başlamak için e-posta hesabınızı bağlayın",
    gmailTitle: 'Gmail',
    gmailDesc: 'Gmail hesabınızı OAuth ile güvenli şekilde bağlayın',
    outlookTitle: 'Outlook',
    outlookDesc: 'Yakında kullanıma açılacak',
    icloudTitle: 'iCloud Mail',
    icloudDesc: 'Apple ID + uygulamaya özel parola ile bağlayın',
    imapTitle: 'Manuel Bağlantı (IMAP)',
    imapDesc:
      'IMAP ve SMTP ayarlarınızla özel sunucunuzu veya alan adınızı bağlayın',
    soonBadge: 'Yakında',
    infoTitle: 'Güvenli Bağlantı',
    infoBody:
      'OAuth ile bağlandığınızda şifrenizi paylaşmadan hesabınıza güvenli erişim sağlanır.',
    icloudModalTitle: 'iCloud Mail bağla',
    icloudModalSubtitle:
      "Apple ID e-posta adresiniz ve uygulamaya özel parola ile bağlanın. iCloud, üçüncü parti uygulamalar için doğrudan Apple ID parolanızı kabul etmez.",
    icloudEmailLabel: 'Apple ID e-posta adresi',
    icloudEmailPlaceholder: 'ornek@icloud.com',
    icloudDisplayNameLabel: 'Görünen ad (opsiyonel)',
    icloudDisplayNamePlaceholder: 'Ad Soyad',
    icloudAppPasswordLabel: 'Uygulamaya özel parola',
    icloudAppPasswordPlaceholder: 'xxxx-xxxx-xxxx-xxxx',
    icloudAppPasswordHelpTitle: 'Uygulamaya özel parola nasıl alınır?',
    icloudAppPasswordHelpBody:
      "appleid.apple.com → Oturum Açma ve Güvenlik → Uygulamaya Özel Parolalar bölümünden yeni bir parola oluşturun. (Apple ID'nizde iki faktörlü kimlik doğrulama açık olmalı.)",
    icloudAppPasswordHelpLink: 'Apple destek sayfasını aç',
    icloudCancel: 'Vazgeç',
    icloudConnect: 'Bağla',
    icloudConnecting: 'Bağlanıyor…',
    imapModalTitle: 'IMAP / SMTP hesabı bağla',
    imapModalSubtitle:
      'Kendi mail sağlayıcınızın IMAP (gelen) ve SMTP (giden) bilgilerini girin. Sağlayıcınızın "Mail istemcisi yapılandırması" sayfasından alabilirsiniz.',
    imapSectionImap: 'Gelen sunucu (IMAP)',
    imapSectionSmtp: 'Giden sunucu (SMTP)',
    imapHostLabel: 'Sunucu adresi',
    imapPortLabel: 'Port',
    imapUsernameLabel: 'Kullanıcı adı',
    imapPasswordLabel: 'Parola',
    smtpHostLabel: 'Sunucu adresi',
    smtpPortLabel: 'Port',
    smtpUsernameLabel: 'Kullanıcı adı',
    smtpPasswordLabel: 'Parola',
    imapMirrorPasswordLabel: 'SMTP parolası IMAP ile aynı',
  },
  en: {
    title: 'Connect your email account',
    subtitle: 'Connect your mailbox to start using MailMind',
    gmailTitle: 'Gmail',
    gmailDesc: 'Connect your Gmail account securely with OAuth',
    outlookTitle: 'Outlook',
    outlookDesc: 'Coming soon',
    icloudTitle: 'iCloud Mail',
    icloudDesc: 'Connect with your Apple ID + app-specific password',
    imapTitle: 'Manual connection (IMAP)',
    imapDesc: 'Connect your domain or custom server with IMAP and SMTP',
    soonBadge: 'Soon',
    infoTitle: 'Secure connection',
    infoBody:
      'With OAuth you get secure access without sharing your password.',
    icloudModalTitle: 'Connect iCloud Mail',
    icloudModalSubtitle:
      'Connect using your Apple ID email and an app-specific password. iCloud does not accept your Apple ID password directly for third-party apps.',
    icloudEmailLabel: 'Apple ID email',
    icloudEmailPlaceholder: 'name@icloud.com',
    icloudDisplayNameLabel: 'Display name (optional)',
    icloudDisplayNamePlaceholder: 'Full name',
    icloudAppPasswordLabel: 'App-specific password',
    icloudAppPasswordPlaceholder: 'xxxx-xxxx-xxxx-xxxx',
    icloudAppPasswordHelpTitle: 'How do I get an app-specific password?',
    icloudAppPasswordHelpBody:
      'Generate one at appleid.apple.com → Sign-In and Security → App-Specific Passwords. (Two-factor authentication must be enabled on your Apple ID.)',
    icloudAppPasswordHelpLink: 'Open Apple support',
    icloudCancel: 'Cancel',
    icloudConnect: 'Connect',
    icloudConnecting: 'Connecting…',
    imapModalTitle: 'Connect via IMAP / SMTP',
    imapModalSubtitle:
      "Enter your email provider's incoming (IMAP) and outgoing (SMTP) server settings. You can find these in your provider's mail client setup page.",
    imapSectionImap: 'Incoming server (IMAP)',
    imapSectionSmtp: 'Outgoing server (SMTP)',
    imapHostLabel: 'Server',
    imapPortLabel: 'Port',
    imapUsernameLabel: 'Username',
    imapPasswordLabel: 'Password',
    smtpHostLabel: 'Server',
    smtpPortLabel: 'Port',
    smtpUsernameLabel: 'Username',
    smtpPasswordLabel: 'Password',
    imapMirrorPasswordLabel: 'SMTP password same as IMAP',
  },
};
