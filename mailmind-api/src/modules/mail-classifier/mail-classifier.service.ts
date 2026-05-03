import { Injectable, Logger } from '@nestjs/common';

export type ClassifyResult = {
  category: string;
  confidence: number;
  probabilities: Record<string, number>;
};

/**
 * Python tarafındaki FastAPI sınıflandırıcısına HTTP istemcisi.
 *
 * Tasarım kararları:
 *  - Sınıflandırma "best-effort": classifier servisi düşse bile mail
 *    pipeline'ı (sync, AI analysis) bozulmamalı. Servis hatası → null döner,
 *    `category` DB'de null kalır.
 *  - Kısa timeout (2sn): mail başına bir HTTP turu, sync worker'ı yavaşlatma.
 *  - Body kırpma: 8 KB üstü gövdeler kesilir (TF-IDF doygunluk noktası
 *    çoktan geçilmiş olur, daha fazla token model çıktısını değiştirmez).
 */
@Injectable()
export class MailClassifierService {
  private readonly logger = new Logger(MailClassifierService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly enabled: boolean;
  /** Body için karakter üst sınırı (byte değil). Türkçe çoğunlukla 1-2 byte/char. */
  private static readonly BODY_MAX_CHARS = 8000;

  constructor() {
    this.baseUrl = (process.env.MAIL_CLASSIFIER_URL ?? 'http://localhost:8001').replace(/\/+$/, '');
    this.timeoutMs = Number(process.env.MAIL_CLASSIFIER_TIMEOUT_MS ?? 2_000);
    this.enabled = (process.env.MAIL_CLASSIFIER_ENABLED ?? 'true').toLowerCase() === 'true';
  }

  /**
   * Servis erişilemez veya hata verirse null döner — log seviyesi WARN.
   * Caller tarafında null güvenli.
   */
  async classify(args: {
    subject?: string | null;
    body?: string | null;
  }): Promise<ClassifyResult | null> {
    if (!this.enabled) return null;

    const subject = (args.subject ?? '').trim();
    const body = this.truncate((args.body ?? '').trim());
    if (!subject && !body) return null;

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);

    try {
      const res = await fetch(`${this.baseUrl}/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject, body }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logger.warn(
          `Classifier non-2xx: ${res.status} ${text.slice(0, 200)}`,
        );
        return null;
      }

      const data = (await res.json()) as ClassifyResult;
      if (typeof data?.category !== 'string') return null;
      return {
        category: data.category,
        confidence: Number(data.confidence ?? 0),
        probabilities: data.probabilities ?? {},
      };
    } catch (err: any) {
      // Abort, ECONNREFUSED, network down — pipeline'ı bozmadan geç.
      this.logger.warn(`Classifier call failed: ${err?.message ?? err}`);
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  private truncate(text: string): string {
    if (text.length <= MailClassifierService.BODY_MAX_CHARS) return text;
    return text.slice(0, MailClassifierService.BODY_MAX_CHARS);
  }
}
