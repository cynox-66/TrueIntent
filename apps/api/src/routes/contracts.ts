/**
 * Response contracts for the operator surface.
 *
 * Extracted so there is exactly one definition of these shapes. The route
 * handlers are annotated with them, which makes a drift between what the server
 * sends and what the console expects a compile error rather than a runtime
 * surprise; the console imports the same types (type-only, so nothing from the
 * API is bundled into the browser).
 *
 * Only the *operator* endpoints live here. The rest of the API returns domain
 * records directly, and inventing wrapper types for those would add a layer
 * that has to be kept in step for no benefit.
 */

import type { Money, ReleaseState, ReviewState, Timestamp } from '@capturelock/core';
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
