/**
 * Postgres release repository.
 *
 * Two statements carry the guarantees:
 *
 *   INSERT ... — relies on `releases_one_active_per_authorization`, a PARTIAL
 *   unique index over non-terminal states. Two API instances racing to spend the
 *   same authorization both issue this insert; the database lets exactly one
 *   through and rejects the other with 23505. No application logic is consulted.
 *
 *   UPDATE ... WHERE release_id = $1 AND state = ANY($2) RETURNING * — a single
 *   atomic compare-and-set. There is no read-then-write anywhere in this file,
 *   because a read-then-write is precisely how two concurrent captures both
 *   decide they are allowed to proceed.
 */

import {
  money,
  type AuthorizationId,
  type CurrencyCode,
  type IdempotencyKey,
  type InsertReleaseResult,
  type Receipt,
  type ReleaseId,
  type ReleaseRecord,
  type ReleaseRepository,
  type ReleaseState,
  type ReleaseTransitionPatch,
  type Sha256Hex,
  type SnapshotId,
  type Timestamp,
} from '@capturelock/core';
import {
  OPERATOR_ATTENTION_RELEASE_STATES,
  TRANSIENT_RELEASE_STATES,
  timestampFromDate,
} from '@capturelock/core';
import { isUniqueViolation, type Queryable } from './client.js';

interface ReleaseRow extends Record<string, unknown> {
  release_id: string;
  authorization_id: string;
  snapshot_id: string;
  state: string;
  client_idempotency_key: string;
  request_fingerprint: string;
  receipt: string;
  amount_minor: string;
  currency: string;
  provider_order_id: string | null;
  provider_payment_id: string | null;
  attempt_count: number;
  in_flight_since: Date | null;
  last_reason_codes: string[];
  created_at: Date;
  updated_at: Date;
}

const TERMINAL = ['SETTLED', 'DENIED', 'CAPTURE_REJECTED', 'FAILED', 'ABORTED'];
const TRANSIENT = [...TRANSIENT_RELEASE_STATES];

function toRecord(row: ReleaseRow): ReleaseRecord {
  return {
    releaseId: row.release_id as ReleaseId,
    authorizationId: row.authorization_id as AuthorizationId,
    snapshotId: row.snapshot_id as SnapshotId,
    state: row.state as ReleaseState,
    clientIdempotencyKey: row.client_idempotency_key as IdempotencyKey,
    requestFingerprint: row.request_fingerprint as Sha256Hex,
    receipt: row.receipt as Receipt,
    // BIGINT arrives as a string from pg. Parsing it explicitly, and asserting
    // it is a safe integer, keeps a large value from silently losing precision.
    amount: money(row.currency as CurrencyCode, parseAmount(row.amount_minor)),
    currency: row.currency as CurrencyCode,
    providerOrderId: row.provider_order_id,
    providerPaymentId: row.provider_payment_id,
    attemptCount: row.attempt_count,
    inFlightSince: row.in_flight_since === null ? null : timestampFromDate(row.in_flight_since),
    createdAt: timestampFromDate(row.created_at),
    updatedAt: timestampFromDate(row.updated_at),
    lastReasonCodes: row.last_reason_codes,
  };
}

