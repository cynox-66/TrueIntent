/**
 * In-memory unit of work.
 *
 * Snapshots every repository's backing map before running the callback and
 * restores them on a throw. That matters: a double that silently commits
 * partial work would let an atomicity test pass for the wrong reason, and the
 * whole point of adding transactions was that a half-applied capture sequence
 * strands a release.
 *
 * The honest limit: this is atomic with respect to other tasks in *this*
 * process, because each callback runs to completion between event-loop turns
 * only if it does not await external I/O — which the release service's
 * transactions do not. It proves the application logic has the right shape. It
 * cannot prove anything about several API instances sharing a database; only
 * the Postgres suite can. See ADR-010 and ADR-011.
 */

import type { Repositories, UnitOfWork } from '@capturelock/kernel';
import type { InMemoryEvidenceLedger } from './ledger.js';
import type { InMemoryPolicyRepository } from './policy-repository.js';
import type {
  InMemoryAuthorizationRepository,
  InMemoryEvaluationRepository,
  InMemoryReleaseRepository,
  InMemoryReviewRepository,
  InMemorySnapshotRepository,
  InMemoryWebhookInboxRepository,
} from './repositories.js';

export interface InMemoryStores {
  readonly authorizations: InMemoryAuthorizationRepository;
  readonly snapshots: InMemorySnapshotRepository;
  readonly releases: InMemoryReleaseRepository;
  readonly evaluations: InMemoryEvaluationRepository;
  readonly reviews: InMemoryReviewRepository;
  readonly webhookInbox: InMemoryWebhookInboxRepository;
  readonly policies: InMemoryPolicyRepository;
  readonly evidence: InMemoryEvidenceLedger;
}

export class InMemoryUnitOfWork implements UnitOfWork {
  constructor(private readonly stores: InMemoryStores) {}

  async withTransaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T> {
    const undo = this.snapshot();
    try {
      return await fn(this.stores);
    } catch (error) {
      undo();
      throw error;
    }
  }

  /** Shallow-copies each backing map and returns a restore function. */
  private snapshot(): () => void {
    const maps: Map<unknown, unknown>[] = [
      this.stores.authorizations.rows,
      this.stores.snapshots.rows,
      this.stores.releases.rows,
      this.stores.releases.byIdempotencyKey,
      this.stores.releases.byReceipt,
      this.stores.evaluations.rows,
      this.stores.reviews.rows,
      this.stores.webhookInbox.rows,
    ];
    const copies = maps.map(map => new Map(map));
    const undoEvidence = this.stores.evidence.snapshot();

    return () => {
      maps.forEach((map, index) => {
        map.clear();
        for (const [key, value] of copies[index]!) map.set(key, value);
      });
      undoEvidence();
    };
  }
}
