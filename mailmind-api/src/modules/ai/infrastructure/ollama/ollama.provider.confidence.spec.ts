/**
 * G6: LLM çıktısındaki "confidence" alanının parser tarafından doğru
 * temizlendiğini doğrular. parseTasks/parseEvents/parseReminders private,
 * bu yüzden parseResponse üzerinden test ederiz.
 */
import { OllamaProvider } from './ollama.provider';

describe('OllamaProvider — confidence parsing', () => {
  const svc = new OllamaProvider();
  const parseResponse = (raw: string) =>
    (svc as any).parseResponse(raw);

  function buildJson(extra: Record<string, unknown>) {
    return JSON.stringify({
      summary: 's',
      tasks: [],
      calendarEvents: [],
      reminders: [],
      ...extra,
    });
  }

  it('extracts confidence from tasks', () => {
    const out = parseResponse(
      buildJson({
        tasks: [
          { title: 't1', priority: 'HIGH', confidence: 0.9 },
          { title: 't2', priority: 'LOW', confidence: 0.4 },
        ],
      }),
    );
    expect(out.tasks[0].confidence).toBe(0.9);
    expect(out.tasks[1].confidence).toBe(0.4);
  });

  it('clamps out-of-range confidence to [0, 1]', () => {
    const out = parseResponse(
      buildJson({
        tasks: [
          { title: 't1', priority: 'MEDIUM', confidence: 1.5 },
          { title: 't2', priority: 'MEDIUM', confidence: -0.2 },
        ],
      }),
    );
    expect(out.tasks[0].confidence).toBe(1);
    expect(out.tasks[1].confidence).toBe(0);
  });

  it('returns undefined for missing or non-numeric confidence', () => {
    const out = parseResponse(
      buildJson({
        tasks: [
          { title: 't1', priority: 'MEDIUM' },
          { title: 't2', priority: 'MEDIUM', confidence: 'high' },
          { title: 't3', priority: 'MEDIUM', confidence: null },
        ],
      }),
    );
    expect(out.tasks[0].confidence).toBeUndefined();
    expect(out.tasks[1].confidence).toBeUndefined();
    expect(out.tasks[2].confidence).toBeUndefined();
  });

  it('extracts confidence from calendarEvents and reminders', () => {
    const out = parseResponse(
      buildJson({
        calendarEvents: [
          {
            title: 'meeting',
            startAt: '2026-05-10T09:00:00Z',
            confidence: 0.95,
          },
        ],
        reminders: [
          { title: 'rem', fireAt: '2026-05-10T09:00:00Z', confidence: 0.5 },
        ],
      }),
    );
    expect(out.calendarEvents[0].confidence).toBe(0.95);
    expect(out.reminders[0].confidence).toBe(0.5);
  });

  it('accepts numeric strings as confidence', () => {
    const out = parseResponse(
      buildJson({
        tasks: [{ title: 't1', priority: 'MEDIUM', confidence: '0.75' }],
      }),
    );
    expect(out.tasks[0].confidence).toBe(0.75);
  });
});
