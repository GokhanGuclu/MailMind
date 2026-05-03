import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import {
  AiProviderPort,
  AnalyzeEmailResult,
  EmailContent,
} from '../../application/ports/ai-provider.port';
import {
  AnalysisResult,
  TaskResult,
  CalendarEventResult,
  ReminderResult,
  AnalysisUpdateResult,
} from '../../domain/value-objects/analysis-result.vo';
import { AiProviderError, AiResponseParseError } from '../../domain/errors/ai.errors';

const SYSTEM_PROMPT = `Sen MailMind'ın e-posta analiz ajanısın. Verilen e-postayı analiz edip yapılandırılmış aksiyonlar çıkarırsın.

YALNIZCA aşağıdaki formatta geçerli bir JSON nesnesiyle yanıt ver (markdown yok, açıklama yok):
{
  "summary": "E-posta içeriğinin 2-3 cümlelik kısa Türkçe özeti",
  "tasks": [
    {
      "title": "Eylem maddesi başlığı",
      "notes": "İsteğe bağlı ek bağlam veya null",
      "dueAt": "ISO 8601 tarih dizesi veya null",
      "rrule": "RFC 5545 RRULE veya null",
      "priority": "LOW" | "MEDIUM" | "HIGH",
      "confidence": 0.0-1.0 arası ondalık sayı
    }
  ],
  "calendarEvents": [
    {
      "title": "Etkinlik veya toplantı başlığı",
      "startAt": "ISO 8601 tarih dizesi",
      "endAt": "ISO 8601 tarih dizesi veya null",
      "isAllDay": true | false,
      "location": "Konum dizesi veya null",
      "attendees": ["email@example.com"],
      "rrule": "RFC 5545 RRULE veya null",
      "confidence": 0.0-1.0 arası ondalık sayı
    }
  ],
  "reminders": [
    {
      "title": "Anımsatıcı başlığı",
      "notes": "İsteğe bağlı veya null",
      "fireAt": "ISO 8601 tek-seferlik zaman veya null",
      "rrule": "RFC 5545 RRULE veya null",
      "confidence": 0.0-1.0 arası ondalık sayı
    }
  ],
  "updates": [
    {
      "action": "CANCEL" | "RESCHEDULE",
      "match": {
        "title": "Etkilenen önceki etkinliğin başlığı",
        "originalStartAt": "Mailde geçen ESKİ tarih (ISO 8601) veya null"
      },
      "newStartAt": "RESCHEDULE için yeni tarih (ISO 8601), CANCEL'da null",
      "newEndAt": "ISO 8601 veya null",
      "newLocation": "Yeni konum veya null",
      "reason": "Niye değişti — kısa metin veya null",
      "confidence": 0.0-1.0
    }
  ]
}

KURALLAR:
1. Tarihleri DAİMA kullanıcının saat dilimine göre yorumla. Çıktı ISO 8601 olmalı (offset belirt).
2. "yarın", "Pazartesi", "ay sonu" gibi göreceli ifadeleri verilen "Şu anki zaman"a göre çöz.
3. TEKRARLAYAN ifadeler için RFC 5545 RRULE üret. BYDAY DAİMA 2-letter
   token'larıyla yazılır: MO, TU, WE, TH, FR, SA, SU. (FRI/MON/FRIDAY YANLIŞ.)
   - "her gün" / "her sabah" / "her akşam"  → "FREQ=DAILY"
   - "her hafta sonu"                       → "FREQ=WEEKLY;BYDAY=SA,SU"
   - "her Pazartesi"                        → "FREQ=WEEKLY;BYDAY=MO"
   - "her Cuma" / "every Friday"            → "FREQ=WEEKLY;BYDAY=FR"
   - "ayın ilk Cuması"                      → "FREQ=MONTHLY;BYDAY=1FR"
   - "iki haftada bir Cuma" / "every other Friday" → "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR"
   - "yılda bir"                            → "FREQ=YEARLY"
4. Aksiyon türü seçimi (TEK BİR yere yaz, ASLA birden fazla yere değil):
   - Net tarih/saatli olay (toplantı, randevu, uçuş, görüşme) → calendarEvents
   - Tarih/saatli + tekrarlayan toplantı                       → calendarEvents (rrule ile)
   - Yapılması gereken iş, deadline'lı veya değil              → tasks
   - Kişisel hatırlatma — tek seferlik veya tekrarlayan
     (ilaç, su iç, kontrol, doğum günü)                        → reminders
5. ÖNEMLİ: Aynı konuyu iki yere YAZMA.
   - Tekrarlı bir reminder ürettiysen, aynı şeyi tasks'a EKLEME.
   - Tekrarlı bir calendarEvent (rrule'lu) ürettiysen, aynı şeyi reminders'a EKLEME.
   - Bir toplantı + ön hazırlık iki AYRI iş ise: calendarEvent (toplantı) + task (hazırlık) ayrı yazılır.
6. Belirsiz tarihlerde ("yakında", "bir ara") fireAt/dueAt VERME — TASK olarak çıkar veya hiç çıkarma.
   AMA: göreceli ama AÇIK ifadeler ("Cuma", "yarın", "5 Mayıs", "ay sonu",
   "haftaya Pazartesi") tarihtir — bunlar için DAİMA dueAt/fireAt çöz ve doldur.
   Saat varsayımı:
   - tasks.dueAt için saat belirtilmemişse 17:00 kullan (deadline default).
   - calendarEvents için saat belirtilmemişse: isAllDay=true VE startAt'ı
     o günün 00:00'ı olarak yaz. ASLA tahmini saat (09:00 vb.) UYDURMA.
     Saat açıkça yazılmışsa isAllDay=false ve gerçek saat kullanılır.
   - reminders.fireAt için saat belirtilmemişse 09:00 kullan (genel).
7. tasks/calendarEvents/reminders alanlarından her biri için aksiyon yoksa BOŞ DİZİ döndür.
8. Pazarlama / bülten / otomatik bildirim mailleri için tüm dizileri BOŞ döndür.
9. summary: HER ZAMAN Türkçe yaz, e-postanın dilinden bağımsız.
10. SADECE JSON nesnesiyle yanıt ver. Önce veya sonra ekstra metin olmadan.
11. CONFIDENCE — Her aksiyon için 0..1 arası bir güven skoru üret:
    - 0.95-1.00 → mailde birebir yazılı: tarih + saat + kişi/konu açık ("Salı 14:00 Ahmet ile call")
    - 0.75-0.94 → açık ama detay eksik (saatsiz tarih, belirsiz katılımcı)
    - 0.50-0.74 → çıkarım: "haftaya görüşelim" → tahmini tarih, ya da rrule çıkarımı
    - 0.30-0.49 → çok zayıf; mümkünse aksiyonu hiç ÜRETME
    - < 0.30 → ASLA üretme. Belirsiz cümleler için boş dizi döndür.
    Aynı mailde net bir toplantı + flou bir hazırlık varsa toplantı için yüksek,
    hazırlık için düşük confidence yaz. Örneklerdeki değerler rehberdir.
13. UPDATES — Mail mevcut bir etkinliği iptal mi ediyor / yeniden mi
    zamanlıyor? "Yarın 14:00'teki toplantı iptal", "Toplantıyı 15:00'a alalım",
    "Pazartesi yerine Salı'ya kaydı" gibi follow-up cümleler için "updates"
    dizisine giriş ekle. AYNI olayı tekrar calendarEvents'e YAZMA — sadece
    updates'a yaz (RESCHEDULE'da newStartAt taşır).
    - "match.title": önceki etkinliğin başlığı (mailden çıkardığın kadarıyla,
      kısa: "XYZ ile call", "Sprint planlama").
    - "match.originalStartAt": mailde önceki tarih açıkça veya bağlam olarak
      varsa ISO; yoksa null. ("Yarın 14:00'teki toplantı iptal" → şu anki zamana
      göre yarının 14:00'i).
    - CANCEL: newStartAt=null. RESCHEDULE: newStartAt zorunlu.
    - Tamamen YENİ bir toplantı mı yoksa eski bir toplantının revizyonu mu? İpucu:
      "iptal", "kaldırıldı", "ertelendi", "yerine", "saati değişti", "rescheduled",
      "moved to", "cancelled" → updates. "Pazartesi 10:00 yeni toplantı" → events.
14. PERSPEKTİF — "Mail yönü" alanına dikkat et:
    - "incoming"  → Mail kullanıcıya GELDİ. Karşı taraf bir şey istiyor / planlıyor /
                    davet ediyor. Aksiyon kullanıcının yapacağı şey olabilir.
    - "outgoing"  → Mail kullanıcı tarafından GÖNDERİLDİ. Kullanıcı kendisi söz
                    veriyor / plan yapıyor. Çıkardığın aksiyonlar kullanıcının
                    KENDİ taahhütleridir; "yarın size dosyayı göndereceğim" gibi
                    bir cümle, kullanıcı için bir TASK üretir.

ÖRNEKLER (kuralları pekiştirmek için):

Örnek A — "Her sabah 08:00'de ilacı al, 30 gün boyunca":
{
  "summary": "Doktor reçete edilen ilacın her sabah 08:00'de düzenli alınmasını istiyor.",
  "tasks": [],
  "calendarEvents": [],
  "reminders": [
    { "title": "İlaç al", "notes": "Her sabah 08:00, 30 gün", "fireAt": null, "rrule": "FREQ=DAILY;COUNT=30", "confidence": 0.95 }
  ]
}

Örnek B — "Çarşamba 11:00'de XYZ ile görüşme; öncesinde profil dokümanını incele":
{
  "summary": "Çarşamba 11:00'de XYZ Holding ile online görüşme; öncesinde müşteri profili incelenecek.",
  "tasks": [
    { "title": "XYZ müşteri profil dokümanını incele", "notes": "Görüşme öncesi hazırlık", "dueAt": null, "rrule": null, "priority": "MEDIUM", "confidence": 0.7 }
  ],
  "calendarEvents": [
    { "title": "XYZ Holding ile görüşme", "startAt": "<Çarşamba 11:00 ISO>", "endAt": null, "isAllDay": false, "location": null, "attendees": [], "rrule": null, "confidence": 0.95 }
  ],
  "reminders": []
}

Örnek E — saatsiz etkinlik: "15 Mayıs Cuma günü ofiste şirket pikniği":
{
  "summary": "15 Mayıs Cuma günü şirket pikniği planlanmış (saat belirtilmemiş).",
  "tasks": [],
  "calendarEvents": [
    { "title": "Şirket pikniği", "startAt": "2026-05-15T00:00:00+03:00", "endAt": null, "isAllDay": true, "location": "ofis", "attendees": [], "rrule": null, "confidence": 0.85 }
  ],
  "reminders": []
}

Örnek C — "Her Pazartesi 09:00 standup, 30 dakika":
{
  "summary": "Her Pazartesi 09:00'da 30 dakikalık ekip standup'ı yapılacak.",
  "tasks": [],
  "calendarEvents": [
    { "title": "Haftalık standup", "startAt": "<ilk Pazartesi 09:00 ISO>", "endAt": "<+30dk>", "location": null, "attendees": [], "rrule": "FREQ=WEEKLY;BYDAY=MO", "confidence": 0.95 }
  ],
  "reminders": []
}

Örnek D — "Q2 raporunu Cuma mesai bitimine kadar gönder" (göreceli + saatsiz deadline):
{
  "summary": "Q2 raporu Cuma mesai bitimine kadar yöneticiye gönderilecek.",
  "tasks": [
    { "title": "Q2 raporunu yöneticiye gönder", "notes": "Cuma mesai bitimi", "dueAt": "<bir sonraki Cuma 17:00 ISO>", "rrule": null, "priority": "MEDIUM", "confidence": 0.9 }
  ],
  "calendarEvents": [],
  "reminders": [],
  "updates": []
}

Örnek F — iptal: "Yarın 14:00'teki XYZ toplantısı iptal edildi.":
{
  "summary": "Yarın planlanan XYZ toplantısı iptal edildi.",
  "tasks": [],
  "calendarEvents": [],
  "reminders": [],
  "updates": [
    {
      "action": "CANCEL",
      "match": { "title": "XYZ toplantısı", "originalStartAt": "<yarın 14:00 ISO>" },
      "newStartAt": null,
      "newEndAt": null,
      "newLocation": null,
      "reason": "Karşı taraf iptal etti",
      "confidence": 0.9
    }
  ]
}

Örnek G — yeniden zamanlama: "Pazartesi 10:00 sprint planlamayı Salı 11:00'a aldık.":
{
  "summary": "Sprint planlama Pazartesi 10:00'dan Salı 11:00'a alındı.",
  "tasks": [],
  "calendarEvents": [],
  "reminders": [],
  "updates": [
    {
      "action": "RESCHEDULE",
      "match": { "title": "Sprint planlama", "originalStartAt": "<Pazartesi 10:00 ISO>" },
      "newStartAt": "<Salı 11:00 ISO>",
      "newEndAt": null,
      "newLocation": null,
      "reason": "Saat çakışması",
      "confidence": 0.9
    }
  ]
}`;

