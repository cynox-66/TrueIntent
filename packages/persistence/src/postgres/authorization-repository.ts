/**
 * Postgres authorization repository.
 *
 * The constraints row and its hash are stored side by side, and the kernel
 * re-derives the hash on every evaluation. That is what makes editing this row
 * — raising a budget directly in the database — detected rather than enforced.
 */

import { asSha256Hex, asTimestamp, timestampFromDate } from '@capturelock/core';
import type {
  AuthorizationId,
  AuthorizationRecord,
  AuthorizationRepository,
  AuthorizationState,
  AuthorizedIntent,
  IntentConstraints,
  IntentNormalization,
  ReleaseId,
  Timestamp,
  UserId,
} from '@capturelock/core';
import type { Queryable } from './client.js';

interface AuthorizationRow extends Record<string, unknown> {
  authorization_id: string;
  user_id: string;
  session_id: string;
  raw_intent_text: string;
  constraints: unknown;
  normalization: unknown;
  intent_hash: string;
  policy_id: string;
  policy_version: string;
  policy_hash: string;
  state: string;
  consumed_by_release_id: string | null;
  created_at: Date;
  updated_at: Date;
  revoked_at: Date | null;
}

/**
 * Rehydrates a stored authorization.
 *
 * Timestamps inside the constraints JSON are re-parsed through `asTimestamp`
 * rather than trusted: they came back from a mutable store, and a malformed one
 * should fail loudly here rather than quietly widen a validity window.
 */
function toRecord(row: AuthorizationRow): AuthorizationRecord {
  const constraints = row.constraints as IntentConstraints;
  const intent: AuthorizedIntent = {
    rawText: row.raw_intent_text,
    constraints: {
      ...constraints,
      notBefore: asTimestamp(String(constraints.notBefore)),
      notAfter: asTimestamp(String(constraints.notAfter)),
    },
    normalization: row.normalization as IntentNormalization,
  };

  return {
    authorizationId: row.authorization_id,
    userId: row.user_id as UserId,
    sessionId: row.session_id,
    intent,
    intentHash: asSha256Hex(row.intent_hash),
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    policyHash: asSha256Hex(row.policy_hash),
    state: row.state as AuthorizationState,
    createdAt: timestampFromDate(row.created_at),
    revokedAt: row.revoked_at === null ? null : timestampFromDate(row.revoked_at),
    consumedByReleaseId: row.consumed_by_release_id,
  };
}

const SELECT = `
  SELECT authorization_id, user_id, session_id, raw_intent_text, constraints,
         normalization, intent_hash, policy_id, policy_version, policy_hash,
         state, consumed_by_release_id, created_at, updated_at, revoked_at
  FROM authorizations`;

export class PostgresAuthorizationRepository implements AuthorizationRepository {
  constructor(private readonly db: Queryable) {}

  async insert(record: AuthorizationRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO authorizations (
         authorization_id, user_id, session_id, raw_intent_text, constraints,
         normalization, intent_hash, policy_id, policy_version, policy_hash,
         state, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12,$12)`,
      [
        record.authorizationId,
        record.userId,
        record.sessionId,
        record.intent.rawText,
        JSON.stringify(record.intent.constraints),
        JSON.stringify(record.intent.normalization),
        record.intentHash,
        record.policyId,
        record.policyVersion,
        record.policyHash,
        record.state,
        record.createdAt,
      ],
    );
  }

  async findById(id: AuthorizationId): Promise<AuthorizationRecord | null> {
    const rows = await this.db.query<AuthorizationRow>(`${SELECT} WHERE authorization_id = $1`, [
      id,
    ]);
    return rows.length === 0 ? null : toRecord(rows[0]!);
  }

  /** Atomic compare-and-set. Null means the authorization was not in `from`. */
  async transition(
    id: AuthorizationId,
    from: readonly AuthorizationState[],
    to: AuthorizationState,
    patch: { consumedByReleaseId?: ReleaseId; revokedAt?: Timestamp },
  ): Promise<AuthorizationRecord | null> {
    const rows = await this.db.query<AuthorizationRow>(
      `UPDATE authorizations SET
         state = $3,
         consumed_by_release_id = COALESCE($4, consumed_by_release_id),
         revoked_at = COALESCE($5, revoked_at),
         updated_at = NOW()
       WHERE authorization_id = $1 AND state = ANY($2::text[])
       RETURNING authorization_id, user_id, session_id, raw_intent_text, constraints,
                 normalization, intent_hash, policy_id, policy_version, policy_hash,
                 state, consumed_by_release_id, created_at, updated_at, revoked_at`,
      [id, [...from], to, patch.consumedByReleaseId ?? null, patch.revokedAt ?? null],
    );
    return rows.length === 0 ? null : toRecord(rows[0]!);
  }
}
