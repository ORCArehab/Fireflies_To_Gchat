import { CloudTasksClient } from '@google-cloud/tasks';
import type { EnqueueResult, ProcessMeetingTask, TaskQueue } from './types.js';

const GRPC_ALREADY_EXISTS = 6;

export interface CloudTasksQueueOptions {
  project: string;
  location: string;
  queue: string;
  handlerUrl: string;
  /** Service account Cloud Tasks uses to mint the OIDC token for the handler. */
  invokerServiceAccount: string;
  audience: string;
  dispatchDeadlineSeconds?: number;
}

export class CloudTasksQueue implements TaskQueue {
  private readonly client: CloudTasksClient;

  constructor(
    private readonly opts: CloudTasksQueueOptions,
    client?: CloudTasksClient,
  ) {
    this.client = client ?? new CloudTasksClient();
  }

  async enqueue(task: ProcessMeetingTask, taskId: string): Promise<EnqueueResult> {
    const parent = this.client.queuePath(this.opts.project, this.opts.location, this.opts.queue);
    const name = this.client.taskPath(this.opts.project, this.opts.location, this.opts.queue, taskId);
    try {
      await this.client.createTask({
        parent,
        task: {
          name,
          dispatchDeadline: { seconds: this.opts.dispatchDeadlineSeconds ?? 120 },
          httpRequest: {
            httpMethod: 'POST',
            url: this.opts.handlerUrl,
            headers: { 'Content-Type': 'application/json' },
            body: Buffer.from(JSON.stringify(task)).toString('base64'),
            oidcToken: { serviceAccountEmail: this.opts.invokerServiceAccount, audience: this.opts.audience },
          },
        },
      });
      return { taskName: name, alreadyExisted: false };
    } catch (err) {
      // Named tasks are de-duplicated by Cloud Tasks: the same id cannot be created twice.
      if ((err as { code?: number }).code === GRPC_ALREADY_EXISTS) return { taskName: name, alreadyExisted: true };
      throw err;
    }
  }
}
