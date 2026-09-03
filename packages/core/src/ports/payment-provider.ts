/**
 * The payment provider boundary.
 *
 * Shaped around what Razorpay's API actually does, verified against its
 * documentation rather than assumed:
 *
 *  - Orders: `receipt` acts as an idempotency key, but with *reject-on-
 *    duplicate* semantics — a repeat create returns an error, not the existing
 *    order. So a retry after a timeout cannot recover the order; only a lookup
 *    by receipt can. Hence `findOrderByReceipt`.
 *  - Capture: `POST /payments/:id/capture` is *not* idempotent. Re-capturing
 *    returns HTTP 400 "already been either captured or voided". Treating that
 *    as a failure is a real bug: it either triggers a retry storm or records a
 *    failure while the money moved. Hence the explicit `ALREADY_CAPTURED`
 *    outcome, which a caller cannot ignore without a type error.
 *
 * The kernel depends on this interface, never on Razorpay. See ADR-005.
 */

import type { Money } from '../money.js';
import type { Receipt } from '../ids.js';
import type { Timestamp } from '../time.js';

export type ProviderOrderStatus = 'created' | 'attempted' | 'paid';
export type ProviderPaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';

export interface ProviderOrder {
  readonly orderId: string;
  readonly receipt: Receipt;
  readonly amount: Money;
  readonly status: ProviderOrderStatus;
  readonly createdAt: Timestamp;
}

export interface ProviderPayment {
  readonly paymentId: string;
  readonly orderId: string | null;
  readonly amount: Money;
  readonly status: ProviderPaymentStatus;
}

export interface CreateOrderRequest {
  readonly receipt: Receipt;
  readonly amount: Money;
  /** Small, non-sensitive key/value metadata. Never carries user identifiers or secrets. */
  readonly notes: Readonly<Record<string, string>>;
}

/**
 * Why `INDETERMINATE` is its own variant: a timeout tells us nothing about
 * whether the provider acted. Collapsing it into `REJECTED` would let a caller
 * conclude "no order was created" from evidence that says no such thing.
 */
export type ProviderIndeterminateCause = 'TIMEOUT' | 'NETWORK' | 'UNKNOWN_5XX';

export type CreateOrderOutcome =
  | { readonly kind: 'CREATED'; readonly order: ProviderOrder }
  | { readonly kind: 'DUPLICATE_RECEIPT'; readonly receipt: Receipt }
  | { readonly kind: 'REJECTED'; readonly code: string; readonly description: string }
  | { readonly kind: 'INDETERMINATE'; readonly cause: ProviderIndeterminateCause };

export interface CapturePaymentRequest {
  readonly paymentId: string;
  readonly amount: Money;
}

export type CaptureOutcome =
  | { readonly kind: 'CAPTURED'; readonly payment: ProviderPayment }
  /** The provider says this payment was already captured or voided. Money may already have moved. */
  | { readonly kind: 'ALREADY_CAPTURED'; readonly payment: ProviderPayment | null }
  /** The payment exists but is not in a capturable state (failed, refunded, still `created`). */
  | { readonly kind: 'NOT_CAPTURABLE'; readonly providerStatus: string }
  | { readonly kind: 'REJECTED'; readonly code: string; readonly description: string }
  | { readonly kind: 'INDETERMINATE'; readonly cause: ProviderIndeterminateCause };

/**
 * The raw adapter.
 *
 * Deliberately NOT the interface application code holds. It is split below into
 * a read half and a write half, and only the write half is reachable, only with
 * a grant. An adapter implements this; the composition root wraps it and hands
 * out the halves.
 */
export interface PaymentProvider {
  /** Human-readable adapter name, recorded in evidence (e.g. "razorpay-test", "fake"). */
  readonly name: string;

  createOrder(request: CreateOrderRequest): Promise<CreateOrderOutcome>;

  /** Recovery path for a create whose response was lost. */
  findOrderByReceipt(receipt: Receipt): Promise<ProviderOrder | null>;

  capturePayment(request: CapturePaymentRequest): Promise<CaptureOutcome>;

  /** Recovery path for a capture whose response was lost. The provider is the authority. */
  getPayment(paymentId: string): Promise<ProviderPayment | null>;
}

/**
 * The read half: asking the provider what already happened.
 *
 * No grant is required because nothing here can change anything. Reconciliation
 * receives exactly this, which is why reconciliation structurally cannot
 * capture — a property worth having in the type system rather than in a comment,
 * since reconciliation runs unattended on a timer.
 */
export interface PaymentReader {
  readonly name: string;
  findOrderByReceipt(receipt: Receipt): Promise<ProviderOrder | null>;
  getPayment(paymentId: string): Promise<ProviderPayment | null>;
}

/**
 * The write half: the only way money moves.
 *
 * Every method takes a grant as its first argument. `ExecutionGrant` carries a
 * module-private brand and is minted only by the kernel, only for an ALLOW, so
 * a caller who has not been through verification cannot even express these
 * calls. Phase 1 relied on the grant being *passed alongside* the provider call;
 * this makes it a precondition of the call. See ADR-012.
 *
 * `TGrant` is a type parameter purely to keep this port in `core`, which cannot
 * import from `kernel`. The kernel instantiates it with the real grant type.
 */
export interface PaymentExecutor<TGrant> {
  readonly name: string;
  createOrder(grant: TGrant, request: CreateOrderRequest): Promise<CreateOrderOutcome>;
  capturePayment(grant: TGrant, request: CapturePaymentRequest): Promise<CaptureOutcome>;
}

export interface WebhookVerificationResult {
  readonly valid: boolean;
  /** Populated only when `valid` is true. */
  readonly eventId: string | null;
  readonly eventType: string | null;
}

export interface WebhookVerifier {
  /**
   * Verifies the signature over the *raw* request bytes.
   *
   * Takes a Buffer rather than a parsed object on purpose: re-serializing a
   * parsed body produces different bytes, and the signature would never match.
   */
  verify(
    rawBody: Buffer,
    signature: string,
    headers: Readonly<Record<string, string>>,
  ): WebhookVerificationResult;
}
