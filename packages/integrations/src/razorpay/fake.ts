/**
 * Deterministic in-memory payment provider.
 *
 * This fake exists to be *harsh*, not convenient. It reproduces the two
 * Razorpay behaviours that break naive integrations, both verified against the
 * published API rather than assumed:
 *
 *  1. **Order `receipt` is reject-on-duplicate.** A second create with the same
 *     receipt returns an error, not the existing order. Code that "retries with
 *     the same idempotency key and reads the response" is therefore wrong for
 *     Razorpay, and this fake will not let it pass.
 *  2. **Capture is not idempotent.** Re-capturing an already-captured payment
 *     returns HTTP 400. A caller that treats that as failure will either retry
 *     forever or record a failure while the money moved.
 *
 * It also injects the failure that matters most and is hardest to reason about:
 * `TIMEOUT_AFTER_APPLY`, where the provider *does* perform the operation and
 * the response is lost. Any system that assumes "no response means nothing
 * happened" gets this wrong, and it is the whole reason the release machine has
 * indeterminate states.
 */

import { randomUUID } from 'node:crypto';
import type {
  CaptureOutcome,
  CapturePaymentRequest,
  CreateOrderOutcome,
  CreateOrderRequest,
  Money,
  PaymentProvider,
  ProviderOrder,
  ProviderPayment,
  Receipt,
  Timestamp,
} from '@capturelock/core';

export type FaultKind =
  /** The call never reached the provider. Safe to retry. */
  | 'TIMEOUT_BEFORE_APPLY'
  /** The provider applied the operation; the response was lost. NOT safe to retry. */
  | 'TIMEOUT_AFTER_APPLY'
  | 'NETWORK'
  | 'UNKNOWN_5XX';

interface Fault {
  readonly kind: FaultKind;
  /** Remaining calls this fault applies to. */
  remaining: number;
}

export interface FakeProviderOptions {
  readonly clock?: () => Timestamp;
  /**
   * Whether a duplicate receipt is rejected.
   *
   * Razorpay's default, measured against real test mode, is **false**: two
   * `orders.create` calls with the same receipt both succeed and produce two
   * distinct orders. Rejection is an opt-in account setting
   * ("Prevent duplicate order with same receipt"), so code must be correct
   * either way. Defaults to the permissive real-world behaviour precisely so
   * tests cannot accidentally rely on protection that is off by default.
   */
  readonly rejectDuplicateReceipt?: boolean;
  /**
   * Whether `findOrderByReceipt` is immediately consistent.
   *
   * Real Razorpay is not: an order was invisible to the receipt filter
   * immediately after creation and visible some seconds later. Modelling that
   * is what stops reconciliation from concluding "never created" from an empty
   * read. See ADR-015.
   */
  readonly lookupImmediatelyConsistent?: boolean;
}

export class FakePaymentProvider implements PaymentProvider {
  public readonly name = 'fake';

  /**
   * Per-instance prefix, so two providers never mint the same identifier.
   *
   * A real provider issues globally unique ids. A fake whose counter restarts
   * at 1 for every instance produces collisions the moment two instances share
   * a database — which is exactly what happened, and the `UNIQUE` constraint on
   * `releases.provider_order_id` caught it. Being unrealistic here would have
   * meant every scenario after the first failing for a reason that has nothing
   * to do with TrueIntent.
   */
  private readonly instance = randomUUID().replace(/-/g, '').slice(0, 8);

  private readonly orders = new Map<string, ProviderOrder>();
  private readonly ordersByReceipt = new Map<string, string>();
  private readonly payments = new Map<string, ProviderPayment>();
  private readonly clock: () => Timestamp;
  private readonly rejectDuplicateReceipt: boolean;
  private lookupImmediatelyConsistent: boolean;
  /** Receipts written but not yet visible to a lookup, modelling index lag. */
  private readonly notYetIndexed = new Set<string>();

  private orderFault: Fault | null = null;
  private captureFault: Fault | null = null;

  /** Every call, in order, for assertions about how many times money was touched. */
  public readonly calls: { method: string; argument: string }[] = [];

  private sequence = 0;

  constructor(options: FakeProviderOptions = {}) {
    this.clock = options.clock ?? (() => new Date().toISOString() as Timestamp);
    this.rejectDuplicateReceipt = options.rejectDuplicateReceipt ?? false;
    this.lookupImmediatelyConsistent = options.lookupImmediatelyConsistent ?? true;
  }

  // ---- test control -------------------------------------------------------

  failNextOrderWith(kind: FaultKind, times = 1): void {
    this.orderFault = { kind, remaining: times };
  }

  failNextCaptureWith(kind: FaultKind, times = 1): void {
    this.captureFault = { kind, remaining: times };
  }

  /** Seeds an authorized payment, as a hosted checkout would produce. */
  seedAuthorizedPayment(orderId: string, amount: Money): ProviderPayment {
    this.sequence += 1;
    const payment: ProviderPayment = {
      paymentId: `pay_fake_${this.instance}_${this.sequence}`,
      orderId,
      amount,
      status: 'authorized',
    };
    this.payments.set(payment.paymentId, payment);
    return payment;
  }

  seedPayment(payment: ProviderPayment): void {
    this.payments.set(payment.paymentId, payment);
  }

  capturedCount(): number {
    return [...this.payments.values()].filter(p => p.status === 'captured').length;
  }

  orderCount(): number {
    return this.orders.size;
  }

  callCount(method: string): number {
    return this.calls.filter(c => c.method === method).length;
  }

  // ---- provider interface -------------------------------------------------

