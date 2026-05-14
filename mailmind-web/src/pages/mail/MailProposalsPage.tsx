import { useCallback, useEffect, useState } from 'react';
import {
  LuCalendarClock,
  LuCheck,
  LuCircleAlert,
  LuListTodo,
  LuPencil,
  LuRefreshCw,
  LuRepeat,
  LuRotateCcw,
  LuSparkles,
  LuX,
} from 'react-icons/lu';
import { useAuth } from '../../shared/context/auth-context';
import {
  proposalsApi,
  type ApiReminderProposal,
  type ApiTaskProposal,
  type ProposalKind,
  type ProposalsList,
} from '../../shared/api/proposals';
import { aiAnalysisApi } from '../../shared/api/ai-analysis';
import type { ApiCalendarEvent } from '../../shared/api/calendar';
import { suggestionsApi, type ApiAiSuggestion } from '../../shared/api/suggestions';

const EMPTY: ProposalsList = { tasks: [], calendarEvents: [], reminders: [] };

/**
 * AI confidence rozeti. < 0.6 ise sarı uyarı, 0.6-0.84 ise gri info,
 * >= 0.85 ise hiç gösterme (gürültü). Confidence yoksa hiç gösterme.
 */
function ConfidenceBadge({ value }: { value: number | null | undefined }) {
  if (value == null || !Number.isFinite(value)) return null;
  if (value >= 0.85) return null;
  const low = value < 0.6;
  const pct = Math.round(value * 100);
  return (
    <span
      className={`ai-proposals-card__confidence ai-proposals-card__confidence--${low ? 'low' : 'mid'}`}
      title={`AI güven skoru: %${pct}`}
    >
      {low ? '⚠ AI emin değil' : `~%${pct} güven`}
    </span>
  );
}

