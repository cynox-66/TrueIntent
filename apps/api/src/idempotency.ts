/**
 * Request-scoped idempotency.
 *
 * Distinct from the release-scoped key on `releases.client_idempotency_key`, and
 * the two answer different questions:
 *
 *   release-scoped   has this authorization already been spent under this key?
 *                    Read by the kernel's execution stage. Enforced by a unique
 *                    index. Covers only endpoints that create a release.
 *
 *   request-scoped   has this HTTP request already been answered? Covers every
 *                    mutating endpoint, returns the *same bytes* on a replay,
 *                    and survives a process restart mid-request because the
 *                    IN_FLIGHT row commits before the work begins.
 *
 * Keeping both is not redundancy. Dropping the release-scoped layer would let a
 * caller vary its key to get a second charge; dropping this one would mean a
 * client that retries after a timeout has no way to learn what happened. See
 * ADR-013.
 *
 * The deliberate non-goal: this does not make a *provider* call idempotent.
 * Razorpay's capture is not idempotent and no amount of application bookkeeping
 * changes that — which is why the release state machine, not this table, is what
 * prevents a double capture.
 */

import { createHash } from 'node:crypto';
import type { Database } from '@capturelock/persistence';

export type IdempotencyStatus = 'IN_FLIGHT' | 'COMPLETED';

export interface IdempotencyRecord {
  readonly key: string;
  readonly route: string;
  readonly fingerprint: string;
  readonly status: IdempotencyStatus;
  readonly statusCode: number | null;
  readonly response: unknown;
}

export type ClaimResult =
  /** This caller owns the request and must do the work. */
  | { readonly kind: 'CLAIMED' }
  /** Already answered, with the same input. Replay the stored response verbatim. */
  | { readonly kind: 'REPLAY'; readonly statusCode: number; readonly response: unknown }
  /** Same key, different input. An attempt to get new input charged under an old answer. */
  | { readonly kind: 'FINGERPRINT_MISMATCH' }
  /** Another request holds this key right now. */
  | { readonly kind: 'IN_FLIGHT' };

export interface IdempotencyStore {
  claim(key: string, route: string, fingerprint: string): Promise<ClaimResult>;
  complete(key: string, statusCode: number, response: unknown): Promise<void>;
  /** Releases a claim whose work failed, so a retry is not blocked forever. */
  abandon(key: string): Promise<void>;
  find(key: string): Promise<IdempotencyRecord | null>;
}

/**
 * Digest of everything that makes two requests materially the same.
 *
 * The principal is included: the same key presented by a different user is a
 * different request, and must not replay someone else's answer.
 */
export function fingerprintOf(
  route: string,
  body: unknown,
  principal: { userId: string; sessionId: string } | null,
): string {
  return createHash('sha256')
    .update('capturelock.v1.http_request')
    .update(Buffer.of(0x00))
    .update(route)
    .update(Buffer.of(0x00))
    .update(JSON.stringify(body ?? null))
    .update(Buffer.of(0x00))
    .update(principal === null ? '' : `${principal.userId}:${principal.sessionId}`)
    .digest('hex');
}

// ------------------------------------------------------------------ postgres

interface Row extends Record<string, unknown> {
  key: string;
  route: string;
  fingerprint: string;
  status: string;
  status_code: number | null;
  response: unknown;
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Database) {}

  /**
   * Claims a key.
   *
   * `INSERT … ON CONFLICT DO NOTHING` against a primary key, so under two
   * concurrent requests with the same key exactly one is told CLAIMED. A prior
   * `SELECT` would race precisely here.
   */
  async claim(key: string, route: string, fingerprint: string): Promise<ClaimResult> {
    const inserted = await this.db.query<Row>(
      `INSERT INTO idempotency_records (key, route, fingerprint, status)
       VALUES ($1,$2,$3,'IN_FLIGHT')
       ON CONFLICT (key) DO NOTHING
       RETURNING key, route, fingerprint, status, status_code, response`,
      [key, route, fingerprint],
    );
    if (inserted.length === 1) return { kind: 'CLAIMED' };

    const existing = await this.find(key);
    if (existing === null) return { kind: 'CLAIMED' };
    if (existing.fingerprint !== fingerprint) return { kind: 'FINGERPRINT_MISMATCH' };
    if (existing.status === 'IN_FLIGHT') return { kind: 'IN_FLIGHT' };
    return { kind: 'REPLAY', statusCode: existing.statusCode ?? 200, response: existing.response };
  }

  async complete(key: string, statusCode: number, response: unknown): Promise<void> {
    await this.db.query(
      `UPDATE idempotency_records
       SET status = 'COMPLETED', status_code = $2, response = $3::jsonb, completed_at = NOW()
       WHERE key = $1`,
      [key, statusCode, JSON.stringify(response ?? null)],
    );
  }

  async abandon(key: string): Promise<void> {
    await this.db.query(`DELETE FROM idempotency_records WHERE key = $1 AND status = 'IN_FLIGHT'`, [
      key,
    ]);
  }

  async find(key: string): Promise<IdempotencyRecord | null> {
    const rows = await this.db.query<Row>(
      `SELECT key, route, fingerprint, status, status_code, response
       FROM idempotency_records WHERE key = $1`,
      [key],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          key: row.key,
          route: row.route,
          fingerprint: row.fingerprint,
          status: row.status as IdempotencyStatus,
          statusCode: row.status_code,
          response: row.response,
        };
  }
}

// ----------------------------------------------------------------- in-memory

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<string, IdempotencyRecord>();

  async claim(key: string, route: string, fingerprint: string): Promise<ClaimResult> {
    // Read and write in one synchronous block, with no interleaving point, so
    // this models the database's atomic insert rather than merely resembling it.
    const existing = this.rows.get(key);
    if (existing === undefined) {
      this.rows.set(key, {
        key,
        route,
        fingerprint,
        status: 'IN_FLIGHT',
        statusCode: null,
        response: null,
      });
      return { kind: 'CLAIMED' };
    }
    if (existing.fingerprint !== fingerprint) return { kind: 'FINGERPRINT_MISMATCH' };
    if (existing.status === 'IN_FLIGHT') return { kind: 'IN_FLIGHT' };
    return { kind: 'REPLAY', statusCode: existing.statusCode ?? 200, response: existing.response };
  }

  async complete(key: string, statusCode: number, response: unknown): Promise<void> {
    const existing = this.rows.get(key);
    if (existing === undefined) return;
    this.rows.set(key, { ...existing, status: 'COMPLETED', statusCode, response });
  }

  async abandon(key: string): Promise<void> {
    const existing = this.rows.get(key);
    if (existing?.status === 'IN_FLIGHT') this.rows.delete(key);
  }

  async find(key: string): Promise<IdempotencyRecord | null> {
    return this.rows.get(key) ?? null;
  }
}
