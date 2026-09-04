/**
 * The API's shapes, imported rather than restated.
 *
 * The operator responses come from `apps/api/src/routes/contracts.ts`, which
 * the route handlers are annotated with — so if the server's response drifts
 * from what this console reads, it is a compile error on the server, not a
 * blank field in the UI. Domain primitives come from `@capturelock/core` for
 * the same reason. Every import here is type-only and erases at build time;
 * nothing from the API or the kernel is bundled into the browser.
 *
 * The few interfaces declared locally are the ones the API returns as bare
 * domain records with no wrapper type of their own.
 */

import type { Gate, Money, ReleaseState, ReviewState, Timestamp, Verdict } from '@capturelock/core';
import type { EvidenceEnvelope } from '@capturelock/evidence';
// Imported rather than only re-exported: `ReleaseEvaluationSummary` is used in
// a declaration below, and a bare `export type { … } from` does not bring a
// name into local scope.
import type { ReleaseEvaluationSummary } from '@capturelock/api-contracts';

export type {
  EvaluationFinding,
  EvidenceTimelineResponse,
  OperatorQueueItem,
  OperatorQueueResponse,
  OperatorQueueReview,
  ReleaseEvaluationSummary,
  WaitingOn,
} from '@capturelock/api-contracts';
export type { EvidenceEnvelope } from '@capturelock/evidence';
export type { Gate, Money, ReleaseState, ReviewState, Timestamp, Verdict };

/** The release record, as `GET /v1/releases/:id` returns it. */
export interface ReleaseRecordView {
  readonly releaseId: string;
  readonly authorizationId: string;
  readonly snapshotId: string;
  readonly state: ReleaseState;
  readonly amount: Money;
  readonly receipt: string;
  readonly providerOrderId: string | null;
  readonly providerPaymentId: string | null;
  readonly attemptCount: number;
  readonly inFlightSince: Timestamp | null;
  readonly lastReasonCodes: readonly string[];
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
}

export interface ReleaseDetailResponse {
  readonly release: ReleaseRecordView;
  readonly evaluations: readonly ReleaseEvaluationSummary[];
}

/**
 * `GET /health`.
 *
 * Read for one field: which payment adapter the API actually constructed. A
 * console that cannot tell a deterministic fake from Razorpay test mode invites
 * exactly the misreading this project cares most about avoiding.
 */
export interface HealthResponse {
  readonly status: string;
  readonly service: string;
  readonly paymentProvider: string;
  readonly timestamp: string;
}

/**
 * `GET /v1/authorizations/:id`.
 *
 * A narrow projection, and deliberately so on the server's part: the endpoint
 * is unauthenticated, so it exposes the mandate's terms and hashes but **not**
 * `userId`, `sessionId`, or the policy id and version. This mirrors the handler
 * exactly — the console shows what the API returns and nothing it wishes were
 * there.
 *
 * `constraints` is rendered as raw JSON rather than destructured: its shape is
 * the kernel's to own, and a UI that half-understood it would be a second,
 * worse specification of the mandate.
 */
export interface AuthorizationView {
  readonly authorizationId: string;
  readonly state: string;
  readonly intentHash: string;
  readonly policyHash: string;
  readonly constraints: unknown;
  readonly rawIntent: string;
  readonly consumedByReleaseId: string | null;
}

/** `GET /v1/evidence/:id` — the envelope plus the server's replay result. */
export interface EvidenceDetailResponse {
  readonly envelope: EvidenceEnvelope;
  readonly replay: {
    readonly reproduced: boolean;
    readonly decisionHash: string | null;
  };
}

/** `GET /v1/evidence/chain/:id/verify`. */
export interface ChainVerificationResponse {
  readonly valid: boolean;
  readonly defects: readonly unknown[];
  readonly verifiedCount: number;
  readonly headChainHash: string | null;
}

/**
 * `POST /v1/releases/:id/reconcile`.
 *
 * `moneyMoved` is the field this console exists to surface. Everything else is
 * context for it.
 */
export interface ReconciliationResponse {
  readonly releaseId: string;
  readonly before: ReleaseState;
  readonly after: ReleaseState;
  readonly moneyMoved: boolean;
  readonly reasonCodes?: readonly string[];
  readonly [key: string]: unknown;
}

export type ReviewResolution = 'APPROVED' | 'REJECTED';

export interface ReviewResolutionResponse {
  readonly kind: string;
  readonly review?: {
    readonly reviewId: string;
    readonly state: ReviewState;
    readonly resolvedBy: string | null;
    readonly resolvedAt: Timestamp | null;
  };
  readonly [key: string]: unknown;
}

