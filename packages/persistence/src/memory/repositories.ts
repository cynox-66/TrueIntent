/**
 * In-memory repositories.
 *
 * These back the fast, offline test suite. They are written to model the
 * database's *semantics* faithfully rather than to be convenient:
 *
 *  - Every state change is a compare-and-set that reports losing the race, so
 *    application code cannot be written against a read-then-write shape that
 *    the real store would not support.
 *  - Uniqueness is enforced eagerly and surfaces as a typed result, exactly as
 *    the Postgres constraint does.
 *  - Every mutating method performs its read and its write in one synchronous
 *    block, with no `await` in between. On a single-threaded event loop that
 *    makes the operation genuinely atomic with respect to other tasks in this
 *    process.
 *
 * The honest limit: that last property holds *within one process only*. It
 * proves the application logic has the right shape; it cannot prove the system
 * is safe across several API instances sharing a database. Only the Postgres
 * suite can, which is why the concurrency tests are duplicated there. See
 * ADR-010.
 */

import { CaptureLockError } from '@capturelock/core';
import type {
  AuthorizationId,
  AuthorizationRecord,
  AuthorizationRepository,
  AuthorizationState,
  EvaluationId,
  EvaluationRecord,
  EvaluationRepository,
  IdempotencyKey,
  InsertReleaseResult,
  Receipt,
  ReleaseId,
  ReleaseRecord,
  ReleaseRepository,
  ReleaseState,
  ReleaseTransitionPatch,
  ReviewId,
  ReviewRecord,
  ReviewRepository,
  ReviewState,
  SnapshotId,
  SnapshotRepository,
  Timestamp,
  VerifiedSnapshot,
  WebhookClaimResult,
  WebhookInboxRecord,
  WebhookInboxRepository,
  WebhookInboxStatus,
} from '@capturelock/core';
import {
  isTerminalReleaseState,
  isTransientReleaseState,
  requiresOperatorAttention,
  timestampToEpochMillis,
} from '@capturelock/core';

export class InMemoryAuthorizationRepository implements AuthorizationRepository {
  /** Exposed so InMemoryUnitOfWork can snapshot and restore it on rollback. */
  readonly rows = new Map<string, AuthorizationRecord>();

  async insert(record: AuthorizationRecord): Promise<void> {
    if (this.rows.has(record.authorizationId)) {
      throw new CaptureLockError('UNIQUE_VIOLATION', 'Authorization already exists');
    }
    this.rows.set(record.authorizationId, record);
  }

  async findById(id: AuthorizationId): Promise<AuthorizationRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async transition(
    id: AuthorizationId,
    from: readonly AuthorizationState[],
    to: AuthorizationState,
    patch: { consumedByReleaseId?: ReleaseId; revokedAt?: Timestamp },
  ): Promise<AuthorizationRecord | null> {
    const current = this.rows.get(id);
    if (current === undefined || !from.includes(current.state)) return null;
    const next: AuthorizationRecord = {
      ...current,
      state: to,
      consumedByReleaseId: patch.consumedByReleaseId ?? current.consumedByReleaseId,
      revokedAt: patch.revokedAt ?? current.revokedAt,
    };
    this.rows.set(id, next);
    return next;
  }
}

export class InMemorySnapshotRepository implements SnapshotRepository {
  readonly rows = new Map<string, VerifiedSnapshot>();

  async insert(snapshot: VerifiedSnapshot): Promise<void> {
    if (this.rows.has(snapshot.snapshotId)) {
      throw new CaptureLockError('UNIQUE_VIOLATION', 'Snapshot already exists');
    }
    this.rows.set(snapshot.snapshotId, snapshot);
  }

  async findById(id: SnapshotId): Promise<VerifiedSnapshot | null> {
    return this.rows.get(id) ?? null;
  }

  async claimForRelease(id: SnapshotId, releaseId: ReleaseId): Promise<VerifiedSnapshot | null> {
    const current = this.rows.get(id);
    if (current === undefined) return null;
    // Idempotent for the release that already owns it; refuses everyone else.
    if (current.redeemedByReleaseId !== null && current.redeemedByReleaseId !== releaseId) {
      return null;
    }
    const next: VerifiedSnapshot = {
      ...current,
      state: 'REDEEMED',
      redeemedByReleaseId: releaseId,
    };
    this.rows.set(id, next);
    return next;
  }
}

export class InMemoryReleaseRepository implements ReleaseRepository {
  readonly rows = new Map<string, ReleaseRecord>();
  readonly byIdempotencyKey = new Map<string, string>();
  readonly byReceipt = new Map<string, string>();

