/**
 * The guarded payment executor: the only object in the system that can move money.
 *
 * Phase 1 relied on the grant being *passed alongside* the provider call —
 * `ReleaseService` held a raw `PaymentProvider` and, by convention, only called
 * it after `mintGrant` returned non-null. That is three layers of discipline and
 * one type-level guarantee, and the discipline is the part that erodes.
 *
 * Here the grant is a **precondition of the call**. The raw provider is private
 * to this class; the release service holds only the executor half, and
 * reconciliation holds only the reader half. See ADR-012.
 *
 * Beyond requiring a grant, this class enforces two things the grant type alone
 * cannot:
 *
 *  - **Single use.** A consumed nonce is refused. Grants never leave the
 *    process, so an in-process set is the honest scope for this; it is replay
 *    protection within one process, not a distributed guarantee.
 *  - **Expiry.** A grant older than its TTL is refused, using the injected
 *    clock rather than an ambient one.
 *  - **Amount binding.** The amount and receipt actually sent to the provider
 *    are read off the *grant*, never off the caller's request, so a caller
 *    holding a valid grant still cannot charge a different figure.
 */

import {
  isAfter,
  type CaptureOutcome,
  type CapturePaymentRequest,
  type Clock,
  type CreateOrderOutcome,
  type CreateOrderRequest,
  type PaymentExecutor,
  type PaymentProvider,
  type PaymentReader,
  type ProviderOrder,
  type ProviderPayment,
  type Receipt,
  type Timestamp,
} from '@capturelock/core';
import type { ExecutionGrant } from './grant.js';

export type GrantedPaymentExecutor = PaymentExecutor<ExecutionGrant>;

export class GrantRejectedError extends Error {
  constructor(
    public readonly reason: 'EXPIRED' | 'ALREADY_CONSUMED' | 'RELEASE_MISMATCH',
    detail: string,
  ) {
    super(`Execution grant rejected (${reason}): ${detail}`);
    this.name = 'GrantRejectedError';
  }
}

/** Read-only view of a provider. Safe to hand to unattended background work. */
export function paymentReaderOf(provider: PaymentProvider): PaymentReader {
  return {
    name: provider.name,
    findOrderByReceipt: (receipt: Receipt): Promise<ProviderOrder | null> =>
      provider.findOrderByReceipt(receipt),
    getPayment: (paymentId: string): Promise<ProviderPayment | null> =>
      provider.getPayment(paymentId),
  };
}

export class GuardedPaymentExecutor implements GrantedPaymentExecutor {
  public readonly name: string;
  /**
   * Burned nonces, held only while they could still be replayed.
   *
   * The value is the grant's expiry. Retaining a nonce past that instant adds
   * no protection — `consume` rejects an expired grant before it ever consults
   * this set — but retaining every nonce for the life of the process is an
   * unbounded leak in a service intended to run for months. Entries are dropped
   * once expired, which cannot widen the replay window because the expiry check
   * runs first.
   */
  private readonly consumed = new Map<string, Timestamp>();

  constructor(
    private readonly provider: PaymentProvider,
    private readonly clock: Clock,
  ) {
    this.name = provider.name;
  }

  async createOrder(
    grant: ExecutionGrant,
    request: CreateOrderRequest,
  ): Promise<CreateOrderOutcome> {
    this.consume(grant, 'createOrder');
    return this.provider.createOrder({
      // Read off the grant, not the request: a caller holding a valid grant
      // still cannot substitute a different amount or receipt.
      receipt: grant.receipt,
      amount: grant.amount,
      notes: request.notes,
    });
  }

  async capturePayment(
    grant: ExecutionGrant,
    request: CapturePaymentRequest,
  ): Promise<CaptureOutcome> {
    this.consume(grant, 'capturePayment');
    return this.provider.capturePayment({
      paymentId: request.paymentId,
      amount: grant.amount,
    });
  }

  /**
   * Validates and burns a grant.
   *
   * Throws rather than returning a result: reaching here with an invalid grant
   * is a programming error or an attack, and neither should be recoverable into
   * a provider call. The release service treats a throw the same as any other
   * failure before the write-ahead — no money moves.
   */
  private consume(grant: ExecutionGrant, operation: string): void {
    const now = this.clock.now();
    if (isAfter(now, grant.expiresAt)) {
      throw new GrantRejectedError(
        'EXPIRED',
        `${operation} for release ${grant.releaseId} presented a grant that expired at ${grant.expiresAt}`,
      );
    }
    if (this.consumed.has(grant.nonce)) {
      throw new GrantRejectedError(
        'ALREADY_CONSUMED',
        `${operation} for release ${grant.releaseId} presented an already-used grant`,
      );
    }
    this.consumed.set(grant.nonce, grant.expiresAt);
    this.evictExpired(now);
  }

  /**
   * Drops nonces whose grants can no longer be presented.
   *
   * Swept on write rather than on a timer, so the executor owns no background
   * work and stays trivially testable.
   */
  private evictExpired(now: Timestamp): void {
    for (const [nonce, expiresAt] of this.consumed) {
      if (isAfter(now, expiresAt)) this.consumed.delete(nonce);
    }
  }

  /** Test helper: how many burned grants are still being remembered. */
  consumedCount(): number {
    return this.consumed.size;
  }
}
