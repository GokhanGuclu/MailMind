import { Injectable, Logger } from '@nestjs/common';
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

/**
 * Verilen anı IANA timezone'a göre yerel ISO 8601 stringine ve offset'ine
 * çevirir. LLM'in TZ matematiği yapmasına bel bağlamamak için: yerel saati
 * ve offset'i hazır veriyoruz, model sadece kopyalıyor.
 *
 * Örn: (2026-05-04T15:30:00Z, "Europe/Istanbul")
 *      → { local: "2026-05-04T18:30:00", offset: "+03:00" }
 */
function formatLocalIso(date: Date, timeZone: string): { local: string; offset: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  // 'en-CA' bazı runtime'larda saati '24' verebilir (gece yarısı); normalize et.
  const hour = get('hour') === '24' ? '00' : get('hour');
  const local = `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}`;

  // Offset: yerel zaman olarak parse edilmiş "as if UTC" değerinden gerçek
  // UTC değerini çıkararak dakika cinsinden farkı hesapla.
  const asUtc = Date.UTC(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(hour),
    Number(get('minute')),
    Number(get('second')),
  );
  const offsetMin = Math.round((asUtc - date.getTime()) / 60_000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return { local, offset: `${sign}${hh}:${mm}` };
}

/**
 * Mail gövdesinde Türkçe (ve İngilizce) gün adlarını tarar; her bulduğu gün
 * için "bir sonraki o gün"ün tarihini ve BYDAY token'ını hesaplar. Küçük
 * modeller (qwen2.5:7b, llama3.1:8b) "Salı" → BYDAY=TU eşleşmesinde sıkça
 * kayıyor; deterministik hint LLM'i kopya yapmaya zorlar.
 *
 * Çıktı (yoksa boş string): satır satır
 *   ⚠ "salı" → BYDAY=TU, bir sonraki Salı = 2026-05-12
 */
function buildDayHints(body: string, now: Date, timeZone: string): string {
  const lower = body.toLocaleLowerCase('tr-TR');
  const dayMap: Array<{ keywords: string[]; dow: number; label: string; byday: string }> = [
    { keywords: ['pazartesi', 'monday'],  dow: 1, label: 'Pazartesi', byday: 'MO' },
    { keywords: ['salı', 'sali', 'tuesday'], dow: 2, label: 'Salı', byday: 'TU' },
    { keywords: ['çarşamba', 'carsamba', 'wednesday'], dow: 3, label: 'Çarşamba', byday: 'WE' },
    { keywords: ['perşembe', 'persembe', 'thursday'], dow: 4, label: 'Perşembe', byday: 'TH' },
    { keywords: ['cuma', 'friday'], dow: 5, label: 'Cuma', byday: 'FR' },
    { keywords: ['cumartesi', 'saturday'], dow: 6, label: 'Cumartesi', byday: 'SA' },
    { keywords: ['pazar', 'sunday'], dow: 0, label: 'Pazar', byday: 'SU' },
  ];

  const found: string[] = [];
  const seen = new Set<number>();
  for (const d of dayMap) {
    if (seen.has(d.dow)) continue;
    const hit = d.keywords.some((kw) => {
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${kw}([^\\p{L}\\p{N}]|$)`, 'iu');
      return re.test(lower);
    });
    if (!hit) continue;
    seen.add(d.dow);

    const baseDow = dayOfWeekInTzLocal(now, timeZone);
    let offset = (d.dow - baseDow + 7) % 7;
    if (offset === 0) offset = 7;
    const target = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(target);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
    const ymd = `${get('year')}-${get('month')}-${get('day')}`;
    found.push(`⚠ "${d.label}" → BYDAY=${d.byday}, bir sonraki ${d.label} = ${ymd}`);
  }
  return found.join('\n');
}

function dayOfWeekInTzLocal(date: Date, timeZone: string): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' })
    .format(date)
    .toUpperCase();
  const map: Record<string, number> = {
    SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6,
  };
  return map[wd] ?? 0;
}

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
0. GÜN ADI İPUÇLARI — Mailin gövdesinde Türkçe bir gün adı geçiyorsa,
   kullanıcı mesajının sonunda "GÜN ADI İPUÇLARI" başlıklı bir bölüm
   görürsün. O bölümde her gün için "bir sonraki o gün"ün tam tarihi
   ve BYDAY token'ı hazır verilir. BYDAY ve startAt için DAİMA bu satırları
   kullan, kafadan eşleştirme yapma. İpuçları yoksa zaten mailde gün adı
   GEÇMİYOR demektir — UYDURMA.

0b. AÇIK TARİHLİ İFADE = MUTLAKA AKSİYON — Mailde "X mayıs", "yarın", "haftaya",
   "Pazartesi", "haftaya Çarşamba", "5 Haziran" gibi NET tarih varsa: aksiyonu
   ASLA atlamayın. Belirsiz değildir.
   - "X günü görüşelim/buluşalım/görüşme talep ediyorum" → calendarEvents
     (saat yoksa isAllDay=true, startAt=o günün 00:00).
   - "X gününe kadar yetiştir" → tasks (dueAt o günün 17:00).
   Mail kısa olsa bile, açık tarih varsa BOŞ DİZİ DÖNDÜRME.

1. SAAT DİLİMİ — Kullanıcı mesajında "Yerel offset" satırı verilir (ör. +03:00).
   Tüm ISO 8601 çıktılarında (startAt, endAt, dueAt, fireAt, originalStartAt,
   newStartAt, newEndAt) DAİMA bu offset'i kullan; offset'i KENDİN HESAPLAMA,
   "Z" (UTC) YAZMA, başka offset KULLANMA.
   Mailde "15:00" yazıyorsa çıktı "<tarih>T15:00:00<Yerel offset>" olur —
   saatleri UTC'ye çevirme, mailde geçen yerel saati birebir yaz.
2. "yarın", "Pazartesi", "ay sonu" gibi göreceli ifadeleri verilen
   "Şu anki yerel zaman"a göre çöz (UTC değil — kullanıcının yerel saati).
3. TEKRARLAYAN ifadeler için RFC 5545 RRULE üret. BYDAY DAİMA 2-letter
   token'larıyla yazılır: MO, TU, WE, TH, FR, SA, SU. (FRI/MON/FRIDAY YANLIŞ.)

   TÜRKÇE → BYDAY EŞLEŞMESİ (KESİN, EZBERLE):
     Pazartesi → MO
     Salı      → TU      ← "her salı" = BYDAY=TU (ASLA MO değil!)
     Çarşamba  → WE
     Perşembe  → TH
     Cuma      → FR
     Cumartesi → SA
     Pazar     → SU

   ÖRNEKLER:
   - "her gün" / "her sabah" / "her akşam"  → "FREQ=DAILY"
   - "her hafta sonu"                       → "FREQ=WEEKLY;BYDAY=SA,SU"
   - "her Pazartesi"                        → "FREQ=WEEKLY;BYDAY=MO"
   - "her Salı"                             → "FREQ=WEEKLY;BYDAY=TU"
   - "her Çarşamba"                         → "FREQ=WEEKLY;BYDAY=WE"
   - "her Perşembe"                         → "FREQ=WEEKLY;BYDAY=TH"
   - "her Cuma" / "every Friday"            → "FREQ=WEEKLY;BYDAY=FR"
   - "her Cumartesi"                        → "FREQ=WEEKLY;BYDAY=SA"
   - "her Pazar"                            → "FREQ=WEEKLY;BYDAY=SU"
   - "ayın ilk Cuması"                      → "FREQ=MONTHLY;BYDAY=1FR"
   - "iki haftada bir Cuma" / "every other Friday" → "FREQ=WEEKLY;INTERVAL=2;BYDAY=FR"
   - "yılda bir"                            → "FREQ=YEARLY"

   ÖNEMLİ — METADATA YASAĞI:
     BYDAY ve saat MUTLAKA mailin GÖVDESİNDEN okunur.
     Mailin "Date:" alanından GÜN ya da SAAT çıkarma — o sadece
     "şu mail ne zaman geldi" bilgisidir, etkinliğin günü/saati DEĞİL.
     Örn: mail Pazartesi geldi ama gövdede "her salı 16:00" yazıyorsa
     → BYDAY=TU, saat=16:00 (Pazartesi DEĞİL, 23:35 gibi mail saati DEĞİL).

   SAAT YAZIM VARYANTLARI (hepsi aynı anlama gelir):
     "16:00" = "16.00" = "16,00" = "saat 16" = "16'da" = "16'te"
     Hepsini ISO çıktıda T16:00:00<offset> olarak yaz.

   WEEKLY/RECURRING için startAt:
     RRULE varsa, startAt = BYDAY günündeki BİR SONRAKİ occurrence
     (gelecekte ilk geçiş). Mailin geldiği gün/saati DEĞİL.
     Örn: Pazartesi mail geldi + "her salı 16:00" → startAt = bir sonraki Salı 16:00.

   ⚠ RRULE NE ZAMAN KULLANILMAZ — KRİTİK YASAKLAR:
     RRULE/rrule alanını SADECE mailde AÇIK tekrarlama ifadesi varsa kullan:
       "her", "haftalık", "aylık", "yıllık", "every", "her gün", "günlük",
       "iki haftada bir", "ayın ilk Cuması", "X gün boyunca her gün".

     AŞAĞIDAKI DURUMLARDA RRULE/rrule = null OLMALI:
     - "3 mayısa yetiştir" / "3 Mayıs'a kadar teslim" → tek seferlik DEADLINE,
       RRULE YOK.
     - "önümüzdeki hafta içinde bir gün" → tek toplantı, BELİRSİZ tarih,
       RRULE YOK; fireAt/startAt da VERME (kural 6).
     - "yarın 14:00 toplantı" → tek seferlik EVENT, RRULE YOK.
     - "bu hafta sonuna kadar" → tek deadline, RRULE YOK.
     - "Cuma günü görüşelim" → tek event, RRULE YOK (sadece o Cuma).
     - "haftaiçi cevap veririm" → bilgilendirme, RRULE YOK.
     - "BYDAY=MO,TU,WE,TH,FR" (haftaiçi her gün) → ÇOK NADİREN doğru.
       Sadece "her hafta içi" gibi ekspilisit ifade varsa kullan.
       "Bir hafta içinde" / "haftaya kadar" → RRULE DEĞİL!

     ŞÜPHE = RRULE YOK. Kararsız kalırsan rrule alanını null yap;
     kullanıcı tek seferlik gördüğünü kendi tekrara çevirebilir, ama
     yanlış tekrar onu rahatsız eder.
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
6. BELİRSİZ ZAMAN İFADELERİ — Aşağıdaki ifadelerden BİRİ varsa: tarih
   ASLA UYDURMA, calendarEvent ÜRETME, fireAt/dueAt VERME. Sadece
   tasks'a dueAt=null ile yaz (veya hiç üretme).

   BELİRSİZ İFADE LİSTESİ (bu kelimeler/öbekler = tarih YOK):
   - "önümüzdeki hafta içinde", "haftaya bir ara", "haftaya"
     (gün belirtmeden, tek başına)
   - "uygun bir gün/zaman/saatte", "müsait olduğunuzda", "müsait bir zamanda"
   - "programınıza uyan", "programınıza göre", "size uygun olduğunda"
   - "yakında", "bir ara", "fırsat bulduğunda", "yakın zamanda"
   - "bu ay içinde", "bu hafta içinde" (gün belirtmeden)
   - "ileride", "ilerleyen günlerde", "ilerleyen zamanda"

   ⚠ ÖZEL DURUM: "önümüzdeki hafta içinde sizin programınıza da uyan bir gün
   ve saatte kısa bir toplantı" → bu cümle BELİRSİZ. calendarEvent ÜRETME,
   tarih SEÇME. Sadece "Toplantı için zaman öner" görevi (dueAt=null) yaz.
   Takvim referansından rastgele Salı/Pazartesi UYDURMA.

   AÇIK ifadelerin listesi (bunlar tarihtir, mutlaka çöz):
   "Cuma", "yarın", "5 Mayıs", "ay sonu", "haftaya Pazartesi", "X mayıs günü",
   "öbür gün", "bu Cumartesi", "gelecek Çarşamba".
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
    - "Önceki thread mailleri" bölümü varsa, mevcut mail oradaki bir etkinliği
      değiştiriyor olabilir. Önceki mailde toplantı/randevu tarihi VARSA ve
      şu anki mail "şunu erteledik / iptal" diyorsa: updates'a yaz, eski tarihi
      "match.originalStartAt"a koy. calendarEvents'e YENİ olarak EKLEME.
    - ⚠ "değişiklik" / "değişikliği" / "yeni program" SUBJECT'te varsa AMA
      mailin gövdesinde belirli bir ESKİ tarih (referans alınan eski etkinlik)
      YOKSA: bu YENİ bir program duyurusu, updates DEĞİL.
      "Bundan sonra her hafta salı 16:00 toplantı" → calendarEvents'e
      RECURRING event olarak yaz (rrule=WEEKLY;BYDAY=TU). updates'a YAZMA.
      updates kullanılması için "X tarihindeki Y toplantısı şuraya alındı"
      gibi NET bir eski referans gerekir.
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

Örnek E2 — KISA MAIL + AÇIK TARİHLİ GÖRÜŞME TALEBİ (ÇOK ÖNEMLİ):
"Geçen hafta planladığımız piknik etkinliğinin düzenlemesi için haftaya 7 mayıs günü görüşme talep ediyorum."
(Mail Cuma 1 Mayıs'ta geldi, şu anki yıl 2026, takvimden 7 Mayıs 2026 = Perşembe.)
{
  "summary": "Karşı taraf piknik düzenlemesi için 7 Mayıs günü görüşme talep ediyor.",
  "tasks": [],
  "calendarEvents": [
    {
      "title": "Piknik düzenleme görüşmesi",
      "startAt": "2026-05-07T00:00:00+03:00",
      "endAt": null,
      "isAllDay": true,
      "location": null,
      "attendees": [],
      "rrule": null,
      "confidence": 0.85
    }
  ],
  "reminders": [],
  "updates": []
}
NOT: "geçen hafta planladığımız" geçmişteki piknikten bahseder, ama "haftaya 7 mayıs günü görüşme talep ediyorum" GELECEK, AÇIK bir görüşme talebidir. ASLA boş dizi döndürme. Saat yok → isAllDay=true.

Örnek E — saatsiz etkinlik: "15 Mayıs Cuma günü ofiste şirket pikniği":
{
  "summary": "15 Mayıs Cuma günü şirket pikniği planlanmış (saat belirtilmemiş).",
  "tasks": [],
  "calendarEvents": [
    { "title": "Şirket pikniği", "startAt": "2026-05-15T00:00:00+03:00", "endAt": null, "isAllDay": true, "location": "ofis", "attendees": [], "rrule": null, "confidence": 0.85 }
  ],
  "reminders": []
}

Örnek I — Tek seferlik DEADLINE, RRULE YOK:
"Size verdiğimiz siparişi 3 mayısa yetiştirmeniz lazım. En geç 15:00'da bekliyoruz."
{
  "summary": "3 Mayıs saat 15:00'a kadar sipariş teslim edilmeli.",
  "tasks": [
    { "title": "Siparişi 3 Mayıs 15:00'a kadar yetiştir",
      "notes": "Acil",
      "dueAt": "2026-05-03T15:00:00+03:00",
      "rrule": null,                              ← TEK seferlik, RRULE YOK
      "priority": "HIGH",
      "confidence": 0.95 }
  ],
  "calendarEvents": [],
  "reminders": [],
  "updates": []
}
NOT: "3 mayısa yetiştir" tek seferlik bir deadline. ASLA rrule koyma.
"BYDAY=TU,WE,TH,FR" gibi haftalık pattern UYDURMA.

Örnek J — Belirsiz TEKLİF, hiç tarih VERME:
"Önümüzdeki hafta içinde uygun bir gün ve saatte kısa bir toplantı yapabilir miyiz?"
{
  "summary": "Önümüzdeki hafta içinde bir toplantı önerildi; tarih saat belirsiz.",
  "tasks": [
    { "title": "Toplantı için bir gün/saat öner",
      "notes": "Önümüzdeki hafta içinde",
      "dueAt": null,                              ← BELİRSİZ, tarih VERME
      "rrule": null,                              ← RRULE YOK
      "priority": "MEDIUM",
      "confidence": 0.6 }
  ],
  "calendarEvents": [],
  "reminders": [],                                ← Reminder DA YAZMA
  "updates": []
}
NOT: "önümüzdeki hafta" belirsizdir, fireAt/dueAt verme. Reminder hiç üretme.
"BYDAY=MO,TU,WE,TH,FR" gibi haftalık pattern KESİNLİKLE YANLIŞ — bu tek bir
toplantı önerisi, haftalık tekrar değil.

Örnek H — "Bundan sonra her hafta salı saat 16.00'da toplantı"
(mail Pazartesi 23:35'te geldi, kullanıcı TZ +03:00, bir sonraki Salı 5 Mayıs 2026):
{
  "summary": "Bundan sonra her hafta salı 16:00'da toplantı yapılacak.",
  "tasks": [],
  "calendarEvents": [
    {
      "title": "Toplantı",
      "startAt": "2026-05-05T16:00:00+03:00",
      "endAt": null,
      "isAllDay": false,
      "location": null,
      "attendees": [],
      "rrule": "FREQ=WEEKLY;BYDAY=TU",
      "confidence": 0.9
    }
  ],
  "reminders": [],
  "updates": []
}
NOT: Mailin geliş günü Pazartesi olsa da BYDAY=TU (Salı). Mailin saati 23:35
olsa da etkinliğin saati 16:00. Body'de yazan kazanır.

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
  private readonly baseUrl: string;
  readonly modelName: string;

  constructor() {
    // Ollama'nın NATIVE API'sini kullanıyoruz (/api/chat). OpenAI uyumlu
    // endpoint (/v1/chat/completions) `options.num_ctx` parametresini
    // YOK SAYIYOR — prompt 4500+ token olunca başından kesiyordu.
    // Native API options'ı tam destekliyor.
    const raw = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1';
    // OLLAMA_BASE_URL eski ayarda /v1 ile bitiyor olabilir; kırp.
    this.baseUrl = raw.replace(/\/v1\/?$/, '').replace(/\/$/, '');
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
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.modelName,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          stream: false,
          format: 'json', // structured output (eski response_format eşdeğeri)
          options: {
            temperature: 0.1,
            // Context window 4096 default; sistem promptumuz + thread context
            // + örnekler ile 5500+ token. Küçük pencere prompt'u keserek
            // örnekleri/kuralları siliyordu. 8192 rahat tampon.
            num_ctx: 8192,
          },
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      raw = json.message?.content ?? '';
      inputTokens = json.prompt_eval_count ?? null;
      outputTokens = json.eval_count ?? null;
    } catch (err: any) {
      throw new AiProviderError(`Ollama request failed: ${err?.message}`, err);
    }

    const latencyMs = Date.now() - startedAt;
    const result = this.parseResponse(raw);
    return { result, inputTokens, outputTokens, latencyMs };
  }

  // ---------------------------------------------------------------------------

  private buildUserMessage(content: EmailContent): string {
    const now = new Date(content.nowIso);
    const { local: nowLocal, offset: tzOffset } = formatLocalIso(now, content.userTimezone);

    const lines: string[] = [
      `Kullanıcı saat dilimi: ${content.userTimezone}`,
      `Yerel offset: ${tzOffset}   ← TÜM ISO çıktılarında bu offset'i kullan`,
      `Şu anki yerel zaman: ${nowLocal}`,
      `Şu anki zaman (UTC referans): ${content.nowIso}`,
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

    // Önceki thread mailleri — RESCHEDULE/CANCEL tespiti için bağlam.
    // En eskiden en yeniye doğru sıralı göstermek okunaklı; UI'da "şöyle
    // konuşmuştuk, şimdi şu mail geldi" hissi.
    if (content.priorMessages && content.priorMessages.length > 0) {
      lines.push(``, `--- Önceki thread mailleri (eskiden yeniye) ---`);
      const ordered = [...content.priorMessages].sort(
        (a, b) => a.date.getTime() - b.date.getTime(),
      );
      for (const p of ordered) {
        lines.push(
          `[${p.date.toISOString()}] ${p.subject}`,
          p.snippet || '(boş)',
          ``,
        );
      }
      lines.push(
        `Bu thread bağlamı yalnızca referans içindir. Aşağıdaki "ŞU ANKİ MAIL" üzerinden aksiyon çıkar; önceki maillerden TASK/EVENT TEKRAR ÜRETME. Ama "şu anki mail" eski bir etkinliği iptal/yeniden zamanlıyorsa, "match.title" ve "match.originalStartAt" alanlarını DOLDURABİLMEK için yukarıdaki bağlamı KULLAN.`,
      );
    }

    const dayHints = buildDayHints(
      `${content.subject ?? ''} ${content.bodyText ?? ''}`,
      now,
      content.userTimezone,
    );

    lines.push(
      ``,
      `--- ŞU ANKİ MAIL ---`,
      `Date: ${content.date.toISOString()}`,
      `From: ${content.from}`,
      `Subject: ${content.subject}`,
      ``,
      `Body:`,
      content.bodyText || '(empty)',
    );

    if (dayHints) {
      lines.push(
        ``,
        `--- GÜN ADI İPUÇLARI (mailin gövdesinde geçen gün adları için ÇÖZÜLMÜŞ tarihler) ---`,
        dayHints,
        `Bu satırlar deterministik olarak hesaplandı. BYDAY token'ı ve startAt için BU SATIRLARI KULLAN, kafadan eşleştirme. "her {gün} 16:00" ifadesinde startAt = bu satırdaki tarih + saat (16:00).`,
      );
    }

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
      .map((e): CalendarEventResult | null => {
        // ÖNEMLİ: LLM bozuk tarih döndürürse "şimdi"yi UYDURMAYIZ. Kayıt
        // tamamen drop edilir — eski davranış mailin gelme zamanını event
        // saati olarak yazıyordu (örn "her salı 16:00" mailini Pazartesi
        // 23:35 olarak kaydediyordu).
        const startAt = this.safeDate(e.startAt);
        if (!startAt) return null;
        return {
          title: String(e.title).slice(0, 500),
          startAt,
          endAt: e.endAt ? this.safeDate(e.endAt) : null,
          isAllDay: e.isAllDay === true, // sadece açık true; eksik/false → false
          location: e.location ? String(e.location) : null,
          attendees: Array.isArray(e.attendees)
            ? e.attendees.map(String).filter(Boolean)
            : [],
          rrule: this.safeRruleString(e.rrule),
          timezone: e.timezone ? String(e.timezone) : undefined,
          confidence: this.safeConfidence(e.confidence),
        };
      })
      .filter((e): e is CalendarEventResult => e !== null);
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
