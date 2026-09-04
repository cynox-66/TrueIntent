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

export type {
  EvidenceTimelineResponse,
  OperatorQueueItem,
  OperatorQueueResponse,
  OperatorQueueReview,
  WaitingOn,
} from '@capturelock/api-contracts';
export type { EvidenceEnvelope } from '@capturelock/evidence';
export type { Gate, Money, ReleaseState, ReviewState, Timestamp, Verdict };

/** One row of `GET /v1/releases/:id`'s `evaluations`. */
export interface EvaluationSummary {
  readonly evaluationId: string;
  readonly gate: Gate;
  readonly verdict: Verdict;
  readonly reasonCodes: readonly string[];
  readonly decisionHash: string;
  readonly evaluatedAt: Timestamp;
}

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
  readonly evaluations: readonly EvaluationSummary[];
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
