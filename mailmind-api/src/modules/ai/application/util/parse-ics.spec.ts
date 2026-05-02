import { parseIcs } from './parse-ics';

const SAMPLE_REQUEST = `BEGIN:VCALENDAR
PRODID:-//Microsoft Corp//Outlook//EN
VERSION:2.0
METHOD:REQUEST
BEGIN:VEVENT
UID:abc-123@outlook.com
SUMMARY:Sprint planning
DTSTART:20260512T110000Z
DTEND:20260512T120000Z
LOCATION:Konferans Odası B
DESCRIPTION:Sprint planlamasi yapilacak.
ATTENDEE;CN=Ali Veli:mailto:ali@firma.com
ATTENDEE:mailto:ayse@firma.com
ORGANIZER:mailto:lead@firma.com
END:VEVENT
END:VCALENDAR`;

const SAMPLE_RECURRING = `BEGIN:VCALENDAR
VERSION:2.0
METHOD:REQUEST
BEGIN:VEVENT
UID:recur-1@google.com
SUMMARY:Weekly standup
DTSTART:20260504T080000Z
DTEND:20260504T083000Z
RRULE:FREQ=WEEKLY;BYDAY=MO
END:VEVENT
END:VCALENDAR`;

const SAMPLE_ALLDAY = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:alld-1
SUMMARY:Sirket pikniği
DTSTART;VALUE=DATE:20260515
DTEND;VALUE=DATE:20260516
LOCATION:Ofis bahçesi
END:VEVENT
END:VCALENDAR`;

const SAMPLE_CANCEL = `BEGIN:VCALENDAR
VERSION:2.0
METHOD:CANCEL
BEGIN:VEVENT
UID:abc-123@outlook.com
SUMMARY:Sprint planning
DTSTART:20260512T110000Z
STATUS:CANCELLED
END:VEVENT
END:VCALENDAR`;

const SAMPLE_LINE_FOLDED = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:f1\r\nSUMMARY:Long mee\r\n ting title\r\nDTSTART:20260512T140000Z\r\nEND:VEVENT\r\nEND:VCALENDAR`;

describe('parseIcs', () => {
  it('parses a basic Outlook REQUEST event', () => {
    const events = parseIcs(SAMPLE_REQUEST);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      uid: 'abc-123@outlook.com',
      summary: 'Sprint planning',
      method: 'REQUEST',
      cancelled: false,
      isAllDay: false,
      location: 'Konferans Odası B',
    });
    expect(events[0].startAt.toISOString()).toBe('2026-05-12T11:00:00.000Z');
    expect(events[0].endAt?.toISOString()).toBe('2026-05-12T12:00:00.000Z');
    expect(events[0].attendees).toEqual(expect.arrayContaining(['ali@firma.com', 'ayse@firma.com']));
  });

  it('parses RRULE for recurring events', () => {
    const events = parseIcs(SAMPLE_RECURRING);
    expect(events[0].rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
  });

  it('marks all-day events from VALUE=DATE', () => {
    const events = parseIcs(SAMPLE_ALLDAY);
    expect(events[0].isAllDay).toBe(true);
    expect(events[0].startAt.toISOString()).toBe('2026-05-15T00:00:00.000Z');
    expect(events[0].location).toBe('Ofis bahçesi');
  });

  it('detects CANCEL method and STATUS:CANCELLED', () => {
    const events = parseIcs(SAMPLE_CANCEL);
    expect(events[0].method).toBe('CANCEL');
    expect(events[0].cancelled).toBe(true);
    expect(events[0].uid).toBe('abc-123@outlook.com');
  });

  it('handles RFC 5545 line folding (CRLF + space continuation)', () => {
    const events = parseIcs(SAMPLE_LINE_FOLDED);
    expect(events[0].summary).toBe('Long meeting title');
  });

  it('returns empty array for non-VCALENDAR input', () => {
    expect(parseIcs('hello world')).toEqual([]);
    expect(parseIcs('')).toEqual([]);
  });

  it('skips VEVENTs without summary or valid DTSTART', () => {
    const broken = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:no-summary
END:VEVENT
END:VCALENDAR`;
    expect(parseIcs(broken)).toEqual([]);
  });

  it('parses multiple VEVENTs in same calendar', () => {
    const multi = `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:a\nSUMMARY:First\nDTSTART:20260512T100000Z\nEND:VEVENT\nBEGIN:VEVENT\nUID:b\nSUMMARY:Second\nDTSTART:20260513T100000Z\nEND:VEVENT\nEND:VCALENDAR`;
    const events = parseIcs(multi);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.summary)).toEqual(['First', 'Second']);
  });
});
