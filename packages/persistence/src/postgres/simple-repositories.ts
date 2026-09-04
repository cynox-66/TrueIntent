/**
 * The remaining Postgres repositories.
 *
 * Grouped in one file because each is a thin, mechanical mapping with no
 * interesting concurrency story of its own — unlike releases, the webhook inbox
 * and the evidence ledger, whose constraints carry real weight and which
 * therefore each get a file and an explanation.
 *
 * Two conventions hold throughout, as in `release-repository.ts`: explicit SQL
 * so an auditor reads the statement rather than a builder's intent, and every
 * `BIGINT` parsed with a `Number.isSafeInteger` assertion so a value too large
 * to represent throws instead of silently rounding.
 */

import { asSha256Hex, asTimestamp, money, timestampFromDate } from '@capturelock/core';
import type {
  AuthorizationId,
  CurrencyCode,
  EvaluationId,
  EvaluationRecord,
  EvaluationRepository,
  Gate,
  MerchantId,
  ProposedCart,
  ReleaseId,
  ReviewId,
  ReviewRecord,
  ReviewRepository,
  ReviewState,
  Sha256Hex,
  Sku,
  SnapshotId,
  SnapshotRepository,
  Timestamp,
  VerificationDecision,
  VerifiedSnapshot,
} from '@capturelock/core';
import type { PolicyDocument, PolicyRepository } from '@capturelock/policy';
import { computePolicyHash } from '@capturelock/policy';
import type { Queryable } from './client.js';

