/**
 * The release: one attempt to move money under one authorization.
 *
 * Phase 0 modelled verdicts (ALLOW/PAUSE/DENY) as *states* of a session. That
 * conflates two different things: a verdict is the output of an evaluation, and
 * an authorization may be evaluated more than once. "The session is in state
 * ALLOW" becomes meaningless as soon as a second evaluation says DENY.
 *
 * So three lifecycles are kept apart:
 *   - the authorization (a mandate: ACTIVE -> CONSUMED / REVOKED / EXPIRED)
 *   - the release (this file: the money-movement state machine)
 *   - the evaluation (an immutable event with no lifecycle at all)
 */

import { z } from 'zod';
import type { Sha256Hex } from '../canonical.js';
import type { CurrencyCode, Money } from '../money.js';
import type { Timestamp } from '../time.js';
import type { AuthorizationId, IdempotencyKey, Receipt, ReleaseId, SnapshotId } from '../ids.js';

/**
 * Release states.
 *
 * The two states Phase 0 lacked, and which matter most, are the `*_IN_FLIGHT`
 * pair and the `*_INDETERMINATE` pair. A system without them cannot answer
 * "we sent the request and never heard back" — it either forgets that money may
 * have moved, or retries blindly and moves it twice.
 */
export const RELEASE_STATES = [
  'DRAFT',
  'VERIFYING',
  'VERIFIED',
  'ORDER_IN_FLIGHT',
  'ORDER_CREATED',
  'ORDER_INDETERMINATE',
  'PAYMENT_AUTHORIZED',
  'CAPTURE_VERIFYING',
  'CAPTURE_APPROVED',
  'CAPTURE_IN_FLIGHT',
  'CAPTURE_INDETERMINATE',
  'CAPTURED',
  'SETTLED',
  'PAUSED',
  'DENIED',
  'CAPTURE_REJECTED',
  'FAILED',
  'ABORTED',
] as const;

export type ReleaseState = (typeof RELEASE_STATES)[number];

export const ReleaseStateSchema = z.enum(RELEASE_STATES);

/**
 * Terminal states. No transition leaves these, and the FSM enforces it.
 *
 * `CAPTURED` is deliberately *not* terminal: money has moved, but the provider
 * has not yet confirmed settlement, and we want that confirmation recorded.
 */
export const TERMINAL_RELEASE_STATES = [
  'SETTLED',
  'DENIED',
  'CAPTURE_REJECTED',
  'FAILED',
  'ABORTED',
] as const satisfies readonly ReleaseState[];

export function isTerminalReleaseState(state: ReleaseState): boolean {
  return (TERMINAL_RELEASE_STATES as readonly ReleaseState[]).includes(state);
}

/**
 * States in which a provider call may already have taken effect.
 *
 * Recovery must never assume "no response" means "nothing happened": the only
 * safe action from here is to ask the provider what it knows.
 */
export const INDETERMINATE_RELEASE_STATES = [
  'ORDER_IN_FLIGHT',
  'ORDER_INDETERMINATE',
  'CAPTURE_IN_FLIGHT',
  'CAPTURE_INDETERMINATE',
] as const satisfies readonly ReleaseState[];

export function requiresReconciliation(state: ReleaseState): boolean {
  return (INDETERMINATE_RELEASE_STATES as readonly ReleaseState[]).includes(state);
}

/**
 * States a crash can strand, from which the provider was provably never called.
 *
 * Each is entered before a write-ahead commit and left by one, so a release
 * sitting here means the commit that precedes a provider call did not happen.
 * That is what makes it safe for the liveness sweep to abort them. They are
 * distinct from the indeterminate states above, where a call may well have
 * taken effect and only the provider can say.
 */
export const TRANSIENT_RELEASE_STATES = [
  'DRAFT',
  'VERIFYING',
  'VERIFIED',
  'CAPTURE_VERIFYING',
  'CAPTURE_APPROVED',
] as const satisfies readonly ReleaseState[];

export function isTransientReleaseState(state: ReleaseState): boolean {
  return (TRANSIENT_RELEASE_STATES as readonly ReleaseState[]).includes(state);
}

/** States in which money has certainly left the payer. */
export function moneyHasMoved(state: ReleaseState): boolean {
  return state === 'CAPTURED' || state === 'SETTLED';
}

export interface ReleaseRecord {
  readonly releaseId: ReleaseId;
  readonly authorizationId: AuthorizationId;
  readonly snapshotId: SnapshotId;
  readonly state: ReleaseState;
  /** Agent-chosen. Dedups requests; cannot bound money movement on its own. */
  readonly clientIdempotencyKey: IdempotencyKey;
  /**
   * Digest of the materially significant request fields.
   *
   * If the same idempotency key returns with a different fingerprint, the agent
   * is either buggy or attempting to smuggle a changed cart through a key that
   * already has a stored answer.
   */
  readonly requestFingerprint: Sha256Hex;
  /** Server-derived from (authorizationId, snapshotHash). The provider-side dedup token. */
  readonly receipt: Receipt;
  readonly amount: Money;
  readonly currency: CurrencyCode;
  readonly providerOrderId: string | null;
  readonly providerPaymentId: string | null;
  readonly attemptCount: number;
  readonly inFlightSince: Timestamp | null;
  readonly createdAt: Timestamp;
  readonly updatedAt: Timestamp;
  readonly lastReasonCodes: readonly string[];
}
