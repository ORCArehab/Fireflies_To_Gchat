import type { Logger } from '../logger.js';
import type { EnqueueResult, ProcessMeetingTask, TaskQueue } from './types.js';

/**
 * Local-mode queue: runs the handler in-process after the webhook responds,
 * retrying retryable outcomes a few times. NOT durable; refused in production.
 */
export class InlineQueue implements TaskQueue {
  private readonly seen = new Set<string>();
  handler?: (task: ProcessMeetingTask, attempt: number) => Promise<{ retry: boolean }>;

  constructor(
    private readonly logger: Logger,
    private readonly maxAttempts = 3,
    private readonly delayMs = 2_000,
  ) {}

  async enqueue(task: ProcessMeetingTask, taskId: string): Promise<EnqueueResult> {
    if (this.seen.has(taskId)) return { taskName: taskId, alreadyExisted: true };
    this.seen.add(taskId);
    setImmediate(() => void this.run(task));
    return { taskName: taskId, alreadyExisted: false };
  }

  private async run(task: ProcessMeetingTask): Promise<void> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        const { retry } = await this.handler!(task, attempt);
        if (!retry) return;
      } catch (err) {
        this.logger.error({ err, event: 'inline_task.error' }, 'inline task failed');
      }
      await new Promise((r) => setTimeout(r, this.delayMs * (attempt + 1)));
    }
  }
}