@Injectable()
export class OllamaProvider implements AiProviderPort {
  private readonly logger = new Logger(OllamaProvider.name);
  private readonly client: OpenAI;
  readonly modelName: string;

  constructor() {
    this.client = new OpenAI({
      baseURL: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
      apiKey: 'ollama',
    });
    // llama3.1:8b doğrulandı: eval seti üzerinde 8/8 (qwen2.5:7b 7/8'di).
    // Override etmek için: OLLAMA_MODEL env değişkeni.
    this.modelName = process.env.OLLAMA_MODEL ?? 'llama3.1:8b';
  }

  async analyzeEmail(content: EmailContent): Promise<AnalyzeEmailResult> {
    const userMessage = this.buildUserMessage(content);
    const startedAt = Date.now();

    let raw: string;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    try {
      const response = await this.client.chat.completions.create({
        model: this.modelName,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      });
      raw = response.choices[0]?.message?.content ?? '';

      // Ollama OpenAI-uyumlu modda usage objesi döner; bazı küçük client
      // versiyonlarında eksik olabiliyor — defensive okuma.
      const usage = response.usage as
        | { prompt_tokens?: number; completion_tokens?: number }
        | undefined;
      inputTokens = usage?.prompt_tokens ?? null;
      outputTokens = usage?.completion_tokens ?? null;
    } catch (err: any) {
      throw new AiProviderError(`Ollama request failed: ${err?.message}`, err);
    }

    const latencyMs = Date.now() - startedAt;
    const result = this.parseResponse(raw);
    return { result, inputTokens, outputTokens, latencyMs };
  }

