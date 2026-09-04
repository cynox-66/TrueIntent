/**
 * Postgres session authority repository.
 *
 * The interesting method is `reserve`, and what makes it interesting is that it
 * is one statement. The entire safety predicate — active, unexpired, and enough
 * budget left counting what is already reserved and spent — lives in the WHERE
 * clause, so two concurrent purchase requests cannot both be told yes: the row
 * lock serializes the updates, and the loser re-evaluates the predicate against
 * the winner's write and matches zero rows.
 *
 * The `commerce_sessions_budget_bounded` CHECK sits behind it as the actual
 * guarantee. If this statement were ever rewritten into a read-then-write, the
 * constraint would still refuse the overspend — noisily, which is the point.
 */

import { asSha256Hex, asTimestamp, timestampFromDate } from '@capturelock/core';
import type {
  AuthorizationId,
  Money,
  RecordPurchaseResult,
  ReserveBudgetResult,
  SessionAuthorityRecord,
  SessionAuthorityRepository,
  SessionAuthorityState,
  SessionBounds,
  SessionId,
  SessionPurchaseRecord,
  PurchaseSettlementState,
  Sha256Hex,
  Timestamp,
  UserId,
} from '@capturelock/core';
import { isUniqueViolation, type Queryable } from './client.js';

interface SessionRow extends Record<string, unknown> {
  session_id: string;
  user_id: string;
  purpose: string;
  bounds: unknown;
  bounds_hash: string;
  policy_id: string;
  policy_version: string;
  currency: string;
  total_budget_minor: string | number;
  reserved_minor: string | number;
  spent_minor: string | number;
  state: string;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

interface PurchaseRow extends Record<string, unknown> {
  authorization_id: string;
  session_id: string;
  purchase_request_id: string;
  reserved_minor: string | number;
  settlement_state: string;
  capsule_hash: string;
  created_at: Date;
  settled_at: Date | null;
}

/**
 * Parses a BIGINT column.
 *
 * `pg` returns bigints as strings so precision is not silently lost. A value
 * outside the safe-integer range is a corrupt row, and throwing here is the only
 * honest response: rounding it would produce a wrong budget.
 */
function parseMinor(value: string | number, column: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`capturelock: ${column} is not a safe integer: ${String(value)}`);
  }
  return parsed;
}

function toRecord(row: SessionRow): SessionAuthorityRecord {
  const bounds = row.bounds as SessionBounds;
  return {
    sessionId: row.session_id as SessionId,
    userId: row.user_id as UserId,
    purpose: row.purpose,
    // Re-parsed rather than trusted: this came back from a mutable store, and a
    // malformed expiry should fail loudly here rather than quietly widen the
    // window a session may spend in.
    bounds: { ...bounds, expiresAt: asTimestamp(String(bounds.expiresAt)) },
    boundsHash: asSha256Hex(row.bounds_hash),
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    state: row.state as SessionAuthorityState,
    reservedMinor: parseMinor(row.reserved_minor, 'reserved_minor'),
    spentMinor: parseMinor(row.spent_minor, 'spent_minor'),
    createdAt: timestampFromDate(row.created_at),
    expiresAt: timestampFromDate(row.expires_at),
    revokedAt: row.revoked_at === null ? null : timestampFromDate(row.revoked_at),
  };
}

function toPurchase(row: PurchaseRow): SessionPurchaseRecord {
  return {
    authorizationId: row.authorization_id,
    sessionId: row.session_id as SessionId,
    purchaseRequestId: asSha256Hex(row.purchase_request_id),
    reservedMinor: parseMinor(row.reserved_minor, 'reserved_minor'),
    settlementState: row.settlement_state as PurchaseSettlementState,
    capsuleHash: asSha256Hex(row.capsule_hash),
    createdAt: timestampFromDate(row.created_at),
    settledAt: row.settled_at === null ? null : timestampFromDate(row.settled_at),
  };
}

const SELECT = `
  SELECT session_id, user_id, purpose, bounds, bounds_hash, policy_id,
         policy_version, currency, total_budget_minor, reserved_minor,
         spent_minor, state, created_at, updated_at, expires_at, revoked_at
  FROM commerce_sessions`;

const RETURNING = `
  RETURNING session_id, user_id, purpose, bounds, bounds_hash, policy_id,
            policy_version, currency, total_budget_minor, reserved_minor,
            spent_minor, state, created_at, updated_at, expires_at, revoked_at`;

