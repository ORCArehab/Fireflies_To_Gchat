import { describe, expect, it } from 'vitest';
import type { FirefliesTranscript } from '../src/fireflies/client.js';
import { chatMessageId, chatRequestId } from '../src/ids.js';
import { PermanentError, ReauthorizationRequiredError, RetryableError } from '../src/processing/errors.js';
import { fixture, makeHarness, signedWebhook, SPACE, taskRequest } from './helpers.js';

const MEETING = 'SYNTH01ABC';
const summarized = { event: 'meeting.summarized', timestamp: 1710876789456, meeting_id: MEETING };

async function queued(h: ReturnType<typeof makeHarness>) {
  expect((await h.app.inject(signedWebhook(summarized))).statusCode).toBe(202);
}

describe('task processing', () => {
  it('end to end: webhook -> task -> one Chat message with deterministic ids', async () => {
    const h = makeHarness();
    await queued(h);
    const res = await h.app.inject(taskRequest(MEETING));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'sent' });
    expect(h.chat.postedCount).toBe(1);
    const call = h.chat.calls[0]!;
    expect(call.space).toBe(SPACE);
    expect(call.messageId).toBe(chatMessageId(MEETING));
    expect(call.messageId).toMatch(/^client-[a-z0-9-]{1,56}$/);
    expect(call.messageId.length).toBeLessThanOrEqual(63);
    expect(call.requestId).toBe(chatRequestId(SPACE, MEETING));
    expect(call.text).toContain('*Weekly Clinic Ops Sync*');
    const record = await h.store.getMeeting(MEETING);
    expect(record).toMatchObject({ status: 'sent', matchedRule: 'ops-sync', chatMessageName: `${SPACE}/messages/${call.messageId}` });
    expect(record?.leaseOwner).toBeUndefined();
  });

  it('rejects task requests without a valid Cloud Tasks OIDC token', async () => {
    const h = makeHarness();
    await queued(h);
    expect((await h.app.inject(taskRequest(MEETING, 0, 'forged'))).statusCode).toBe(401);
    const { authorization: _a, ...noAuth } = taskRequest(MEETING).headers;
    expect((await h.app.inject({ ...taskRequest(MEETING), headers: noAuth })).statusCode).toBe(401);
    expect(h.fireflies.calls).toBe(0);
    expect(h.chat.calls).toHaveLength(0);
  });

  it('acknowledges malformed task bodies without processing', async () => {
    const h = makeHarness();
    const res = await h.app.inject({ ...taskRequest(MEETING), payload: '{"meetingId":"../x"}' });
    expect(res.statusCode).toBe(200);
    expect(h.fireflies.calls).toBe(0);
  });

  it('posts nothing when no rules are configured (default)', async () => {
    const h = makeHarness({ rules: [] });
    await queued(h);
    const res = await h.app.inject(taskRequest(MEETING));
    expect(res.json()).toEqual({ result: 'skipped' });
    expect(h.chat.calls).toHaveLength(0);
    expect(await h.store.getMeeting(MEETING)).toMatchObject({ status: 'skipped', statusReason: 'no_rules_configured' });
  });

  it('skips meetings that do not match an approved rule, using Fireflies API metadata', async () => {
    const h = makeHarness({ transcript: { ...fixture<FirefliesTranscript>('transcript-full.json'), organizer_email: 'outsider@example.com' } });
    await queued(h);
    expect((await h.app.inject(taskRequest(MEETING))).json()).toEqual({ result: 'skipped' });
    expect(h.chat.calls).toHaveLength(0);
  });

  it('does not post twice for duplicate task deliveries', async () => {
    const h = makeHarness();
    await queued(h);
    await h.app.inject(taskRequest(MEETING));
    const again = await h.app.inject(taskRequest(MEETING, 1));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ result: 'duplicate' });
    expect(h.chat.calls).toHaveLength(1);
    expect(h.fireflies.calls).toBe(1);
  });

  it('serializes concurrent deliveries: exactly one Chat message', async () => {
    const h = makeHarness();
    await queued(h);
    h.chat.delayMs = 30;
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => h.app.inject(taskRequest(MEETING, i % 2))));
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 503)).toHaveLength(5); // lease busy -> Cloud Tasks retries later
    for (const r of results.filter((x) => x.statusCode === 503)) {
      expect(r.json()).toEqual({ result: 'retry', code: 'lease_busy' });
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    }
    expect(h.chat.calls).toHaveLength(1);
    // Those retries later find the meeting finished.
    expect((await h.app.inject(taskRequest(MEETING, 2))).json()).toEqual({ result: 'duplicate' });
    expect(h.chat.postedCount).toBe(1);
  });

  it('retries after an uncertain send with the same ids, producing no duplicate', async () => {
    const h = makeHarness();
    await queued(h);
    h.chat.plan = ['commit-then-timeout'];
    const first = await h.app.inject(taskRequest(MEETING, 0));
    expect(first.statusCode).toBe(503);
    expect(first.json()).toEqual({ result: 'retry', code: 'chat_send_uncertain' });
    const mid = await h.store.getMeeting(MEETING);
    expect(mid?.sendStartedAt).toBeTypeOf('number');
    expect(mid?.status).toBe('queued');

    const second = await h.app.inject(taskRequest(MEETING, 1));
    expect(second.json()).toEqual({ result: 'sent' });
    expect(h.chat.calls).toHaveLength(2);
    expect(h.chat.calls[1]!.requestId).toBe(h.chat.calls[0]!.requestId);
    expect(h.chat.calls[1]!.messageId).toBe(h.chat.calls[0]!.messageId);
    expect(h.chat.postedCount).toBe(1);
  });

  it('still completes the send after an uncertain attempt even if eligibility rules changed meanwhile', async () => {
    const h = makeHarness();
    await queued(h);
    h.chat.plan = ['commit-then-timeout'];
    await h.app.inject(taskRequest(MEETING, 0));
    // Same store, new processor with no rules (e.g. config redeployed between attempts).
    const { MeetingProcessor } = await import('../src/processing/processor.js');
    const p = new MeetingProcessor({ store: h.store, fireflies: h.fireflies, chat: h.chat, rules: [], chatSpace: SPACE, logger: h.logger, maxAttempts: 5 });
    expect(await p.process(MEETING, { retryCount: 1 })).toMatchObject({ result: 'sent' });
    expect(h.chat.postedCount).toBe(1);
  });

  it('retries while the summary is still processing, then sends', async () => {
    const h = makeHarness();
    await queued(h);
    h.fireflies.responses = [fixture('transcript-processing.json')];
    const first = await h.app.inject(taskRequest(MEETING, 0));
    expect(first.statusCode).toBe(503);
    expect(first.json()).toEqual({ result: 'retry', code: 'summary_processing' });
    expect(h.chat.calls).toHaveLength(0);
    expect((await h.app.inject(taskRequest(MEETING, 1))).json()).toEqual({ result: 'sent' });
  });

  it('retries rate limits and transient Chat errors with Retry-After', async () => {
    const h = makeHarness();
    await queued(h);
    h.fireflies.responses = [new RetryableError('fireflies_rate_limited', 'Fireflies rate limit', 42)];
    const first = await h.app.inject(taskRequest(MEETING, 0));
    expect(first.statusCode).toBe(503);
    expect(first.headers['retry-after']).toBe('42');
    h.chat.plan = [new RetryableError('chat_unavailable', 'Google Chat temporarily unavailable (HTTP 503)')];
    expect((await h.app.inject(taskRequest(MEETING, 1))).statusCode).toBe(503);
    expect((await h.app.inject(taskRequest(MEETING, 2))).json()).toEqual({ result: 'sent' });
    expect(h.chat.postedCount).toBe(1);
  });

  it('records permanent failures with a clear error and stops retrying', async () => {
    const h = makeHarness();
    await queued(h);
    h.fireflies.responses = [new PermanentError('summary_failed', 'Fireflies summary_status is failed')];
    const res = await h.app.inject(taskRequest(MEETING, 0));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'failed' });
    expect(await h.store.getMeeting(MEETING)).toMatchObject({ status: 'failed', lastErrorCode: 'summary_failed' });
    expect(h.lines.join('\n')).toMatch(/"event":"recap.delivery_failed"/);
  });

  it('reports expired/revoked Google credentials clearly and recovers after re-authorization', async () => {
    const h = makeHarness();
    await queued(h);
    h.chat.plan = [new ReauthorizationRequiredError('Google refresh token was rejected (invalid_grant). Re-authorize via /oauth/start.')];
    const res = await h.app.inject(taskRequest(MEETING, 0));
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ result: 'retry', code: 'google_reauthorization_required' });
    const errorLine = h.lines.map((l) => JSON.parse(l)).find((l) => l.event === 'recap.google_auth_required');
    expect(errorLine).toMatchObject({ severity: 'ERROR', code: 'google_reauthorization_required' });
    expect(errorLine.message).toContain('/oauth/start');
    expect((await h.app.inject(taskRequest(MEETING, 1))).json()).toEqual({ result: 'sent' });
  });

  it('marks the final attempt as failed, flagging an ambiguous send for manual check', async () => {
    const h = makeHarness({ maxAttempts: 2 });
    await queued(h);
    h.chat.plan = [new RetryableError('chat_send_uncertain', 'timeout'), new RetryableError('chat_send_uncertain', 'timeout')];
    expect((await h.app.inject(taskRequest(MEETING, 0))).statusCode).toBe(503);
    const last = await h.app.inject(taskRequest(MEETING, 1));
    expect(last.statusCode).toBe(200);
    expect(last.json()).toEqual({ result: 'failed' });
    expect(await h.store.getMeeting(MEETING)).toMatchObject({ status: 'failed', statusReason: 'delivery_uncertain' });
  });

  it('takes over an expired lease from a crashed worker', async () => {
    let now = 1_000_000;
    const h = makeHarness({ now: () => now });
    await queued(h);
    await h.store.acquireLease(MEETING, 'crashed-worker', now, 60_000);
    expect((await h.app.inject(taskRequest(MEETING, 0))).json()).toMatchObject({ code: 'lease_busy' });
    now += 61_000;
    expect((await h.app.inject(taskRequest(MEETING, 1))).json()).toEqual({ result: 'sent' });
  });

  it('logs identifiers and status but never summary content', async () => {
    const h = makeHarness();
    await queued(h);
    await h.app.inject(taskRequest(MEETING));
    const logs = h.lines.join('\n');
    expect(logs).toContain('"event":"recap.sent"');
    expect(logs).toContain(MEETING);
    for (const sensitive of ['intake form', 'Alex Rivera', 'Weekly Clinic Ops Sync', 'treadmill', 'ops-lead@orcarehab.example']) {
      expect(logs).not.toContain(sensitive);
    }
  });
});