  // ---------------------------------------------------------------------------

  private buildUserMessage(content: EmailContent): string {
    const lines: string[] = [
      `Kullanıcı saat dilimi: ${content.userTimezone}`,
      `Şu anki zaman (UTC): ${content.nowIso}`,
      `Mail yönü: ${content.direction}` +
        (content.direction === 'outgoing'
          ? '  (kullanıcı tarafından gönderildi — perspektif: kullanıcı söz veriyor)'
          : '  (kullanıcıya geldi — perspektif: karşı taraf istiyor/planlıyor)'),
    ];

    // Classifier ipucu — yalnızca yeterli güvende verilir. Düşük güvenli
    // tahmin LLM'i yanlış yönlendirebilir; eşik altında satır eklenmez.
    if (content.category && (content.categoryConfidence ?? 0) >= 0.6) {
      lines.push(
        `Kategori (sınıflandırıcı): ${content.category}` +
          (content.categoryConfidence != null
            ? ` (güven ${content.categoryConfidence.toFixed(2)})`
            : ''),
      );
      lines.push(
        `Not: Pazarlama / Sosyal Medya / Spam / Abonelik-Fatura kategorilerinde aksiyon ÜRETME — pazarlama, otomatik bildirim ve spam mailleri için tüm dizileri boş döndür (kural 8). Diğer kategorilerde kategori sadece ipucu, içerik kararı senin.`,
      );
    }

    lines.push(
      ``,
      `--- E-posta ---`,
      `Date: ${content.date.toISOString()}`,
      `From: ${content.from}`,
      `Subject: ${content.subject}`,
      ``,
      `Body:`,
      content.bodyText || '(empty)',
    );

    return lines.join('\n');
  }

