import { assertSummaryReady, type TranscriptSource } from '../fireflies/client.js';
import type { ChatSender } from '../google/chatClient.js';
import { chatMessageId, chatRequestId, randomToken } from '../ids.js';
import { errorReportingFields, type Logger } from '../logger.js';
import { evaluateEligibility, type MeetingRule } from '../recap/eligibility.js';
import { formatRecap } from '../recap/format.js';
import type { MeetingRecord, StateStore } from '../store/types.js';
import { PermanentError, ReauthorizationRequiredError, RetryableError } from './errors.js';

export type ProcessOutcome =
  | { result: 'sent'; messageName: string }
  | { result: 'skipped'; reason: string }
  | { result: 'duplicate'; status: string }
  | { result: 'failed'; code: string }
  | { result: 'retry'; code: string; retryAfterSeconds?: number };

export interface ProcessorDeps {
  store: StateStore;
  fireflies: TranscriptSource;
  chat: ChatSender;
  rules: MeetingRule[];
  chatSpace: string;
  logger: Logger;
  /** Should equal the Cloud Tasks queue's max attempts. */
  maxAttempts: number;
  leaseMs?: number;
  now?: () => number;
  instanceId?: string;
}

/**
 * Processes one meeting exactly-once-in-effect:
 * 1. Take a Firestore lease (concurrent deliveries back off; terminal records are no-ops).
 * 2. Fetch the summary from Fireflies (verified source of truth; the webhook carries only an id).
 * 3. Apply the eligibility rules (default: send nothing).
 * 4. Persist deterministic Chat requestId/messageId *before* sending, then send.
 *    A retry after an ambiguous send reuses the same ids, so Chat returns the
 *    existing message instead of creating a second recap.
 */
export class MeetingProcessor {
  private readonly leaseMs: number;
  private readonly now: () => number;
  private readonly instanceId: string;

  constructor(private readonly deps: ProcessorDeps) {
    this.leaseMs = deps.leaseMs ?? 3 * 60_000;
    this.now = deps.now ?? Date.now;
    this.instanceId = deps.instanceId ?? randomToken(6);
  }

  async process(meetingId: string, ctx: { retryCount: number; taskName?: string }): Promise<ProcessOutcome> {
    const { store, logger } = this.deps;
    const owner = `${this.instanceId}:${randomToken(6)}`;
    const log = logger.child({ meetingId, taskName: ctx.taskName, retryCount: ctx.retryCount });

    const lease = await store.acquireLease(meetingId, owner, this.now(), this.leaseMs);
    if (lease.outcome === 'missing') {
      log.warn({ event: 'recap.no_record' }, 'task for unknown meeting; ignoring');
      return { result: 'skipped', reason: 'no_record' };
    }
    if (lease.outcome === 'terminal') {
      log.info({ event: 'recap.duplicate', status: lease.record.status }, 'meeting already finished; nothing to do');
      return { result: 'duplicate', status: lease.record.status };
    }
    if (lease.outcome === 'busy') {
      log.info({ event: 'recap.lease_busy' }, 'another worker is processing this meeting');
      return { result: 'retry', code: 'lease_busy', retryAfterSeconds: Math.ceil(lease.retryAfterMs / 1000) };
    }

    const record = lease.record;
    log.info({ event: 'recap.processing', attempt: record.attempts, previousSendStarted: Boolean(record.sendStartedAt) }, 'processing meeting');

    try {
      return await this.run(meetingId, owner, record, log);
    } catch (err) {
      return this.handleError(meetingId, owner, err, ctx, log);
    }
  }

