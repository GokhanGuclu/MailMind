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
    /** Gönderici (örn. `Apple <News@insideapple.apple.com>`). Post-processing
     *  kuralları için kullanılır — modelin yanlış sınıflandırmalarını
     *  iyi bilinen markaların domain'iyle düzeltmek için. */
    from?: string | null;
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

      // Post-processing: tanınmış gönderici domain'leri Spam'a düşmemeli.
      // Model küçük bir veri seti üstünde fine-tune edildi; "logoyu görünce
      // Spam dedi" türü hataları sender allowlist ile düzeltiyoruz.
      const overridden = this.postProcessByFrom(data.category, args.from);
      return {
        category: overridden,
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

  /**
   * Domain allowlist tabanlı kategori düzeltmesi.
   * - Resmi/marka domain'lerden gelen mail SPAM olamaz → Pazarlama'ya çek
   * - Sosyal ağ domain'lerinden geleni Sosyal Medya'ya çek
   * - Fatura/banka domain'lerinden geleni Abonelik/Fatura'ya çek
   * Kategori bu üç gruptan farklıysa modelin kararına saygı duy (örn. iş maili).
   */
  private postProcessByFrom(category: string, from?: string | null): string {
    if (!from) return category;
    const domain = this.extractDomain(from);
    if (!domain) return category;

    // ─── Sosyal medya ───
    const SOCIAL_DOMAINS = [
      'facebook.com', 'facebookmail.com', 'instagram.com', 'linkedin.com',
      'twitter.com', 'x.com', 'tiktok.com', 'youtube.com', 'pinterest.com',
      'reddit.com', 'discord.com', 'snapchat.com',
    ];
    if (SOCIAL_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) {
      return 'Sosyal Medya';
    }

    // ─── Fatura / Abonelik / Banka / Telekom ───
    const BILLING_HINTS = [
      'fatura', 'invoice', 'billing', 'payment', 'odeme',
    ];
    const BANK_DOMAINS = [
      'paypal.com', 'stripe.com', 'iyzico.com', 'paytr.com',
      'turkcell.com.tr', 'vodafone.com.tr', 'turktelekom.com.tr', 'turknet.com.tr',
      'enerjisa.com.tr', 'iski.istanbul', 'ibb.gov.tr',
      'garanti.com.tr', 'isbank.com.tr', 'akbank.com', 'yapikredi.com.tr',
      'denizbank.com', 'qnbfinansbank.com', 'enpara.com', 'odeabank.com.tr',
      'amazon.com', 'amazon.com.tr', 'aliexpress.com', 'trendyol.com',
      'hepsiburada.com', 'n11.com', 'getir.com',
    ];
    if (
      BANK_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d)) ||
      BILLING_HINTS.some((h) => domain.includes(h))
    ) {
      return 'Abonelik/Fatura';
    }

    // ─── Resmi marka domain'leri — Spam etiketinden kurtar ───
    const BRAND_DOMAINS = [
      'apple.com', 'insideapple.apple.com',
      'google.com', 'gmail.com', 'accounts.google.com', 'youtube.com',
      'microsoft.com', 'outlook.com', 'office.com',
      'github.com', 'githubusercontent.com',
      'spotify.com', 'netflix.com', 'twitch.tv',
      'amazon.com', 'aws.amazon.com',
      'openai.com', 'anthropic.com',
      'medium.com', 'substack.com',
      'jetbrains.com', 'cursor.com', 'vercel.com',
    ];
    const isBrand = BRAND_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d));

    if (category === 'Spam' && isBrand) {
      return 'Pazarlama';
    }

    return category;
  }

  /** "Apple <News@insideapple.apple.com>" → "insideapple.apple.com" */
  private extractDomain(from: string): string | null {
    const m = from.match(/<([^@]+@([^>]+))>/) ?? from.match(/([^\s@]+@(\S+))/);
    if (!m) return null;
    const raw = (m[2] ?? '').trim().toLowerCase();
    return raw || null;
  }
}
