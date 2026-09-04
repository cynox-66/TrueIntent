/**
 * Response contracts for the operator surface.
 *
 * Extracted so there is exactly one definition of these shapes. The route
 * handlers are annotated with them, which makes a drift between what the server
 * sends and what the console expects a compile error rather than a runtime
 * surprise; the console imports the same types (type-only, so nothing from the
 * API is bundled into the browser).
 *
 * Only the endpoints the console reads live here. The rest of the API returns
 * domain records directly, and inventing wrapper types for those would add a
 * layer that has to be kept in step for no benefit.
 */

import type {
  Gate,
  Money,
  ReasonCode,
  ReleaseState,
  ReviewState,
  Severity,
  StageId,
  Timestamp,
  Verdict,
} from '@capturelock/core';
import type { EvidenceEnvelope } from '@capturelock/evidence';

/**
 * Which of the two kinds of waiting this is.
 *
 * They are not interchangeable: `REVIEW` is resolved by a human decision,
 * `RECONCILIATION` by asking the provider what actually happened. An operator
 * shown the wrong one would take the wrong action.
 */
export type WaitingOn = 'REVIEW' | 'RECONCILIATION';

/** The open review attached to a queued release, when there is one. */
export interface OperatorQueueReview {
  readonly reviewId: string;
  readonly state: ReviewState;
  readonly reasonCodes: readonly string[];
  readonly createdAt: Timestamp;
}

/**
 * One row of the operator queue.
 *
 * An index entry, not a detail view: enough to triage and to navigate, and
 * nothing more. Anything further is fetched from the release, authorization and
 * evidence endpoints, which remain the source of truth for their own records.
 */
export interface OperatorQueueItem {
  readonly releaseId: string;
  readonly authorizationId: string;
  readonly state: ReleaseState;
  readonly waitingOn: WaitingOn;
  readonly amount: Money;
  readonly reasonCodes: readonly string[];
  readonly attemptCount: number;
  readonly providerOrderId: string | null;
  readonly providerPaymentId: string | null;
  readonly inFlightSince: Timestamp | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly review: OperatorQueueReview | null;
}

export interface OperatorQueueResponse {
  readonly items: readonly OperatorQueueItem[];
  readonly count: number;
  readonly limit: number;
}

/**
 * One authorization's evidence chain, in sequence.
 *
 * The envelopes are returned exactly as the ledger stores them. Replay and
 * verification are deliberately absent: `GET /v1/evidence/:id` replays and
 * `GET /v1/evidence/chain/:id/verify` verifies, and duplicating either here
 * would create a second answer to a question that must have one.
 */
export interface EvidenceTimelineResponse {
  readonly chainId: string;
  readonly head: { readonly sequence: number; readonly chainHash: string } | null;
  readonly envelopes: readonly EvidenceEnvelope[];
}

/**
 * One finding from a recorded gate evaluation.
 *
 * The detail map is the kernel's own — the same scalars the stage put in the
 * evidence envelope, carried through unchanged. It is what lets a console say
 * *what* changed ("live 549900, charged 479900") rather than only that
 * something did, without the console knowing anything about price checks.
 *
 * Restricted to canonicalizable scalars at the source, so there is nothing here
 * a UI has to defend itself against structurally.
 */