  private async run(meetingId: string, owner: string, record: MeetingRecord, log: Logger): Promise<ProcessOutcome> {
    const { store, fireflies, chat, rules, chatSpace } = this.deps;

    // A previous attempt may already have posted; never re-evaluate eligibility in that case.
    const resumingSend = Boolean(record.sendStartedAt);

    const transcript = await fireflies.getTranscript(meetingId);
    assertSummaryReady(transcript);

    let matchedRule = record.matchedRule;
    if (!resumingSend) {
      const eligibility = evaluateEligibility(rules, {
        title: transcript.title,
        organizerEmail: transcript.organizer_email,
        calendarId: transcript.calendar_id,
      });
      if (!eligibility.eligible) {
        await this.finish(meetingId, owner, { status: 'skipped', statusReason: eligibility.reason });
        log.info({ event: 'recap.skipped', reason: eligibility.reason }, 'meeting not eligible; not posting');
        return { result: 'skipped', reason: eligibility.reason };
      }
      matchedRule = eligibility.rule;
    }

    const recap = formatRecap(transcript);
    const ids = {
      chatRequestId: record.chatRequestId ?? chatRequestId(chatSpace, meetingId),
      chatMessageId: record.chatMessageId ?? chatMessageId(meetingId),
    };
    const persisted = await store.updateWithLease(
      meetingId,
      owner,
      { ...ids, matchedRule, sendStartedAt: record.sendStartedAt ?? this.now() },
      this.now(),
    );
    if (!persisted) throw new RetryableError('lease_lost', 'processing lease lost before send');

    log.info(
      { event: 'recap.sending', rule: matchedRule, bytes: recap.bytes, truncated: recap.truncated, counts: recap.counts, resumingSend, chatMessageId: ids.chatMessageId },
      'posting recap to Google Chat',
    );
    const result = await chat.createMessage({
      space: chatSpace,
      text: recap.text,
      messageId: ids.chatMessageId,
      requestId: ids.chatRequestId,
    });

    const saved = await this.finish(meetingId, owner, { status: 'sent', statusReason: result.alreadyExisted ? 'already_existed' : 'posted', chatMessageName: result.name });
    if (!saved) log.warn({ event: 'recap.lease_lost_after_send' }, 'posted, but lease was lost; a retry will be deduplicated by requestId');
    log.info({ event: 'recap.sent', chatMessageName: result.name, alreadyExisted: result.alreadyExisted }, 'recap posted');
    return { result: 'sent', messageName: result.name };
  }

  private async handleError(
    meetingId: string,
    owner: string,
    err: unknown,
    ctx: { retryCount: number },
    log: Logger,
  ): Promise<ProcessOutcome> {
    const record = await this.deps.store.getMeeting(meetingId);
    const sendStarted = Boolean(record?.sendStartedAt);
    const isFinalAttempt = ctx.retryCount + 1 >= this.deps.maxAttempts;

    if (err instanceof PermanentError) {
      await this.finish(meetingId, owner, { status: 'failed', statusReason: err.code, lastErrorCode: err.code, lastErrorMessage: err.message });
      log.error({ ...errorReportingFields, event: 'recap.delivery_failed', code: err.code, sendStarted, err }, `recap failed permanently: ${err.message}`);
      return { result: 'failed', code: err.code };
    }

    const retryable =
      err instanceof RetryableError ? err : new RetryableError('unexpected_error', `unexpected error: ${(err as Error)?.name ?? 'unknown'}`);

    if (isFinalAttempt) {
      const code = sendStarted ? 'delivery_uncertain' : retryable.code;
      await this.finish(meetingId, owner, { status: 'failed', statusReason: code, lastErrorCode: retryable.code, lastErrorMessage: retryable.message });
      log.error(
        { ...errorReportingFields, event: 'recap.delivery_failed', code, cause: retryable.code, sendStarted, err },
        sendStarted
          ? `retries exhausted after an ambiguous send; check the Chat space manually: ${retryable.message}`
          : `retries exhausted: ${retryable.message}`,
      );
      return { result: 'failed', code };
    }

    await this.deps.store.updateWithLease(
      meetingId,
      owner,
      { status: 'queued', lastErrorCode: retryable.code, lastErrorMessage: retryable.message, leaseOwner: undefined, leaseExpiresAt: undefined },
      this.now(),
    );
    if (err instanceof ReauthorizationRequiredError) {
      log.error({ ...errorReportingFields, event: 'recap.google_auth_required', code: retryable.code, err }, retryable.message);
    } else if (retryable.code === 'unexpected_error') {
      log.error({ event: 'recap.retry', code: retryable.code, err }, 'unexpected error; will retry');
    } else {
      log.warn({ event: 'recap.retry', code: retryable.code, sendStarted }, `will retry: ${retryable.message}`);
    }
    return { result: 'retry', code: retryable.code, retryAfterSeconds: retryable.retryAfterSeconds };
  }

  private finish(meetingId: string, owner: string, patch: Partial<MeetingRecord>): Promise<boolean> {
    return this.deps.store.updateWithLease(meetingId, owner, { ...patch, leaseOwner: undefined, leaseExpiresAt: undefined }, this.now());
  }
}
