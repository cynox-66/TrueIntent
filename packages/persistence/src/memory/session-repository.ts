/**
 * In-memory session authority repository.
 *
 * Written to model the SQL's semantics, not to be convenient. Three things it
 * reproduces deliberately, each named after the Postgres constraint it stands in
 * for so `parity.db.test.ts` can compare which rule fired:
 *
 *  - `commerce_sessions_budget_bounded` — the budget predicate. Checked here as
 *    an eager refusal, exactly as the CHECK constraint refuses the row.
 *  - `commerce_session_purchases_request_idx` — the retry path. A repeated
 *    (session, request) is a typed result, not a throw.
 *  - Ordering under a limit, including the tiebreak. A store that filtered in
 *    insertion order and truncated would hand a sweeper a different set of work
 *    from the one production picks up.
 *
 * `reserve` does its read and its write in one synchronous block with no `await`
 * between them, which on a single-threaded event loop makes it genuinely atomic
 * with respect to other tasks in this process. That proves the application logic
 * has the right shape; it cannot prove anything about two API instances sharing
 * a database, which is why the concurrency assertion is duplicated against real
 * Postgres. See ADR-010 and ADR-020.
 */

import { CaptureLockError } from '@capturelock/core';
import type {
  AuthorizationId,
  Money,
  RecordPurchaseResult,
  ReserveBudgetResult,
  SessionAuthorityRecord,
  SessionAuthorityRepository,
  SessionAuthorityState,
  SessionId,
  SessionPurchaseRecord,
  Sha256Hex,
  Timestamp,
  UserId,
} from '@capturelock/core';
import { timestampToEpochMillis } from '@capturelock/core';

function uniqueViolation(constraint: string, detail: string): CaptureLockError {
  return new CaptureLockError(
    'UNIQUE_VIOLATION',
    `duplicate key value violates unique constraint "${constraint}": ${detail}`,
    { constraint },
  );
}

export class InMemorySessionAuthorityRepository implements SessionAuthorityRepository {
  /** Exposed so InMemoryUnitOfWork can snapshot and restore it on rollback. */
  readonly rows = new Map<string, SessionAuthorityRecord>();
  readonly purchases = new Map<string, SessionPurchaseRecord>();

  async insert(record: SessionAuthorityRecord): Promise<void> {
    if (this.rows.has(record.sessionId)) {
      throw uniqueViolation('commerce_sessions_pkey', record.sessionId);
    }
    this.rows.set(record.sessionId, record);
  }

  async findById(id: SessionId): Promise<SessionAuthorityRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async listByUser(userId: UserId, limit: number): Promise<readonly SessionAuthorityRecord[]> {
    return [...this.rows.values()]
      .filter(row => row.userId === userId)
      .sort(byCreatedAtDescThenId)
      .slice(0, limit);
  }

  async reserve(id: SessionId, amount: Money, at: Timestamp): Promise<ReserveBudgetResult> {
    const current = this.rows.get(id);
    if (current === undefined) return { kind: 'REFUSED', reason: 'NOT_FOUND' };
    if (current.state !== 'ACTIVE') return { kind: 'REFUSED', reason: 'NOT_ACTIVE' };
    if (timestampToEpochMillis(current.expiresAt) <= timestampToEpochMillis(at)) {
      return { kind: 'REFUSED', reason: 'EXPIRED' };
    }
    // The SQL predicate includes `currency = $4`. A cross-currency reserve is a
    // programming error rather than an attack, but it must refuse identically in
    // both stores or the parity suite is comparing different behaviour.
    if (current.bounds.currency !== amount.currency) {
      return { kind: 'REFUSED', reason: 'BUDGET_EXCEEDED' };
    }
    // Stands in for CHECK commerce_sessions_budget_bounded.
    const committed = current.reservedMinor + current.spentMinor + amount.amountMinor;
    if (committed > current.bounds.totalBudget.amountMinor) {
      return { kind: 'REFUSED', reason: 'BUDGET_EXCEEDED' };
    }

    const next: SessionAuthorityRecord = {
      ...current,
      reservedMinor: current.reservedMinor + amount.amountMinor,
    };
    this.rows.set(id, next);
    return { kind: 'RESERVED', session: next };
  }

