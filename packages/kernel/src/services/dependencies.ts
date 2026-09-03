/**
 * The dependency bundles services are constructed with.
 *
 * There are deliberately two of them. `CoreDependencies` has no payment
 * provider in it at all; only `PaymentDependencies` does. That means a service
 * built from `CoreDependencies` — the quote service, the review service, the
 * webhook service — *cannot* call the provider, because it has no reference to
 * one. Enforcement is structural rather than a rule someone has to remember,
 * and an architecture test asserts that only the two services that need it are
 * given the wider bundle.
 */

import type { Clock, MerchantStateProvider, PaymentReader } from '@capturelock/core';
import type { AdvisoryReviewer } from '../advisory.js';
import type { GrantedPaymentExecutor } from '../payment-executor.js';
import type { Repositories, UnitOfWork } from './unit-of-work.js';

export interface KernelConfig {
  /** How long a verified snapshot stays redeemable. */
  readonly snapshotTtlSeconds: number;
  /** Release attempts permitted inside the velocity window before pausing. */
  readonly maxAttemptsInWindow: number;
  readonly velocityWindowSeconds: number;
  /** How long a release may sit mid-provider-call before the sweep reconciles it. */
  readonly reconcileAfterSeconds: number;
  /**
   * How long a release may sit in a transient state before the liveness sweep
   * aborts it.
   *
   * Transient states are the ones a crash can strand: the provider was
   * provably never called from them, because the write-ahead commit that
   * precedes a provider call moves out of them. Aborting frees the
   * authorization, which would otherwise be held forever by the
   * one-active-release index. See ADR-011.
   */
  readonly abandonTransientAfterSeconds: number;
  /** How long an execution grant remains usable after it is minted. */
  readonly grantTtlSeconds: number;
  /**
   * How long the provider's order lookup may lag a write.
   *
   * Razorpay's `GET /v1/orders?receipt=` is eventually consistent: measured
   * against real test mode it returned nothing immediately after a create and
   * the order roughly eight seconds later. Concluding "the order does not
   * exist" from a single empty lookup would therefore mark a *real* order
   * FAILED. Reconciliation only draws that conclusion once the release has been
   * in flight longer than this window. See ADR-015.
   */
  readonly providerLookupConsistencySeconds: number;
}

export const DEFAULT_KERNEL_CONFIG: KernelConfig = Object.freeze({
  snapshotTtlSeconds: 30,
  maxAttemptsInWindow: 3,
  velocityWindowSeconds: 60,
  reconcileAfterSeconds: 30,
  abandonTransientAfterSeconds: 120,
  // Short by design: a grant is consumed within milliseconds of being minted,
  // in the same call. A generous window would only widen the replay surface.
  grantTtlSeconds: 60,
  // Comfortably beyond the ~8s lag observed against real test mode.
  providerLookupConsistencySeconds: 60,
});

/**
 * Everything a service may need that does not move money.
 *
 * Extends `Repositories` so the same set is available both directly (for reads
 * outside a transaction) and inside `unitOfWork.withTransaction`.
 */
export interface CoreDependencies extends Repositories {
  /**
   * Optional advisory intent reviewer.
   *
   * Optional because the system is complete without it: the advisory layer can
   * only restrict a verdict, never grant one, so its absence removes a check
   * rather than opening a hole. See ADR-009.
   */
  readonly advisory?: AdvisoryReviewer;
  readonly clock: Clock;
  readonly config: KernelConfig;
  readonly unitOfWork: UnitOfWork;
  readonly merchant: MerchantStateProvider;
}

/**
 * Read-only provider access.
 *
 * Reconciliation receives this and nothing more, so it *structurally cannot*
 * capture — the only thing it can do is ask the provider what already happened,
 * which is the entire point of reconciliation. See ADR-012.
 */
export interface ReconciliationDependencies extends CoreDependencies {
  readonly paymentReader: PaymentReader;
}

/**
 * The only bundle that can move money.
 *
 * `PaymentExecutor` requires an `ExecutionGrant` on every method, so possessing
 * this bundle is still not sufficient to charge anyone — a verdict is.
 */
export interface PaymentDependencies extends ReconciliationDependencies {
  readonly paymentExecutor: GrantedPaymentExecutor;
}
