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

const EMPTY: ProposalsList = { tasks: [], calendarEvents: [], reminders: [] };

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [editing, setEditing] = useState<EditingState>(null);

  const load = useCallback(async () => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const res = await proposalsApi.list(accessToken);
      setData(res);
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

  const total = data.tasks.length + data.calendarEvents.length + data.reminders.length;

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
                  <dd className="ai-proposals-card__rrule">
                    <LuRepeat size={12} /> {t.rrule}
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
                {e.isAllDay ? (
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
                  <dd className="ai-proposals-card__rrule">
                    <LuRepeat size={12} /> {(e as any).rrule}
                  </dd>
                </>
              )}
            </dl>
          </>
        )}
        {renderActions('calendar-event', e.id, () => startEditEvent(e), e.aiAnalysisId ?? null)}
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
                  <dd className="ai-proposals-card__rrule">
                    <LuRepeat size={12} /> {r.rrule}
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
        <button
          type="button"
          className="ai-proposals-page__refresh"
          onClick={load}
          disabled={loading}
          title="Yenile"
        >
          <LuRefreshCw size={16} className={loading ? 'is-spinning' : ''} aria-hidden /> Yenile
        </button>
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
