import { readFileSync } from 'node:fs';
import { pino } from 'pino';
import { buildApp, type AppDeps } from '../src/app.js';
import type { FirefliesTranscript, TranscriptSource } from '../src/fireflies/client.js';
import { computeSignature } from '../src/fireflies/signature.js';
import type { ChatSender, CreateMessageInput, CreateMessageResult } from '../src/google/chatClient.js';
import type { TaskRequestVerifier } from '../src/google/oidc.js';
import { TaskAuthError } from '../src/google/oidc.js';
import { loggerOptions, type Logger } from '../src/logger.js';
import { MeetingProcessor } from '../src/processing/processor.js';
import type { EnqueueResult, ProcessMeetingTask, TaskQueue } from '../src/queue/types.js';
import type { MeetingRule } from '../src/recap/eligibility.js';
import { MemoryStateStore } from '../src/store/memory.js';

export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
export const SPACE = 'spaces/AAAATESTSPACE';
export const APPROVED_RULES: MeetingRule[] = [{ name: 'ops-sync', organizerEmails: ['ops-lead@orcarehab.example'], titleContains: ['ops sync'] }];

export function fixture<T = FirefliesTranscript>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
}

/** Captures log lines so tests can assert nothing sensitive is logged. */
export function captureLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  // Same options as production, so tests exercise the real redaction and serializers.
  const logger = pino(loggerOptions('debug'), { write: (s: string) => void lines.push(s) });
  return { logger, lines };
}

export class FakeFireflies implements TranscriptSource {
  calls = 0;
  responses: Array<FirefliesTranscript | Error> = [];
  constructor(private readonly fallback?: FirefliesTranscript) {}
  async getTranscript(): Promise<FirefliesTranscript> {
    this.calls++;
    const next = this.responses.length > 0 ? this.responses.shift()! : this.fallback;
    if (!next) throw new Error('no fake transcript');
    if (next instanceof Error) throw next;
    return structuredClone(next);
  }
}

/**
 * Emulates the documented Chat API idempotency: a repeated create with the
 * same requestId returns the existing message instead of creating another.
 */
export class FakeChat implements ChatSender {
  readonly messages = new Map<string, { name: string; text: string; messageId: string }>();
  calls: CreateMessageInput[] = [];
  /** Queue of behaviours for upcoming calls. */
  plan: Array<'ok' | 'commit-then-timeout' | Error> = [];
  delayMs = 0;

  async createMessage(input: CreateMessageInput): Promise<CreateMessageResult> {
    this.calls.push(input);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const step = this.plan.shift() ?? 'ok';
    if (step instanceof Error) throw step;
    const existing = this.messages.get(input.requestId);
    const record = existing ?? { name: `${input.space}/messages/${input.messageId}`, text: input.text, messageId: input.messageId };
    if (!existing) this.messages.set(input.requestId, record);
    if (step === 'commit-then-timeout') {
      const { RetryableError } = await import('../src/processing/errors.js');
      throw new RetryableError('chat_send_uncertain', 'Chat request failed without a response: TimeoutError');
    }
    return { name: record.name, alreadyExisted: false };
  }

  get postedCount(): number {
    return this.messages.size;
  }
}

export class RecordingQueue implements TaskQueue {
  readonly tasks = new Map<string, ProcessMeetingTask>();
  failNext?: Error;
  async enqueue(task: ProcessMeetingTask, taskId: string): Promise<EnqueueResult> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      throw e;
    }
    if (this.tasks.has(taskId)) return { taskName: taskId, alreadyExisted: true };
    this.tasks.set(taskId, task);
    return { taskName: taskId, alreadyExisted: false };
  }
}

export const TASK_TOKEN = 'valid-task-token';
export class FakeTaskVerifier implements TaskRequestVerifier {
  async verify(header: string | undefined): Promise<void> {
    if (header !== `Bearer ${TASK_TOKEN}`) throw new TaskAuthError('invalid OIDC token');
  }
}

export function makeHarness(opts: { rules?: MeetingRule[]; transcript?: FirefliesTranscript; maxAttempts?: number; oauth?: AppDeps['oauth']; now?: () => number } = {}) {
  const { logger, lines } = captureLogger();
  const store = new MemoryStateStore();
  const queue = new RecordingQueue();
  const fireflies = new FakeFireflies(opts.transcript ?? fixture('transcript-full.json'));
  const chat = new FakeChat();
  const processor = new MeetingProcessor({
    store,
    fireflies,
    chat,
    rules: opts.rules ?? APPROVED_RULES,
    chatSpace: SPACE,
    logger,
    maxAttempts: opts.maxAttempts ?? 5,
    now: opts.now,
  });
  const app = buildApp({
    logLevel: 'debug',
    logger,
    webhookSecret: WEBHOOK_SECRET,
    store,
    queue,
    processor,
    taskVerifier: new FakeTaskVerifier(),
    oauth: opts.oauth,
    now: opts.now,
  });
  return { app, store, queue, fireflies, chat, processor, logger, lines };
}

export function signedWebhook(body: string | object, secret = WEBHOOK_SECRET) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    method: 'POST' as const,
    url: '/webhooks/fireflies',
    headers: { 'content-type': 'application/json', 'x-hub-signature': computeSignature(Buffer.from(payload), secret) },
    payload,
  };
}

export function taskRequest(meetingId: string, retryCount = 0, token = TASK_TOKEN) {
  return {
    method: 'POST' as const,
    url: '/tasks/process-meeting',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-cloudtasks-taskretrycount': String(retryCount),
      'x-cloudtasks-taskname': `projects/p/locations/l/queues/q/tasks/t-${meetingId}`,
    },
    payload: JSON.stringify({ meetingId }),
  };
}