function parseAmount(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${field} value ${value} is outside the safe integer range`);
  }
  return parsed;
}

// ------------------------------------------------------------------ snapshots

interface SnapshotRow extends Record<string, unknown> {
  snapshot_id: string;
  authorization_id: string;
  merchant_id: string;
  currency: string;
  cart: unknown;
  item_subtotal_minor: string;
  fee_total_minor: string;
  discount_total_minor: string;
  total_minor: string;
  row_hashes: Record<string, string>;
  live_state_digest: string;
  snapshot_hash: string;
  observed_at: Date;
  expires_at: Date;
  state: string;
  redeemed_by_release_id: string | null;
}

function toSnapshot(row: SnapshotRow): VerifiedSnapshot {
  const currency = row.currency as CurrencyCode;
  const rowHashes = new Map<Sku, Sha256Hex>();
  for (const [sku, hash] of Object.entries(row.row_hashes)) {
    rowHashes.set(sku as Sku, asSha256Hex(hash));
  }
  return {
    snapshotId: row.snapshot_id,
    authorizationId: row.authorization_id,
    merchantId: row.merchant_id as MerchantId,
    currency,
    cart: row.cart as ProposedCart,
    itemSubtotal: money(currency, parseAmount(row.item_subtotal_minor, 'itemSubtotal')),
    feeTotal: money(currency, parseAmount(row.fee_total_minor, 'feeTotal')),
    discountTotal: money(currency, parseAmount(row.discount_total_minor, 'discountTotal')),
    total: money(currency, parseAmount(row.total_minor, 'total')),
    rowHashes,
    liveStateDigest: asSha256Hex(row.live_state_digest),
    observedAt: timestampFromDate(row.observed_at),
    expiresAt: timestampFromDate(row.expires_at),
    snapshotHash: asSha256Hex(row.snapshot_hash),
    state: row.state as VerifiedSnapshot['state'],
    redeemedByReleaseId: row.redeemed_by_release_id,
  };
}

const SNAPSHOT_SELECT = `
  SELECT snapshot_id, authorization_id, merchant_id, currency, cart,
         item_subtotal_minor, fee_total_minor, discount_total_minor, total_minor,
         row_hashes, live_state_digest, snapshot_hash, observed_at, expires_at,
         state, redeemed_by_release_id
  FROM verified_snapshots`;

export class PostgresSnapshotRepository implements SnapshotRepository {
  constructor(private readonly db: Queryable) {}

  async insert(snapshot: VerifiedSnapshot): Promise<void> {
    await this.db.query(
      `INSERT INTO verified_snapshots (
         snapshot_id, authorization_id, merchant_id, currency, cart,
         item_subtotal_minor, fee_total_minor, discount_total_minor, total_minor,
         row_hashes, live_state_digest, snapshot_hash, observed_at, expires_at, state
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15)`,
      [
        snapshot.snapshotId,
        snapshot.authorizationId,
        snapshot.merchantId,
        snapshot.currency,
        JSON.stringify(snapshot.cart),
        snapshot.itemSubtotal.amountMinor,
        snapshot.feeTotal.amountMinor,
        snapshot.discountTotal.amountMinor,
        snapshot.total.amountMinor,
        JSON.stringify(Object.fromEntries(snapshot.rowHashes)),
        snapshot.liveStateDigest,
        snapshot.snapshotHash,
        snapshot.observedAt,
        snapshot.expiresAt,
        snapshot.state,
      ],
    );
  }

  async findById(id: SnapshotId): Promise<VerifiedSnapshot | null> {
    const rows = await this.db.query<SnapshotRow>(`${SNAPSHOT_SELECT} WHERE snapshot_id = $1`, [
      id,
    ]);
    return rows.length === 0 ? null : toSnapshot(rows[0]!);
  }

  /**
   * Claims a snapshot for one release.
   *
   * The `WHERE` clause is the guarantee: idempotent for the release that already
   * owns it, and refused for everyone else. Two releases racing to redeem one
   * quote cannot both win.
   */
  async claimForRelease(id: SnapshotId, releaseId: ReleaseId): Promise<VerifiedSnapshot | null> {
    const rows = await this.db.query<SnapshotRow>(
      `UPDATE verified_snapshots
       SET state = 'REDEEMED', redeemed_by_release_id = $2
       WHERE snapshot_id = $1
         AND (redeemed_by_release_id IS NULL OR redeemed_by_release_id = $2)
       RETURNING snapshot_id, authorization_id, merchant_id, currency, cart,
                 item_subtotal_minor, fee_total_minor, discount_total_minor, total_minor,
                 row_hashes, live_state_digest, snapshot_hash, observed_at, expires_at,
                 state, redeemed_by_release_id`,
      [id, releaseId],
    );
    return rows.length === 0 ? null : toSnapshot(rows[0]!);
  }
}

// ---------------------------------------------------------------- evaluations

interface EvaluationRow extends Record<string, unknown> {
  evaluation_id: string;
  authorization_id: string;
  release_id: string | null;
  gate: string;
  decision: unknown;
  context_hash: string;
  decision_hash: string;
  evaluated_at: Date;
}

function toEvaluation(row: EvaluationRow): EvaluationRecord {
  return {
    evaluationId: row.evaluation_id as EvaluationId,
    authorizationId: row.authorization_id as AuthorizationId,
    releaseId: row.release_id as ReleaseId | null,
    gate: row.gate as Gate,
    decision: row.decision as VerificationDecision,
    contextHash: asSha256Hex(row.context_hash),
    decisionHash: asSha256Hex(row.decision_hash),
    evaluatedAt: timestampFromDate(row.evaluated_at),
  };
}

/** Append-only: no update, no delete, and a database trigger enforces it. */
export class PostgresEvaluationRepository implements EvaluationRepository {
  constructor(private readonly db: Queryable) {}

  async append(record: EvaluationRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO evaluations (
         evaluation_id, authorization_id, release_id, gate, verdict,
         reason_codes, decision, context_hash, decision_hash, evaluated_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10)`,
      [
        record.evaluationId,
        record.authorizationId,
        record.releaseId,
        record.gate,
        record.decision.verdict,
        JSON.stringify(record.decision.reasonCodes),
        JSON.stringify(record.decision),
        record.contextHash,
        record.decisionHash,
        record.evaluatedAt,
      ],
    );
  }

  async findById(id: EvaluationId): Promise<EvaluationRecord | null> {
    const rows = await this.db.query<EvaluationRow>(
      `SELECT evaluation_id, authorization_id, release_id, gate, decision,
              context_hash, decision_hash, evaluated_at
       FROM evaluations WHERE evaluation_id = $1`,
      [id],
    );
    return rows.length === 0 ? null : toEvaluation(rows[0]!);
  }

  /**
   * Oldest first, with `evaluation_id` breaking ties.
   *
   * Two evaluations can share an instant — both gates take their timestamp once
   * at the start of the evaluation — and the console reads the *last* one
   * recorded at each gate to decide which verdicts it is contrasting. An
   * arbitrary order there would make the release page show a different story
   * on different reads.
   */
  async listByRelease(id: ReleaseId): Promise<readonly EvaluationRecord[]> {
    const rows = await this.db.query<EvaluationRow>(
      `SELECT evaluation_id, authorization_id, release_id, gate, decision,
              context_hash, decision_hash, evaluated_at
       FROM evaluations WHERE release_id = $1
       ORDER BY evaluated_at ASC, evaluation_id ASC`,
      [id],
    );
    return rows.map(toEvaluation);
  }
}

// -------------------------------------------------------------------- reviews

interface ReviewRow extends Record<string, unknown> {
  review_id: string;
  release_id: string;
  authorization_id: string;
  snapshot_hash: string;
  reason_codes: string[];
  state: string;
  resolved_by: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

function toReview(row: ReviewRow): ReviewRecord {
  return {
    reviewId: row.review_id as ReviewId,
    releaseId: row.release_id as ReleaseId,
    authorizationId: row.authorization_id as AuthorizationId,
    snapshotHash: asSha256Hex(row.snapshot_hash),
    reasonCodes: row.reason_codes,
    state: row.state as ReviewState,
    createdAt: timestampFromDate(row.created_at),
    resolvedAt: row.resolved_at === null ? null : timestampFromDate(row.resolved_at),
    resolvedBy: row.resolved_by,
  };
}

const REVIEW_SELECT = `
  SELECT review_id, release_id, authorization_id, snapshot_hash, reason_codes,
         state, resolved_by, created_at, resolved_at
  FROM review_requests`;

export class PostgresReviewRepository implements ReviewRepository {
  constructor(private readonly db: Queryable) {}

