import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TaskAuthError, type TaskRequestVerifier } from '../google/oidc.js';
import type { MeetingProcessor } from '../processing/processor.js';

const taskBodySchema = z.object({ meetingId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/) }).strict();

/**
 * Cloud Tasks handler. Cloud Tasks treats any 2xx as done and retries anything
 * else with the queue's backoff, so retryable outcomes return 503.
 */
export function registerTaskRoutes(app: FastifyInstance, deps: { verifier: TaskRequestVerifier; processor: MeetingProcessor }): void {
  app.post('/tasks/process-meeting', async (req, reply) => {
    try {
      await deps.verifier.verify(req.headers.authorization);
    } catch (err) {
      req.log.warn({ event: 'task.unauthorized', reason: err instanceof TaskAuthError ? err.message : 'verification_error' }, 'task request rejected');
      return reply.code(err instanceof TaskAuthError ? 401 : 503).send({ error: 'unauthorized' });
    }

    let body: z.infer<typeof taskBodySchema>;
    try {
      const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
      body = taskBodySchema.parse(JSON.parse(raw));
    } catch {
      // Malformed task: retrying cannot help, so acknowledge it.
      req.log.error({ event: 'task.invalid_body' }, 'invalid task body; dropping');
      return reply.code(200).send({ result: 'invalid_task' });
    }

    const retryCount = Number.parseInt(String(req.headers['x-cloudtasks-taskretrycount'] ?? '0'), 10) || 0;
    const taskName = typeof req.headers['x-cloudtasks-taskname'] === 'string' ? req.headers['x-cloudtasks-taskname'] : undefined;

    const outcome = await deps.processor.process(body.meetingId, { retryCount, taskName });
    if (outcome.result === 'retry') {
      if (outcome.retryAfterSeconds) reply.header('Retry-After', String(outcome.retryAfterSeconds));
      return reply.code(503).send({ result: 'retry', code: outcome.code });
    }
    return reply.code(200).send({ result: outcome.result });
  });
}
