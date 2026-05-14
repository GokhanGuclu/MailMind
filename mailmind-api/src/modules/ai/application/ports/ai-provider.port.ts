import { AnalysisResult } from '../../domain/value-objects/analysis-result.vo';

/**
 * Provider çağrısının sonucu + telemetry. Provider implementasyonları çağrı
 * süresini ölçer ve mümkünse token sayılarını yanıt metadata'sından doldurur
 * (Ollama OpenAI-uyumlu mod chat completion `usage` objesi döner). Token
 * yoksa null kalır — DB nullable.
 */
export type AnalyzeEmailResult = {
  result: AnalysisResult;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
};

export type EmailContent = {
  subject: string;
  from: string;
  date: Date;
  bodyText: string; // truncated

  /** IANA timezone (örn "Europe/Istanbul") — LLM'in göreceli tarihleri çözmesi için */
  userTimezone: string;

  /** "Şu anki zaman" — LLM'in "yarın", "Pazartesi" gibi ifadeleri çözmesi için */
  nowIso: string;

  /**
   * Mailin yönü:
   * - "incoming" → INBOX, kullanıcıya gelen mail (üçüncü kişi söz/plan/davet ediyor).
   * - "outgoing" → SENT,  kullanıcının yazdığı mail (kullanıcı söz/plan veriyor).
   * Prompt'taki perspektif kuralı bu alana göre değişir.
   */
  direction: 'incoming' | 'outgoing';

  /**
   * MailMind classifier (Linear SVM) etiketi — AI prompt'una ipucu olarak
   * verilir. LLM "bu Pazarlama mailinin aksiyonu yok" gibi karar verirken
   * bu sinyali kullanır. Eksikse undefined.
   */
  category?: string;
  /** Classifier'ın kategori için verdiği güven (0..1). */
  categoryConfidence?: number;

  /**
   * Aynı thread/konuşmadan önceki maillerden kısa bağlam. Heuristic ile
   * çıkarılır (aynı gönderici + normalize subject + son 14 gün). LLM bunu
   * RESCHEDULE/CANCEL tespitinde kullanır: "8 Mayıs'taki toplantıyı 9'a
   * aldık" cümlesinde önceki maile referansı görmesi için. En yeniden eskiye
   * sıralı, max 3 öğe, snippet 200 karaktere kırpılır.
   */
  priorMessages?: Array<{
    date: Date;
    subject: string;
    snippet: string;
  }>;
};

export interface AiProviderPort {
  analyzeEmail(content: EmailContent): Promise<AnalyzeEmailResult>;
  readonly modelName: string;
}

export const AI_PROVIDER_TOKEN = 'AI_PROVIDER_TOKEN';
