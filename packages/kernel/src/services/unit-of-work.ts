/**
 * Transaction boundaries.
 *
 * Phase 1 had no transaction abstraction at all, and the capture path paid for
 * it: three sequential `transition()` calls plus two appends, each its own
 * autocommit. A crash between them left the release in `CAPTURE_VERIFYING` or
 * `CAPTURE_APPROVED` — neither of which the reconciliation sweep can see, and
 * both of which hold the authorization's one-active-release slot forever. The
 * partial unique index that gives us at-most-once was, without this, also a way
 * to permanently brick a mandate. See ADR-011.
 *
 * The callback receives **transaction-scoped repositories** rather than a `tx`
 * handle threaded through every method signature. The handle approach is
 * trivially forgotten at exactly one call site, and the one that matters is the
 * one that moves money.
 */

import type {
  AuthorizationRepository,
  EvaluationRepository,
  ReleaseRepository,
  ReviewRepository,
  SnapshotRepository,
  WebhookInboxRepository,
} from '@capturelock/core';
import type { EvidenceLedger } from '@capturelock/evidence';
import type { PolicyRepository } from '@capturelock/policy';

/** Every store that may participate in a transaction. */
export interface Repositories {
  readonly authorizations: AuthorizationRepository;
  readonly snapshots: SnapshotRepository;
  readonly releases: ReleaseRepository;
  readonly evaluations: EvaluationRepository;
  readonly reviews: ReviewRepository;
  readonly webhookInbox: WebhookInboxRepository;
  readonly policies: PolicyRepository;
  readonly evidence: EvidenceLedger;
}

export interface UnitOfWork {
  /**
   * Runs `fn` inside one transaction.
   *
   * Everything written through the repositories handed to `fn` commits together
   * or not at all. A throw rolls back and re-throws: a caller must never be able
   * to interpret a failed transaction as a partial success.
   */
  withTransaction<T>(fn: (repos: Repositories) => Promise<T>): Promise<T>;
}
