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

export type AnalysisResult = {
  summary: string;
  tasks: TaskResult[];
  calendarEvents: CalendarEventResult[];
  reminders: ReminderResult[];
};
