/**
 * Persistence ports.
 *
 * Two shapes recur and both are deliberate:
 *
 * - Every state change is a **compare-and-set**: the caller states which states
 *   it is willing to move from, and the store either performs the move or
 *   reports that it lost the race. Read-then-write is never offered, because
 *   under concurrency it is exactly how a payment gets captured twice.
 * - Uniqueness violations surface as typed results, not exceptions to be
 *   pattern-matched on driver error strings. The database constraint is the
 *   real guarantee; the application code just has to notice it.
 */

import type { Sha256Hex } from '../canonical.js';
import type { Timestamp } from '../time.js';
import type {
  AuthorizationId,
  EvaluationId,
  IdempotencyKey,
  Receipt,
  ReleaseId,
  ReviewId,
  SnapshotId,
} from '../ids.js';
import type { AuthorizationRecord, AuthorizationState } from '../domain/intent.js';
import type { VerifiedSnapshot } from '../domain/snapshot.js';
import type { ReleaseRecord, ReleaseState } from '../domain/release.js';
import type { Gate, VerificationDecision } from '../domain/decision.js';

export interface AuthorizationRepository {
  insert(record: AuthorizationRecord): Promise<void>;
  findById(id: AuthorizationId): Promise<AuthorizationRecord | null>;
  /** CAS on state. Returns null when the authorization was not in `from`. */
  transition(
    id: AuthorizationId,
    from: readonly AuthorizationState[],
    to: AuthorizationState,
    patch: { readonly consumedByReleaseId?: ReleaseId; readonly revokedAt?: Timestamp },
  ): Promise<AuthorizationRecord | null>;
}

export interface SnapshotRepository {
  insert(snapshot: VerifiedSnapshot): Promise<void>;
  findById(id: SnapshotId): Promise<VerifiedSnapshot | null>;
  /**
   * Claims a snapshot for one release.
   *
   * Returns null if another release already claimed it, which is what stops the
   * same verified quote being paid twice under two different idempotency keys.
   */
  claimForRelease(id: SnapshotId, releaseId: ReleaseId): Promise<VerifiedSnapshot | null>;
}

export type InsertReleaseResult =
  | { readonly kind: 'INSERTED'; readonly release: ReleaseRecord }
  /** A release already exists for this client idempotency key. */
  | { readonly kind: 'DUPLICATE_IDEMPOTENCY_KEY'; readonly existing: ReleaseRecord }
  /** A non-terminal release already exists for this authorization. */
  | { readonly kind: 'AUTHORIZATION_BUSY'; readonly existing: ReleaseRecord };

export interface ReleaseTransitionPatch {
  readonly providerOrderId?: string | null;
  readonly providerPaymentId?: string | null;
  readonly inFlightSince?: Timestamp | null;
  readonly incrementAttempt?: boolean;
  readonly lastReasonCodes?: readonly string[];
}

export interface ReleaseRepository {
  insert(record: ReleaseRecord): Promise<InsertReleaseResult>;
  findById(id: ReleaseId): Promise<ReleaseRecord | null>;
  findByClientIdempotencyKey(key: IdempotencyKey): Promise<ReleaseRecord | null>;
  findByReceipt(receipt: Receipt): Promise<ReleaseRecord | null>;
  /**
   * Correlation for incoming webhooks.
   *
   * Both identifiers were recorded by us when we made the provider call, so a
   * webhook can only ever address a release we already created. It cannot
   * introduce one.
   */
  findByProviderPaymentId(paymentId: string): Promise<ReleaseRecord | null>;
  findByProviderOrderId(orderId: string): Promise<ReleaseRecord | null>;
  /** Non-terminal release for an authorization, if any. */
  findActiveByAuthorization(id: AuthorizationId): Promise<ReleaseRecord | null>;
  /**
   * Atomic compare-and-set. Returns null when the row was not in `from`,
   * which the caller must treat as "another actor got there first".
   */
  transition(
    id: ReleaseId,
    from: readonly ReleaseState[],
    to: ReleaseState,
    patch: ReleaseTransitionPatch,
    at: Timestamp,
  ): Promise<ReleaseRecord | null>;
  /** Releases stuck mid-provider-call, for the reconciliation sweep. */
  findRequiringReconciliation(
    olderThan: Timestamp,
    limit: number,
  ): Promise<readonly ReleaseRecord[]>;
  /**
   * Releases abandoned in a transient state, for the liveness sweep.
   *
   * These never reached the provider, but each holds its authorization's only
   * active-release slot. Without this query a crash during verification would
   * brick the mandate permanently. See ADR-011.
   */
  findAbandonedInTransientState(
    olderThan: Timestamp,
    limit: number,
  ): Promise<readonly ReleaseRecord[]>;
  /**
   * Releases waiting on a human, for the operator queue.
   *
   * Distinct from `findRequiringReconciliation` on purpose. That query is the
   * reconciliation sweeper's: time-based, and it excludes `PAUSED` because a
   * paused release is not stuck. This one answers the operator's question —
   * "what needs me?" — which is `PAUSED` plus every state where the provider's
   * truth is still unknown, with no age threshold, because an operator looking
   * at the queue wants to see a release the moment it arrives.
   *
   * Ordered oldest-first by `updatedAt`, with `releaseId` breaking ties so the
   * order is total and a page boundary cannot drop or repeat a row.
   */
  listRequiringOperatorAttention(limit: number): Promise<readonly ReleaseRecord[]>;
}