  private parseResponse(raw: string): AnalysisResult {
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    let parsed: any;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new AiResponseParseError(raw.slice(0, 500));
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        throw new AiResponseParseError(raw.slice(0, 500));
      }
    }

    return {
      summary: String(parsed.summary ?? ''),
      tasks: this.parseTasks(parsed.tasks),
      calendarEvents: this.parseEvents(parsed.calendarEvents),
      reminders: this.parseReminders(parsed.reminders),
      updates: this.parseUpdates(parsed.updates),
    };
  }

  private parseUpdates(raw: unknown): AnalysisUpdateResult[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .map((u: any): AnalysisUpdateResult | null => {
        const action = String(u?.action ?? '').toUpperCase();
        if (action !== 'CANCEL' && action !== 'RESCHEDULE') return null;
        const matchTitle = u?.match?.title ? String(u.match.title).slice(0, 500) : null;
        const matchOriginal = u?.match?.originalStartAt ? this.safeDate(u.match.originalStartAt) : null;
        // Match için en az bir ipucu olmalı; yoksa hiçbir event'e bağlanamaz, drop.
        if (!matchTitle && !matchOriginal) return null;
        // RESCHEDULE için newStartAt zorunlu.
        const newStartAt = u?.newStartAt ? this.safeDate(u.newStartAt) : null;
        if (action === 'RESCHEDULE' && !newStartAt) return null;
        return {
          action: action as 'CANCEL' | 'RESCHEDULE',
          match: { title: matchTitle, originalStartAt: matchOriginal },
          newStartAt,
          newEndAt: u?.newEndAt ? this.safeDate(u.newEndAt) : null,
          newLocation: u?.newLocation ? String(u.newLocation) : null,
          reason: u?.reason ? String(u.reason).slice(0, 500) : null,
          confidence: this.safeConfidence(u?.confidence),
        };
      })
      .filter((u): u is AnalysisUpdateResult => u !== null);
  }

  private parseTasks(raw: unknown): TaskResult[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((t) => t?.title)
      .map((t) => ({
        title: String(t.title).slice(0, 500),
        notes: t.notes ? String(t.notes) : undefined,
        dueAt: t.dueAt ? this.safeDate(t.dueAt) : null,
        rrule: this.safeRruleString(t.rrule),
        priority: this.parsePriority(t.priority),
        confidence: this.safeConfidence(t.confidence),
      }));
  }

  private parseEvents(raw: unknown): CalendarEventResult[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((e) => e?.title && e?.startAt)
      .map((e) => ({
        title: String(e.title).slice(0, 500),
        startAt: this.safeDate(e.startAt) ?? new Date(),
        endAt: e.endAt ? this.safeDate(e.endAt) : null,
        isAllDay: e.isAllDay === true, // sadece açık true; eksik/false → false
        location: e.location ? String(e.location) : null,
        attendees: Array.isArray(e.attendees)
          ? e.attendees.map(String).filter(Boolean)
          : [],
        rrule: this.safeRruleString(e.rrule),
        timezone: e.timezone ? String(e.timezone) : undefined,
        confidence: this.safeConfidence(e.confidence),
      }))
      .filter((e) => e.startAt !== null);
  }

  private parseReminders(raw: unknown): ReminderResult[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r) => r?.title && (r?.fireAt || r?.rrule))
      .map((r) => ({
        title: String(r.title).slice(0, 500),
        notes: r.notes ? String(r.notes) : null,
        fireAt: r.fireAt ? this.safeDate(r.fireAt) : null,
        rrule: this.safeRruleString(r.rrule),
        timezone: r.timezone ? String(r.timezone) : undefined,
        confidence: this.safeConfidence(r.confidence),
      }));
  }

  /**
   * LLM'in döndürdüğü confidence'ı 0..1 aralığına sıkıştır. Sayı olmayan,
   * NaN veya negatif/aşırı değerler undefined döner — UI rozet göstermez.
   */
  private safeConfidence(raw: unknown): number | undefined {
    const n = typeof raw === 'number' ? raw : raw != null ? Number(raw) : NaN;
    if (!Number.isFinite(n)) return undefined;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
  }

  private parsePriority(raw: unknown): 'LOW' | 'MEDIUM' | 'HIGH' {
    if (raw === 'LOW' || raw === 'MEDIUM' || raw === 'HIGH') return raw;
    return 'MEDIUM';
  }

  private safeDate(raw: unknown): Date | null {
    if (!raw) return null;
    const d = new Date(String(raw));
    return isNaN(d.getTime()) ? null : d;
  }

  private safeRruleString(raw: unknown): string | null {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.toLowerCase() === 'null') return null;
    return trimmed;
  }
}
