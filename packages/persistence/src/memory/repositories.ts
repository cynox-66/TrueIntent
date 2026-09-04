/**
 * In-memory repositories.
 *
 * These back the fast, offline test suite. They are written to model the
 * database's *semantics* faithfully rather than to be convenient:
 *
 *  - Every state change is a compare-and-set that reports losing the race, so
 *    application code cannot be written against a read-then-write shape that
 *    the real store would not support.
 *  - Uniqueness is enforced eagerly, on every constraint the schema declares,
 *    and surfaces the way the Postgres one does: as a typed result where the
 *    caller has a branch for it, and as a throw where it does not.
 *  - Ordering matches the SQL, including under a limit. A store that filtered
 *    in insertion order and then truncated would hand a sweeper a *different
 *    set of work* from the one production would pick up.
 *  - Every mutating method performs its read and its write in one synchronous
 *    block, with no `await` in between. On a single-threaded event loop that
 *    makes the operation genuinely atomic with respect to other tasks in this
 *    process.
 *
 * Each uniqueness check below names the Postgres constraint it stands in for.
 * That naming is not decoration: `parity.db.test.ts` runs the same sequences
 * against both stores and compares the constraint that fired, so a constraint
 * renamed in SQL and not here fails the build.
 *
 * Deliberately NOT modelled, because reimplementing a relational store inside a
 * test double costs more than it proves: foreign keys between tables, and the
 * CHECK constraints the type system already covers. Every production write goes
 * through a service that has resolved its parent row first, and the parity
 * suite asserts those Postgres-only refusals directly so the boundary is
 * explicit rather than assumed.
 *
 * The honest limit: atomicity here holds *within one process only*. It proves
 * the application logic has the right shape; it cannot prove the system is safe
 * across several API instances sharing a database. Only the Postgres suite can,
 * which is why the concurrency tests are duplicated there. See ADR-010.
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
  Sha256Hex,
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

/**
 * The refusal a unique index produces, carrying which index it was.
 *
 * `constraint` holds the Postgres constraint name so a caller — and the parity
 * suite — can tell one uniqueness rule from another. `pg` reports the same
 * value on its own error object, which is what makes the two comparable.
 */
function uniqueViolation(constraint: string, detail: string): CaptureLockError {
  return new CaptureLockError(
    'UNIQUE_VIOLATION',
    `duplicate key value violates unique constraint "${constraint}": ${detail}`,
    { constraint },
  );
}

export class InMemoryAuthorizationRepository implements AuthorizationRepository {
  /** Exposed so InMemoryUnitOfWork can snapshot and restore it on rollback. */
  readonly rows = new Map<string, AuthorizationRecord>();

