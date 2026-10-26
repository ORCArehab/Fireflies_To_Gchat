export interface ProcessMeetingTask {
  meetingId: string;
}

export type EnqueueResult = { taskName: string; alreadyExisted: boolean };

export interface TaskQueue {
  /**
   * Durably enqueue processing for a meeting. `taskId` is deterministic, so
   * enqueuing the same meeting twice is a no-op (`alreadyExisted: true`).
   */
  enqueue(task: ProcessMeetingTask, taskId: string): Promise<EnqueueResult>;
}
