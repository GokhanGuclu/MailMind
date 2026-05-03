import type { AnalysisResult } from '../../src/modules/ai/domain/value-objects/analysis-result.vo';

export type CountRange = { min: number; max: number };

export type FixtureExpected = {
  tasks: CountRange;
  calendarEvents: CountRange;
  reminders: CountRange;
  /** updates: opsiyonel; G2 (cancel/reschedule) için. */
  updates?: CountRange;
  task?: ItemAssertion;
  calendarEvent?: ItemAssertion;
  reminder?: ItemAssertion;
  update?: UpdateAssertion;
};

export type UpdateAssertion = {
  action?: 'CANCEL' | 'RESCHEDULE';
  matchTitleContains?: string[];
  newStartAtNotNull?: boolean;
};

export type ItemAssertion = {
  titleContains?: string[];      // herhangi biri eşleşmeli (case-insensitive substring)
  rruleContains?: string[];      // tümü RRULE içinde olmalı
  rruleByday?: string;           // "MO", "FR" vb. — BYDAY alanında olmalı
  rruleNull?: boolean;           // true ise rrule null/empty olmalı
  locationContains?: string[];   // herhangi biri eşleşmeli
  dueAtNotNull?: boolean;        // task için
};

export type Fixture = {
  name: string;
  input: {
    subject: string;
    from: string;
    date: string;
    bodyText: string;
    userTimezone: string;
    nowIso: string;
    /** Default: incoming. SENT klasöründen gelen / kullanıcının yazdığı maillerde "outgoing". */
    direction?: 'incoming' | 'outgoing';
    /** RFC 5545 (.ics) içeriği — varsa AI'ın calendarEvents'i yerine ICS parser kullanılır. */
    icsRaw?: string;
  };
  expected: FixtureExpected;
};

export type FixtureResult = {
  name: string;
  passed: boolean;
  failures: string[];
  latencyMs: number;
  parseOk: boolean;
  raw?: AnalysisResult;
};

// ─── Assertion helpers ──────────────────────────────────────────────────────

function checkRange(label: string, actual: number, range: CountRange, failures: string[]) {
  if (actual < range.min || actual > range.max) {
    failures.push(`${label}: count=${actual}, expected ${range.min}..${range.max}`);
  }
}

/**
 * Türkçe I/İ duyarlı, aksanları düzleyen küçük harf normalizasyonu.
 * Default JS `İ.toLowerCase()` = "i̇" (i + combining dot above) — match'i bozar.
 */
function normalize(s: string): string {
  return (s ?? '')
    .replace(/İ/g, 'i')
    .replace(/I/g, 'i')
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function checkContainsAny(label: string, value: string, needles: string[], failures: string[]) {
  if (!needles?.length) return;
  const lower = normalize(value);
  const ok = needles.some((n) => lower.includes(normalize(n)));
  if (!ok) {
    failures.push(`${label}: "${value}" should contain one of [${needles.join(', ')}]`);
  }
}

function checkContainsAll(label: string, value: string | null, needles: string[], failures: string[]) {
  if (!needles?.length) return;
  const v = (value ?? '').toUpperCase();
  for (const n of needles) {
    if (!v.includes(n.toUpperCase())) {
      failures.push(`${label}: "${value}" missing token "${n}"`);
    }
  }
}

function checkRruleByday(label: string, rrule: string | null | undefined, byday: string, failures: string[]) {
  if (!rrule) {
    failures.push(`${label}: rrule null but expected BYDAY=${byday}`);
    return;
  }
  const m = /BYDAY=([^;]+)/i.exec(rrule);
  if (!m) {
    failures.push(`${label}: rrule has no BYDAY but expected ${byday}`);
    return;
  }
  if (!m[1].toUpperCase().split(',').includes(byday.toUpperCase())) {
    failures.push(`${label}: BYDAY="${m[1]}" should include ${byday}`);
  }
}

function checkItem(
  label: string,
  item: any,
  assertion: ItemAssertion,
  fields: { title?: string; rrule?: string; location?: string; dueAt?: string },
  failures: string[],
) {
  if (assertion.titleContains && fields.title) {
    checkContainsAny(`${label}.${fields.title}`, item?.[fields.title] ?? '', assertion.titleContains, failures);
  }
  if (assertion.rruleNull) {
    if (item?.rrule) {
      failures.push(`${label}.rrule: expected null/empty, got "${item.rrule}"`);
    }
  }
  if (assertion.rruleContains?.length) {
    checkContainsAll(`${label}.rrule`, item?.rrule ?? null, assertion.rruleContains, failures);
  }
  if (assertion.rruleByday) {
    checkRruleByday(`${label}.rrule`, item?.rrule, assertion.rruleByday, failures);
  }
  if (assertion.locationContains && fields.location) {
    checkContainsAny(`${label}.${fields.location}`, item?.[fields.location] ?? '', assertion.locationContains, failures);
  }
  if (assertion.dueAtNotNull && fields.dueAt) {
    if (!item?.[fields.dueAt]) {
      failures.push(`${label}.${fields.dueAt}: expected non-null`);
    }
  }
}

// ─── Main evaluation ────────────────────────────────────────────────────────

export function evaluate(fixture: Fixture, result: AnalysisResult): string[] {
  const failures: string[] = [];
  const exp = fixture.expected;

  checkRange('tasks', result.tasks.length, exp.tasks, failures);
  checkRange('calendarEvents', result.calendarEvents.length, exp.calendarEvents, failures);
  checkRange('reminders', result.reminders.length, exp.reminders, failures);

  if (exp.task && result.tasks[0]) {
    checkItem('task', result.tasks[0], exp.task, { title: 'title', rrule: 'rrule', dueAt: 'dueAt' }, failures);
  }
  if (exp.calendarEvent && result.calendarEvents[0]) {
    checkItem(
      'calendarEvent',
      result.calendarEvents[0],
      exp.calendarEvent,
      { title: 'title', rrule: 'rrule', location: 'location' },
      failures,
    );
  }
  if (exp.reminder && result.reminders[0]) {
    checkItem('reminder', result.reminders[0], exp.reminder, { title: 'title', rrule: 'rrule' }, failures);
  }
  if (exp.updates) {
    checkRange('updates', result.updates?.length ?? 0, exp.updates, failures);
  }
  if (exp.update && result.updates?.[0]) {
    const u = result.updates[0];
    if (exp.update.action && u.action !== exp.update.action) {
      failures.push(`update.action: got "${u.action}", expected "${exp.update.action}"`);
    }
    if (exp.update.matchTitleContains?.length) {
      checkContainsAny('update.match.title', u.match?.title ?? '', exp.update.matchTitleContains, failures);
    }
    if (exp.update.newStartAtNotNull && !u.newStartAt) {
      failures.push('update.newStartAt: expected non-null (RESCHEDULE)');
    }
  }

  return failures;
}