// ---- the buyer surface ----------------------------------------------------

/**
 * What the trusted application sends to delegate a session.
 *
 * The bounds are the user's, not the agent's: an agent that could state these
 * would be choosing its own budget. This request carries the issuer key, which
 * lives on this application and is never handed to the agent loop.
 */
export interface CreateSessionRequest {
  readonly userId: string;
  readonly purpose: string;
  readonly bounds: {
    readonly currency: string;
    readonly totalBudget: { currency: string; amountMinor: number };
    readonly maxPerPurchase: { currency: string; amountMinor: number };
    readonly merchants: { mode: 'ANY' } | { mode: 'ALLOWLIST'; merchantIds: readonly string[] };
    readonly allowedCategories: readonly string[];
    readonly forbiddenCategories: readonly string[];
    readonly itemsPerPurchase: { min: number; max: number };
    readonly recurrence: 'ONE_TIME_ONLY' | 'RECURRING_ALLOWED';
    readonly expiresAt: string;
  };
}

/**
 * What the dev demo route hands back.
 *
 * A session id and the principal to act as. Deliberately not a credential: the
 * issuer key that created the session stays on the server.
 */
export interface DemoSessionResponse {
  readonly sessionId: string;
  readonly principal: { readonly userId: string; readonly sessionId: string };
  readonly merchantId: string;
  readonly purpose: string;
  readonly bounds: {
    readonly currency: string;
    readonly totalBudget: { currency: string; amountMinor: number };
    readonly maxPerPurchase: { currency: string; amountMinor: number };
    readonly allowedCategories: readonly string[];
  };
}

/** One turn of the agent loop, and what the server did about it. */
export interface AgentStepView {
  readonly index: number;
  readonly action: { readonly action: string; readonly [key: string]: unknown } | null;
  readonly accepted: boolean;
  readonly refusedWith: string | null;
  readonly detail: string;
}

/** A candidate the agent saw. The price is indicative, and named so. */
export interface AgentObservedProduct {
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly indicativeUnitPriceMinor: number;
  readonly currency: string;
  readonly available: boolean;
  readonly availableStock: number;
}

export type AgentRunOutcomeView =
  | {
      readonly kind: 'PURCHASE_REQUESTED';
      readonly cart: readonly { sku: string; quantity: number }[];
      readonly reason: string;
      readonly catalogVersion: string;
    }
  | { readonly kind: 'ABANDONED'; readonly reason: string }
  | { readonly kind: 'FAILED'; readonly reasonCode: string; readonly detail: string };

export interface AgentRunResponse {
  readonly model: string;
  readonly outcome: AgentRunOutcomeView;
  readonly steps: readonly AgentStepView[];
  readonly observed: readonly AgentObservedProduct[];
}

/**
 * What an agent may say when asking to buy.
 *
 * There is no amount, no currency, no total and no verdict, and the server's
 * schema is strict — so adding one is a 400 rather than a value ignored.
 */
export interface PurchaseRequestBody {
  readonly merchantId: string;
  readonly lines: readonly { sku: string; quantity: number }[];
  readonly idempotencyKey: string;
  readonly rationale: string;
  readonly agentModel: string;
  readonly agentSteps: number;
  readonly agentRefusedSteps: number;
  readonly catalogVersion: string;
}

/**
 * CaptureLock's answer, or a refusal that never reached it.
 *
 * The two are distinguishable: a refusal before a mandate existed carries
 * `error` and no verdict, while a gate decision carries a verdict and reason
 * codes. Collapsing them would lose the difference between "the delegation said
 * no" and "the kernel said no", which are different failures.
 */
export interface PurchaseOutcomeResponse {
  readonly sessionId?: string;
  readonly authorizationId?: string;
  readonly snapshotId?: string;
  readonly capsuleHash?: string;
  readonly releaseId?: string | null;
  readonly verdict?: 'ALLOW' | 'PAUSE' | 'DENY';
  readonly reasonCodes?: readonly string[];
  readonly state?: ReleaseState | null;
  readonly moneyMoved?: boolean;
  readonly replayedPurchase?: boolean;
  readonly evidenceEnvelopeId?: string | null;
  /** Present only when the request was refused before verification. */
  readonly error?: string;
  readonly message?: string;
}

export type {
  AgentContextCapsuleView,
  AgentContextResponse,
  AgentSessionView,
  AgentTimelineGate,
  AgentTimelinePurchase,
  AgentTimelineResponse,
} from '@capturelock/api-contracts';
