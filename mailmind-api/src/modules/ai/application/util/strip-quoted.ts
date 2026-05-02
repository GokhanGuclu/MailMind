/**
 * Reply zincirinde quoted/önceki maili ve standart imza bloğunu kırparak
 * AI'a sadece "yeni" yazılmış kısmı vermeyi sağlar.
 *
 * Neden:
 *  - Re: Re: Re: thread'lerde aynı toplantı 3 kez geçince LLM duplicate
 *    calendar event üretiyor.
 *  - Outlook reply header (From/Sent/To/Subject) tekrarı LLM'i karıştırıyor.
 *  - Signature blokları gürültü.
 *
 * Yaklaşım:
 *  - Lines'ı tara; ilk reply-marker'da kes, sonrasını at.
 *  - `>` ile başlayan satırları drop et.
 *  - Sondaki imzayı (`-- ` satırı) kes.
 *  - Sonuç boşsa orijinali döndür (over-strip emniyeti).
 */

/** "On <date>, X wrote:" / "On Mon, Jan 1, 2026 at 10:00, foo@bar.com wrote:" — EN ve TR varyantlar */
const REPLY_MARKER_PATTERNS: RegExp[] = [
  /^On\s.+\swrote:\s*$/i, // EN Gmail
  /^.{0,80}\b(yazdı|wrote)\s*:\s*$/i, // TR / generic — "Ali Veli yazdı:" / "X wrote:"
  /^[-_]{2,}\s*Original Message\s*[-_]{2,}/i, // Outlook
  /^[-_]{2,}\s*Forwarded message\s*[-_]{2,}/i, // Gmail forward
  /^[-_]{2,}\s*Yönlendirilen ileti\s*[-_]{2,}/i, // TR Gmail forward
  /^From:\s.+/i, // Outlook reply blok başlangıcı
  /^Kimden:\s.+/i, // Outlook TR
  /^Gönderen:\s.+/i, // Outlook TR alternative
];

/** İmza ayırıcısı: `-- ` (RFC 3676 §4.3) — kesinlikle iki tire + boşluk */
const SIGNATURE_DELIM = /^-- ?$/;

/** Bir satır "quote" mu? `>` veya `> ` ile başlar (whitespace toleransıyla) */
function isQuoteLine(line: string): boolean {
  return /^\s*>/.test(line);
}

function isReplyMarker(line: string): boolean {
  const trimmed = line.trim();
  return REPLY_MARKER_PATTERNS.some((rx) => rx.test(trimmed));
}

export function stripQuotedText(body: string): string {
  if (!body) return body;

  const lines = body.split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    if (isReplyMarker(line)) break;
    if (isQuoteLine(line)) continue;
    if (SIGNATURE_DELIM.test(line)) break;
    out.push(line);
  }

  // Sondaki boş satırları kırp
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  // Baştaki boş satırları kırp
  while (out.length > 0 && out[0].trim() === '') out.shift();

  const cleaned = out.join('\n');

  // Over-strip emniyeti: sonuç boşaldıysa veya 10 char altına düştüyse,
  // orijinali döndür — AI'ya hiçbir şey vermemekten yanlış bir şey vermek
  // daha kötü.
  if (cleaned.length < 10 && body.trim().length >= 10) {
    return body;
  }

  return cleaned;
}