function formatIso(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('tr-TR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatDateOnly(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('tr-TR', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

/**
 * RRULE'ü Türkçe insan-okunaklı metne çevirir. Tam RFC 5545 değil; UI'da
 * göstermek için yeterli pattern'ları kapsar (DAILY/WEEKLY/MONTHLY/YEARLY +
 * INTERVAL + BYDAY + COUNT + UNTIL). Tanımadığı bir kombinasyonda raw
 * RRULE'a fallback eder ki bilgi kaybolmasın.
 */
function formatRrule(raw: string | null | undefined): string {
  if (!raw) return '';
  const rrule = raw.replace(/^RRULE:/i, '').trim();
  const parts: Record<string, string> = {};
  for (const seg of rrule.split(';')) {
    const [k, v] = seg.split('=');
    if (k && v != null) parts[k.toUpperCase()] = v.toUpperCase();
  }
  const freq = parts.FREQ;
  if (!freq) return rrule;

  const dayNames: Record<string, string> = {
    MO: 'Pazartesi', TU: 'Salı', WE: 'Çarşamba', TH: 'Perşembe',
    FR: 'Cuma', SA: 'Cumartesi', SU: 'Pazar',
  };
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  const byday = parts.BYDAY?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  const untilRaw = parts.UNTIL;

  let main = '';
  switch (freq) {
    case 'DAILY':
      main = interval === 1 ? 'Her gün' : `${interval} günde bir`;
      break;
    case 'WEEKLY':
      if (byday.length > 0) {
        // BYDAY tokens her birinde 1FR, -1MO gibi prefix olabilir.
        const dayLabels = byday.map((b) => {
          const m = /^(-?\d+)?([A-Z]{2})$/.exec(b);
          if (!m) return b;
          const ord = m[1];
          const code = m[2];
          const name = dayNames[code] ?? code;
          if (!ord) return name;
          if (ord === '1') return `ayın ilk ${name}'si`;
          if (ord === '-1') return `ayın son ${name}'si`;
          return `ayın ${ord}. ${name}'si`;
        });
        const list = dayLabels.length === 1
          ? dayLabels[0]
          : dayLabels.slice(0, -1).join(', ') + ' ve ' + dayLabels[dayLabels.length - 1];
        main = interval === 1 ? `Her ${list}` : `${interval} haftada bir ${list}`;
      } else {
        main = interval === 1 ? 'Her hafta' : `${interval} haftada bir`;
      }
      break;
    case 'MONTHLY':
      main = interval === 1 ? 'Her ay' : `${interval} ayda bir`;
      break;
    case 'YEARLY':
      main = interval === 1 ? 'Her yıl' : `${interval} yılda bir`;
      break;
    default:
      return rrule;
  }

  if (count) main += `, ${count} kez`;
  if (untilRaw) {
    // UNTIL formatı: 20260512T160000Z veya 20260512
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(untilRaw);
    if (m) main += `, ${m[3]}.${m[2]}.${m[1]} tarihine kadar`;
  }
  return main;
}

/** ISO → datetime-local input value ("YYYY-MM-DDTHH:mm") — kullanıcının yerel saatinde */
function toDtLocal(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** datetime-local value → ISO ("local time"i UTC offset ile saklamayı new Date'e bırakırız) */
function fromDtLocal(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}

type EditingState =
  | { kind: 'task'; id: string; draft: TaskDraft }
  | { kind: 'calendar-event'; id: string; draft: EventDraft }
  | { kind: 'reminder'; id: string; draft: ReminderDraft }
  | null;

type TaskDraft = {
  title: string;
  notes: string;
  dueAtLocal: string;
  rrule: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
};
type EventDraft = {
  title: string;
  description: string;
  startAtLocal: string;
  endAtLocal: string;
  isAllDay: boolean;
  location: string;
  rrule: string;
};
type ReminderDraft = {
  title: string;
  notes: string;
  fireAtLocal: string;
  rrule: string;
};

export function MailProposalsPage() {
  const { accessToken } = useAuth();
  const [data, setData] = useState<ProposalsList>(EMPTY);
  const [suggestions, setSuggestions] = useState<ApiAiSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingState>(null);
  // AI'ın güveni düşük etkinliklerde "Gün belirsiz" akışında kullanıcının
  // seçtiği tarih (datetime-local string) — eventId → seçilen tarih.
  const [pickedDates, setPickedDates] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const [res, suggList] = await Promise.all([
        proposalsApi.list(accessToken),
        suggestionsApi.list(accessToken),
      ]);
      setData(res);
      setSuggestions(suggList);
    } catch (e: any) {
      setError(e?.message ?? 'Öneriler yüklenemedi');
    } finally {
      setLoading(false);
    }
  }, [accessToken]);

  useEffect(() => {
    load();
    // 30sn polling: AI worker yeni öneri ürettiğinde sayfa yenilemeden görünsün.
    const id = setInterval(() => {
      load();
    }, 30_000);
    // Tab arka plandaysa yeni request gönderme; öne dönünce hemen tazele.
    const onVis = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);

  const total =
    data.tasks.length + data.calendarEvents.length + data.reminders.length + suggestions.length;

  // ─── DEBUG: TÜM analizleri sıfırla ────────────────────────────────────
  const [bulkReanalyzing, setBulkReanalyzing] = useState(false);
  const handleBulkReanalyze = async () => {
    if (!accessToken || bulkReanalyzing) return;
    if (
      !window.confirm(
        'TÜM mailler için AI analizlerini sıfırlayıp baştan çalıştırmak istediğine emin misin?\n\n' +
          'Onaylanmamış (PROPOSED) öneriler silinecek. Onayladığın görev/etkinlikler korunur.\n\n' +
          'Worker birkaç dakika içinde tüm mailleri yeniden analiz edecek.',
      )
    ) {
      return;
    }
    setBulkReanalyzing(true);
    setError(null);
    try {
      const res = await aiAnalysisApi.reanalyzeAll(accessToken);
      // Listeleri hemen boşalt; worker yeni önerileri ürettikçe polling getirir
      setData(EMPTY);
      setSuggestions([]);
      alert(`${res.count} mailin analizi sıfırlandı. Worker birkaç dakika içinde sonuçları üretecek.`);
    } catch (e: any) {
      setError(e?.message ?? 'Bulk re-analyze başarısız');
    } finally {
      setBulkReanalyzing(false);
    }
  };

  // ─── Suggestion handlers ─────────────────────────────────────────────────
  const handleApproveSuggestion = async (id: string) => {
    if (!accessToken || pendingId) return;
    setPendingId(id);
    try {
      await suggestionsApi.approve(accessToken, id);
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
    } catch (e: any) {
      setError(e?.message ?? 'Onaylama başarısız');
    } finally {
      setPendingId(null);
    }
  };

  const handleRejectSuggestion = async (id: string) => {
    if (!accessToken || pendingId) return;
    setPendingId(id);
    try {
      await suggestionsApi.reject(accessToken, id);
      setSuggestions((prev) => prev.filter((s) => s.id !== id));
    } catch (e: any) {
      setError(e?.message ?? 'Reddetme başarısız');
    } finally {
      setPendingId(null);
    }
  };

  // ─── Action handlers ───────────────────────────────────────────────────

  const removeFromList = (kind: ProposalKind, id: string) => {
    setData((prev) => {
      switch (kind) {
        case 'task':
          return { ...prev, tasks: prev.tasks.filter((t) => t.id !== id) };
        case 'calendar-event':
          return { ...prev, calendarEvents: prev.calendarEvents.filter((e) => e.id !== id) };
        case 'reminder':
          return { ...prev, reminders: prev.reminders.filter((r) => r.id !== id) };
      }
    });
  };

  const handleApprove = async (kind: ProposalKind, id: string) => {
    if (!accessToken || pendingId) return;
    setPendingId(id);
    try {
      await proposalsApi.approve(accessToken, kind, id);
      removeFromList(kind, id);
    } catch (e: any) {
      setError(e?.message ?? 'Onaylama başarısız');
    } finally {
      setPendingId(null);
    }
  };

  const handleReject = async (kind: ProposalKind, id: string) => {
    if (!accessToken || pendingId) return;
    setPendingId(id);
    try {
      await proposalsApi.reject(accessToken, kind, id);
      removeFromList(kind, id);
    } catch (e: any) {
      setError(e?.message ?? 'Reddetme başarısız');
    } finally {
      setPendingId(null);
    }
  };

  // ─── Edit handlers ─────────────────────────────────────────────────────

  const startEditTask = (t: ApiTaskProposal) => {
    setEditing({
      kind: 'task',
      id: t.id,
      draft: {
        title: t.title,
        notes: t.notes ?? '',
        dueAtLocal: toDtLocal(t.dueAt),
        rrule: t.rrule ?? '',
        priority: t.priority,
      },
    });
  };

  const startEditEvent = (e: ApiCalendarEvent) => {
    setEditing({
      kind: 'calendar-event',
      id: e.id,
      draft: {
        title: e.title,
        description: e.description ?? '',
        startAtLocal: toDtLocal(e.startAt),
        endAtLocal: toDtLocal(e.endAt ?? null),
        isAllDay: e.isAllDay ?? false,
        location: e.location ?? '',
        rrule: (e as any).rrule ?? '',
      },
    });
  };

  const startEditReminder = (r: ApiReminderProposal) => {
    setEditing({
      kind: 'reminder',
      id: r.id,
      draft: {
        title: r.title,
        notes: r.notes ?? '',
        fireAtLocal: toDtLocal(r.fireAt),
        rrule: r.rrule ?? '',
      },
    });
  };

  const cancelEdit = () => setEditing(null);

  /**
   * "Gün belirsiz" akışı — kullanıcı inline picker'dan tarih seçer, biz
   * önce updateCalendarEvent ile startAt'ı düzeltir, ardından approve ederiz.
   * Tek tıkta "doğru tarih + onay" yapar.
   */
  const handleApproveWithDate = async (
    e: ApiCalendarEvent,
    pickedLocal: string,
  ) => {
    if (!accessToken || pendingId) return;
    const startIso = fromDtLocal(pickedLocal);
    if (!startIso) {
      setError('Lütfen geçerli bir tarih seçin.');
      return;
    }
    setPendingId(e.id);
    setError(null);
    try {
      // Saat girilmediyse datetime-local boş kalır; saat girildiyse isAllDay=false.
      // Kullanıcı sadece tarih yazıp 00:00 gönderdiyse isAllDay=true sayalım.
      const d = new Date(startIso);
      const isAllDay = d.getHours() === 0 && d.getMinutes() === 0;
      await proposalsApi.updateCalendarEvent(accessToken, e.id, {
        title: e.title,
        description: e.description ?? null,
        startAt: startIso,
        endAt: e.endAt ?? null,
        isAllDay,
        location: e.location ?? null,
        rrule: (e as any).rrule ?? null,
      });
      await proposalsApi.approve(accessToken, 'calendar-event', e.id);
      removeFromList('calendar-event', e.id);
      setPickedDates((prev) => {
        const next = { ...prev };
        delete next[e.id];
        return next;
      });
    } catch (err: any) {
      setError(err?.message ?? 'Kaydet ve Onayla başarısız');
    } finally {
      setPendingId(null);
    }
  };

  const handleReanalyze = async (analysisId: string | null) => {
    if (!accessToken || !analysisId) return;
    if (!window.confirm('Bu mailin AI analizini sıfırdan tekrar yapmak ister misin? Onaylanmamış öneriler silinecek; yenisi üretilecek.')) return;
    setError(null);
    try {
      await aiAnalysisApi.reanalyzeByAnalysisId(accessToken, analysisId);
      // Sayfayı yenile — yeni öneriler birkaç saniye içinde gelir, polling de var
      load();
    } catch (e: any) {
      setError(e?.message ?? 'Tekrar analiz başarısız');
    }
  };

  const saveEdit = async () => {
    if (!editing || !accessToken) return;
    setPendingId(editing.id);
    setError(null);
    try {
      if (editing.kind === 'task') {
        const d = editing.draft;
        const updated = await proposalsApi.updateTask(accessToken, editing.id, {
          title: d.title,
          notes: d.notes || null,
          dueAt: d.dueAtLocal ? fromDtLocal(d.dueAtLocal) : null,
          rrule: d.rrule.trim() || null,
          priority: d.priority,
        });
        setData((prev) => ({
          ...prev,
          tasks: prev.tasks.map((t) => (t.id === editing.id ? (updated as ApiTaskProposal) : t)),
        }));
      } else if (editing.kind === 'calendar-event') {
        const d = editing.draft;
        const updated = await proposalsApi.updateCalendarEvent(accessToken, editing.id, {
          title: d.title,
          description: d.description || null,
          startAt: fromDtLocal(d.startAtLocal) ?? new Date().toISOString(),
          endAt: d.endAtLocal ? fromDtLocal(d.endAtLocal) : null,
          isAllDay: d.isAllDay,
          location: d.location || null,
          rrule: d.rrule.trim() || null,
        });
        setData((prev) => ({
          ...prev,
          calendarEvents: prev.calendarEvents.map((e) =>
            e.id === editing.id ? (updated as ApiCalendarEvent) : e,
          ),
        }));
      } else if (editing.kind === 'reminder') {
        const d = editing.draft;
        const updated = await proposalsApi.updateReminder(accessToken, editing.id, {
          title: d.title,
          notes: d.notes || null,
          fireAt: d.fireAtLocal ? fromDtLocal(d.fireAtLocal) : null,
          rrule: d.rrule.trim() || null,
        });
        setData((prev) => ({
          ...prev,
          reminders: prev.reminders.map((r) =>
            r.id === editing.id ? (updated as ApiReminderProposal) : r,
          ),
        }));
      }
      setEditing(null);
    } catch (e: any) {
      setError(e?.message ?? 'Kaydetme başarısız');
    } finally {
      setPendingId(null);
    }
  };

  // ─── Render helpers ────────────────────────────────────────────────────

  const renderActions = (
    kind: ProposalKind,
    id: string,
    onEdit: () => void,
    aiAnalysisId: string | null,
  ) => {
    const isEditing = editing?.id === id;
    if (isEditing) {
      return (
        <div className="ai-proposals-card__actions">
          <button
            type="button"
            className="ai-proposals-card__btn ai-proposals-card__btn--approve"
            onClick={saveEdit}
            disabled={pendingId === id}
            title="Kaydet"
          >
            <LuCheck size={16} aria-hidden />
            Kaydet
          </button>
          <button
            type="button"
            className="ai-proposals-card__btn ai-proposals-card__btn--reject"
            onClick={cancelEdit}
            disabled={pendingId === id}
            title="Vazgeç"
          >
            <LuX size={16} aria-hidden />
            Vazgeç
          </button>
        </div>
      );
    }
    return (
      <div className="ai-proposals-card__actions">
        <button
          type="button"
          className="ai-proposals-card__btn ai-proposals-card__btn--approve"
          onClick={() => handleApprove(kind, id)}
          disabled={pendingId === id || editing !== null}
          title="Onayla"
        >
          <LuCheck size={16} aria-hidden />
          Onayla
        </button>
        <button
          type="button"
          className="ai-proposals-card__btn ai-proposals-card__btn--edit"
          onClick={onEdit}
          disabled={pendingId === id || editing !== null}
          title="Düzenle"
        >
          <LuPencil size={16} aria-hidden />
          Düzenle
        </button>
        <button
          type="button"
          className="ai-proposals-card__btn ai-proposals-card__btn--reject"
          onClick={() => handleReject(kind, id)}
          disabled={pendingId === id || editing !== null}
          title="Reddet"
        >
          <LuX size={16} aria-hidden />
          Reddet
        </button>
        {aiAnalysisId && (
          <button
            type="button"
            className="ai-proposals-card__btn ai-proposals-card__btn--reanalyze"
            onClick={() => handleReanalyze(aiAnalysisId)}
            disabled={pendingId === id || editing !== null}
            title="AI'a tekrar sor (kaynak maili sıfırdan analiz et)"
          >
            <LuRotateCcw size={14} aria-hidden />
          </button>
        )}
      </div>
    );
  };

  const renderTask = (t: ApiTaskProposal) => {
    const isEditing = editing?.kind === 'task' && editing.id === t.id;
    const draft = isEditing ? (editing.draft as TaskDraft) : null;
    const updateDraft = (patch: Partial<TaskDraft>) =>
      setEditing((prev) =>
        prev && prev.kind === 'task' ? { ...prev, draft: { ...(prev.draft as TaskDraft), ...patch } } : prev,
      );
    return (
      <article key={t.id} className={`ai-proposals-card${isEditing ? ' ai-proposals-card--editing' : ''}`}>
        <header className="ai-proposals-card__head">
          <span className="ai-proposals-card__kind ai-proposals-card__kind--task">
            <LuListTodo size={14} /> Görev
          </span>
          <span className={`ai-proposals-card__priority ai-proposals-card__priority--${(draft?.priority ?? t.priority).toLowerCase()}`}>
            {draft?.priority ?? t.priority}
          </span>
          <ConfidenceBadge value={t.confidence} />
        </header>
        {isEditing && draft ? (
          <div className="ai-proposals-card__form">
            <label>Başlık</label>
            <input value={draft.title} onChange={(e) => updateDraft({ title: e.target.value })} maxLength={500} />
            <label>Notlar</label>
            <textarea value={draft.notes} onChange={(e) => updateDraft({ notes: e.target.value })} rows={2} />
            <label>Son tarih</label>
            <input type="datetime-local" value={draft.dueAtLocal} onChange={(e) => updateDraft({ dueAtLocal: e.target.value })} />
            <label>Öncelik</label>
            <select value={draft.priority} onChange={(e) => updateDraft({ priority: e.target.value as TaskDraft['priority'] })}>
              <option value="LOW">LOW</option>
              <option value="MEDIUM">MEDIUM</option>
              <option value="HIGH">HIGH</option>
            </select>
            <label>RRULE (opsiyonel)</label>
            <input value={draft.rrule} placeholder="örn: FREQ=WEEKLY;BYDAY=MO" onChange={(e) => updateDraft({ rrule: e.target.value })} />
          </div>
        ) : (
          <>
            <h3 className="ai-proposals-card__title">{t.title}</h3>
            {t.notes && <p className="ai-proposals-card__notes">{t.notes}</p>}
            <dl className="ai-proposals-card__meta">
              {t.dueAt && (
                <>
                  <dt>Son tarih</dt>
                  <dd>{formatIso(t.dueAt)}</dd>
                </>
              )}
              {t.rrule && (
                <>
                  <dt>Tekrar</dt>
                  <dd className="ai-proposals-card__rrule" title={t.rrule}>
                    <LuRepeat size={12} /> {formatRrule(t.rrule)}
                  </dd>
                </>
              )}
            </dl>
          </>
        )}
        {renderActions('task', t.id, () => startEditTask(t), t.aiAnalysisId ?? null)}
      </article>
    );
  };

  const renderCalendarEvent = (e: ApiCalendarEvent) => {
    const isEditing = editing?.kind === 'calendar-event' && editing.id === e.id;
    const draft = isEditing ? (editing.draft as EventDraft) : null;
    // AI güveni düşük → tarihi gizle, kullanıcıdan seçim al. 0.7 eşiği:
    // 0.95+ kesin (rozet zaten gizli), 0.7-0.85 normal göster, < 0.7 belirsiz.
    const dateUncertain = !isEditing && (e.confidence ?? 1) < 0.7;
    const pickedLocal = pickedDates[e.id] ?? '';
    const updateDraft = (patch: Partial<EventDraft>) =>
      setEditing((prev) =>
        prev && prev.kind === 'calendar-event'
          ? { ...prev, draft: { ...(prev.draft as EventDraft), ...patch } }
          : prev,
      );
    return (
      <article key={e.id} className={`ai-proposals-card${isEditing ? ' ai-proposals-card--editing' : ''}`}>
        <header className="ai-proposals-card__head">
          <span className="ai-proposals-card__kind ai-proposals-card__kind--event">
            <LuCalendarClock size={14} /> Etkinlik
          </span>
          <ConfidenceBadge value={e.confidence} />
        </header>
        {isEditing && draft ? (
          <div className="ai-proposals-card__form">
            <label>Başlık</label>
            <input value={draft.title} onChange={(ev) => updateDraft({ title: ev.target.value })} maxLength={500} />
            <label>Açıklama</label>
            <textarea value={draft.description} onChange={(ev) => updateDraft({ description: ev.target.value })} rows={2} />
            <label>Başlangıç</label>
            <input type="datetime-local" value={draft.startAtLocal} onChange={(ev) => updateDraft({ startAtLocal: ev.target.value })} />
            <label>Bitiş</label>
            <input type="datetime-local" value={draft.endAtLocal} onChange={(ev) => updateDraft({ endAtLocal: ev.target.value })} />
            <label className="ai-proposals-card__form-checkbox">
              <input
                type="checkbox"
                checked={draft.isAllDay}
                onChange={(ev) => updateDraft({ isAllDay: ev.target.checked })}
              />
              Tüm gün (saat belirsiz)
            </label>
            <label>Yer</label>
            <input value={draft.location} onChange={(ev) => updateDraft({ location: ev.target.value })} />
            <label>RRULE (opsiyonel)</label>
            <input value={draft.rrule} placeholder="örn: FREQ=WEEKLY;BYDAY=MO" onChange={(ev) => updateDraft({ rrule: ev.target.value })} />
          </div>
        ) : (
          <>
            <h3 className="ai-proposals-card__title">{e.title}</h3>
            {e.description && <p className="ai-proposals-card__notes">{e.description}</p>}
            {e.syncErrorMessage && e.syncErrorMessage.toLowerCase().includes('re-consent') && (
              <div className="ai-proposals-card__warn">
                ⚠ Google Takvim'e push için yeniden bağlantı gerekli.
                <a href="/connect-email"> Yeniden bağlan</a>
              </div>
            )}
            <dl className="ai-proposals-card__meta">
              <dt>Tarih</dt>
              <dd>
                {dateUncertain ? (
                  <span className="ai-proposals-card__time-hint">
                    Gün belirsiz · onaylarken seçin
                  </span>
                ) : e.isAllDay ? (
                  <>
                    {formatDateOnly(e.startAt)}{' '}
                    <span className="ai-proposals-card__time-hint">
                      · Tüm gün (saat belirsiz)
                    </span>
                  </>
                ) : (
                  formatIso(e.startAt)
                )}
              </dd>
              {e.endAt && !e.isAllDay && (
                <>
                  <dt>Bitiş</dt>
                  <dd>{formatIso(e.endAt)}</dd>
                </>
              )}
              {e.location && (
                <>
                  <dt>Yer</dt>
                  <dd>{e.location}</dd>
                </>
              )}
              {(e as any).rrule && (
                <>
                  <dt>Tekrar</dt>
                  <dd className="ai-proposals-card__rrule" title={(e as any).rrule}>
                    <LuRepeat size={12} /> {formatRrule((e as any).rrule)}
                  </dd>
                </>
              )}
            </dl>
          </>
        )}
        {dateUncertain ? (
          <div className="ai-proposals-card__date-pick">
            <label htmlFor={`pick-${e.id}`}>Tarih seç</label>
            <input
              id={`pick-${e.id}`}
              type="datetime-local"
              value={pickedLocal}
              onChange={(ev) =>
                setPickedDates((prev) => ({ ...prev, [e.id]: ev.target.value }))
              }
            />
            <div className="ai-proposals-card__actions">
              <button
                type="button"
                className="ai-proposals-card__btn ai-proposals-card__btn--approve"
                onClick={() => handleApproveWithDate(e, pickedLocal)}
                disabled={pendingId === e.id || !pickedLocal}
                title="Seçtiğin tarihle kaydedip onayla"
              >
                <LuCheck size={16} aria-hidden /> Kaydet ve Onayla
              </button>
              <button
                type="button"
                className="ai-proposals-card__btn ai-proposals-card__btn--reject"
                onClick={() => handleReject('calendar-event', e.id)}
                disabled={pendingId === e.id}
                title="Reddet"
              >
                <LuX size={16} aria-hidden /> Reddet
              </button>
              {e.aiAnalysisId && (
                <button
                  type="button"
                  className="ai-proposals-card__btn ai-proposals-card__btn--reanalyze"
                  onClick={() => handleReanalyze(e.aiAnalysisId ?? null)}
                  disabled={pendingId === e.id}
                  title="AI'a tekrar sor"
                >
                  <LuRotateCcw size={14} aria-hidden />
                </button>
              )}
            </div>
          </div>
        ) : (
          renderActions('calendar-event', e.id, () => startEditEvent(e), e.aiAnalysisId ?? null)
        )}
      </article>
    );
  };

  const renderReminder = (r: ApiReminderProposal) => {
    const isEditing = editing?.kind === 'reminder' && editing.id === r.id;
    const draft = isEditing ? (editing.draft as ReminderDraft) : null;
    const updateDraft = (patch: Partial<ReminderDraft>) =>
      setEditing((prev) =>
        prev && prev.kind === 'reminder'
          ? { ...prev, draft: { ...(prev.draft as ReminderDraft), ...patch } }
          : prev,
      );
    return (
      <article key={r.id} className={`ai-proposals-card${isEditing ? ' ai-proposals-card--editing' : ''}`}>
        <header className="ai-proposals-card__head">
          <span className="ai-proposals-card__kind ai-proposals-card__kind--reminder">
            <LuRepeat size={14} /> Anımsatıcı
          </span>
          <ConfidenceBadge value={r.confidence} />
        </header>
        {isEditing && draft ? (
          <div className="ai-proposals-card__form">
            <label>Başlık</label>
            <input value={draft.title} onChange={(e) => updateDraft({ title: e.target.value })} maxLength={500} />
            <label>Notlar</label>
            <textarea value={draft.notes} onChange={(e) => updateDraft({ notes: e.target.value })} rows={2} />
            <label>Tek seferlik tetiklenme</label>
            <input type="datetime-local" value={draft.fireAtLocal} onChange={(e) => updateDraft({ fireAtLocal: e.target.value })} />
            <label>RRULE (tekrar — opsiyonel)</label>
            <input value={draft.rrule} placeholder="örn: FREQ=DAILY" onChange={(e) => updateDraft({ rrule: e.target.value })} />
          </div>
        ) : (
          <>
            <h3 className="ai-proposals-card__title">{r.title}</h3>
            {r.notes && <p className="ai-proposals-card__notes">{r.notes}</p>}
            <dl className="ai-proposals-card__meta">
              {r.fireAt && (
                <>
                  <dt>Tetiklenme</dt>
                  <dd>{formatIso(r.fireAt)}</dd>
                </>
              )}
              {r.rrule && (
                <>
                  <dt>Tekrar</dt>
                  <dd className="ai-proposals-card__rrule" title={r.rrule}>
                    <LuRepeat size={12} /> {formatRrule(r.rrule)}
                  </dd>
                </>
              )}
              {r.nextFireAt && (
                <>
                  <dt>Sıradaki</dt>
                  <dd>{formatIso(r.nextFireAt)}</dd>
                </>
              )}
            </dl>
          </>
        )}
        {renderActions('reminder', r.id, () => startEditReminder(r), r.aiAnalysisId ?? null)}
      </article>
    );
  };

  // ─── Render ────────────────────────────────────────────────────────────

  return (
    <div className="ai-proposals-page">
      <div className="ai-proposals-page__head">
        <div className="ai-proposals-page__head-info">
          <h2 className="ai-proposals-page__heading">
            <LuSparkles size={22} aria-hidden /> AI Önerileri
          </h2>
          <p className="ai-proposals-page__lead">
            Mailleriniz analiz edildi. Aşağıdaki öğeleri onaylayarak takviminize, görevlerinize ya da
            anımsatıcılarınıza ekleyin; reddederseniz iptal edilirler.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="ai-proposals-page__refresh"
            onClick={load}
            disabled={loading || bulkReanalyzing}
            title="Yenile"
          >
            <LuRefreshCw size={16} className={loading ? 'is-spinning' : ''} aria-hidden /> Yenile
          </button>
          <button
            type="button"
            className="ai-proposals-page__refresh"
            onClick={handleBulkReanalyze}
            disabled={bulkReanalyzing || loading}
            title="DEBUG: Tüm mailleri AI'la baştan analiz et (PROPOSED öneriler silinir)"
            style={{
              borderColor: '#dc2626',
              color: '#dc2626',
            }}
          >
            <LuRotateCcw
              size={16}
              className={bulkReanalyzing ? 'is-spinning' : ''}
              aria-hidden
            />
            {bulkReanalyzing ? 'Sıfırlanıyor…' : '🔄 Hepsini Yeniden Analiz'}
          </button>
        </div>
      </div>

      {error && (
        <div className="ai-proposals-page__error">
          <LuCircleAlert size={16} /> {error}
        </div>
      )}

      {!loading && total === 0 && !error && (
        <div className="ai-proposals-page__empty">
          <LuSparkles size={32} aria-hidden />
          <p>Şu anda bekleyen öneri yok.</p>
          <span>Yeni mailler analiz edildiğinde burada görünecek.</span>
        </div>
      )}

      {suggestions.length > 0 && (
        <section className="ai-proposals-page__section">
          <h3 className="ai-proposals-page__section-title">
            <LuCircleAlert size={16} /> AI Belirsiz — Sen Karar Ver
            <span className="ai-proposals-page__count">{suggestions.length}</span>
          </h3>
          <p className="ai-proposals-page__lead" style={{ marginTop: 0 }}>
            AI, bu maillerin mevcut bir etkinliği iptal/erteleme amacıyla
            yazıldığını sezdi ama emin değil. Onaylarsan ilgili etkinlik
            güncellenir; reddedersen bu öneri kaybolur.
          </p>
          <div className="ai-proposals-page__grid">
            {suggestions.map((s) => (
              <article key={s.id} className="ai-proposals-card">
                <header className="ai-proposals-card__head">
                  <span className={`ai-proposals-card__kind ai-proposals-card__kind--${s.kind === 'CANCEL' ? 'reminder' : 'event'}`}>
                    {s.kind === 'CANCEL' ? (
                      <><LuX size={14} /> İptal önerisi</>
                    ) : (
                      <><LuCalendarClock size={14} /> Erteleme önerisi</>
                    )}
                  </span>
                  <ConfidenceBadge value={s.confidence} />
                </header>
                <h3 className="ai-proposals-card__title">
                  {s.matchTitle ?? '(başlık tespit edilemedi)'}
                </h3>
                {s.reason && <p className="ai-proposals-card__notes">{s.reason}</p>}
                <dl className="ai-proposals-card__meta">
                  {s.originalStartAt && (
                    <>
                      <dt>Eski tarih</dt>
                      <dd>{formatIso(s.originalStartAt)}</dd>
                    </>
                  )}
                  {s.kind === 'RESCHEDULE' && s.newStartAt && (
                    <>
                      <dt>Yeni tarih</dt>
                      <dd>{formatIso(s.newStartAt)}</dd>
                    </>
                  )}
                  {s.newLocation && (
                    <>
                      <dt>Yeni konum</dt>
                      <dd>{s.newLocation}</dd>
                    </>
                  )}
                  {s.messageSubject && (
                    <>
                      <dt>Kaynak mail</dt>
                      <dd>{s.messageSubject}</dd>
                    </>
                  )}
                  <dt>Sebep</dt>
                  <dd>
                    {s.dropReason === 'LOW_CONFIDENCE'
                      ? 'AI emin değildi'
                      : 'Eşleşen etkinlik bulunamadı'}
                  </dd>
                </dl>
                <div className="ai-proposals-card__actions">
                  <button
                    type="button"
                    className="ai-proposals-card__btn ai-proposals-card__btn--approve"
                    onClick={() => handleApproveSuggestion(s.id)}
                    disabled={pendingId === s.id}
                    title={
                      s.dropReason === 'NO_MATCH' && !s.matchedEventId
                        ? 'Eşleşme bulunamadığı için bu işlem başarısız olabilir; etkinliği elle güncellemen gerekebilir.'
                        : 'Bu güncellemeyi takvime uygula'
                    }
                  >
                    <LuCheck size={14} /> Onayla
                  </button>
                  <button
                    type="button"
                    className="ai-proposals-card__btn ai-proposals-card__btn--reject"
                    onClick={() => handleRejectSuggestion(s.id)}
                    disabled={pendingId === s.id}
                  >
                    <LuX size={14} /> Reddet
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {data.calendarEvents.length > 0 && (
        <section className="ai-proposals-page__section">
          <h3 className="ai-proposals-page__section-title">
            <LuCalendarClock size={16} /> Takvim Etkinlikleri
            <span className="ai-proposals-page__count">{data.calendarEvents.length}</span>
          </h3>
          <div className="ai-proposals-page__grid">
            {data.calendarEvents.map(renderCalendarEvent)}
          </div>
        </section>
      )}

      {data.reminders.length > 0 && (
        <section className="ai-proposals-page__section">
          <h3 className="ai-proposals-page__section-title">
            <LuRepeat size={16} /> Anımsatıcılar
            <span className="ai-proposals-page__count">{data.reminders.length}</span>
          </h3>
          <div className="ai-proposals-page__grid">
            {data.reminders.map(renderReminder)}
          </div>
        </section>
      )}

      {data.tasks.length > 0 && (
        <section className="ai-proposals-page__section">
          <h3 className="ai-proposals-page__section-title">
            <LuListTodo size={16} /> Görevler
            <span className="ai-proposals-page__count">{data.tasks.length}</span>
          </h3>
          <div className="ai-proposals-page__grid">
            {data.tasks.map(renderTask)}
          </div>
        </section>
      )}
    </div>
  );
}