  async recordPurchase(record: SessionPurchaseRecord): Promise<RecordPurchaseResult> {
    // Stands in for the commerce_session_purchases_request_idx unique index.
    for (const row of this.purchases.values()) {
      if (
        row.sessionId === record.sessionId &&
        row.purchaseRequestId === record.purchaseRequestId
      ) {
        return { kind: 'DUPLICATE_REQUEST', existing: row };
      }
    }
    if (this.purchases.has(record.authorizationId)) {
      throw uniqueViolation('commerce_session_purchases_pkey', record.authorizationId);
    }
    this.purchases.set(record.authorizationId, record);
    return { kind: 'RECORDED', purchase: record };
  }

  async findPurchaseByAuthorization(id: AuthorizationId): Promise<SessionPurchaseRecord | null> {
    return this.purchases.get(id) ?? null;
  }

  async findPurchaseByRequestId(
    id: SessionId,
    purchaseRequestId: Sha256Hex,
  ): Promise<SessionPurchaseRecord | null> {
    for (const row of this.purchases.values()) {
      if (row.sessionId === id && row.purchaseRequestId === purchaseRequestId) return row;
    }
    return null;
  }

  async listPurchasesBySession(
    id: SessionId,
    limit: number,
  ): Promise<readonly SessionPurchaseRecord[]> {
    return [...this.purchases.values()]
      .filter(row => row.sessionId === id)
      .sort(byPurchaseCreatedAtDescThenId)
      .slice(0, limit);
  }

  async settlePurchase(id: AuthorizationId, at: Timestamp): Promise<SessionPurchaseRecord | null> {
    return this.resolve(id, 'SETTLED', at);
  }

  async releasePurchase(id: AuthorizationId, at: Timestamp): Promise<SessionPurchaseRecord | null> {
    return this.resolve(id, 'RELEASED', at);
  }

  async findUnsettledPurchases(
    olderThan: Timestamp,
    limit: number,
  ): Promise<readonly SessionPurchaseRecord[]> {
    const cutoff = timestampToEpochMillis(olderThan);
    return [...this.purchases.values()]
      .filter(
        row => row.settlementState === 'RESERVED' && timestampToEpochMillis(row.createdAt) < cutoff,
      )
      .sort(byPurchaseCreatedAtAscThenId)
      .slice(0, limit);
  }

  async transition(
    id: SessionId,
    from: readonly SessionAuthorityState[],
    to: SessionAuthorityState,
    patch: { revokedAt?: Timestamp },
  ): Promise<SessionAuthorityRecord | null> {
    const current = this.rows.get(id);
    if (current === undefined || !from.includes(current.state)) return null;
    const next: SessionAuthorityRecord = {
      ...current,
      state: to,
      revokedAt: patch.revokedAt ?? current.revokedAt,
    };
    this.rows.set(id, next);
    return next;
  }

  /**
   * CAS from RESERVED, then move the counters.
   *
   * Same ordering as the SQL: the purchase row is the compare-and-set target, so
   * a second caller loses it and the session counters are never touched twice.
   */
  private resolve(
    id: AuthorizationId,
    to: 'SETTLED' | 'RELEASED',
    at: Timestamp,
  ): SessionPurchaseRecord | null {
    const purchase = this.purchases.get(id);
    if (purchase === undefined || purchase.settlementState !== 'RESERVED') return null;

    const next: SessionPurchaseRecord = { ...purchase, settlementState: to, settledAt: at };
    this.purchases.set(id, next);

    const session = this.rows.get(purchase.sessionId);
    if (session !== undefined) {
      this.rows.set(purchase.sessionId, {
        ...session,
        reservedMinor: session.reservedMinor - purchase.reservedMinor,
        spentMinor:
          to === 'SETTLED' ? session.spentMinor + purchase.reservedMinor : session.spentMinor,
      });
    }
    return next;
  }
}

function byCreatedAtDescThenId(a: SessionAuthorityRecord, b: SessionAuthorityRecord): number {
  const byTime = timestampToEpochMillis(b.createdAt) - timestampToEpochMillis(a.createdAt);
  return byTime !== 0 ? byTime : b.sessionId.localeCompare(a.sessionId, 'en');
}

function byPurchaseCreatedAtDescThenId(a: SessionPurchaseRecord, b: SessionPurchaseRecord): number {
  const byTime = timestampToEpochMillis(b.createdAt) - timestampToEpochMillis(a.createdAt);
  return byTime !== 0 ? byTime : b.authorizationId.localeCompare(a.authorizationId, 'en');
}

function byPurchaseCreatedAtAscThenId(a: SessionPurchaseRecord, b: SessionPurchaseRecord): number {
  const byTime = timestampToEpochMillis(a.createdAt) - timestampToEpochMillis(b.createdAt);
  return byTime !== 0 ? byTime : a.authorizationId.localeCompare(b.authorizationId, 'en');
}
