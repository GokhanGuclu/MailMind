import { apiRequest } from './client';

export const aiAnalysisApi = {
  /**
   * Bir mailın analizini sıfırdan tekrar yapar. PROPOSED öneriler silinir,
   * onaylananlar korunur. Worker yeni PENDING'i kısa sürede işler.
   */
  reanalyze(accessToken: string, messageId: string) {
    return apiRequest<{ analysisId: string }>(
      `/ai/analyses/by-message/${encodeURIComponent(messageId)}/reanalyze`,
      { method: 'POST', token: accessToken },
    );
  },

  /** Bir AI analiz id'si üzerinden source maile re-analyze tetiklenir. */
  reanalyzeByAnalysisId(accessToken: string, analysisId: string) {
    return apiRequest<{ analysisId: string }>(
      `/ai/analyses/${encodeURIComponent(analysisId)}/reanalyze`,
      { method: 'POST', token: accessToken },
    );
  },
};
