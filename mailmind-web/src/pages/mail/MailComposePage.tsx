import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  LuArrowLeft,
  LuBold,
  LuCheck,
  LuChevronDown,
  LuItalic,
  LuLink,
  LuList,
  LuListOrdered,
  LuPaperclip,
  LuRemoveFormatting,
  LuSend,
  LuSparkles,
  LuStrikethrough,
  LuUnderline,
  LuX,
} from 'react-icons/lu';

import { useUIContext } from '../../shared/context/ui-context';
import { useAuth } from '../../shared/context/auth-context';
import { useDrafts } from '../../shared/context/drafts-context';
import { messagesApi } from '../../shared/api/messages';
import { aiApi } from '../../shared/api/ai';
import { mailDashboardContent } from './page.mock-data';

type AttachmentDraft = {
  id: string;
  filename: string;
  size: number;
  contentType: string;
  contentBase64: string;
};

/** "a@x.com, b@y.com" → ["a@x.com", "b@y.com"] */
function parseEmails(input: string): string[] {
  return input
    .split(/[,;]\s*|\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 1234567 → "1.2 MB" */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // dataURL → sadece base64 kısmı
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024; // 20 MB toplam sınır

/** "Ad Soyad <user@host>" veya çıplak "user@host" → "user@host" */
function extractEmail(input: string | null | undefined): string | null {
  if (!input) return null;
  const angle = input.match(/<([^>]+)>/);
  if (angle) return angle[1].trim();
  const naked = input.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/);
  return naked ? naked[0] : null;
}

function escapeHtmlLocal(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildQuoteHeader(
  src: { from: string | null; date: string },
  lang: 'tr' | 'en',
): string {
  const fromTxt = escapeHtmlLocal(src.from ?? '(unknown sender)');
  const dt = new Date(src.date);
  const dateTxt = Number.isNaN(dt.getTime())
    ? ''
    : dt.toLocaleString(lang === 'tr' ? 'tr-TR' : 'en-US');
  const intro =
    lang === 'tr'
      ? `${dateTxt} tarihinde ${fromTxt} şunu yazdı:`
      : `On ${dateTxt}, ${fromTxt} wrote:`;
  return `<div style="color:#666;font-size:0.85em;margin-bottom:4px;">${intro}</div>`;
}

export function MailComposePage() {
  const { language } = useUIContext();
  const copy = mailDashboardContent[language];
  const navigate = useNavigate();
  const { accessToken, mailboxAccounts } = useAuth();
  const { saveDraft, updateDraft, removeDraft, rawDrafts } = useDrafts();
  const [searchParams] = useSearchParams();
  const editingDraftId = searchParams.get('draftId');

  const activeAccounts = useMemo(
    () => mailboxAccounts.filter((a) => a.status === 'ACTIVE'),
    [mailboxAccounts],
  );

  // Gönderen seçimi — birden fazla aktif hesap olduğunda kullanıcı
  // hangisinden yollayacağını burada belirler. İlk render'da listenin ilki
  // seçilir; hesap listesi değişip seçili id artık aktif değilse otomatik
  // ilkine düşeriz.
  const [fromAccountId, setFromAccountId] = useState<string | null>(null);
  useEffect(() => {
    if (activeAccounts.length === 0) {
      setFromAccountId(null);
      return;
    }
    if (!fromAccountId || !activeAccounts.some((a) => a.id === fromAccountId)) {
      setFromAccountId(activeAccounts[0].id);
    }
  }, [activeAccounts, fromAccountId]);

  const activeAccount = useMemo(
    () => activeAccounts.find((a) => a.id === fromAccountId) ?? activeAccounts[0],
    [activeAccounts, fromAccountId],
  );

  // Gönderen custom dropdown'u: native <select> yerine tema-uyumlu açılır panel.
  const [fromMenuOpen, setFromMenuOpen] = useState(false);
  const fromMenuWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fromMenuOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!fromMenuWrapRef.current) return;
      if (!fromMenuWrapRef.current.contains(e.target as Node)) setFromMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFromMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [fromMenuOpen]);

  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [bcc, setBcc] = useState('');
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState('');
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDraftModal, setShowDraftModal] = useState(false);
  const [showAiModal, setShowAiModal] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiTone, setAiTone] = useState<'formal' | 'neutral' | 'friendly'>('neutral');
  const [aiLength, setAiLength] = useState<'short' | 'normal' | 'long'>('normal');
  /** AI isteği gönderildi; cevap/stream bitene kadar form kilitli + placeholder görünür. */
  const [aiBusy, setAiBusy] = useState(false);

  // Yanıt zincirine yapışacak meta — backend `In-Reply-To` ve `References`
  // header'larını bunlarla doldurur. `null` ise yeni mail (zincir başlatma).
  const [inReplyTo, setInReplyTo] = useState<string | null>(null);
  const [references, setReferences] = useState<string[]>([]);

  const editorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hydratedDraftIdRef = useRef<string | null>(null);
  const hydratedReplyKeyRef = useRef<string | null>(null);

  // Draft yükle: ?draftId=... varsa, rawDrafts context'inden bul ve formu doldur.
  useEffect(() => {
    if (!editingDraftId) return;
    if (hydratedDraftIdRef.current === editingDraftId) return;

    const draft = rawDrafts.find((d) => d.id === editingDraftId);
    if (!draft) return;

    hydratedDraftIdRef.current = editingDraftId;

    setTo(draft.to.join(', '));
    if (draft.cc.length) {
      setCc(draft.cc.join(', '));
      setShowCc(true);
    }
    if (draft.bcc.length) {
      setBcc(draft.bcc.join(', '));
      setShowBcc(true);
    }
    setSubject(draft.subject ?? '');

    if (editorRef.current) {
      editorRef.current.innerHTML = draft.bodyHtml ?? draft.bodyText ?? '';
    }

    if (draft.attachments.length) {
      setAttachments(
        draft.attachments.map((a) => ({
          id: `draft-att-${Math.random().toString(36).slice(2, 10)}`,
          filename: a.filename,
          size: Math.ceil((a.contentBase64.length * 3) / 4),
          contentType: a.contentType ?? 'application/octet-stream',
          contentBase64: a.contentBase64,
        })),
      );
    }
  }, [editingDraftId, rawDrafts]);

  // ─── Reply / ReplyAll / Forward hydrate ────────────────────────────────
  // ?reply=<id> | ?replyAll=<id> | ?forward=<id> ile geldiğimizde orijinal
  // maili backend'den çek ve formu doldur. inReplyTo + references state'leri
  // gönderimde header zincirini taşır; Gmail/Outlook bu sayede yanıtı aynı
  // konuşmaya bağlar.
  useEffect(() => {
    const replyId = searchParams.get('reply');
    const replyAllId = searchParams.get('replyAll');
    const forwardId = searchParams.get('forward');
    const mode: 'reply' | 'replyAll' | 'forward' | null = replyId
      ? 'reply'
      : replyAllId
        ? 'replyAll'
        : forwardId
          ? 'forward'
          : null;
    const sourceId = replyId ?? replyAllId ?? forwardId;
    if (!mode || !sourceId || !accessToken) return;

    const key = `${mode}:${sourceId}`;
    if (hydratedReplyKeyRef.current === key) return;
    hydratedReplyKeyRef.current = key;

    void (async () => {
      try {
        const src = await messagesApi.getOneById(accessToken, sourceId);
        const subjectPrefix = mode === 'forward' ? 'Fwd: ' : 'Re: ';
        const hasPrefix = (src.subject ?? '').match(
          mode === 'forward' ? /^\s*(fwd|fw):/i : /^\s*re:/i,
        );
        setSubject(`${hasPrefix ? '' : subjectPrefix}${src.subject ?? ''}`);

        if (mode !== 'forward') {
          const fromEmail = extractEmail(src.from);
          if (fromEmail) setTo(fromEmail);

          if (mode === 'replyAll') {
            const myEmail = activeAccount?.email?.toLowerCase();
            const extras = (src.to || '')
              .split(/[,;]/)
              .map((s) => extractEmail(s))
              .filter((e): e is string => !!e && e.toLowerCase() !== myEmail && e !== fromEmail);
            const ccList = Array.from(new Set(extras));
            if (ccList.length > 0) {
              setCc(ccList.join(', '));
              setShowCc(true);
            }
          }
        }

        // Yanıt zinciri — Message-ID yoksa zincir başlatılamaz, sessizce
        // boş bırakırız; mail yine gönderilir, sadece thread'e bağlanmaz.
        if (mode !== 'forward' && src.messageIdHeader) {
          setInReplyTo(src.messageIdHeader);
          setReferences([src.messageIdHeader]);
        } else {
          setInReplyTo(null);
          setReferences([]);
        }

        // Alıntı bloğu — orijinal mailin HTML/text gövdesini blockquote'a sar.
        const quoteHeader = buildQuoteHeader(src, language);
        const quotedHtml = src.bodyHtml
          ? `<br/><br/><div class="mailmind-quote">${quoteHeader}<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex;">${src.bodyHtml}</blockquote></div>`
          : `<br/><br/><div class="mailmind-quote">${quoteHeader}<blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex;white-space:pre-wrap;">${escapeHtmlLocal(src.bodyText ?? '')}</blockquote></div>`;

        if (editorRef.current) {
          editorRef.current.innerHTML = quotedHtml;
        }
      } catch (err: any) {
        setError(
          err?.message ??
            (language === 'tr' ? 'Orijinal mail yüklenemedi.' : 'Could not load original message.'),
        );
      }
    })();
  }, [searchParams, accessToken, activeAccount, language]);

  const hasContent = useCallback(() => {
    const bodyText = (editorRef.current?.innerText ?? '').trim();
    return to.trim() !== '' || subject.trim() !== '' || bodyText !== '';
  }, [to, subject]);

  const goBack = useCallback(() => {
    if (hasContent()) {
      setShowDraftModal(true);
    } else {
      navigate('/mail');
    }
  }, [hasContent, navigate]);

  const [savingDraft, setSavingDraft] = useState(false);

  const handleSaveDraft = useCallback(async () => {
    if (savingDraft) return;
    const bodyText = (editorRef.current?.innerText ?? '').trim();
    const bodyHtml = editorRef.current?.innerHTML ?? '';
    const toList = to.trim() ? parseEmails(to) : undefined;
    const ccList = cc.trim() ? parseEmails(cc) : undefined;
    const bccList = bcc.trim() ? parseEmails(bcc) : undefined;

    setSavingDraft(true);
    setError(null);
    try {
      const payload = {
        to: toList,
        cc: ccList,
        bcc: bccList,
        subject: subject.trim() || undefined,
        bodyText: bodyText || undefined,
        bodyHtml: bodyHtml || undefined,
        attachments: attachments.length
          ? attachments.map((a) => ({
              filename: a.filename,
              contentBase64: a.contentBase64,
              contentType: a.contentType,
            }))
          : undefined,
      };
      const result = editingDraftId
        ? await updateDraft(editingDraftId, payload)
        : await saveDraft(payload);
      if (!result) {
        setError(language === 'tr' ? 'Taslak kaydedilemedi.' : 'Failed to save draft.');
        return;
      }
      setShowDraftModal(false);
      navigate('/mail/taslaklar');
    } finally {
      setSavingDraft(false);
    }
  }, [
    savingDraft,
    saveDraft,
    updateDraft,
    editingDraftId,
    to,
    cc,
    bcc,
    subject,
    attachments,
    language,
    navigate,
  ]);

  const handleDiscardDraft = useCallback(() => {
    setShowDraftModal(false);
    navigate('/mail');
  }, [navigate]);

  // Toolbar aktif durum haritası — imleç/secim hangi biçimlerin içindeyse true
  const [activeFormats, setActiveFormats] = useState<Record<string, boolean>>({});

  const refreshActiveFormats = useCallback(() => {
    // Seçim editor'un dışındaysa butonları pasif göster
    const sel = window.getSelection();
    const anchor = sel?.anchorNode;
    const editorEl = editorRef.current;
    const inside =
      !!editorEl && !!anchor && (editorEl === anchor || editorEl.contains(anchor));
    if (!inside) {
      setActiveFormats({});
      return;
    }
    try {
      setActiveFormats({
        bold: document.queryCommandState('bold'),
        italic: document.queryCommandState('italic'),
        underline: document.queryCommandState('underline'),
        strikeThrough: document.queryCommandState('strikeThrough'),
        insertUnorderedList: document.queryCommandState('insertUnorderedList'),
        insertOrderedList: document.queryCommandState('insertOrderedList'),
      });
    } catch {
      // queryCommandState bazı tarayıcılarda fırlatabilir — sessizce yoksay
    }
  }, []);

  /** document.execCommand deprecated olsa da contentEditable'da hâlâ en pratik yol. */
  const exec = useCallback(
    (cmd: string, value?: string) => {
      editorRef.current?.focus();
      document.execCommand(cmd, false, value);
      refreshActiveFormats();
    },
    [refreshActiveFormats],
  );

  // Seçim değişimini ve klavye/fare olaylarını global dinle
  useEffect(() => {
    const handler = () => refreshActiveFormats();
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [refreshActiveFormats]);

  const onInsertLink = useCallback(() => {
    const url = window.prompt(language === 'tr' ? 'Bağlantı URL’i:' : 'Link URL:');
    if (!url) return;
    exec('createLink', url);
  }, [exec, language]);

  const onPickFiles = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFilesSelected = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length === 0) return;
      e.target.value = ''; // aynı dosya ikinci kez seçilebilsin

      const currentSize = attachments.reduce((s, a) => s + a.size, 0);
      const additionalSize = files.reduce((s, f) => s + f.size, 0);
      if (currentSize + additionalSize > MAX_ATTACHMENT_BYTES) {
        setError(
          language === 'tr'
            ? 'Toplam ek boyutu 20 MB sınırını aşıyor.'
            : 'Total attachment size exceeds 20 MB limit.',
        );
        return;
      }

      try {
        const newDrafts: AttachmentDraft[] = await Promise.all(
          files.map(async (f) => ({
            id: `${Date.now()}-${f.name}-${Math.random().toString(36).slice(2, 8)}`,
            filename: f.name,
            size: f.size,
            contentType: f.type || 'application/octet-stream',
            contentBase64: await readFileAsBase64(f),
          })),
        );
        setAttachments((prev) => [...prev, ...newDrafts]);
        setError(null);
      } catch {
        setError(language === 'tr' ? 'Dosya okunamadı.' : 'Failed to read file.');
      }
    },
    [attachments, language],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const onSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!accessToken || !activeAccount) {
        setError(
          language === 'tr'
            ? 'Aktif mail hesabı bulunamadı.'
            : 'No active mail account found.',
        );
        return;
      }
      const toList = parseEmails(to);
      if (toList.length === 0) {
        setError(language === 'tr' ? 'En az bir alıcı girin.' : 'Add at least one recipient.');
        return;
      }
      const ccList = cc ? parseEmails(cc) : undefined;
      const bccList = bcc ? parseEmails(bcc) : undefined;

      const html = editorRef.current?.innerHTML ?? '';
      // Plain text fallback: HTML etiketlerini kaba şekilde sıyır
      const text = (editorRef.current?.innerText ?? '').trim();

      setSending(true);
      setError(null);
      try {
        await messagesApi.send(accessToken, activeAccount.id, {
          to: toList,
          cc: ccList,
          bcc: bccList,
          subject: subject || undefined,
          text: text || undefined,
          html: html || undefined,
          inReplyTo: inReplyTo ?? undefined,
          references: references.length > 0 ? references : undefined,
          attachments: attachments.length
            ? attachments.map((a) => ({
                filename: a.filename,
                contentBase64: a.contentBase64,
                contentType: a.contentType,
              }))
            : undefined,
        });
        // Başarılı → düzenlenen taslak varsa sil, sonra Gönderilmiş klasörüne yönlendir
        if (editingDraftId) {
          try {
            await removeDraft(editingDraftId);
          } catch {
            // taslak silinemezse kullanıcıyı engellemeyelim
          }
        }
        navigate('/mail/gonderilen');
      } catch (err: any) {
        setError(err?.message ?? (language === 'tr' ? 'Gönderim başarısız.' : 'Send failed.'));
      } finally {
        setSending(false);
      }
    },
    [
      accessToken,
      activeAccount,
      to,
      cc,
      bcc,
      subject,
      attachments,
      inReplyTo,
      references,
      language,
      navigate,
      editingDraftId,
      removeDraft,
    ],
  );

  /** ms bekle */
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** HTML meta karakterlerini escape et. */
  const escapeHtml = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  /** Konu + gövdeyi soldan sağa harf harf editöre bas. */
  const streamIntoForm = useCallback(
    async (subjectText: string, bodyText: string, bodyHtml: string) => {
      const SUBJECT_MS = 22;
      const BODY_MS = 10;

      // Konu
      setSubject('');
      for (let i = 1; i <= subjectText.length; i++) {
        setSubject(subjectText.slice(0, i));
        // eslint-disable-next-line no-await-in-loop
        await sleep(SUBJECT_MS);
      }

      // Gövde — editöre düz metin olarak harf harf yaz (yeni satır → <br/>).
      if (editorRef.current) editorRef.current.innerHTML = '';
      for (let i = 1; i <= bodyText.length; i++) {
        const chunk = bodyText.slice(0, i);
        const safe = escapeHtml(chunk).replace(/\n/g, '<br/>');
        if (editorRef.current) editorRef.current.innerHTML = safe;
        // eslint-disable-next-line no-await-in-loop
        await sleep(BODY_MS);
      }
      // Animasyon bittiğinde tam HTML çıktısını yerleştir (paragraflı)
      if (editorRef.current) editorRef.current.innerHTML = bodyHtml;
    },
    [],
  );

  const handleAiGenerate = useCallback(async () => {
    if (!accessToken) {
      setAiError(language === 'tr' ? 'Önce giriş yapmalısınız.' : 'You must be signed in.');
      return;
    }
    const prompt = aiPrompt.trim();
    if (prompt.length < 3) {
      setAiError(
        language === 'tr'
          ? 'Lütfen ne yazmak istediğinizi kısaca açıklayın.'
          : 'Please describe what you want to write.',
      );
      return;
    }

    // 1) Modal hemen kapat, formu kilitle, konuya yükleniyor yer tutucusu koy
    setAiLoading(true);
    setAiError(null);
    setShowAiModal(false);
    setAiBusy(true);
    const placeholder = language === 'tr' ? 'AI Yükleniyor…' : 'AI loading…';
    setSubject(placeholder);
    if (editorRef.current) editorRef.current.innerHTML = '';

    try {
      // 2) API çağrısı
      const result = await aiApi.compose(accessToken, {
        prompt,
        language,
        tone: aiTone,
        length: aiLength,
      });
      // 3) Harf harf bas
      await streamIntoForm(result.subject, result.bodyText, result.bodyHtml);
      setAiPrompt('');
    } catch (err: any) {
      // Hata: placeholder'ı temizle, hatayı göster
      setSubject('');
      setAiError(
        err?.message ?? (language === 'tr' ? 'AI hazırlayamadı.' : 'AI could not compose.'),
      );
      setError(
        err?.message ?? (language === 'tr' ? 'AI hazırlayamadı.' : 'AI could not compose.'),
      );
    } finally {
      setAiLoading(false);
      setAiBusy(false);
    }
  }, [accessToken, aiPrompt, aiTone, aiLength, language, streamIntoForm]);

  const totalAttachmentSize = useMemo(
    () => attachments.reduce((s, a) => s + a.size, 0),
    [attachments],
  );

  return (
    <main className="mail-dash-main mail-dash-main--compose" aria-label={copy.composeRegionAria}>
      {showAiModal ? (
        <div
          className="draft-confirm-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={language === 'tr' ? 'AI ile hazırla' : 'Draft with AI'}
          onClick={(e) => {
            if (e.target === e.currentTarget && !aiLoading) setShowAiModal(false);
          }}
        >
          <div className="draft-confirm-dialog ai-compose-dialog">
            <h2 className="draft-confirm-dialog__title">
              {language === 'tr' ? 'AI ile hazırla' : 'Draft with AI'}
            </h2>
            <p className="draft-confirm-dialog__body">
              {language === 'tr'
                ? 'Ne yazmak istediğinizi birkaç cümleyle anlatın. AI bunu düzgün, nazik bir e-postaya dönüştürsün.'
                : 'Describe what you want to say. AI will turn it into a polished email.'}
            </p>

            <textarea
              className="ai-compose-dialog__textarea"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder={
                language === 'tr'
                  ? 'Örn: Ayşe Hanım\'a yarınki toplantının 14:00\'e ertelendiğini bildir, saygılı bir dille.'
                  : 'E.g.: Let Jane know tomorrow\'s meeting is postponed to 2 pm, politely.'
              }
              rows={5}
              disabled={aiLoading}
              autoFocus
            />

            <div className="ai-compose-dialog__tone">
              <span className="ai-compose-dialog__tone-label">
                {language === 'tr' ? 'Ton:' : 'Tone:'}
              </span>
              {(['formal', 'neutral', 'friendly'] as const).map((t) => (
                <label key={t} className="ai-compose-dialog__tone-opt">
                  <input
                    type="radio"
                    name="ai-tone"
                    value={t}
                    checked={aiTone === t}
                    onChange={() => setAiTone(t)}
                    disabled={aiLoading}
                  />
                  <span>
                    {language === 'tr'
                      ? t === 'formal'
                        ? 'Resmi'
                        : t === 'friendly'
                          ? 'Samimi'
                          : 'Nötr'
                      : t === 'formal'
                        ? 'Formal'
                        : t === 'friendly'
                          ? 'Friendly'
                          : 'Neutral'}
                  </span>
                </label>
              ))}
            </div>

            <div className="ai-compose-dialog__tone">
              <span className="ai-compose-dialog__tone-label">
                {language === 'tr' ? 'Uzunluk:' : 'Length:'}
              </span>
              {(['short', 'normal', 'long'] as const).map((l) => (
                <label key={l} className="ai-compose-dialog__tone-opt">
                  <input
                    type="radio"
                    name="ai-length"
                    value={l}
                    checked={aiLength === l}
                    onChange={() => setAiLength(l)}
                    disabled={aiLoading}
                  />
                  <span>
                    {language === 'tr'
                      ? l === 'short'
                        ? 'Kısa'
                        : l === 'long'
                          ? 'Uzun'
                          : 'Normal'
                      : l === 'short'
                        ? 'Short'
                        : l === 'long'
                          ? 'Long'
                          : 'Normal'}
                  </span>
                </label>
              ))}
            </div>

            {aiError ? (
              <div className="mail-compose__error" role="alert" style={{ marginTop: 8 }}>
                {aiError}
              </div>
            ) : null}

            <div className="draft-confirm-dialog__actions">
              <button
                type="button"
                className="mail-compose__btn mail-compose__btn--ghost"
                onClick={() => setShowAiModal(false)}
                disabled={aiLoading}
              >
                {language === 'tr' ? 'Vazgeç' : 'Cancel'}
              </button>
              <button
                type="button"
                className="mail-compose__btn mail-compose__btn--primary"
                onClick={handleAiGenerate}
                disabled={aiLoading || aiPrompt.trim().length < 3}
              >
                <LuSparkles size={16} strokeWidth={2.25} aria-hidden />
                {aiLoading
                  ? language === 'tr'
                    ? 'Hazırlanıyor…'
                    : 'Generating…'
                  : language === 'tr'
                    ? 'Hazırla'
                    : 'Generate'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showDraftModal ? (
        <div className="draft-confirm-overlay" role="dialog" aria-modal="true" aria-label={language === 'tr' ? 'Taslağı kaydet' : 'Save draft'}>
          <div className="draft-confirm-dialog">
            <h2 className="draft-confirm-dialog__title">
              {language === 'tr' ? 'Taslağa kaydedelim mi?' : 'Save as draft?'}
            </h2>
            <p className="draft-confirm-dialog__body">
              {language === 'tr'
                ? 'Yazdığınız içerik kaybolmasın diye taslak olarak saklayabiliriz.'
                : "We can save your message as a draft so you don't lose it."}
            </p>
            <div className="draft-confirm-dialog__actions">
              <button
                type="button"
                className="mail-compose__btn mail-compose__btn--ghost"
                onClick={handleDiscardDraft}
                disabled={savingDraft}
              >
                {language === 'tr' ? 'Vazgeç' : 'Discard'}
              </button>
              <button
                type="button"
                className="mail-compose__btn mail-compose__btn--primary"
                onClick={handleSaveDraft}
                disabled={savingDraft}
              >
                {savingDraft
                  ? language === 'tr'
                    ? 'Kaydediliyor…'
                    : 'Saving…'
                  : language === 'tr'
                    ? 'Taslağa Kaydet'
                    : 'Save Draft'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <form className="mail-compose" onSubmit={onSubmit}>
        <header className="mail-compose__head">
          <button
            type="button"
            className="mail-compose__back"
            onClick={goBack}
            aria-label={copy.composeBackAria}
            title={copy.composeBackAria}
          >
            <LuArrowLeft size={20} strokeWidth={2} aria-hidden />
          </button>
          <h1 className="mail-compose__title">{copy.composeTitle}</h1>
          <div className="mail-compose__head-actions">
            <button
              type="button"
              className="mail-compose__btn mail-compose__btn--ghost"
              onClick={goBack}
              disabled={sending || aiBusy}
            >
              {copy.composeClose}
            </button>
            <button
              type="submit"
              className="mail-compose__btn mail-compose__btn--primary"
              disabled={sending || aiBusy}
            >
              <LuSend size={16} strokeWidth={2.25} aria-hidden />
              {sending
                ? language === 'tr'
                  ? 'Gönderiliyor…'
                  : 'Sending…'
                : copy.composeSend}
            </button>
          </div>
        </header>

        {error ? (
          <div className="mail-compose__error" role="alert">
            {error}
          </div>
        ) : null}

        <div className="mail-compose__card">
          {activeAccount ? (
            <div className="mail-compose__row">
              <span className="mail-compose__row-label">
                {language === 'tr' ? 'Gönderen' : 'From'}
              </span>
              <div className="mail-compose__from-wrap" ref={fromMenuWrapRef}>
                <button
                  type="button"
                  className="mail-compose__from-trigger"
                  onClick={() => {
                    if (activeAccounts.length > 1) setFromMenuOpen((v) => !v);
                  }}
                  disabled={sending || aiBusy || activeAccounts.length <= 1}
                  aria-haspopup="listbox"
                  aria-expanded={fromMenuOpen}
                >
                  <span className="mail-compose__from-text">
                    {activeAccount.displayName
                      ? `${activeAccount.displayName} <${activeAccount.email}>`
                      : activeAccount.email}
                  </span>
                  {activeAccounts.length > 1 && (
                    <LuChevronDown size={16} aria-hidden className="mail-compose__from-caret" />
                  )}
                </button>
                {fromMenuOpen && activeAccounts.length > 1 && (
                  <ul className="mail-compose__from-menu" role="listbox">
                    {activeAccounts.map((a) => {
                      const selected = a.id === fromAccountId;
                      return (
                        <li key={a.id}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={`mail-compose__from-option ${selected ? 'mail-compose__from-option--selected' : ''}`}
                            onClick={() => {
                              setFromAccountId(a.id);
                              setFromMenuOpen(false);
                            }}
                          >
                            <span className="mail-compose__from-option-text">
                              <span className="mail-compose__from-option-name">
                                {a.displayName || a.email}
                              </span>
                              {a.displayName && (
                                <span className="mail-compose__from-option-email">{a.email}</span>
                              )}
                              <span className="mail-compose__from-option-provider">{a.provider}</span>
                            </span>
                            {selected && <LuCheck size={16} aria-hidden />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          ) : null}

          <div className="mail-compose__row">
            <span className="mail-compose__row-label">{copy.composeToLabel}</span>
            <input
              type="text"
              className="mail-compose__row-input"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder={language === 'tr' ? 'ornek@alan.com, ornek2@alan.com' : 'a@example.com, b@example.com'}
              autoComplete="email"
              spellCheck={false}
              required
            />
            <div className="mail-compose__row-aux">
              {!showCc ? (
                <button
                  type="button"
                  className="mail-compose__chip-btn"
                  onClick={() => setShowCc(true)}
                >
                  Cc
                </button>
              ) : null}
              {!showBcc ? (
                <button
                  type="button"
                  className="mail-compose__chip-btn"
                  onClick={() => setShowBcc(true)}
                >
                  Bcc
                </button>
              ) : null}
            </div>
          </div>

          {showCc ? (
            <div className="mail-compose__row">
              <span className="mail-compose__row-label">Cc</span>
              <input
                type="text"
                className="mail-compose__row-input"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                spellCheck={false}
              />
              <button
                type="button"
                className="mail-compose__row-remove"
                onClick={() => {
                  setCc('');
                  setShowCc(false);
                }}
                aria-label="Cc"
              >
                <LuX size={16} aria-hidden />
              </button>
            </div>
          ) : null}

          {showBcc ? (
            <div className="mail-compose__row">
              <span className="mail-compose__row-label">Bcc</span>
              <input
                type="text"
                className="mail-compose__row-input"
                value={bcc}
                onChange={(e) => setBcc(e.target.value)}
                spellCheck={false}
              />
              <button
                type="button"
                className="mail-compose__row-remove"
                onClick={() => {
                  setBcc('');
                  setShowBcc(false);
                }}
                aria-label="Bcc"
              >
                <LuX size={16} aria-hidden />
              </button>
            </div>
          ) : null}

          <div className="mail-compose__row mail-compose__row--subject">
            <span className="mail-compose__row-label">{copy.composeSubjectLabel}</span>
            <input
              type="text"
              className={
                aiBusy
                  ? 'mail-compose__row-input mail-compose__row-input--subject mail-compose__row-input--ai'
                  : 'mail-compose__row-input mail-compose__row-input--subject'
              }
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              autoComplete="off"
              readOnly={aiBusy}
            />
          </div>
        </div>

        <div className="mail-compose__editor-wrap">
          <div className="mail-compose__toolbar" role="toolbar" aria-label="Biçimlendirme">
            <button
              type="button"
              className={`mail-compose__tool ${activeFormats.bold ? 'mail-compose__tool--active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => exec('bold')}
              aria-pressed={!!activeFormats.bold}
              title={language === 'tr' ? 'Kalın (Ctrl+B)' : 'Bold (Ctrl+B)'}
              aria-label="Bold"
            >
              <LuBold size={16} strokeWidth={2.25} aria-hidden />
            </button>
            <button
              type="button"
              className={`mail-compose__tool ${activeFormats.italic ? 'mail-compose__tool--active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => exec('italic')}
              aria-pressed={!!activeFormats.italic}
              title={language === 'tr' ? 'İtalik (Ctrl+I)' : 'Italic (Ctrl+I)'}
              aria-label="Italic"
            >
              <LuItalic size={16} strokeWidth={2.25} aria-hidden />
            </button>
            <button
              type="button"
              className={`mail-compose__tool ${activeFormats.underline ? 'mail-compose__tool--active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => exec('underline')}
              aria-pressed={!!activeFormats.underline}
              title={language === 'tr' ? 'Altı çizili (Ctrl+U)' : 'Underline (Ctrl+U)'}
              aria-label="Underline"
            >
              <LuUnderline size={16} strokeWidth={2.25} aria-hidden />
            </button>
            <button
              type="button"
              className={`mail-compose__tool ${activeFormats.strikeThrough ? 'mail-compose__tool--active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => exec('strikeThrough')}
              aria-pressed={!!activeFormats.strikeThrough}
              title={language === 'tr' ? 'Üstü çizili' : 'Strikethrough'}
              aria-label="Strikethrough"
            >
              <LuStrikethrough size={16} strokeWidth={2.25} aria-hidden />
            </button>
            <span className="mail-compose__tool-sep" aria-hidden />
            <button
              type="button"
              className={`mail-compose__tool ${activeFormats.insertUnorderedList ? 'mail-compose__tool--active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => exec('insertUnorderedList')}
              aria-pressed={!!activeFormats.insertUnorderedList}
              title={language === 'tr' ? 'Madde işaretleri' : 'Bulleted list'}
              aria-label="Bulleted list"
            >
              <LuList size={16} strokeWidth={2} aria-hidden />
            </button>
            <button
              type="button"
              className={`mail-compose__tool ${activeFormats.insertOrderedList ? 'mail-compose__tool--active' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => exec('insertOrderedList')}
              aria-pressed={!!activeFormats.insertOrderedList}
              title={language === 'tr' ? 'Numaralandırma' : 'Numbered list'}
              aria-label="Numbered list"
            >
              <LuListOrdered size={16} strokeWidth={2} aria-hidden />
            </button>
            <span className="mail-compose__tool-sep" aria-hidden />
            <button
              type="button"
              className="mail-compose__tool"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onInsertLink}
              title={language === 'tr' ? 'Bağlantı ekle' : 'Insert link'}
              aria-label="Insert link"
            >
              <LuLink size={16} strokeWidth={2} aria-hidden />
            </button>
            <button
              type="button"
              className="mail-compose__tool"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => exec('removeFormat')}
              title={language === 'tr' ? 'Biçimi temizle' : 'Clear formatting'}
              aria-label="Clear formatting"
            >
              <LuRemoveFormatting size={16} strokeWidth={2} aria-hidden />
            </button>
            <span className="mail-compose__tool-spacer" />
            <button
              type="button"
              className="mail-compose__tool mail-compose__tool--attach"
              onClick={onPickFiles}
              title={language === 'tr' ? 'Dosya ekle' : 'Attach file'}
              aria-label="Attach"
            >
              <LuPaperclip size={16} strokeWidth={2} aria-hidden />
              <span className="mail-compose__tool-label">
                {language === 'tr' ? 'Ek' : 'Attach'}
              </span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={onFilesSelected}
            />
          </div>

          <div
            ref={editorRef}
            className={
              aiBusy
                ? 'mail-compose__editor mail-compose__editor--ai'
                : 'mail-compose__editor'
            }
            contentEditable={!aiBusy}
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label={copy.composeBodyLabel}
            spellCheck
          />

          {attachments.length > 0 ? (
            <div className="mail-compose__attachments" aria-label="Ekler">
              <div className="mail-compose__attachments-head">
                <LuPaperclip size={14} aria-hidden />
                <span>
                  {attachments.length} {language === 'tr' ? 'ek' : 'attachment(s)'}
                </span>
                <span className="mail-compose__attachments-size">
                  · {formatBytes(totalAttachmentSize)}
                </span>
              </div>
              <ul className="mail-compose__attachments-list">
                {attachments.map((a) => (
                  <li key={a.id} className="mail-compose__attachment">
                    <span className="mail-compose__attachment-name" title={a.filename}>
                      {a.filename}
                    </span>
                    <span className="mail-compose__attachment-size">{formatBytes(a.size)}</span>
                    <button
                      type="button"
                      className="mail-compose__attachment-remove"
                      onClick={() => removeAttachment(a.id)}
                      aria-label={language === 'tr' ? 'Eki kaldır' : 'Remove attachment'}
                      title={language === 'tr' ? 'Eki kaldır' : 'Remove attachment'}
                    >
                      <LuX size={14} aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </form>

      {/* Göz önünde, yüzen AI butonu — sağ alt köşede */}
      <button
        type="button"
        className={
          aiBusy
            ? 'mail-compose__ai-fab mail-compose__ai-fab--busy'
            : 'mail-compose__ai-fab'
        }
        onClick={() => {
          setAiError(null);
          setShowAiModal(true);
        }}
        disabled={sending || aiBusy}
        aria-label={language === 'tr' ? 'AI ile hazırla' : 'Draft with AI'}
        title={language === 'tr' ? 'AI ile hazırla' : 'Draft with AI'}
      >
        <LuSparkles size={20} strokeWidth={2.25} aria-hidden />
        <span className="mail-compose__ai-fab-label">
          {aiBusy
            ? language === 'tr'
              ? 'AI Yükleniyor…'
              : 'AI loading…'
            : language === 'tr'
              ? 'AI ile hazırla'
              : 'Draft with AI'}
        </span>
      </button>
    </main>
  );
}