  async insert(record: ReviewRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO review_requests (
         review_id, release_id, authorization_id, snapshot_hash, reason_codes, state, created_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (review_id) DO NOTHING`,
      [
        record.reviewId,
        record.releaseId,
        record.authorizationId,
        record.snapshotHash,
        JSON.stringify(record.reasonCodes),
        record.state,
        record.createdAt,
      ],
    );
  }

  async findById(id: ReviewId): Promise<ReviewRecord | null> {
    const rows = await this.db.query<ReviewRow>(`${REVIEW_SELECT} WHERE review_id = $1`, [id]);
    return rows.length === 0 ? null : toReview(rows[0]!);
  }

  async findOpenByRelease(id: ReleaseId): Promise<ReviewRecord | null> {
    const rows = await this.db.query<ReviewRow>(
      `${REVIEW_SELECT} WHERE release_id = $1 AND state = 'OPEN' LIMIT 1`,
      [id],
    );
    return rows.length === 0 ? null : toReview(rows[0]!);
  }

  /**
   * The approval for a release bound to this exact request, which the kernel
   * consumes.
   *
   * `snapshot_hash` is the column the binding persists to; it holds a request
   * fingerprint. Ordering is still newest-first so that a release re-approved
   * for the same request yields the current decision.
   */
  async findApprovedByReleaseAndBinding(
    id: ReleaseId,
    boundTo: Sha256Hex,
  ): Promise<ReviewRecord | null> {
    const rows = await this.db.query<ReviewRow>(
      `${REVIEW_SELECT}
       WHERE release_id = $1 AND state = 'APPROVED' AND snapshot_hash = $2
       ORDER BY resolved_at DESC NULLS LAST, review_id DESC
       LIMIT 1`,
      [id, boundTo],
    );
    return rows.length === 0 ? null : toReview(rows[0]!);
  }

  /**
   * Open reviews only, oldest first.
   *
   * `created_at` is NOT NULL with a default, so no null ordering case exists;
   * `review_id` is the primary key and makes the sort total.
   */
  async listOpen(limit: number): Promise<readonly ReviewRecord[]> {
    const rows = await this.db.query<ReviewRow>(
      `${REVIEW_SELECT}
       WHERE state = 'OPEN'
       ORDER BY created_at ASC, review_id ASC
       LIMIT $1`,
      [limit],
    );
    return rows.map(toReview);
  }

  /** CAS from OPEN. Two reviewers clicking at once cannot both resolve. */
  async resolve(
    id: ReviewId,
    to: Exclude<ReviewState, 'OPEN'>,
    resolvedBy: string,
    at: Timestamp,
  ): Promise<ReviewRecord | null> {
    const rows = await this.db.query<ReviewRow>(
      `UPDATE review_requests SET state = $2, resolved_by = $3, resolved_at = $4
       WHERE review_id = $1 AND state = 'OPEN'
       RETURNING review_id, release_id, authorization_id, snapshot_hash, reason_codes,
                 state, resolved_by, created_at, resolved_at`,
      [id, to, resolvedBy, at],
    );
    return rows.length === 0 ? null : toReview(rows[0]!);
  }
}

// ------------------------------------------------------------------- policies

interface PolicyRow extends Record<string, unknown> {
  policy_id: string;
  version: string;
  name: string;
  rules: unknown[];
  created_at: Date;
}

export class PostgresPolicyRepository implements PolicyRepository {
  constructor(private readonly db: Queryable) {}

  async insert(document: PolicyDocument): Promise<void> {
    await this.db.query(
      `INSERT INTO policies (policy_id, version, name, rules, policy_hash, created_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6)
       ON CONFLICT (policy_id, version) DO NOTHING`,
      [
        document.policyId,
        document.version,
        document.name,
        JSON.stringify(document.rules),
        computePolicyHash(document),
        document.createdAt,
      ],
    );
  }

  async findByIdAndVersion(policyId: string, version: string): Promise<PolicyDocument | null> {
    const rows = await this.db.query<PolicyRow>(
      `SELECT policy_id, version, name, rules, created_at
       FROM policies WHERE policy_id = $1 AND version = $2`,
      [policyId, version],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      policyId: row.policy_id,
      version: row.version,
      name: row.name,
      rules: row.rules,
      createdAt: asTimestamp(row.created_at.toISOString()),
    };
  }
}