export interface EvaluationFinding {
  readonly code: ReasonCode;
  readonly severity: Severity;
  readonly stage: StageId;
  readonly message: string;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

/**
 * One row of `GET /v1/releases/:id`'s `evaluations`.
 *
 * Findings are included, and that is the point of this type existing: the
 * decision hash proves a decision was reached, and the findings are the only
 * record of *why*. Projecting codes alone left the console able to say
 * LIVE_PRICE_DIVERGED and unable to say what the two prices were, while the
 * evaluation row in the database had held both all along.
 */
export interface ReleaseEvaluationSummary {
  readonly evaluationId: string;
  readonly gate: Gate;
  readonly verdict: Verdict;
  readonly reasonCodes: readonly ReasonCode[];
  readonly findings: readonly EvaluationFinding[];
  readonly decisionHash: string;
  readonly evaluatedAt: Timestamp;
}

/**
 * `GET /v1/releases/:id/agent-context`.
 *
 * Answers the question the operator console cannot otherwise ask: *why did an
 * agent think the user wanted this?* A release created through the plain API
 * has no agentic context, and says so with `agentic: false` rather than 404 —
 * the console asks about every release it shows.
 */
export interface AgentContextCapsuleView {
  readonly capsuleVersion: number;
  readonly sessionId: string;
  readonly userId: string;
  /** The user's own words. Evidence only; no deterministic check reads it. */
  readonly intentText: string;
  readonly boundsHash: string;
  readonly merchantId: string;
  /** Which version of the catalogue the agent was looking at when it chose. */
  readonly catalogVersion: string;
  readonly lines: readonly {
    readonly sku: string;
    readonly quantity: number;
    /** Server-priced, from the snapshot. Never the agent's claim. */
    readonly unitPriceMinor: number;
    readonly name: string;
    readonly category: string;
  }[];
  readonly agentDecision: {
    readonly model: string;
    readonly steps: number;
    readonly refusedSteps: number;
    /** The agent's own justification. A judgement, clearly labelled as one. */
    readonly rationale: string;
  };
  readonly authorizationId: string;
  readonly intentHash: string;
  readonly snapshotId: string;
  readonly snapshotHash: string;
  readonly currency: string;
  readonly totalMinor: number;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly policyHash: string;
  readonly observedAt: Timestamp;
}

export interface AgentSessionView {
  readonly sessionId: string;
  readonly purpose: string;
  readonly state: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  readonly boundsHash: string;
  readonly bounds: Readonly<Record<string, unknown>>;
  readonly reservedMinor: number;
  readonly spentMinor: number;
  readonly remaining: { readonly currency: string; readonly amountMinor: number };
  readonly createdAt: Timestamp;
  readonly expiresAt: Timestamp;
}

export interface AgentContextResponse {
  readonly releaseId: string;
  /** False for a release created through the plain API. Not an error. */
  readonly agentic: boolean;
  readonly capsuleHash?: string;
  readonly settlementState?: 'RESERVED' | 'SETTLED' | 'RELEASED';
  readonly reservedMinor?: number;
  readonly capsule: AgentContextCapsuleView | null;
  readonly evidenceEnvelopeId?: string | null;
  readonly session: AgentSessionView | null;
}

/**
 * `GET /v1/sessions/:id/timeline`.
 *
 * One read that assembles what a buyer-facing screen needs: the delegation, and
 * for each purchase attempted under it, the release, both gate decisions, the
 * provider's state and the evidence chain.
 *
 * It exists because the alternative — four round trips per purchase, stitched
 * together in a browser — would put the ordering of the story in the client,
 * where it could drift from what actually happened. The server already knows
 * the order; saying it once is both simpler and harder to get wrong.
 *
 * Every field is projected from stored state. Nothing here is derived for
 * presentation, and nothing is simulated: a step that did not happen is absent
 * rather than inferred.
 */
export interface AgentTimelineGate {
  readonly gate: Gate;
  readonly verdict: Verdict;
  readonly reasonCodes: readonly ReasonCode[];
  readonly findings: readonly EvaluationFinding[];
  readonly decisionHash: string;
  readonly evaluatedAt: Timestamp;
}

export interface AgentTimelinePurchase {
  readonly authorizationId: string;
  readonly releaseId: string | null;
  readonly state: ReleaseState | null;
  /** What the server priced, not what the agent proposed. */
  readonly amount: { readonly currency: string; readonly amountMinor: number } | null;
  readonly settlementState: 'RESERVED' | 'SETTLED' | 'RELEASED';
  readonly reservedMinor: number;
  readonly capsuleHash: string;
  /** The agent's selection and rationale, from the context capsule. */
  readonly capsule: AgentContextCapsuleView | null;
  readonly gates: readonly AgentTimelineGate[];
  readonly providerOrderId: string | null;
  readonly providerPaymentId: string | null;
  /**
   * Whether the provider confirmed funds moved for this release.
   *
   * The single most important field on this response, and read from release
   * state rather than inferred from a verdict — a refusal and an unmoved payment
   * are different claims, and only the second one is a promise.
   */
  readonly moneyMoved: boolean;
  readonly evidence: {
    readonly chainId: string;
    readonly envelopeCount: number;
    readonly kinds: readonly string[];
    readonly valid: boolean;
    readonly headChainHash: string | null;
  };
  readonly createdAt: Timestamp;
}

export interface AgentTimelineResponse {
  readonly session: AgentSessionView;
  readonly purchases: readonly AgentTimelinePurchase[];
  /** Whether any purchase in this session moved money. */
  readonly anyMoneyMoved: boolean;
  /** Which payment adapter is wired, so a screen never has to guess. */
  readonly paymentProvider: string;
}