  async createOrder(request: CreateOrderRequest): Promise<CreateOrderOutcome> {
    this.calls.push({ method: 'createOrder', argument: request.receipt });
    const fault = this.takeFault('order');

    if (fault === 'TIMEOUT_BEFORE_APPLY' || fault === 'NETWORK') {
      return { kind: 'INDETERMINATE', cause: fault === 'NETWORK' ? 'NETWORK' : 'TIMEOUT' };
    }

    // Only when the account setting is on. Razorpay's *default*, verified
    // against real test mode, is to accept the duplicate and create a second
    // order — which is why the release machine has no edge that would retry a
    // create.
    if (this.rejectDuplicateReceipt && this.ordersByReceipt.has(request.receipt)) {
      if (fault === 'TIMEOUT_AFTER_APPLY' || fault === 'UNKNOWN_5XX') {
        return {
          kind: 'INDETERMINATE',
          cause: fault === 'UNKNOWN_5XX' ? 'UNKNOWN_5XX' : 'TIMEOUT',
        };
      }
      return { kind: 'DUPLICATE_RECEIPT', receipt: request.receipt };
    }

    this.sequence += 1;
    const order: ProviderOrder = {
      orderId: `order_fake_${this.instance}_${this.sequence}`,
      receipt: request.receipt,
      amount: request.amount,
      status: 'created',
      createdAt: this.clock(),
    };
    this.orders.set(order.orderId, order);
    // Last write wins, mirroring a real duplicate: both orders exist, and a
    // lookup by receipt surfaces one of them.
    this.ordersByReceipt.set(request.receipt, order.orderId);
    if (!this.lookupImmediatelyConsistent) this.notYetIndexed.add(request.receipt);

    // The order now exists but the caller will never learn its id from this
    // response. Only a lookup can recover it.
    if (fault === 'TIMEOUT_AFTER_APPLY' || fault === 'UNKNOWN_5XX') {
      return { kind: 'INDETERMINATE', cause: fault === 'UNKNOWN_5XX' ? 'UNKNOWN_5XX' : 'TIMEOUT' };
    }

    return { kind: 'CREATED', order };
  }

  async findOrderByReceipt(receipt: Receipt): Promise<ProviderOrder | null> {
    this.calls.push({ method: 'findOrderByReceipt', argument: receipt });
    if (this.notYetIndexed.has(receipt)) return null;
    const orderId = this.ordersByReceipt.get(receipt);
    return orderId === undefined ? null : (this.orders.get(orderId) ?? null);
  }

  /** Test control: makes previously written receipts visible to lookups. */
  indexPendingReceipts(): void {
    this.notYetIndexed.clear();
  }

  /** Test control: models the provider's read-after-write lag on receipt search. */
  setLookupImmediatelyConsistent(value: boolean): void {
    this.lookupImmediatelyConsistent = value;
  }

  async capturePayment(request: CapturePaymentRequest): Promise<CaptureOutcome> {
    this.calls.push({ method: 'capturePayment', argument: request.paymentId });
    const fault = this.takeFault('capture');

    if (fault === 'TIMEOUT_BEFORE_APPLY' || fault === 'NETWORK') {
      return { kind: 'INDETERMINATE', cause: fault === 'NETWORK' ? 'NETWORK' : 'TIMEOUT' };
    }

    const payment = this.payments.get(request.paymentId);
    if (payment === undefined) {
      // INDETERMINATE, not REJECTED — matching what the live API actually does.
      //
      // Measured in Phase 3: capturing an unknown payment returns
      //   HTTP 404 {"message":"no Route matched with those values"}
      // with no Razorpay `error` envelope. That is the API gateway declining to
      // route, which is indistinguishable from a renamed route or a wrongly
      // built path — cases where the payments service may never have seen the
      // request. The adapter therefore maps it to INDETERMINATE, and a fake
      // that returned a confident REJECTED here would let tests exercise a
      // path that cannot occur against the real provider. See ADR-016.
      return { kind: 'INDETERMINATE', cause: 'UNKNOWN_5XX' };
    }

    // Only an authorized payment is capturable. Everything else is a 400, and
    // the already-captured case is called out separately because it means the
    // money DID move.
    if (payment.status === 'captured') {
      return { kind: 'ALREADY_CAPTURED', payment };
    }
    if (payment.status !== 'authorized') {
      return { kind: 'NOT_CAPTURABLE', providerStatus: payment.status };
    }

    if (payment.amount.amountMinor !== request.amount.amountMinor) {
      return {
        kind: 'REJECTED',
        code: 'BAD_REQUEST_ERROR',
        description: 'capture amount must equal the authorized amount',
      };
    }

    const captured: ProviderPayment = { ...payment, status: 'captured' };
    this.payments.set(captured.paymentId, captured);

    // Money has moved and the caller is about to be told nothing at all.
    if (fault === 'TIMEOUT_AFTER_APPLY' || fault === 'UNKNOWN_5XX') {
      return { kind: 'INDETERMINATE', cause: fault === 'UNKNOWN_5XX' ? 'UNKNOWN_5XX' : 'TIMEOUT' };
    }

    return { kind: 'CAPTURED', payment: captured };
  }

  async getPayment(paymentId: string): Promise<ProviderPayment | null> {
    this.calls.push({ method: 'getPayment', argument: paymentId });
    return this.payments.get(paymentId) ?? null;
  }

  private takeFault(which: 'order' | 'capture'): FaultKind | null {
    const fault = which === 'order' ? this.orderFault : this.captureFault;
    if (fault === null || fault.remaining <= 0) return null;
    fault.remaining -= 1;
    if (fault.remaining === 0) {
      if (which === 'order') this.orderFault = null;
      else this.captureFault = null;
    }
    return fault.kind;
  }
}
