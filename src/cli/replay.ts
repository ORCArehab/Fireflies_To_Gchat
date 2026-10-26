/**
 * Operator replay for a meeting whose processing failed (e.g. retries were
 * exhausted while the Google account needed re-authorization):
 *
 *   npm run replay -- --meeting <fireflies meeting id>
 *
 * Uses the production configuration (Firestore + Cloud Tasks). The stored
 * Chat requestId/messageId are kept, so replaying a meeting that was in fact
 * posted returns the existing message instead of posting a duplicate.
 */
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createServices } from '../container.js';
import { taskId } from '../ids.js';
import { createLogger } from '../logger.js';

async function main() {
  const { values } = parseArgs({ options: { meeting: { type: 'string' } } });
  if (!values.meeting) throw new Error('usage: replay --meeting <id>');
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const { store, queue } = createServices(config, logger);

  const record = await store.resetForReplay(values.meeting, Date.now());
  const enqueued = await queue.enqueue({ meetingId: values.meeting }, taskId(values.meeting, record.enqueueGeneration));
  await store.markEnqueued(values.meeting, enqueued.taskName, Date.now());
  logger.info({ event: 'recap.replay_enqueued', meetingId: values.meeting, taskName: enqueued.taskName }, 'replay enqueued');
}

main().catch((err) => {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exit(1);
});
