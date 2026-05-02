/**
 * Minimal RFC 5545 (.ics) parser — VEVENT'leri çıkarır.
 *
 * Tam standart parse etmez; calendar invite (Outlook/Google/iCloud) için
 * pratikte yeterli alanları okur. Eksik bir property görürse hata vermez,
 * sadece o alanı boş bırakır.
 *
 * Çıktı `IcsEventOut` AI provider'ın `CalendarEventResult` tipine
 * eşlenmek üzere benzer şekildedir; analyzer service merge'de kullanır.
 */

export type IcsMethod = 'REQUEST' | 'CANCEL' | 'PUBLISH' | 'REPLY' | 'COUNTER' | 'OTHER';

export type IcsEventOut = {
  uid: string | null;
  summary: string;
  startAt: Date;
  endAt: Date | null;
  isAllDay: boolean;
  location: string | null;
  description: string | null;
  attendees: string[];
  rrule: string | null;
  /** METHOD=CANCEL ise iptal davetidir. */
  method: IcsMethod;
  /** STATUS=CANCELLED → event iptal */
  cancelled: boolean;
};

/** RFC 5545 line folding: CRLF + space/tab → satır birleşir. */
function unfoldLines(raw: string): string[] {
  // Önce CRLF ve LF normalize, sonra "\n " ya da "\n\t" → ""
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
  return normalized.split('\n');
}

/** "DTSTART;TZID=Europe/Istanbul:20260512T140000" → { name, params, value } */
function splitProperty(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;
  const head = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);
  const parts = head.split(';');
  const name = parts[0]?.toUpperCase() ?? '';
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq > 0) params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { name, params, value };
}

/**
 * RFC 5545 DATE-TIME formatları:
 *   - "20260512T140000Z"           → UTC
 *   - "20260512T140000"            → floating (TZID parametresi olabilir)
 *   - "20260512"                   → DATE (all-day)
 */
function parseIcsDate(value: string, params: Record<string, string>): { date: Date; isAllDay: boolean } | null {
  if (!value) return null;
  const isDateOnly = params.VALUE === 'DATE' || /^\d{8}$/.test(value);

  if (isDateOnly && /^\d{8}$/.test(value)) {
    const y = +value.slice(0, 4);
    const m = +value.slice(4, 6) - 1;
    const d = +value.slice(6, 8);
    // All-day: gün başı UTC (analyzer all-day flag'iyle anlamlı kılıyor)
    return { date: new Date(Date.UTC(y, m, d, 0, 0, 0)), isAllDay: true };
  }

  // 20260512T140000(Z)
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!m) return null;
  const [, ys, ms, ds, hs, mins, ss, z] = m;
  const y = +ys, mo = +ms - 1, d = +ds, h = +hs, mi = +mins, sec = +ss;

  if (z === 'Z') {
    return { date: new Date(Date.UTC(y, mo, d, h, mi, sec)), isAllDay: false };
  }

  // TZID varsa offset hesabı zor — minimal parser olarak floating'i UTC kabul
  // ediyoruz (RFC kesinlikle yanlış olduğunu söyler ama %95 senaryoda
  // kullanıcının kendi tz'sinde okunduğu için yeterli; iyileştirme G3+ ileri
  // sürüm için).
  return { date: new Date(Date.UTC(y, mo, d, h, mi, sec)), isAllDay: false };
}

/** ATTENDEE:mailto:foo@bar.com → "foo@bar.com" */
function extractEmail(value: string): string | null {
  const m = /mailto:([^>\s,;]+)/i.exec(value);
  if (m) return m[1].trim();
  // Bazen sadece "foo@bar.com" geliyor
  if (/^[^\s@]+@[^\s@]+$/.test(value.trim())) return value.trim();
  return null;
}

/** RFC 5545 backslash-escape unescape: \\, \n, \, → kasıtlı karakterler */
function unescapeText(value: string): string {
  return value
    .replace(/\\\\/g, '\\')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\n/gi, '\n');
}

export function parseIcs(raw: string): IcsEventOut[] {
  if (!raw || !/BEGIN:VCALENDAR/i.test(raw)) return [];

  const lines = unfoldLines(raw);
  let calendarMethod: IcsMethod = 'OTHER';
  const events: IcsEventOut[] = [];
  let inEvent = false;
  let cur: Partial<IcsEventOut> & { _startParams?: Record<string, string> } | null = null;

  for (const line of lines) {
    const prop = splitProperty(line);
    if (!prop) continue;

    if (!inEvent) {
      if (prop.name === 'METHOD') {
        const upper = prop.value.toUpperCase();
        if (upper === 'REQUEST' || upper === 'CANCEL' || upper === 'PUBLISH' || upper === 'REPLY' || upper === 'COUNTER') {
          calendarMethod = upper as IcsMethod;
        }
      }
      if (prop.name === 'BEGIN' && prop.value.toUpperCase() === 'VEVENT') {
        inEvent = true;
        cur = {
          uid: null,
          summary: '',
          startAt: new Date(0),
          endAt: null,
          isAllDay: false,
          location: null,
          description: null,
          attendees: [],
          rrule: null,
          method: calendarMethod,
          cancelled: false,
        };
      }
      continue;
    }

    // inEvent
    if (prop.name === 'END' && prop.value.toUpperCase() === 'VEVENT') {
      if (cur && cur.summary && cur.startAt && cur.startAt.getTime() > 0) {
        events.push(cur as IcsEventOut);
      }
      cur = null;
      inEvent = false;
      continue;
    }
    if (!cur) continue;

    switch (prop.name) {
      case 'UID':
        cur.uid = prop.value;
        break;
      case 'SUMMARY':
        cur.summary = unescapeText(prop.value);
        break;
      case 'DESCRIPTION':
        cur.description = unescapeText(prop.value);
        break;
      case 'LOCATION':
        cur.location = unescapeText(prop.value);
        break;
      case 'DTSTART': {
        const parsed = parseIcsDate(prop.value, prop.params);
        if (parsed) {
          cur.startAt = parsed.date;
          cur.isAllDay = parsed.isAllDay;
        }
        break;
      }
      case 'DTEND': {
        const parsed = parseIcsDate(prop.value, prop.params);
        if (parsed) cur.endAt = parsed.date;
        break;
      }
      case 'RRULE':
        cur.rrule = prop.value.trim();
        break;
      case 'ATTENDEE': {
        const email = extractEmail(prop.value) ?? extractEmail(prop.params.CN ?? '');
        if (email) (cur.attendees ??= []).push(email);
        break;
      }
      case 'STATUS':
        if (prop.value.toUpperCase() === 'CANCELLED') cur.cancelled = true;
        break;
      case 'METHOD':
        // VEVENT içinde de bazen verilir
        {
          const upper = prop.value.toUpperCase();
          if (upper === 'REQUEST' || upper === 'CANCEL' || upper === 'PUBLISH') {
            cur.method = upper as IcsMethod;
          }
        }
        break;
    }
  }

  return events;
}