  async insert(record: ReleaseRecord): Promise<InsertReleaseResult> {
    const existingByKey = this.byIdempotencyKey.get(record.clientIdempotencyKey);
    if (existingByKey !== undefined) {
      return { kind: 'DUPLICATE_IDEMPOTENCY_KEY', existing: this.rows.get(existingByKey)! };
    }

    // Models the partial unique index on (authorization_id) WHERE state is
    // non-terminal: one authorization can fund at most one live release.
    for (const row of this.rows.values()) {
      if (row.authorizationId === record.authorizationId && !isTerminalReleaseState(row.state)) {
        return { kind: 'AUTHORIZATION_BUSY', existing: row };
      }
    }

    this.rows.set(record.releaseId, record);
    this.byIdempotencyKey.set(record.clientIdempotencyKey, record.releaseId);
    this.byReceipt.set(record.receipt, record.releaseId);
    return { kind: 'INSERTED', release: record };
  }

  async findById(id: ReleaseId): Promise<ReleaseRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findByClientIdempotencyKey(key: IdempotencyKey): Promise<ReleaseRecord | null> {
    const id = this.byIdempotencyKey.get(key);
    return id === undefined ? null : (this.rows.get(id) ?? null);
  }

  async findByReceipt(receipt: Receipt): Promise<ReleaseRecord | null> {
    const id = this.byReceipt.get(receipt);
    return id === undefined ? null : (this.rows.get(id) ?? null);
  }

  async findByProviderPaymentId(paymentId: string): Promise<ReleaseRecord | null> {
    for (const row of this.rows.values()) {
      if (row.providerPaymentId === paymentId) return row;
    }
    return null;
  }

  async findByProviderOrderId(orderId: string): Promise<ReleaseRecord | null> {
    for (const row of this.rows.values()) {
      if (row.providerOrderId === orderId) return row;
    }
    return null;
  }

  async findActiveByAuthorization(id: AuthorizationId): Promise<ReleaseRecord | null> {
    for (const row of this.rows.values()) {
      if (row.authorizationId === id && !isTerminalReleaseState(row.state)) return row;
    }
    return null;
  }

  async transition(
    id: ReleaseId,
    from: readonly ReleaseState[],
    to: ReleaseState,
    patch: ReleaseTransitionPatch,
    at: Timestamp,
  ): Promise<ReleaseRecord | null> {
    // Read and write happen together with no interleaving point, mirroring
    // `UPDATE ... WHERE id = $1 AND state = ANY($2) RETURNING *`.
    const current = this.rows.get(id);
    if (current === undefined || !from.includes(current.state)) return null;

    const next: ReleaseRecord = {
      ...current,
      state: to,
      providerOrderId:
        patch.providerOrderId === undefined ? current.providerOrderId : patch.providerOrderId,
      providerPaymentId:
        patch.providerPaymentId === undefined ? current.providerPaymentId : patch.providerPaymentId,
      inFlightSince:
        patch.inFlightSince === undefined ? current.inFlightSince : patch.inFlightSince,
      attemptCount:
        patch.incrementAttempt === true ? current.attemptCount + 1 : current.attemptCount,
      lastReasonCodes: patch.lastReasonCodes ?? current.lastReasonCodes,
      updatedAt: at,
    };
    this.rows.set(id, next);
    return next;
  }

