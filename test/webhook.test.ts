import { describe, expect, it } from 'vitest';
import { makeHarness, signedWebhook, WEBHOOK_SECRET } from './helpers.js';

const summarized = { event: 'meeting.summarized', timestamp: 1710876789456, meeting_id: 'SYNTH01ABC' };

describe('POST /webhooks/fireflies', () => {
  it('accepts a signed meeting.summarized event and enqueues it durably before responding', async () => {
    const h = makeHarness();
    const res = await h.app.inject(signedWebhook(summarized));
    expect(res.statusCode).toBe(202);
    expect(h.queue.tasks.size).toBe(1);
    expect([...h.queue.tasks.values()][0]).toEqual({ meetingId: 'SYNTH01ABC' });
    const record = await h.store.getMeeting('SYNTH01ABC');
    expect(record?.status).toBe('queued');
    expect(record?.taskName).toMatch(/^ff-[0-9a-f]{40}$/);
  });

  it('rejects invalid, missing, or wrong-secret signatures with 401 and enqueues nothing', async () => {
    const h = makeHarness();
    const req = signedWebhook(summarized);
    expect((await h.app.inject({ ...req, headers: { ...req.headers, 'x-hub-signature': 'sha256=' + '0'.repeat(64) } })).statusCode).toBe(401);
    expect((await h.app.inject({ ...req, headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
    expect((await h.app.inject(signedWebhook(summarized, 'a-different-secret-123456'))).statusCode).toBe(401);
    // Signed body, then tampered in transit:
    expect((await h.app.inject({ ...req, payload: req.payload.replace('SYNTH01ABC', 'SYNTH99XYZ') })).statusCode).toBe(401);
    expect(h.queue.tasks.size).toBe(0);
  });

  it('verifies against the original bytes, not re-serialized JSON', async () => {
    const h = makeHarness();
    const res = await h.app.inject(signedWebhook('{ "meeting_id" : "SYNTH01ABC",\n "event":"meeting.summarized", "timestamp": 1710876789456 }'));
    expect(res.statusCode).toBe(202);
  });

  it('rejects malformed JSON and invalid payloads with 400', async () => {
    const h = makeHarness();
    expect((await h.app.inject(signedWebhook('{not json'))).statusCode).toBe(400);
    expect((await h.app.inject(signedWebhook({ event: 'meeting.summarized', timestamp: 1 }))).statusCode).toBe(400);
    expect((await h.app.inject(signedWebhook({ ...summarized, meeting_id: '../../etc' }))).statusCode).toBe(400);
    expect((await h.app.inject(signedWebhook({ ...summarized, timestamp: 'yesterday' }))).statusCode).toBe(400);
    expect(h.queue.tasks.size).toBe(0);
  });

  it('accepts only meeting.summarized', async () => {
    const h = makeHarness();
    for (const event of ['meeting.transcribed', 'meeting.bot_joined', 'Transcription completed']) {
      const res = await h.app.inject(signedWebhook({ ...summarized, event }));
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'unsupported_event' });
    }
    expect(h.queue.tasks.size).toBe(0);
  });

  it('treats summary updates (reprocessed_at) as already processed', async () => {
    const h = makeHarness();
    const res = await h.app.inject(signedWebhook({ ...summarized, reprocessed_at: 1791465987256 }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ignored', reason: 'summary_update' });
    expect(h.queue.tasks.size).toBe(0);
  });

  it('rejects non-JSON content types', async () => {
    const h = makeHarness();
    const req = signedWebhook(summarized);
    const res = await h.app.inject({ ...req, headers: { ...req.headers, 'content-type': 'text/plain' } });
    expect(res.statusCode).toBe(415);
  });

  it('deduplicates repeated and concurrent deliveries into one task', async () => {
    const h = makeHarness();
    const results = await Promise.all(Array.from({ length: 5 }, () => h.app.inject(signedWebhook(summarized))));
    expect(results.every((r) => r.statusCode === 202)).toBe(true);
    expect(h.queue.tasks.size).toBe(1);
  });

  it('returns 200 duplicate once the meeting is finished', async () => {
    const h = makeHarness();
    await h.app.inject(signedWebhook(summarized));
    await h.processor.process('SYNTH01ABC', { retryCount: 0 });
    const res = await h.app.inject(signedWebhook(summarized));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'duplicate' });
  });

  it('returns 503 (so Fireflies retries) when work cannot be enqueued, then succeeds on redelivery', async () => {
    const h = makeHarness();
    h.queue.failNext = new Error('Cloud Tasks unavailable');
    expect((await h.app.inject(signedWebhook(summarized))).statusCode).toBe(503);
    expect(h.queue.tasks.size).toBe(0);
    expect((await h.app.inject(signedWebhook(summarized))).statusCode).toBe(202);
    expect(h.queue.tasks.size).toBe(1);
  });

  it('never logs the signature, secret, or body', async () => {
    const h = makeHarness();
    const req = signedWebhook(summarized);
    await h.app.inject(req);
    const logs = h.lines.join('\n');
    expect(logs).not.toContain(req.headers['x-hub-signature']);
    expect(logs).not.toContain(WEBHOOK_SECRET);
    expect(logs).toContain('"meetingId":"SYNTH01ABC"');
  });
});