export interface EvaluationRecord {
  readonly evaluationId: EvaluationId;
  readonly authorizationId: AuthorizationId;
  readonly releaseId: ReleaseId | null;
  readonly gate: Gate;
  readonly decision: VerificationDecision;
  readonly contextHash: Sha256Hex;
  readonly decisionHash: Sha256Hex;
  readonly evaluatedAt: Timestamp;
}

/** Append-only: there is no update or delete, by design and by database trigger. */
export interface EvaluationRepository {
  append(record: EvaluationRecord): Promise<void>;
  findById(id: EvaluationId): Promise<EvaluationRecord | null>;
  listByRelease(id: ReleaseId): Promise<readonly EvaluationRecord[]>;
}

export type WebhookInboxStatus =
  'RECEIVED' | 'PROCESSED' | 'IGNORED_DUPLICATE' | 'IGNORED_UNKNOWN' | 'FAILED';

export interface WebhookInboxRecord {
  readonly providerEventId: string;
  readonly eventType: string;
  readonly payloadHash: Sha256Hex;
  readonly payload: unknown;
  readonly signatureValid: boolean;
  readonly receivedAt: Timestamp;
  readonly processedAt: Timestamp | null;
  readonly status: WebhookInboxStatus;
  readonly releaseId: ReleaseId | null;
  /** Provider-stated event time, used to detect out-of-order delivery. */
  readonly providerEventAt: Timestamp | null;
}

export type WebhookClaimResult =
  | { readonly kind: 'CLAIMED'; readonly record: WebhookInboxRecord }
  /** The unique constraint on provider event id rejected the insert. */
  | { readonly kind: 'DUPLICATE'; readonly existing: WebhookInboxRecord };

export interface WebhookInboxRepository {
  /**
   * Attempts to claim an event id for processing.
   *
   * Deduplication is the database's `UNIQUE(provider_event_id)` constraint, not
   * a prior `SELECT`. Under concurrent delivery of the same event only one
   * caller can be told CLAIMED.
   */
  claim(record: WebhookInboxRecord): Promise<WebhookClaimResult>;
  markProcessed(
    providerEventId: string,
    status: WebhookInboxStatus,
    at: Timestamp,
    releaseId: ReleaseId | null,
  ): Promise<void>;
  findByEventId(providerEventId: string): Promise<WebhookInboxRecord | null>;
}

export type ReviewState = 'OPEN' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export interface ReviewRecord {
  readonly reviewId: ReviewId;
  readonly releaseId: ReleaseId;
  readonly authorizationId: AuthorizationId;
  /**
   * The snapshot this review is bound to.
   *
   * An approval authorizes *this exact cart*. Re-quoting after approval
   * produces a different hash and requires a new review, which is what stops an
   * approval being reused for a cart the reviewer never saw.
   */
  readonly snapshotHash: Sha256Hex;
  readonly reasonCodes: readonly string[];
  readonly state: ReviewState;
  readonly createdAt: Timestamp;
  readonly resolvedAt: Timestamp | null;
  readonly resolvedBy: string | null;
}

export interface ReviewRepository {
  insert(record: ReviewRecord): Promise<void>;
  findById(id: ReviewId): Promise<ReviewRecord | null>;
  findOpenByRelease(id: ReleaseId): Promise<ReviewRecord | null>;
  /**
   * Every unresolved review, oldest first.
   *
   * Only `OPEN`. A resolved review is history, not work, and the operator queue
   * must not invite anyone to decide something already decided — `resolve` is a
   * CAS from `OPEN`, so a second resolution would fail anyway, but showing it
   * would be a lie about the state of the world.
   */
  listOpen(limit: number): Promise<readonly ReviewRecord[]>;
  /** CAS from OPEN to a resolution. Returns null if already resolved. */
  resolve(
    id: ReviewId,
    to: Exclude<ReviewState, 'OPEN'>,
    resolvedBy: string,
    at: Timestamp,
  ): Promise<ReviewRecord | null>;
}