  async findRequiringReconciliation(
    olderThan: Timestamp,
    limit: number,
  ): Promise<readonly ReleaseRecord[]> {
    const cutoff = timestampToEpochMillis(olderThan);
    const out: ReleaseRecord[] = [];
    for (const row of this.rows.values()) {
      if (row.inFlightSince === null) continue;
      if (timestampToEpochMillis(row.inFlightSince) > cutoff) continue;
      if (
        row.state === 'ORDER_IN_FLIGHT' ||
        row.state === 'ORDER_INDETERMINATE' ||
        row.state === 'CAPTURE_IN_FLIGHT' ||
        row.state === 'CAPTURE_INDETERMINATE'
      ) {
        out.push(row);
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  async findAbandonedInTransientState(
    olderThan: Timestamp,
    limit: number,
  ): Promise<readonly ReleaseRecord[]> {
    const cutoff = timestampToEpochMillis(olderThan);
    const out: ReleaseRecord[] = [];
    for (const row of this.rows.values()) {
      if (!isTransientReleaseState(row.state)) continue;
      if (timestampToEpochMillis(row.updatedAt) > cutoff) continue;
      out.push(row);
      if (out.length >= limit) break;
    }
    return out;
  }

  async listRequiringOperatorAttention(limit: number): Promise<readonly ReleaseRecord[]> {
    // Sorted before slicing, not while iterating: taking the first `limit`
    // rows in insertion order and then sorting them would return a different
    // set than the Postgres query, which orders the whole table first.
    return [...this.rows.values()]
      .filter(row => requiresOperatorAttention(row.state))
      .sort(
        (a, b) =>
          timestampToEpochMillis(a.updatedAt) - timestampToEpochMillis(b.updatedAt) ||
          a.releaseId.localeCompare(b.releaseId),
      )
      .slice(0, limit);
  }

  /** Test helper: total releases, used to assert that no duplicate was created. */
  count(): number {
    return this.rows.size;
  }

  all(): readonly ReleaseRecord[] {
    return [...this.rows.values()];
  }
}

export class InMemoryEvaluationRepository implements EvaluationRepository {
  readonly rows = new Map<string, EvaluationRecord>();

  async append(record: EvaluationRecord): Promise<void> {
    if (this.rows.has(record.evaluationId)) {
      throw new CaptureLockError('UNIQUE_VIOLATION', 'Evaluation already recorded');
    }
    this.rows.set(record.evaluationId, record);
  }

  async findById(id: EvaluationId): Promise<EvaluationRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async listByRelease(id: ReleaseId): Promise<readonly EvaluationRecord[]> {
    return [...this.rows.values()].filter(row => row.releaseId === id);
  }

  count(): number {
    return this.rows.size;
  }
}

export class InMemoryWebhookInboxRepository implements WebhookInboxRepository {
  readonly rows = new Map<string, WebhookInboxRecord>();

  async claim(record: WebhookInboxRecord): Promise<WebhookClaimResult> {
    // The unique constraint is the deduplication mechanism, not a prior lookup.
    // Under concurrent delivery of the same event exactly one caller is told
    // CLAIMED; every other is told DUPLICATE.
    const existing = this.rows.get(record.providerEventId);
    if (existing !== undefined) {
      return { kind: 'DUPLICATE', existing };
    }
    this.rows.set(record.providerEventId, record);
    return { kind: 'CLAIMED', record };
  }

  async markProcessed(
    providerEventId: string,
    status: WebhookInboxStatus,
    at: Timestamp,
    releaseId: ReleaseId | null,
  ): Promise<void> {
    const current = this.rows.get(providerEventId);
    if (current === undefined) return;
    this.rows.set(providerEventId, { ...current, status, processedAt: at, releaseId });
  }

  async findByEventId(providerEventId: string): Promise<WebhookInboxRecord | null> {
    return this.rows.get(providerEventId) ?? null;
  }

  count(): number {
    return this.rows.size;
  }
}

export class InMemoryReviewRepository implements ReviewRepository {
  readonly rows = new Map<string, ReviewRecord>();

  async insert(record: ReviewRecord): Promise<void> {
    // Models `reviews_one_open_per_release`, the partial unique index on
    // (release_id) WHERE state = 'OPEN'. Postgres raises on the second open
    // review for a release, and a fake that accepted it would let a test
    // exercise a state the production store cannot hold — the operator queue
    // would show two live decisions for one release, and resolving either would
    // leave the other dangling. Found by the Postgres parity suite.
    if (record.state === 'OPEN') {
      for (const row of this.rows.values()) {
        if (row.releaseId === record.releaseId && row.state === 'OPEN') {
          throw new Error(
            `duplicate key value violates unique constraint "reviews_one_open_per_release"`,
          );
        }
      }
    }
    this.rows.set(record.reviewId, record);
  }

  async findById(id: ReviewId): Promise<ReviewRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findOpenByRelease(id: ReleaseId): Promise<ReviewRecord | null> {
    for (const row of this.rows.values()) {
      if (row.releaseId === id && row.state === 'OPEN') return row;
    }
    return null;
  }

  async listOpen(limit: number): Promise<readonly ReviewRecord[]> {
    return [...this.rows.values()]
      .filter(row => row.state === 'OPEN')
      .sort(
        (a, b) =>
          timestampToEpochMillis(a.createdAt) - timestampToEpochMillis(b.createdAt) ||
          a.reviewId.localeCompare(b.reviewId),
      )
      .slice(0, limit);
  }

  async resolve(
    id: ReviewId,
    to: Exclude<ReviewState, 'OPEN'>,
    resolvedBy: string,
    at: Timestamp,
  ): Promise<ReviewRecord | null> {
    const current = this.rows.get(id);
    if (current === undefined || current.state !== 'OPEN') return null;
    const next: ReviewRecord = { ...current, state: to, resolvedBy, resolvedAt: at };
    this.rows.set(id, next);
    return next;
  }
}
