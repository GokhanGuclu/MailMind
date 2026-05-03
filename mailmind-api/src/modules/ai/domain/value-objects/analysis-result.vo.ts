/**
 * Confidence: AI'ın bu aksiyona ne kadar güvendiği (0..1).
 * - 1.0: maile birebir yazılmış (ICS daveti, açık tarih+saat+kişi)
 * - 0.7-0.9: çıkarım açık ama bazı detaylar eksik
 * - 0.4-0.6: yorumla bulunmuş; UI uyarı gösterir
 * - < 0.4: çok belirsiz; LLM aslında üretmemeliydi
 *
 * Eksik / null → undefined (UI rozeti gizler).
 */
export type TaskResult = {
  title: string;
  notes?: string;
  dueAt?: Date | null;
  rrule?: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  confidence?: number;
};

export type CalendarEventResult = {
  title: string;
  startAt: Date;
  endAt?: Date | null;
  /**
   * Mailde saat belirtilmemişse true. UI "Tüm gün" gösterir, startAt
   * o günün 00:00'ı olarak yazılır, kullanıcı edit'te saat girince
   * false'a çevrilir.
   */
  isAllDay?: boolean;
  location?: string | null;
  attendees?: string[];
  rrule?: string | null;
  timezone?: string;
  confidence?: number;
};

export type ReminderResult = {
  title: string;
  notes?: string | null;
  fireAt?: Date | null;
  rrule?: string | null;
  timezone?: string;
  confidence?: number;
};

/**
 * Mevcut bir etkinliği iptal eden veya yeniden zamanlayan follow-up mailler
 * için. LLM önceki event'in başlığını + tarihini "match" alanına koyar;
 * EventMatcherService kullanıcının veritabanındaki gerçek event'i bulur.
 */
export type AnalysisUpdateAction = 'CANCEL' | 'RESCHEDULE';

export type AnalysisUpdateResult = {
  action: AnalysisUpdateAction;
  /** Mevcut event'i bulmak için ipuçları (mailde geçen önceki tarih + başlık). */
  match: {
    title?: string | null;
    /** Mailde "önceki tarih" — eski event'in startAt'i, yoksa null. */
    originalStartAt?: Date | null;
  };
  /** RESCHEDULE için yeni başlangıç (CANCEL'da null). */
  newStartAt?: Date | null;
  newEndAt?: Date | null;
  newLocation?: string | null;
  /** Niye iptal/değişiklik — UI'da bilgi. */
  reason?: string | null;
  confidence?: number;
};

export type AnalysisResult = {
  summary: string;
  tasks: TaskResult[];
  calendarEvents: CalendarEventResult[];
  reminders: ReminderResult[];
  /** Önceki bir event'i etkileyen follow-up aksiyonları (iptal / yeniden planla). */
  updates: AnalysisUpdateResult[];
};
