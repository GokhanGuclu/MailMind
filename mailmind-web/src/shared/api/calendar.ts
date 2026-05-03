import { apiRequest } from './client';

export type ApiCalendarEvent = {
  id: string;
  title: string;
  description: string | null;
  startAt: string;
  endAt: string | null;
  /** Saat belirsiz (mailden çıkmıyor) → UI 'Tüm gün' göstersin. */
  isAllDay?: boolean;
  location: string | null;
  attendees: string | null;
  rrule?: string | null;
  timezone?: string;
  status: string | null;
  aiAnalysisId: string | null;
  /** 'google_calendar' veya null. */
  externalSystem?: string | null;
  /** Push edildiyse Google event id. */
  externalId?: string | null;
  /** Push hatası (örn re-consent gerekli). UI uyarı banner'ı için. */
  syncErrorMessage?: string | null;
  syncAttemptCount?: number;
  /** AI çıkarımı güven skoru (0..1); ICS davetinde 1.0, manuel kayıtta null. */
  confidence?: number | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateCalendarEventPayload = {
  title: string;
  description?: string;
  startAt: string;
  endAt?: string;
  location?: string;
  attendees?: string[];
};

export type UpdateCalendarEventPayload = Partial<CreateCalendarEventPayload>;

export const calendarApi = {
  list(accessToken: string) {
    return apiRequest<ApiCalendarEvent[]>('/calendar/events', {
      method: 'GET',
      token: accessToken,
    });
  },

  create(accessToken: string, payload: CreateCalendarEventPayload) {
    return apiRequest<ApiCalendarEvent>('/calendar/events', {
      method: 'POST',
      token: accessToken,
      body: payload,
    });
  },

  update(accessToken: string, eventId: string, payload: UpdateCalendarEventPayload) {
    return apiRequest<ApiCalendarEvent>(`/calendar/events/${eventId}`, {
      method: 'PATCH',
      token: accessToken,
      body: payload,
    });
  },

  remove(accessToken: string, eventId: string) {
    return apiRequest<{ deleted: boolean }>(`/calendar/events/${eventId}`, {
      method: 'DELETE',
      token: accessToken,
    });
  },
};
