/**
 * Postgres access.
 *
 * Written against `pg` with explicit SQL rather than through a query builder.
 * The statements in the repositories are the security guarantee — a
 * compare-and-set with an explicit source-state list, an insert that relies on a
 * partial unique index — and they should be readable as SQL by anyone auditing
 * this system. A builder would add a layer of indirection between the reviewer
 * and the statement without adding safety. See ADR-010.
 */

import { Pool, type PoolClient } from 'pg';
// Imported for the `migrate()` test helper below. `migrate.ts` imports only a
// *type* from this module, so this is not a runtime cycle.
import { runMigrations } from './migrate.js';

/**
 * Anything a repository can issue SQL against.
 *
 * Repositories take this rather than a `Pool`, so the same class works both
 * outside a transaction (backed by the pool) and inside one (backed by a
 * checked-out client). Without it, a repository method called inside
 * `withTransaction` would silently run on a *different* connection and commit
 * independently — which is exactly the bug the unit of work exists to prevent.
 */
export interface Queryable {
  query<T extends Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<T[]>;
}

export interface PostgresOptions {
  readonly connectionString: string;
  readonly max?: number;
}

export class Database implements Queryable {
  private readonly pool: Pool;

  constructor(options: PostgresOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.max ?? 10,
    });
  }

  async query<T extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(text, [...values]);
    return result.rows;
  }

  /** Wraps a checked-out client so repositories can be bound to one transaction. */
  static queryableOf(client: PoolClient): Queryable {
    return {
      async query<T extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ): Promise<T[]> {
        const result = await client.query<T>(text, [...values]);
        return result.rows;
      },
    };
  }

  /**
   * Runs a function inside a transaction.
   *
   * Used where several writes must land together — appending an evidence
   * envelope while transitioning a release, for instance. A failure rolls the
   * whole thing back rather than leaving a half-recorded decision.
   */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Applies every migration, in order.
   *
   * This used to read `0001_init.sql` and nothing else, which meant the three
   * suites calling `reset()` then `migrate()` ran against a schema that was not
   * the production schema — no `idempotency_records` table, and none of the
   * indexes 0002 adds. A test double diverging from the database is the failure
   * this repository already had once; a *test schema* diverging from it is the
   * same failure one level down, and harder to notice, because nothing reads
   * as broken until a suite happens to touch the missing table.
   *
   * Delegates to the real runner rather than reimplementing the ordering, so
   * there is one definition of "the schema" and adding `0003` cannot leave this
   * behind.
   */
  async migrate(): Promise<void> {
    await runMigrations(this);
  }

  /** Test helper: drops everything so a suite starts from a known state. */
  async reset(): Promise<void> {
    await this.pool.query(`
      DROP TRIGGER IF EXISTS evidence_envelopes_append_only ON evidence_envelopes;
      DROP TRIGGER IF EXISTS evaluations_append_only ON evaluations;
      DROP TABLE IF EXISTS idempotency_records, review_requests, webhook_inbox,
        evidence_envelopes, evaluations, releases, verified_snapshots,
        authorizations, policies, schema_migrations CASCADE;
      DROP FUNCTION IF EXISTS capturelock_reject_mutation();
    `);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Postgres error code for a unique-constraint violation. */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/**
 * SQLSTATE raised by the append-only triggers.
 *
 * `RAISE EXCEPTION ... USING ERRCODE = 'restrict_violation'` maps to 23001.
 * P0001 is the default for a RAISE with no explicit code and is accepted too,
 * so a future edit to the trigger that drops the ERRCODE clause still surfaces
 * as an append-only violation rather than as an unrecognised error.
 */
export const RESTRICT_VIOLATION = '23001';

export function isAppendOnlyViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === RESTRICT_VIOLATION || code === 'P0001';
}
