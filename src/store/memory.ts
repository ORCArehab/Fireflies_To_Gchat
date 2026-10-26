import { TERMINAL_STATUSES, type LeaseResult, type MeetingPatch, type MeetingRecord, type OAuthStateRecord, type RegisterResult, type StateStore } from './types.js';

/**
 * In-process store for local mode and tests. Each method runs without awaiting
 * in between, so it is atomic within a single Node.js process. NOT durable.
 */
export class MemoryStateStore implements StateStore {
  readonly meetings = new Map<string, MeetingRecord>();
  readonly oauthStates = new Map<string, OAuthStateRecord>();

  async registerMeeting(meetingId: string, init: { webhookTimestamp: number }, now: number): Promise<RegisterResult> {
    const existing = this.meetings.get(meetingId);
    if (existing) return { outcome: 'existing', record: { ...existing } };
    const record: MeetingRecord = {
      meetingId,
      status: 'queued',
      attempts: 0,
      enqueueGeneration: 0,
      webhookTimestamp: init.webhookTimestamp,
      createdAt: now,
      updatedAt: now,
    };
    this.meetings.set(meetingId, record);
    return { outcome: 'created', record: { ...record } };
  }

  async markEnqueued(meetingId: string, taskName: string, now: number): Promise<void> {
    const r = this.meetings.get(meetingId);
    if (r) this.meetings.set(meetingId, { ...r, taskName, updatedAt: now });
  }

  async acquireLease(meetingId: string, owner: string, now: number, leaseMs: number): Promise<LeaseResult> {
    const r = this.meetings.get(meetingId);
    if (!r) return { outcome: 'missing' };
    if (TERMINAL_STATUSES.has(r.status)) return { outcome: 'terminal', record: { ...r } };
    if (r.status === 'processing' && r.leaseOwner && r.leaseOwner !== owner && (r.leaseExpiresAt ?? 0) > now) {
      return { outcome: 'busy', record: { ...r }, retryAfterMs: (r.leaseExpiresAt ?? now) - now };
    }
    const next: MeetingRecord = {
      ...r,
      status: 'processing',
      leaseOwner: owner,
      leaseExpiresAt: now + leaseMs,
      attempts: r.attempts + 1,
      updatedAt: now,
    };
    this.meetings.set(meetingId, next);
    return { outcome: 'acquired', record: { ...next } };
  }

  async updateWithLease(meetingId: string, owner: string, patch: MeetingPatch, now: number): Promise<boolean> {
    const r = this.meetings.get(meetingId);
    if (!r || r.leaseOwner !== owner) return false;
    this.meetings.set(meetingId, { ...r, ...patch, updatedAt: now });
    return true;
  }

  async resetForReplay(meetingId: string, now: number): Promise<MeetingRecord> {
    const r = this.meetings.get(meetingId);
    if (!r) throw new Error('meeting record not found');
    const next: MeetingRecord = {
      ...r,
      status: 'queued',
      statusReason: 'operator_replay',
      enqueueGeneration: r.enqueueGeneration + 1,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    };
    this.meetings.set(meetingId, next);
    return { ...next };
  }

  async getMeeting(meetingId: string): Promise<MeetingRecord | undefined> {
    const r = this.meetings.get(meetingId);
    return r ? { ...r } : undefined;
  }

  async saveOAuthState(stateHash: string, record: OAuthStateRecord): Promise<void> {
    this.oauthStates.set(stateHash, { ...record });
  }

  async consumeOAuthState(stateHash: string): Promise<OAuthStateRecord | undefined> {
    const r = this.oauthStates.get(stateHash);
    this.oauthStates.delete(stateHash);
    return r;
  }
}
