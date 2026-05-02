/* eslint-disable no-console */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OllamaProvider } from '../../src/modules/ai/infrastructure/ollama/ollama.provider';
import type { EmailContent } from '../../src/modules/ai/application/ports/ai-provider.port';
import { AiResponseParseError } from '../../src/modules/ai/domain/errors/ai.errors';
import { stripQuotedText } from '../../src/modules/ai/application/util/strip-quoted';
import { parseIcs } from '../../src/modules/ai/application/util/parse-ics';
import { evaluate, type Fixture, type FixtureResult } from './metrics';

const FIXTURE_DIR = join(__dirname, 'fixtures');

async function main() {
  const provider = new OllamaProvider();
  const files = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();

  console.log(`\n=== MailMind AI Eval ===`);
  console.log(`Model:     ${provider.modelName}`);
  console.log(`Base URL:  ${process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1'}`);
  console.log(`Fixtures:  ${files.length}\n`);

  const results: FixtureResult[] = [];
  for (const file of files) {
    const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf-8')) as Fixture;
    const content: EmailContent = {
      subject: fixture.input.subject,
      from: fixture.input.from,
      date: new Date(fixture.input.date),
      // Production parity: EmailAnalyzerService body'yi stripQuotedText'ten geçirip
      // provider'a veriyor; eval de aynı pre-processing'i uygular.
      bodyText: stripQuotedText(fixture.input.bodyText),
      userTimezone: fixture.input.userTimezone,
      nowIso: fixture.input.nowIso,
      direction: fixture.input.direction ?? 'incoming',
    };

    const t0 = Date.now();
    let parseOk = true;
    let failures: string[] = [];
    let raw: any;
    try {
      const out = await provider.analyzeEmail(content);
      raw = out.result;

      // ICS merge: production EmailAnalyzerService ile aynı mantık — fixture'da
      // icsRaw varsa AI'ın calendarEvents'i ICS parser'ın çıktısıyla değiştirilir.
      if (fixture.input.icsRaw) {
        const icsEvents = parseIcs(fixture.input.icsRaw)
          .filter((e) => !e.cancelled && e.method !== 'CANCEL')
          .map((e) => ({
            title: e.summary,
            startAt: e.startAt,
            endAt: e.endAt,
            isAllDay: e.isAllDay,
            location: e.location,
            attendees: e.attendees,
            rrule: e.rrule,
            timezone: fixture.input.userTimezone,
          }));
        raw = { ...raw, calendarEvents: icsEvents };
      }

      failures = evaluate(fixture, raw);
    } catch (e: any) {
      parseOk = !(e instanceof AiResponseParseError);
      failures = [`exception: ${e?.message ?? String(e)}`];
    }
    const latencyMs = Date.now() - t0;

    const passed = parseOk && failures.length === 0;
    results.push({ name: fixture.name, passed, failures, latencyMs, parseOk, raw });

    const status = passed ? '✓' : '✗';
    const icon = passed ? '\x1b[32m' : '\x1b[31m';
    console.log(`${icon}${status}\x1b[0m  [${file}]  ${fixture.name}  (${latencyMs}ms)`);
    if (!passed) {
      for (const f of failures) console.log(`     - ${f}`);
      if (raw) {
        console.log(`     actual: tasks=${raw.tasks?.length ?? '?'} events=${raw.calendarEvents?.length ?? '?'} reminders=${raw.reminders?.length ?? '?'}`);
      }
    }
  }

  // ── Aggregate ────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const parseOkCount = results.filter((r) => r.parseOk).length;
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length / 2)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  console.log(`\n=== Summary ===`);
  console.log(`Pass rate:     ${passed}/${total} (${((passed / total) * 100).toFixed(1)}%)`);
  console.log(`JSON parse ok: ${parseOkCount}/${total}`);
  console.log(`Latency p50:   ${p50}ms`);
  console.log(`Latency p95:   ${p95}ms`);
  console.log();

  if (passed < total) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