function parseAmount(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Release amount ${value} is outside the safe integer range`);
  }
  return parsed;
}

const SELECT = `
  SELECT release_id, authorization_id, snapshot_id, state, client_idempotency_key,
         request_fingerprint, receipt, amount_minor, currency, provider_order_id,
         provider_payment_id, attempt_count, in_flight_since, last_reason_codes,
         created_at, updated_at
  FROM releases`;

export class PostgresReleaseRepository implements ReleaseRepository {
  constructor(private readonly db: Queryable) {}

  async insert(record: ReleaseRecord): Promise<InsertReleaseResult> {
    try {
      const rows = await this.db.query<ReleaseRow>(
        `INSERT INTO releases (
           release_id, authorization_id, snapshot_id, state, client_idempotency_key,
           request_fingerprint, receipt, amount_minor, currency, attempt_count,
           last_reason_codes, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
         RETURNING release_id, authorization_id, snapshot_id, state, client_idempotency_key,
                   request_fingerprint, receipt, amount_minor, currency, provider_order_id,
                   provider_payment_id, attempt_count, in_flight_since, last_reason_codes,
                   created_at, updated_at`,
        [
          record.releaseId,
          record.authorizationId,
          record.snapshotId,
          record.state,
          record.clientIdempotencyKey,
          record.requestFingerprint,
          record.receipt,
          record.amount.amountMinor,
          record.currency,
          record.attemptCount,
          JSON.stringify(record.lastReasonCodes),
          record.createdAt,
          record.updatedAt,
        ],
      );
      return { kind: 'INSERTED', release: toRecord(rows[0]!) };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // The database refused. Which constraint fired determines what the caller
      // is told, so the reason code reported to the agent is accurate.
      const byKey = await this.findByClientIdempotencyKey(record.clientIdempotencyKey);
      if (byKey !== null) return { kind: 'DUPLICATE_IDEMPOTENCY_KEY', existing: byKey };

      const active = await this.findActiveByAuthorization(record.authorizationId);
      if (active !== null) return { kind: 'AUTHORIZATION_BUSY', existing: active };

      throw error;
    }
  }

  async findById(id: ReleaseId): Promise<ReleaseRecord | null> {
    const rows = await this.db.query<ReleaseRow>(`${SELECT} WHERE release_id = $1`, [id]);
    return rows.length === 0 ? null : toRecord(rows[0]!);
  }

  async findByClientIdempotencyKey(key: IdempotencyKey): Promise<ReleaseRecord | null> {
    const rows = await this.db.query<ReleaseRow>(`${SELECT} WHERE client_idempotency_key = $1`, [
      key,
    ]);
    return rows.length === 0 ? null : toRecord(rows[0]!);
  }

  async findByReceipt(receipt: Receipt): Promise<ReleaseRecord | null> {
    const rows = await this.db.query<ReleaseRow>(`${SELECT} WHERE receipt = $1`, [receipt]);
    return rows.length === 0 ? null : toRecord(rows[0]!);
  }

  async findByProviderPaymentId(paymentId: string): Promise<ReleaseRecord | null> {
    const rows = await this.db.query<ReleaseRow>(`${SELECT} WHERE provider_payment_id = $1`, [
      paymentId,
    ]);
    return rows.length === 0 ? null : toRecord(rows[0]!);
  }

  async findByProviderOrderId(orderId: string): Promise<ReleaseRecord | null> {
    const rows = await this.db.query<ReleaseRow>(`${SELECT} WHERE provider_order_id = $1`, [
      orderId,
    ]);
    return rows.length === 0 ? null : toRecord(rows[0]!);
  }

  async findActiveByAuthorization(id: AuthorizationId): Promise<ReleaseRecord | null> {
    const rows = await this.db.query<ReleaseRow>(
      `${SELECT} WHERE authorization_id = $1 AND state <> ALL($2::text[]) LIMIT 1`,
      [id, TERMINAL],
    );
    return rows.length === 0 ? null : toRecord(rows[0]!);
  }

  /**
   * Atomic compare-and-set.
   *
   * Returns null when zero rows matched, which means the release was not in one
   * of the states the caller was willing to move from — someone else got there
   * first. The caller must treat that as losing the race and must never retry
   * the transition with a widened source list.
   */
  async transition(
    id: ReleaseId,
    from: readonly ReleaseState[],
    to: ReleaseState,
    patch: ReleaseTransitionPatch,
    at: Timestamp,
  ): Promise<ReleaseRecord | null> {
    const rows = await this.db.query<ReleaseRow>(
      `UPDATE releases SET
         state = $3,
         provider_order_id   = COALESCE($4, provider_order_id),
         provider_payment_id = COALESCE($5, provider_payment_id),
         in_flight_since     = CASE WHEN $6::boolean THEN $7::timestamptz ELSE in_flight_since END,
         attempt_count       = attempt_count + CASE WHEN $8::boolean THEN 1 ELSE 0 END,
         last_reason_codes   = COALESCE($9::jsonb, last_reason_codes),
         updated_at          = $10
       WHERE release_id = $1 AND state = ANY($2::text[])
       RETURNING release_id, authorization_id, snapshot_id, state, client_idempotency_key,
                 request_fingerprint, receipt, amount_minor, currency, provider_order_id,
                 provider_payment_id, attempt_count, in_flight_since, last_reason_codes,
                 created_at, updated_at`,
      [
        id,
        [...from],
        to,
        patch.providerOrderId ?? null,
        patch.providerPaymentId ?? null,
        patch.inFlightSince !== undefined,
        patch.inFlightSince ?? null,
        patch.incrementAttempt === true,
        patch.lastReasonCodes === undefined ? null : JSON.stringify(patch.lastReasonCodes),
        at,
      ],
    );
    return rows.length === 0 ? null : toRecord(rows[0]!);
  }

  /**
   * Releases abandoned in a transient state.
   *
   * Filtered on `updated_at` rather than `in_flight_since`, because these rows
   * never had a provider call and so never set the latter. See ADR-011.
   *
   * `release_id` makes the ordering total. Without it two rows sharing a
   * timestamp order arbitrarily, so a limit could return a different set on
   * each call — and the in-memory store, which must match, would have no
   * defined answer to match.
   */
  async findAbandonedInTransientState(
    olderThan: Timestamp,
    limit: number,
  ): Promise<readonly ReleaseRecord[]> {
    const rows = await this.db.query<ReleaseRow>(
      `${SELECT}
       WHERE state = ANY($1::text[])
         AND updated_at <= $2
       ORDER BY updated_at ASC, release_id ASC
       LIMIT $3`,
      [[...TRANSIENT], olderThan, limit],
    );
    return rows.map(toRecord);
  }

  /** Oldest in-flight first; `release_id` makes the order total under a limit. */
  async findRequiringReconciliation(
    olderThan: Timestamp,
    limit: number,
  ): Promise<readonly ReleaseRecord[]> {
    const rows = await this.db.query<ReleaseRow>(
      `${SELECT}
       WHERE state IN ('ORDER_IN_FLIGHT','ORDER_INDETERMINATE','CAPTURE_IN_FLIGHT','CAPTURE_INDETERMINATE')
         AND in_flight_since IS NOT NULL
         AND in_flight_since <= $1
       ORDER BY in_flight_since ASC, release_id ASC
       LIMIT $2`,
      [olderThan, limit],
    );
    return rows.map(toRecord);
  }

  /**
   * The operator queue's backing query.
   *
   * The state list is bound as a parameter rather than interpolated, so it
   * stays derived from the domain constant instead of being a second copy of it
   * that can drift. No age threshold: unlike the sweeper queries this answers
   * "what needs a human right now", and a release that just paused needs one.
   *
   * `updated_at` is NOT NULL with a default, so the ordering has no null case;
   * `release_id` is the primary key, which makes the sort total and the result
   * stable across identical timestamps.
   */
  async listRequiringOperatorAttention(limit: number): Promise<readonly ReleaseRecord[]> {
    const rows = await this.db.query<ReleaseRow>(
      `${SELECT}
       WHERE state = ANY($1)
       ORDER BY updated_at ASC, release_id ASC
       LIMIT $2`,
      [[...OPERATOR_ATTENTION_RELEASE_STATES], limit],
    );
    return rows.map(toRecord);
  }
}