const SELECT_PURCHASE = `
  SELECT authorization_id, session_id, purchase_request_id, reserved_minor,
         settlement_state, capsule_hash, created_at, settled_at
  FROM commerce_session_purchases`;

const RETURNING_PURCHASE = `
  RETURNING authorization_id, session_id, purchase_request_id, reserved_minor,
            settlement_state, capsule_hash, created_at, settled_at`;

export class PostgresSessionAuthorityRepository implements SessionAuthorityRepository {
  constructor(private readonly db: Queryable) {}

  async insert(record: SessionAuthorityRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO commerce_sessions (
         session_id, user_id, purpose, bounds, bounds_hash, policy_id,
         policy_version, currency, total_budget_minor, reserved_minor,
         spent_minor, state, created_at, updated_at, expires_at, revoked_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15)`,
      [
        record.sessionId,
        record.userId,
        record.purpose,
        JSON.stringify(record.bounds),
        record.boundsHash,
        record.policyId,
        record.policyVersion,
        record.bounds.currency,
        record.bounds.totalBudget.amountMinor,
        record.reservedMinor,
        record.spentMinor,
        record.state,
        record.createdAt,
        record.expiresAt,
        record.revokedAt,
      ],
    );
  }

  async findById(id: SessionId): Promise<SessionAuthorityRecord | null> {
    const rows = await this.db.query<SessionRow>(`${SELECT} WHERE session_id = $1`, [id]);
    return rows.length === 0 ? null : toRecord(rows[0]!);
  }

  async listByUser(userId: UserId, limit: number): Promise<readonly SessionAuthorityRecord[]> {
    // `session_id` breaks ties so a limit returns a stable set. Two sessions
    // created in the same transaction share `created_at`, and an ordering that
    // left that undefined would let the two stores disagree about which rows a
    // limit selects.
    const rows = await this.db.query<SessionRow>(
      `${SELECT} WHERE user_id = $1 ORDER BY created_at DESC, session_id DESC LIMIT $2`,
      [userId, limit],
    );
    return rows.map(toRecord);
  }

  /**
   * Commits budget to a purchase, atomically.
   *
   * On zero rows the reason is established by a follow-up read. That read is
   * only ever used to *explain* a refusal that already happened — it never
   * decides one — so a concurrent change between the two statements cannot turn
   * a refusal into an approval.
   */
  async reserve(id: SessionId, amount: Money, at: Timestamp): Promise<ReserveBudgetResult> {
    const rows = await this.db.query<SessionRow>(
      `UPDATE commerce_sessions SET
         reserved_minor = reserved_minor + $2,
         updated_at = $3
       WHERE session_id = $1
         AND state = 'ACTIVE'
         AND expires_at > $3
         AND currency = $4
         AND reserved_minor + spent_minor + $2 <= total_budget_minor
       ${RETURNING}`,
      [id, amount.amountMinor, at, amount.currency],
    );

    if (rows.length === 1) return { kind: 'RESERVED', session: toRecord(rows[0]!) };

    const current = await this.findById(id);
    if (current === null) return { kind: 'REFUSED', reason: 'NOT_FOUND' };
    if (current.state !== 'ACTIVE') return { kind: 'REFUSED', reason: 'NOT_ACTIVE' };
    if (current.expiresAt <= at) return { kind: 'REFUSED', reason: 'EXPIRED' };
    return { kind: 'REFUSED', reason: 'BUDGET_EXCEEDED' };
  }

  async recordPurchase(record: SessionPurchaseRecord): Promise<RecordPurchaseResult> {
    try {
      const rows = await this.db.query<PurchaseRow>(
        `INSERT INTO commerce_session_purchases (
           authorization_id, session_id, purchase_request_id, reserved_minor,
           settlement_state, capsule_hash, created_at, settled_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ${RETURNING_PURCHASE}`,
        [
          record.authorizationId,
          record.sessionId,
          record.purchaseRequestId,
          record.reservedMinor,
          record.settlementState,
          record.capsuleHash,
          record.createdAt,
          record.settledAt,
        ],
      );
      return { kind: 'RECORDED', purchase: toPurchase(rows[0]!) };
    } catch (error) {
      // The unique index on (session_id, purchase_request_id) is the retry
      // path, not a fault: hand back the row that already exists so the caller
      // reuses its authorization instead of minting a second one.
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.findPurchaseByRequestId(
        record.sessionId,
        record.purchaseRequestId,
      );
      if (existing === null) throw error;
      return { kind: 'DUPLICATE_REQUEST', existing };
    }
  }

  async findPurchaseByAuthorization(id: AuthorizationId): Promise<SessionPurchaseRecord | null> {
    const rows = await this.db.query<PurchaseRow>(
      `${SELECT_PURCHASE} WHERE authorization_id = $1`,
      [id],
    );
    return rows.length === 0 ? null : toPurchase(rows[0]!);
  }

  async findPurchaseByRequestId(
    id: SessionId,
    purchaseRequestId: Sha256Hex,
  ): Promise<SessionPurchaseRecord | null> {
    const rows = await this.db.query<PurchaseRow>(
      `${SELECT_PURCHASE} WHERE session_id = $1 AND purchase_request_id = $2`,
      [id, purchaseRequestId],
    );
    return rows.length === 0 ? null : toPurchase(rows[0]!);
  }

  async listPurchasesBySession(
    id: SessionId,
    limit: number,
  ): Promise<readonly SessionPurchaseRecord[]> {
    const rows = await this.db.query<PurchaseRow>(
      `${SELECT_PURCHASE} WHERE session_id = $1
         ORDER BY created_at DESC, authorization_id DESC LIMIT $2`,
      [id, limit],
    );
    return rows.map(toPurchase);
  }

  /**
   * Converts a hold into confirmed spend.
   *
   * Two statements in one transaction, and the ordering matters: the CAS on the
   * purchase row happens first, so if it matches zero rows the counters are
   * never touched. That is what makes double settlement impossible rather than
   * merely unlikely — a second caller loses the CAS and moves no money into
   * `spent_minor`.
   */
  async settlePurchase(id: AuthorizationId, at: Timestamp): Promise<SessionPurchaseRecord | null> {
    const rows = await this.db.query<PurchaseRow>(
      `UPDATE commerce_session_purchases SET
         settlement_state = 'SETTLED',
         settled_at = $2
       WHERE authorization_id = $1 AND settlement_state = 'RESERVED'
       ${RETURNING_PURCHASE}`,
      [id, at],
    );
    if (rows.length === 0) return null;
    const purchase = toPurchase(rows[0]!);

    await this.db.query(
      `UPDATE commerce_sessions SET
         reserved_minor = reserved_minor - $2,
         spent_minor = spent_minor + $2,
         updated_at = $3
       WHERE session_id = $1`,
      [purchase.sessionId, purchase.reservedMinor, at],
    );
    return purchase;
  }

  /** Frees a hold whose purchase did not move money. Same CAS-first ordering. */
  async releasePurchase(id: AuthorizationId, at: Timestamp): Promise<SessionPurchaseRecord | null> {
    const rows = await this.db.query<PurchaseRow>(
      `UPDATE commerce_session_purchases SET
         settlement_state = 'RELEASED',
         settled_at = $2
       WHERE authorization_id = $1 AND settlement_state = 'RESERVED'
       ${RETURNING_PURCHASE}`,
      [id, at],
    );
    if (rows.length === 0) return null;
    const purchase = toPurchase(rows[0]!);

    await this.db.query(
      `UPDATE commerce_sessions SET
         reserved_minor = reserved_minor - $2,
         updated_at = $3
       WHERE session_id = $1`,
      [purchase.sessionId, purchase.reservedMinor, at],
    );
    return purchase;
  }

  async findUnsettledPurchases(
    olderThan: Timestamp,
    limit: number,
  ): Promise<readonly SessionPurchaseRecord[]> {
    const rows = await this.db.query<PurchaseRow>(
      `${SELECT_PURCHASE}
        WHERE settlement_state = 'RESERVED' AND created_at < $1
        ORDER BY created_at ASC, authorization_id ASC LIMIT $2`,
      [olderThan, limit],
    );
    return rows.map(toPurchase);
  }

  async transition(
    id: SessionId,
    from: readonly SessionAuthorityState[],
    to: SessionAuthorityState,
    patch: { revokedAt?: Timestamp },
  ): Promise<SessionAuthorityRecord | null> {
    const rows = await this.db.query<SessionRow>(
      `UPDATE commerce_sessions SET
         state = $3,
         revoked_at = COALESCE($4, revoked_at),
         updated_at = NOW()
       WHERE session_id = $1 AND state = ANY($2::text[])
       ${RETURNING}`,
      [id, [...from], to, patch.revokedAt ?? null],
    );
    return rows.length === 0 ? null : toRecord(rows[0]!);
  }
}
