/**
 * @capturelock/persistence
 *
 * Repository implementations. The in-memory set backs the offline suite; the
 * Postgres set (schema and adapters) is what the concurrency suite runs
 * against.
 */

export {
  InMemoryAuthorizationRepository,
  InMemoryEvaluationRepository,
  InMemoryReleaseRepository,
  InMemoryReviewRepository,
  InMemorySnapshotRepository,
  InMemoryWebhookInboxRepository,
} from './memory/repositories.js';

export { InMemorySessionAuthorityRepository } from './memory/session-repository.js';
export { InMemoryEvidenceLedger } from './memory/ledger.js';
export { InMemoryUnitOfWork, type InMemoryStores } from './memory/unit-of-work.js';
export { InMemoryPolicyRepository } from './memory/policy-repository.js';

export {
  Database,
  RESTRICT_VIOLATION,
  UNIQUE_VIOLATION,
  isAppendOnlyViolation,
  isUniqueViolation,
  type PostgresOptions,
} from './postgres/client.js';

export { PostgresReleaseRepository } from './postgres/release-repository.js';
export { PostgresWebhookInboxRepository } from './postgres/webhook-inbox.js';
export { PostgresEvidenceLedger } from './postgres/evidence-ledger.js';
export { PostgresAuthorizationRepository } from './postgres/authorization-repository.js';
export { PostgresSessionAuthorityRepository } from './postgres/session-repository.js';
export {
  PostgresEvaluationRepository,
  PostgresPolicyRepository,
  PostgresReviewRepository,
  PostgresSnapshotRepository,
} from './postgres/simple-repositories.js';
export { PostgresUnitOfWork, buildRepositories } from './postgres/unit-of-work.js';
export { runMigrations } from './postgres/migrate.js';
