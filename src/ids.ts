import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Firestore-safe, fixed-length document id for a Fireflies meeting. */
export function meetingKey(meetingId: string): string {
  return sha256Hex(`fireflies-meeting:${meetingId}`);
}

/**
 * Deterministic Google Chat custom message id. Rules (spaces.messages.create):
 * starts with `client-`, at most 63 chars, lowercase letters, digits, hyphens.
 */
export function chatMessageId(meetingId: string): string {
  return `client-ff-${sha256Hex(`chat-message:${meetingId}`).slice(0, 48)}`;
}

/**
 * Deterministic Chat `requestId`. Google documents that repeating a create
 * request with the same requestId returns the existing message instead of
 * posting again, which makes retries after an ambiguous send safe.
 */
export function chatRequestId(space: string, meetingId: string): string {
  const h = sha256Hex(`chat-request:${space}:${meetingId}`);
  // UUID-shaped, as Google recommends a UUID for requestId.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Deterministic Cloud Tasks task id, so duplicate webhooks cannot enqueue twice. */
export function taskId(meetingId: string, generation = 0): string {
  const suffix = generation > 0 ? `-r${generation}` : '';
  return `ff-${sha256Hex(`task:${meetingId}`).slice(0, 40)}${suffix}`;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison that does not leak length via early exit. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
