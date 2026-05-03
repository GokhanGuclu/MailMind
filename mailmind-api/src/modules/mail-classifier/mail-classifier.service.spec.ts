import { MailClassifierService } from './mail-classifier.service';

describe('MailClassifierService', () => {
  let originalFetch: typeof fetch;
  let svc: MailClassifierService;

  beforeEach(() => {
    originalFetch = global.fetch;
    process.env.MAIL_CLASSIFIER_URL = 'http://classifier:8001';
    process.env.MAIL_CLASSIFIER_TIMEOUT_MS = '500';
    process.env.MAIL_CLASSIFIER_ENABLED = 'true';
    svc = new MailClassifierService();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns parsed result on 200 OK', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        category: 'Pazarlama',
        confidence: 0.91,
        probabilities: { Pazarlama: 0.91, 'İş/Acil': 0.05 },
      }),
    } as any);

    const out = await svc.classify({ subject: 'İndirim!', body: 'Bugün fırsat.' });
    expect(out?.category).toBe('Pazarlama');
    expect(out?.confidence).toBeCloseTo(0.91);
  });

  it('returns null on non-2xx', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'model not loaded',
    } as any);
    const out = await svc.classify({ subject: 's', body: 'b' });
    expect(out).toBeNull();
  });

  it('returns null on network error / abort', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await svc.classify({ subject: 's', body: 'b' });
    expect(out).toBeNull();
  });

  it('returns null when both subject and body empty', async () => {
    global.fetch = jest.fn();
    const out = await svc.classify({ subject: '', body: '' });
    expect(out).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('returns null when MAIL_CLASSIFIER_ENABLED=false', async () => {
    process.env.MAIL_CLASSIFIER_ENABLED = 'false';
    const disabled = new MailClassifierService();
    global.fetch = jest.fn();
    const out = await disabled.classify({ subject: 's', body: 'b' });
    expect(out).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('truncates body over 8KB before sending', async () => {
    let captured: any;
    global.fetch = jest.fn().mockImplementation(async (_url, init: any) => {
      captured = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ category: 'Diğer', confidence: 0.5, probabilities: {} }),
      } as any;
    });

    const longBody = 'a'.repeat(20000);
    await svc.classify({ subject: 's', body: longBody });
    expect(captured.body.length).toBe(8000);
  });
});
