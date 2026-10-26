import { z } from 'zod';

export const SUMMARY_EVENT = 'meeting.summarized';

/** Webhooks V2 body: `{ event, timestamp, meeting_id, client_reference_id?, reprocessed_at? }`. */
export const webhookPayloadSchema = z
  .object({
    event: z.string().min(1).max(100),
    timestamp: z.number().int().nonnegative(),
    meeting_id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/, 'unexpected meeting_id format'),
    client_reference_id: z.string().max(512).nullable().optional(),
    /** Present only on resends after the meeting's notes changed. */
    reprocessed_at: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
