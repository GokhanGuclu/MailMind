import { apiRequest } from './client';
import type { ApiCalendarEvent } from './calendar';

export type ProposalKind = 'task' | 'calendar-event' | 'reminder';

// AiProposalsService listesinde dönen kaba shape — sayfalama yok, hepsi gelir.

export type ApiTaskProposal = {
  id: string;
  userId: string;
  aiAnalysisId: string | null;
  title: string;
  notes: string | null;
  dueAt: string | null;
  rrule: string | null;
  status: string; // 'PROPOSED' | 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'CANCELLED'
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  /** AI çıkarımı güven skoru (0..1); manuelde null. */
  confidence?: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiReminderProposal = {
  id: string;
  userId: string;
  aiAnalysisId: string | null;
  title: string;
  notes: string | null;
  fireAt: string | null;
  rrule: string | null;
  timezone: string;
  nextFireAt: string | null;
  lastFiredAt: string | null;
  status: string; // 'PROPOSED' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'CANCELLED'
  /** AI çıkarımı güven skoru (0..1); manuelde null. */
  confidence?: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ProposalsList = {
  tasks: ApiTaskProposal[];
  calendarEvents: ApiCalendarEvent[];
  reminders: ApiReminderProposal[];
};

export type ProposalsCount = {
  tasks: number;
  calendarEvents: number;
  reminders: number;
  total: number;
};

/**
 * mailboxMessage id → PROPOSED öneri sayıları haritası.
 * Inbox kart rozeti için kullanılır.
 */
export type ProposalsByMessage = Record<
  string,
  { tasks: number; calendarEvents: number; reminders: number; total: number }
>;

export const proposalsApi = {
  list(accessToken: string) {
    return apiRequest<ProposalsList>('/ai/proposals', {
      method: 'GET',
      token: accessToken,
    });
  },

  count(accessToken: string) {
    return apiRequest<ProposalsCount>('/ai/proposals/count', {
      method: 'GET',
      token: accessToken,
    });
  },

  byMessage(accessToken: string) {
    return apiRequest<ProposalsByMessage>('/ai/proposals/by-message', {
      method: 'GET',
      token: accessToken,
    });
  },

  forMessage(accessToken: string, messageId: string) {
    return apiRequest<ProposalsList>(
      `/ai/proposals/by-message/${encodeURIComponent(messageId)}`,
      { method: 'GET', token: accessToken },
    );
  },

  approve(accessToken: string, kind: ProposalKind, id: string) {
    return apiRequest<ApiTaskProposal | ApiCalendarEvent | ApiReminderProposal>(
      `/ai/proposals/${kind}/${id}/approve`,
      { method: 'POST', token: accessToken },
    );
  },

  reject(accessToken: string, kind: ProposalKind, id: string) {
    return apiRequest<ApiTaskProposal | ApiCalendarEvent | ApiReminderProposal>(
      `/ai/proposals/${kind}/${id}/reject`,
      { method: 'POST', token: accessToken },
    );
  },

  // ─── Düzenleme (kabul etmeden önce PROPOSED öğeyi güncelle) ──────────
  // Kind'a göre var olan PATCH endpoint'leri kullanılır; PROPOSED status
  // korunur (UI sadece içerik alanlarını gönderir).

  updateTask(
    accessToken: string,
    id: string,
    patch: Partial<{
      title: string;
      notes: string | null;
      dueAt: string | null;
      rrule: string | null;
      priority: 'LOW' | 'MEDIUM' | 'HIGH';
    }>,
  ) {
    return apiRequest<ApiTaskProposal>(`/tasks/${id}`, {
      method: 'PATCH',
      token: accessToken,
      body: patch,
    });
  },

  updateCalendarEvent(
    accessToken: string,
    id: string,
    patch: Partial<{
      title: string;
      description: string | null;
      startAt: string;
      endAt: string | null;
      isAllDay: boolean;
      location: string | null;
      attendees: string[];
      rrule: string | null;
      timezone: string;
    }>,
  ) {
    return apiRequest<ApiCalendarEvent>(`/calendar/events/${id}`, {
      method: 'PATCH',
      token: accessToken,
      body: patch,
    });
  },

  updateReminder(
    accessToken: string,
    id: string,
    patch: Partial<{
      title: string;
      notes: string | null;
      fireAt: string | null;
      rrule: string | null;
      timezone: string;
    }>,
  ) {
    return apiRequest<ApiReminderProposal>(`/reminders/${id}`, {
      method: 'PATCH',
      token: accessToken,
      body: patch,
    });
  },
};
