import { FieldValue, Firestore, Timestamp, type DocumentReference } from '@google-cloud/firestore';
import { meetingKey } from '../ids.js';
import { TERMINAL_STATUSES, type LeaseResult, type MeetingPatch, type MeetingRecord, type OAuthStateRecord, type RegisterResult, type StateStore } from './types.js';

/**
 * Firestore-backed durable state. Every state transition runs in a transaction,
 * so concurrent webhook deliveries and concurrent Cloud Tasks attempts on
 * different instances serialize on the meeting document.
 *
 * Collections: `<prefix>meetings/{sha256(meetingId)}`, `<prefix>oauth_states/{sha256(state)}`.
 * OAuth state documents carry `expireAt` (a Timestamp) for an optional TTL policy.
 */
export class FirestoreStateStore implements StateStore {
  private readonly db: Firestore;

  constructor(opts: { projectId: string; databaseId: string; collectionPrefix: string }) {
    this.db = new Firestore({ projectId: opts.projectId, databaseId: opts.databaseId, ignoreUndefinedProperties: true });
    this.meetingsCol = `${opts.collectionPrefix}meetings`;
    this.statesCol = `${opts.collectionPrefix}oauth_states`;
  }

  private readonly meetingsCol: string;
  private readonly statesCol: string;

  private meetingRef(meetingId: string): DocumentReference {
    return this.db.collection(this.meetingsCol).doc(meetingKey(meetingId));
  }

  async registerMeeting(meetingId: string, init: { webhookTimestamp: number }, now: number): Promise<RegisterResult> {
    const ref = this.meetingRef(meetingId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return { outcome: 'existing', record: snap.data() as MeetingRecord };
      const record: MeetingRecord = {
        meetingId,
        status: 'queued',
        attempts: 0,
        enqueueGeneration: 0,
        webhookTimestamp: init.webhookTimestamp,
        createdAt: now,
        updatedAt: now,
      };
      tx.create(ref, record);
      return { outcome: 'created', record };
    });
  }

  async markEnqueued(meetingId: string, taskName: string, now: number): Promise<void> {
    await this.meetingRef(meetingId).update({ taskName, updatedAt: now });
  }

  async acquireLease(meetingId: string, owner: string, now: number, leaseMs: number): Promise<LeaseResult> {
    const ref = this.meetingRef(meetingId);
    return this.db.runTransaction(async (tx): Promise<LeaseResult> => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { outcome: 'missing' };
      const r = snap.data() as MeetingRecord;
      if (TERMINAL_STATUSES.has(r.status)) return { outcome: 'terminal', record: r };
      if (r.status === 'processing' && r.leaseOwner && r.leaseOwner !== owner && (r.leaseExpiresAt ?? 0) > now) {
        return { outcome: 'busy', record: r, retryAfterMs: (r.leaseExpiresAt ?? now) - now };
      }
      const patch = { status: 'processing' as const, leaseOwner: owner, leaseExpiresAt: now + leaseMs, attempts: r.attempts + 1, updatedAt: now };
      tx.update(ref, patch);
      return { outcome: 'acquired', record: { ...r, ...patch } };
    });
  }

  async updateWithLease(meetingId: string, owner: string, patch: MeetingPatch, now: number): Promise<boolean> {
    const ref = this.meetingRef(meetingId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || (snap.data() as MeetingRecord).leaseOwner !== owner) return false;
      tx.update(ref, toUpdate({ ...patch, updatedAt: now }));
      return true;
    });
  }

  async resetForReplay(meetingId: string, now: number): Promise<MeetingRecord> {
    const ref = this.meetingRef(meetingId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('meeting record not found');
      const r = snap.data() as MeetingRecord;
      const patch: MeetingPatch = {
        status: 'queued',
        statusReason: 'operator_replay',
        enqueueGeneration: r.enqueueGeneration + 1,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
      };
      tx.update(ref, toUpdate(patch));
      return { ...r, ...patch } as MeetingRecord;
    });
  }

  async getMeeting(meetingId: string): Promise<MeetingRecord | undefined> {
    const snap = await this.meetingRef(meetingId).get();
    return snap.exists ? (snap.data() as MeetingRecord) : undefined;
  }

  async saveOAuthState(stateHash: string, record: OAuthStateRecord): Promise<void> {
    await this.db
      .collection(this.statesCol)
      .doc(stateHash)
      .create({ ...record, expireAt: Timestamp.fromMillis(record.expiresAt) });
  }

  async consumeOAuthState(stateHash: string): Promise<OAuthStateRecord | undefined> {
    const ref = this.db.collection(this.statesCol).doc(stateHash);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return undefined;
      tx.delete(ref);
      const d = snap.data() as OAuthStateRecord;
      return { nonceHash: d.nonceHash, createdAt: d.createdAt, expiresAt: d.expiresAt };
    });
  }
}

/** Firestore rejects `undefined`; an explicitly-undefined patch key means "delete the field". */
function toUpdate(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) out[k] = v === undefined ? FieldValue.delete() : v;
  return out;
}
