export type MeetingStatus =
  | 'queued' // webhook accepted, task enqueued
  | 'processing' // a worker holds the lease
  | 'sent' // recap posted (terminal)
  | 'skipped' // not eligible / nothing to send (terminal)
  | 'failed'; // permanent failure or retries exhausted (terminal)

export const TERMINAL_STATUSES: ReadonlySet<MeetingStatus> = new Set(['sent', 'skipped', 'failed']);

export interface MeetingRecord {
  meetingId: string;
  status: MeetingStatus;
  statusReason?: string;
  /** Number of processing attempts that acquired the lease. */
  attempts: number;
  enqueueGeneration: number;
  taskName?: string;
  leaseOwner?: string;
  leaseExpiresAt?: number;
  /**
   * Set immediately before the Chat API call. If present while status is not
   * `sent`, a previous attempt may have posted the message (ambiguous result),
   * so the retry must reuse the same chatRequestId / chatMessageId.
   */
  sendStartedAt?: number;
  chatRequestId?: string;
  chatMessageId?: string;
  chatMessageName?: string;
  matchedRule?: string;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  webhookTimestamp?: number;
  createdAt: number;
  updatedAt: number;
}

export type RegisterResult = { outcome: 'created' | 'existing'; record: MeetingRecord };

export type LeaseResult =
  | { outcome: 'acquired'; record: MeetingRecord }
  | { outcome: 'terminal'; record: MeetingRecord }
  | { outcome: 'busy'; record: MeetingRecord; retryAfterMs: number }
  | { outcome: 'missing' };

export type MeetingPatch = Partial<Omit<MeetingRecord, 'meetingId' | 'createdAt'>>;

export interface OAuthStateRecord {
  /** sha256 of the browser-binding nonce stored in an HttpOnly cookie. */
  nonceHash: string;
  createdAt: number;
  expiresAt: number;
}

export interface StateStore {
  /** Atomically create the meeting record if absent. */
  registerMeeting(meetingId: string, init: { webhookTimestamp: number }, now: number): Promise<RegisterResult>;
  markEnqueued(meetingId: string, taskName: string, now: number): Promise<void>;
  /** Atomically take the processing lease unless the record is terminal or leased by someone else. */
  acquireLease(meetingId: string, owner: string, now: number, leaseMs: number): Promise<LeaseResult>;
  /** Apply a patch only if `owner` still holds the lease. Returns false if the lease was lost. */
  updateWithLease(meetingId: string, owner: string, patch: MeetingPatch, now: number): Promise<boolean>;
  /** Operator replay: reset a record so it can be processed again. */
  resetForReplay(meetingId: string, now: number): Promise<MeetingRecord>;
  getMeeting(meetingId: string): Promise<MeetingRecord | undefined>;

  saveOAuthState(stateHash: string, record: OAuthStateRecord): Promise<void>;
  /** Atomically read and delete (single use). */
  consumeOAuthState(stateHash: string): Promise<OAuthStateRecord | undefined>;
}
