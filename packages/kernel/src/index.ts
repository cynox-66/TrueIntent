/**
 * @capturelock/kernel
 *
 * The deterministic verification kernel, the release state machine, and the
 * orchestration services that sit between them. Depends only on domain ports —
 * never on Fastify, Drizzle, or any payment provider.
 */

export {
  deepFreeze,
  type ExecutionContext,
  type Principal,
  type VerificationContext,
} from './context.js';

export {
  blocked,
  completed,
  runStages,
  type StageExecution,
  type StageOutcome,
  type VerificationStage,
} from './pipeline.js';

export { MANDATORY_STAGES, combine } from './combine.js';

export { PIPELINE, evaluate, evaluateWithHashes, type KernelResult } from './kernel.js';

export { mintGrant, type ExecutionGrant, type GrantSubject } from './grant.js';

export {
  LexicalOverlapReviewer,
  applyAdvisory,
  type AdvisoryInput,
  type AdvisoryJudgement,
  type AdvisoryOutcome,
  type AdvisoryReviewer,
} from './advisory.js';

export { computeContextHash, deserializeContext, serializeContext } from './serialize.js';

export {
  InvalidTransitionError,
  TRANSITIONS,
  TRANSITION_TRIGGERS,
  graphInvariants,
  isWriteAheadTrigger,
  nextState,
  requireNextState,
  sourceStatesFor,
  type TransitionRule,
  type TransitionTrigger,
} from './release-fsm.js';

export { structuralStage } from './stages/structural.js';
export { authorityStage } from './stages/authority.js';
export { snapshotStage } from './stages/snapshot.js';
export { intentAlignmentStage } from './stages/intent.js';
export { policyStage } from './stages/policy.js';
export { freshnessStage } from './stages/freshness.js';
export { executionStage } from './stages/execution.js';

export {
  DEFAULT_KERNEL_CONFIG,
  type CoreDependencies,
  type KernelConfig,
  type PaymentDependencies,
  type ReconciliationDependencies,
} from './services/dependencies.js';

export type { Repositories, UnitOfWork } from './services/unit-of-work.js';

export {
  GrantRejectedError,
  GuardedPaymentExecutor,
  paymentReaderOf,
  type GrantedPaymentExecutor,
} from './payment-executor.js';

export {
  requestFingerprint,
  resolveContext,
  type ResolveInput,
  type ResolvedContext,
} from './services/resolve.js';

export {
  ReleaseService,
  type CaptureRequest,
  type ReleaseOutcome,
  type ReleaseRequest,
} from './services/release-service.js';

export { QuoteService, type QuoteRequest, type QuoteResult } from './services/quote-service.js';

export {
  AuthorizationService,
  type CreateAuthorizationRequest,
  type CreateAuthorizationResult,
} from './services/authorization-service.js';

export {
  WebhookService,
  type WebhookEvent,
  type WebhookResult,
} from './services/webhook-service.js';

export {
  ReconciliationService,
  type ReconciliationOutcome,
} from './services/reconciliation-service.js';

export {
  ReviewService,
  type ResolveReviewResult,
  type ReviewResolution,
} from './services/review-service.js';