  async insert(record: AuthorizationRecord): Promise<void> {
    if (this.rows.has(record.authorizationId)) {
      throw uniqueViolation('authorizations_pkey', record.authorizationId);
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
      throw uniqueViolation('verified_snapshots_pkey', snapshot.snapshotId);
    }
    // `snapshot_hash` is UNIQUE in the schema: it is the content address of a
    // priced cart, so two rows sharing one would be two snapshots claiming to
    // be the same quote — and the snapshot stage compares that hash to decide
    // whether the cart it is verifying is the one the server issued.
    for (const row of this.rows.values()) {
      if (row.snapshotHash === snapshot.snapshotHash) {
        throw uniqueViolation('verified_snapshots_snapshot_hash_key', snapshot.snapshotHash);
      }
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

  /**
   * Insert, with every constraint the `releases` table declares.
   *
   * Two of them have a typed result because the caller has a branch for them
   * and reports a distinct reason code; the rest throw, which is exactly what
   * the Postgres implementation does — it catches the unique violation, checks
   * for those two cases, and rethrows anything else.
   *
   * The precedence matters and is asserted by the parity suite: when a request
   * both reuses an idempotency key and targets a busy authorization, the caller
   * must be told about the key, because "you already asked me this" and "that
   * mandate is already being spent" send an agent to different places.
   */
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

    if (this.rows.has(record.releaseId)) {
      throw uniqueViolation('releases_pkey', record.releaseId);
    }
    // The receipt is derived from (authorization, snapshot hash) and is UNIQUE.
    // A duplicate means the same cart is about to be sent to the provider under
    // a second release — which is the thing the derivation exists to prevent,
    // so the store must refuse rather than quietly re-point its index.
    if (this.byReceipt.has(record.receipt)) {
      throw uniqueViolation('releases_receipt_key', record.receipt);
    }
    this.assertProviderIdsFree(record.releaseId, record.providerOrderId, record.providerPaymentId);

    this.rows.set(record.releaseId, record);
    this.byIdempotencyKey.set(record.clientIdempotencyKey, record.releaseId);
    this.byReceipt.set(record.receipt, record.releaseId);
    return { kind: 'INSERTED', release: record };
  }

  /**
   * `provider_order_id` and `provider_payment_id` are both UNIQUE.
   *
   * The payment one is the load-bearing constraint of the pair: it is what
   * makes "one release per payment" true. Without it a webhook naming a payment
   * already bound elsewhere could bind it a second time, and the capture gate
   * would later present that payment id to the provider with *this* release's
   * amount. The fake not modelling it meant no offline test could see that.
   */
  private assertProviderIdsFree(
    releaseId: string,
    orderId: string | null | undefined,
    paymentId: string | null | undefined,
  ): void {
    for (const row of this.rows.values()) {
      if (row.releaseId === releaseId) continue;
      if (orderId != null && row.providerOrderId === orderId) {
        throw uniqueViolation('releases_provider_order_id_key', orderId);
      }
      if (paymentId != null && row.providerPaymentId === paymentId) {
        throw uniqueViolation('releases_provider_payment_id_key', paymentId);
      }
    }
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

    // The unique indexes apply to an UPDATE exactly as they do to an INSERT.
    // Checked before the write so a refused transition leaves the row alone,
    // which is what the failed statement does.
    this.assertProviderIdsFree(id, patch.providerOrderId, patch.providerPaymentId);

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

  /**
   * Oldest in-flight first, then truncated — in that order.
   *
   * Filtering in insertion order and truncating afterwards returns a different
   * *set*, not merely a different order, so under a limit the sweeper would
   * pick up different work here than in production. Sorted first for the same
   * reason `listRequiringOperatorAttention` is.
   */
  async findRequiringReconciliation(
    olderThan: Timestamp,
    limit: number,
  ): Promise<readonly ReleaseRecord[]> {
    const cutoff = timestampToEpochMillis(olderThan);
    return [...this.rows.values()]
      .filter(
        row =>
          row.inFlightSince !== null &&
          timestampToEpochMillis(row.inFlightSince) <= cutoff &&
          (row.state === 'ORDER_IN_FLIGHT' ||
            row.state === 'ORDER_INDETERMINATE' ||
            row.state === 'CAPTURE_IN_FLIGHT' ||
            row.state === 'CAPTURE_INDETERMINATE'),
      )
      .sort(
        (a, b) =>
          timestampToEpochMillis(a.inFlightSince!) - timestampToEpochMillis(b.inFlightSince!) ||
          a.releaseId.localeCompare(b.releaseId),
      )
      .slice(0, limit);
  }

  /** Oldest-updated first, then truncated. Same reasoning as above. */
  async findAbandonedInTransientState(
    olderThan: Timestamp,
    limit: number,
  ): Promise<readonly ReleaseRecord[]> {
    const cutoff = timestampToEpochMillis(olderThan);
    return [...this.rows.values()]
      .filter(
        row =>
          isTransientReleaseState(row.state) && timestampToEpochMillis(row.updatedAt) <= cutoff,
      )
      .sort(
        (a, b) =>
          timestampToEpochMillis(a.updatedAt) - timestampToEpochMillis(b.updatedAt) ||
          a.releaseId.localeCompare(b.releaseId),
      )
      .slice(0, limit);
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
      throw uniqueViolation('evaluations_pkey', record.evaluationId);
    }
    this.rows.set(record.evaluationId, record);
  }

  async findById(id: EvaluationId): Promise<EvaluationRecord | null> {
    return this.rows.get(id) ?? null;
  }

  /**
   * Oldest first, with the id breaking ties.
   *
   * Not cosmetic: the console reads the last evaluation recorded at each gate
   * to decide which two verdicts it is contrasting, so a store that returned
   * them in insertion order rather than chronological order would show a
   * different story from production for the same release.
   */
  async listByRelease(id: ReleaseId): Promise<readonly EvaluationRecord[]> {
    return [...this.rows.values()]
      .filter(row => row.releaseId === id)
      .sort(
        (a, b) =>
          timestampToEpochMillis(a.evaluatedAt) - timestampToEpochMillis(b.evaluatedAt) ||
          a.evaluationId.localeCompare(b.evaluationId),
      );
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
    // `COALESCE(release_id, ...)` in the SQL: a null here means "not supplied",
    // never "clear it". The release id on an inbox row is the only record of
    // which release an event was applied to, and the service calls this with
    // null on the paths where no release matched — which must not erase a
    // binding an earlier call established.
    this.rows.set(providerEventId, {
      ...current,
      status,
      processedAt: at,
      releaseId: releaseId ?? current.releaseId,
    });
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

  /**
   * Insert, matching `INSERT ... ON CONFLICT (review_id) DO NOTHING`.
   *
   * The two rules are checked in the order the statement applies them. A
   * repeated review id is a no-op — the stored row wins, and the partial index
   * is never consulted. Only a *new* id competing for the one open slot raises.
   *
   * Overwriting on a repeated id, which is what this used to do, silently
   * replaced a resolved review with a fresh OPEN one: an approval, its operator
   * and its binding erased from a table that is part of the audit record, while
   * Postgres kept all three. That is the divergence that let the capture-gate
   * approval defect hide.
   */
  async insert(record: ReviewRecord): Promise<void> {
    if (this.rows.has(record.reviewId)) return;

    // `reviews_one_open_per_release`: at most one open review per release, so
    // the operator queue can never show two live decisions for one release.
    if (record.state === 'OPEN') {
      for (const row of this.rows.values()) {
        if (row.releaseId === record.releaseId && row.state === 'OPEN') {
          throw uniqueViolation('reviews_one_open_per_release', record.releaseId);
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

  async findApprovedByReleaseAndBinding(
    id: ReleaseId,
    boundTo: Sha256Hex,
  ): Promise<ReviewRecord | null> {
    const approved = [...this.rows.values()]
      .filter(
        row =>
          row.releaseId === id &&
          row.state === 'APPROVED' &&
          row.resolvedAt !== null &&
          row.snapshotHash === boundTo,
      )
      .sort(
        (a, b) =>
          timestampToEpochMillis(b.resolvedAt!) - timestampToEpochMillis(a.resolvedAt!) ||
          b.reviewId.localeCompare(a.reviewId),
      );
    return approved[0] ?? null;
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
