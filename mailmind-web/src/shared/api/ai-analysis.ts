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

  /**
   * GEÇİCİ DEBUG: Kullanıcının TÜM AI analizlerini sıfırla. PROPOSED öneriler
   * silinir, AiAnalysis kayıtları PENDING'e döner; worker hepsini yeniden
   * işler. Prompt iterasyonunda mevcut DB üzerinde yeni promptu test etmek
   * için. Production'da kaldırılacak.
   */
  reanalyzeAll(accessToken: string) {
    return apiRequest<{ count: number }>(
      `/ai/analyses/reanalyze-all`,
      { method: 'POST', token: accessToken },
    );
  },
};
