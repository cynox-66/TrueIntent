/**
 * Postgres unit of work.
 *
 * Checks out one client, `BEGIN`s, and builds a **fresh set of repositories
 * bound to that client**. That binding is the whole point: a repository backed
 * by the pool would take a different connection and commit independently, so a
 * `withTransaction` block would silently not be a transaction at all — the
 * failure mode is invisible until a crash strands a release.
 *
 * The evidence ledger inside a transaction is built without its own transaction
 * wrapper, because it is already inside one. It still takes the per-chain
 * advisory lock, which now holds for the life of the enclosing transaction
 * rather than just the append.
 */

import type { Repositories, UnitOfWork } from '@capturelock/kernel';
import type { EvidenceSigner, EvidenceVerifier } from '@capturelock/evidence';
import { Database, type Queryable } from './client.js';
import { PostgresAuthorizationRepository } from './authorization-repository.js';
import { PostgresReleaseRepository } from './release-repository.js';
import { PostgresWebhookInboxRepository } from './webhook-inbox.js';
import { PostgresEvidenceLedger } from './evidence-ledger.js';
import {
  PostgresEvaluationRepository,
  PostgresPolicyRepository,
  PostgresReviewRepository,
  PostgresSnapshotRepository,
} from './simple-repositories.js';

export function buildRepositories(
  db: Queryable,
  signer: EvidenceSigner,
  verifier: EvidenceVerifier,
  options: { readonly ownsTransaction: boolean },
): Repositories {
  return {
    authorizations: new PostgresAuthorizationRepository(db),
    snapshots: new PostgresSnapshotRepository(db),
    releases: new PostgresReleaseRepository(db),
    evaluations: new PostgresEvaluationRepository(db),
    reviews: new PostgresReviewRepository(db),
    webhookInbox: new PostgresWebhookInboxRepository(db),
    policies: new PostgresPolicyRepository(db),
    evidence: new PostgresEvidenceLedger(db, signer, verifier, options),
  };
}

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(
    private readonly db: Database,
    private readonly signer: EvidenceSigner,
    private readonly verifier: EvidenceVerifier,
  ) {}

  async withTransaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    return this.db.transaction(async client => {
      const bound = Database.queryableOf(client);
      // `ownsTransaction: false` — the ledger must not open a nested one.
      return fn(buildRepositories(bound, this.signer, this.verifier, { ownsTransaction: false }));
    });
  }
}
