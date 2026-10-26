import type { FastifyInstance } from 'fastify';
import { SIGNATURE_HEADER, verifySignature } from '../fireflies/signature.js';
import { SUMMARY_EVENT, webhookPayloadSchema } from '../fireflies/webhookPayload.js';
import { taskId } from '../ids.js';
import { errorReportingFields } from '../logger.js';
import type { TaskQueue } from '../queue/types.js';
import { TERMINAL_STATUSES, type StateStore } from '../store/types.js';

export interface WebhookRouteDeps {
  webhookSecret: string;
  store: StateStore;
  queue: TaskQueue;
  now: () => number;
}

/**
 * Fireflies retries 429/5xx and connection failures, and never retries other
 * 4xx. So: invalid requests get 4xx; infrastructure failures get 503 so the
 * event is redelivered; 2xx is returned only once work is durably enqueued.
 */
export function registerWebhookRoutes(app: FastifyInstance, deps: WebhookRouteDeps): void {
  app.post('/webhooks/fireflies', async (req, reply) => {
    const raw = req.body;
    if (!Buffer.isBuffer(raw)) return reply.code(415).send({ error: 'unsupported_media_type' });

    if (!verifySignature(raw, req.headers[SIGNATURE_HEADER], deps.webhookSecret)) {
      req.log.warn({ event: 'webhook.rejected', reason: 'invalid_signature' }, 'webhook signature invalid');
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    let json: unknown;
    try {
      json = JSON.parse(raw.toString('utf8'));
    } catch {
      req.log.warn({ event: 'webhook.rejected', reason: 'invalid_json' }, 'webhook body is not JSON');
      return reply.code(400).send({ error: 'invalid_json' });
    }
    const parsed = webhookPayloadSchema.safeParse(json);
    if (!parsed.success) {
      req.log.warn({ event: 'webhook.rejected', reason: 'invalid_payload', issues: parsed.error.issues.map((i) => i.path.join('.')) }, 'webhook payload invalid');
      return reply.code(400).send({ error: 'invalid_payload' });
    }
    const payload = parsed.data;
    const log = req.log.child({ meetingId: payload.meeting_id, eventType: payload.event });

    if (payload.event !== SUMMARY_EVENT) {
      log.info({ event: 'webhook.rejected', reason: 'unsupported_event' }, 'unsupported event type');
      return reply.code(400).send({ error: 'unsupported_event' });
    }
    if (payload.reprocessed_at != null) {
      // v1 policy: an updated summary for a meeting is treated as already processed.
      log.info({ event: 'webhook.ignored', reason: 'summary_update', reprocessedAt: payload.reprocessed_at }, 'ignoring summary update');
      return reply.code(200).send({ status: 'ignored', reason: 'summary_update' });
    }

    try {
      const now = deps.now();
      const { outcome, record } = await deps.store.registerMeeting(payload.meeting_id, { webhookTimestamp: payload.timestamp }, now);
      if (outcome === 'existing' && TERMINAL_STATUSES.has(record.status)) {
        log.info({ event: 'webhook.duplicate', status: record.status }, 'meeting already processed');
        return reply.code(200).send({ status: 'duplicate' });
      }
      // Deterministic task id: a duplicate or concurrent delivery cannot create a second task.
      const enqueued = await deps.queue.enqueue({ meetingId: payload.meeting_id }, taskId(payload.meeting_id, record.enqueueGeneration));
      if (!enqueued.alreadyExisted || !record.taskName) await deps.store.markEnqueued(payload.meeting_id, enqueued.taskName, now);
      log.info({ event: 'webhook.accepted', registration: outcome, taskAlreadyExisted: enqueued.alreadyExisted }, 'meeting queued');
      return reply.code(202).send({ status: 'accepted' });
    } catch (err) {
      log.error({ ...errorReportingFields, event: 'webhook.enqueue_failed', err }, 'could not durably enqueue webhook; Fireflies will retry');
      return reply.code(503).send({ error: 'temporarily_unavailable' });
    }
  });
}
