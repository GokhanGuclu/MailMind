import { apiRequest } from './client';

export type SuggestionKind = 'CANCEL' | 'RESCHEDULE';
export type SuggestionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type SuggestionDropReason = 'LOW_CONFIDENCE' | 'NO_MATCH';

export type ApiAiSuggestion = {
  id: string;
  kind: SuggestionKind;
  status: SuggestionStatus;
  dropReason: SuggestionDropReason;
  matchedEventId: string | null;
  matchTitle: string | null;
  originalStartAt: string | null;
  newStartAt: string | null;
  newEndAt: string | null;
  newLocation: string | null;
  reason: string | null;
  confidence: number | null;
  createdAt: string;
  aiAnalysisId: string;
  mailboxMessageId: string | null;
  messageSubject: string | null;
  messageFrom: string | null;
  messageDate: string | null;
};

export const suggestionsApi = {
  list(token: string) {
    return apiRequest<ApiAiSuggestion[]>('/ai/suggestions', { method: 'GET', token });
  },
  count(token: string) {
    return apiRequest<{ pending: number }>('/ai/suggestions/count', {
      method: 'GET',
      token,
    });
  },
  approve(token: string, id: string, eventId?: string) {
    return apiRequest<{ id: string; status: 'APPROVED'; eventId: string }>(
      `/ai/suggestions/${id}/approve`,
      { method: 'POST', token, body: eventId ? { eventId } : {} },
    );
  },
  reject(token: string, id: string) {
    return apiRequest<{ id: string; status: 'REJECTED' }>(
      `/ai/suggestions/${id}/reject`,
      { method: 'POST', token },
    );
  },
};
