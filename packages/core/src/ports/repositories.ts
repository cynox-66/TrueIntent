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
import type { Money } from '../money.js';
import type {
  AuthorizationId,
  EvaluationId,
  IdempotencyKey,
  Receipt,
  ReleaseId,
  ReviewId,
  SessionId,
  SnapshotId,
  UserId,
} from '../ids.js';
import type { AuthorizationRecord, AuthorizationState } from '../domain/intent.js';
import type {
  SessionAuthorityRecord,
  SessionAuthorityState,
  SessionPurchaseRecord,
} from '../domain/session.js';
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
   * Every release for an authorization, newest first, terminal ones included.
   *
   * Distinct from `findActiveByAuthorization` on purpose. That query answers
   * "is this mandate busy?" and deliberately excludes terminal states. A
   * read surface that used it to *describe* a purchase would show nothing for
   * the refused ones — which are the cases most worth showing.
   */
  listByAuthorization(id: AuthorizationId, limit: number): Promise<readonly ReleaseRecord[]>;
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
  /**
   * The APPROVED review for a release that is bound to `boundTo`, if any.
   *
   * The kernel reads this so an operator's approval can actually clear the
   * findings it covers. Without it, re-verification after an approval
   * reproduces the same PAUSE and the review loop never terminates.
   *
   * Selected by binding rather than by recency, and that is the security-
   * relevant part. A release can pause more than once — at the order gate, and
   * again at the capture gate — and the binding names the gate as well as the
   * cart. Returning "the latest approval" meant handing the kernel an approval
   * for a *different* request and letting it discover the mismatch, which in
   * practice returned the order-gate approval to the capture gate and left a
   * genuine capture-gate approval unusable. Asking the question the kernel
   * actually has ("is there an approval for THIS request?") cannot do that.
   *
   * The kernel re-checks the binding itself. This is not redundant: a
   * security property that rests on a caller's query being written correctly is
   * one refactor away from being lost.
   */
  findApprovedByReleaseAndBinding(id: ReleaseId, boundTo: Sha256Hex): Promise<ReviewRecord | null>;
  /** CAS from OPEN to a resolution. Returns null if already resolved. */
  resolve(
    id: ReviewId,
    to: Exclude<ReviewState, 'OPEN'>,
    resolvedBy: string,
    at: Timestamp,
  ): Promise<ReviewRecord | null>;
}

/**
 * The outcome of committing budget to a purchase attempt.
 *
 * Refusal is a typed result rather than a throw because it is an ordinary
 * answer, not a fault: an agent working through a session will legitimately run
 * out of budget, and that has to be reportable without an exception path that
 * something upstream might catch permissively.
 */
export type ReserveBudgetResult =
  | { readonly kind: 'RESERVED'; readonly session: SessionAuthorityRecord }
  /** The predicate failed. `reason` says which part of it. */
  | {
      readonly kind: 'REFUSED';
      readonly reason: 'BUDGET_EXCEEDED' | 'NOT_ACTIVE' | 'EXPIRED' | 'NOT_FOUND';
    };

export type RecordPurchaseResult =
  | { readonly kind: 'RECORDED'; readonly purchase: SessionPurchaseRecord }
  /**
   * This (session, purchaseRequestId) already exists.
   *
   * Returned rather than thrown because it is the retry path: the caller hands
   * back the existing authorization instead of minting a second mandate.
   */
  | { readonly kind: 'DUPLICATE_REQUEST'; readonly existing: SessionPurchaseRecord };

export interface SessionAuthorityRepository {
  insert(record: SessionAuthorityRecord): Promise<void>;
  findById(id: SessionId): Promise<SessionAuthorityRecord | null>;
  listByUser(userId: UserId, limit: number): Promise<readonly SessionAuthorityRecord[]>;

  /**
   * Commits `amount` of the session's budget, atomically.
   *
   * One statement, whose WHERE clause carries the entire safety predicate:
   * active, unexpired, and `reserved + spent + amount <= totalBudget`. Two
   * concurrent purchase requests cannot both succeed against the same remaining
   * budget, because the row lock serializes the updates and the second one
   * re-evaluates the predicate against the first one's write.
   *
   * This is deliberately not `findById` followed by a check: that shape is
   * readable and wrong, and it is the exact race the aggregate budget exists to
   * close.
   */
  reserve(id: SessionId, amount: Money, at: Timestamp): Promise<ReserveBudgetResult>;

  /** Records a purchase attempt's hold. Duplicate (session, request) is a typed result. */
  recordPurchase(record: SessionPurchaseRecord): Promise<RecordPurchaseResult>;

  findPurchaseByAuthorization(id: AuthorizationId): Promise<SessionPurchaseRecord | null>;
  findPurchaseByRequestId(
    id: SessionId,
    purchaseRequestId: Sha256Hex,
  ): Promise<SessionPurchaseRecord | null>;
  listPurchasesBySession(id: SessionId, limit: number): Promise<readonly SessionPurchaseRecord[]>;

  /**
   * Converts a hold into confirmed spend. CAS from RESERVED; null if already resolved.
   *
   * Exactly-once is the purchase row's compare-and-set, not an application
   * check: money that moved must be counted once even if the caller is retried
   * or two sweepers race.
   */
  settlePurchase(id: AuthorizationId, at: Timestamp): Promise<SessionPurchaseRecord | null>;

  /** Frees a hold whose purchase did not move money. CAS from RESERVED. */
  releasePurchase(id: AuthorizationId, at: Timestamp): Promise<SessionPurchaseRecord | null>;

  /** Holds still unresolved after `olderThan`, for the reconciling sweep. */
  findUnsettledPurchases(
    olderThan: Timestamp,
    limit: number,
  ): Promise<readonly SessionPurchaseRecord[]>;

  /** CAS on session state. Returns null when the session was not in `from`. */
  transition(
    id: SessionId,
    from: readonly SessionAuthorityState[],
    to: SessionAuthorityState,
    patch: { readonly revokedAt?: Timestamp },
  ): Promise<SessionAuthorityRecord | null>;
}
