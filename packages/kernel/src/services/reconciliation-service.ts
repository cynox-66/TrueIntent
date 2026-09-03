/**
 * Reconciliation: resolving releases whose provider call left us in the dark.
 *
 * The rule this service exists to enforce is that **"no response" is never
 * treated as "nothing happened"**. A release sitting in an in-flight or
 * indeterminate state is resolved by *asking the provider what it knows*, never
 * by retrying the operation.
 *
 * That distinction is not academic for Razorpay specifically:
 *
 *  - Retrying `orders.create` with the same receipt returns a duplicate error,
 *    not the order, so a retry cannot recover the order id. `GET /orders?receipt=`
 *    can.
 *  - Retrying a capture is not idempotent. If the first capture succeeded and
 *    the response was lost, a retry either double-charges on a provider that
 *    permits it, or returns a 400 that naive code reads as failure while the
 *    money has already moved. Reading the payment tells the truth.
 */

import {
  addSeconds,
  millisBetween,
  moneyHasMoved,
  type ReleaseRecord,
  type ReleaseState,
} from '@capturelock/core';
import { nextState } from '../release-fsm.js';
import type { ReconciliationDependencies } from './dependencies.js';

export interface ReconciliationOutcome {
  readonly releaseId: string;
  readonly before: ReleaseState;
  readonly after: ReleaseState;
  readonly moneyMoved: boolean;
  readonly resolvedBy: 'ORDER_LOOKUP' | 'PAYMENT_LOOKUP' | 'ABANDONED' | 'NOT_RESOLVED';
}

export class ReconciliationService {
  /**
   * Note the dependency type: `ReconciliationDependencies` carries a
   * `paymentReader` and no executor at all. This service runs unattended on a
   * timer, and it *structurally cannot* capture — the only provider methods it
   * can reach are the ones that ask what already happened. See ADR-012.
   */
  constructor(private readonly deps: ReconciliationDependencies) {}

  /**
   * Resolves every release that has been mid-call longer than the configured window.
   *
   * The age filter matters. Phase 1 passed `now` as the cutoff, so a release
   * whose provider call started a millisecond ago was eligible — a background
   * sweeper would have raced live captures and asked the provider about a call
   * still in flight. `reconcileAfterSeconds` was declared but never read.
   */
  async sweep(limit = 50): Promise<readonly ReconciliationOutcome[]> {
    const cutoff = addSeconds(this.deps.clock.now(), -this.deps.config.reconcileAfterSeconds);
    const stuck = await this.deps.releases.findRequiringReconciliation(cutoff, limit);
    const results: ReconciliationOutcome[] = [];
    for (const release of stuck) {
      results.push(await this.reconcile(release));
    }
    return results;
  }

  /**
   * Aborts releases abandoned in a transient state.
   *
   * These provably never reached the provider, so no money is at stake — but
   * each one holds its authorization's only active-release slot, so leaving
   * them would permanently prevent that mandate from ever being spent. This is
   * a liveness fix for a hazard the safety index itself creates.
   */
  async sweepAbandoned(limit = 50): Promise<readonly ReconciliationOutcome[]> {
    const cutoff = addSeconds(
      this.deps.clock.now(),
      -this.deps.config.abandonTransientAfterSeconds,
    );
    const abandoned = await this.deps.releases.findAbandonedInTransientState(cutoff, limit);

    const results: ReconciliationOutcome[] = [];
    for (const release of abandoned) {
      const target = nextState(release.state, 'ABORT');
      if (target === null) continue;

      const updated = await this.deps.unitOfWork.withTransaction(async repos => {
        const next = await repos.releases.transition(
          release.releaseId,
          [release.state],
          target,
          { inFlightSince: null, lastReasonCodes: ['RELEASE_ABANDONED'] },
          this.deps.clock.now(),
        );
        if (next !== null) {
          await repos.evidence.append({
            chainId: release.authorizationId,
            kind: 'RELEASE_TRANSITION',
            recordedAt: this.deps.clock.now(),
            body: {
              releaseId: release.releaseId,
              reason: 'ABANDONED_IN_TRANSIENT_STATE',
              before: release.state,
              after: target,
              providerWasCalled: false,
            },
          });
        }
        return next;
      });

      results.push({
        releaseId: release.releaseId,
        before: release.state,
        after: updated?.state ?? release.state,
        moneyMoved: false,
        resolvedBy: 'ABANDONED',
      });
    }
    return results;
  }

  async reconcileById(
    releaseId: ReleaseRecord['releaseId'],
  ): Promise<ReconciliationOutcome | null> {
    const release = await this.deps.releases.findById(releaseId);
    if (release === null) return null;
    return this.reconcile(release);
  }

  private async reconcile(release: ReleaseRecord): Promise<ReconciliationOutcome> {
    const before = release.state;

    if (before === 'ORDER_IN_FLIGHT' || before === 'ORDER_INDETERMINATE') {
      const order = await this.deps.paymentReader.findOrderByReceipt(release.receipt);

      if (order === null && !this.pastLookupConsistencyWindow(release)) {
        // An empty lookup is NOT proof of absence. Razorpay's receipt search is
        // eventually consistent — measured against real test mode it returned
        // nothing immediately after a create and the order some seconds later.
        // Concluding FAILED here would strand an order that exists, and would
        // invite a later attempt to create a duplicate. Staying indeterminate
        // is the honest answer until the lag window has passed. See ADR-015.
        return {
          releaseId: release.releaseId,
          before,
          after: before,
          moneyMoved: false,
          resolvedBy: 'NOT_RESOLVED',
        };
      }

      const trigger = order === null ? 'ORDER_RECONCILED_ABSENT' : 'ORDER_RECONCILED_FOUND';
      const after = await this.apply(release, trigger, {
        providerOrderId: order?.orderId ?? null,
        inFlightSince: null,
      });
      await this.record(release, before, after, 'ORDER_LOOKUP');
      return {
        releaseId: release.releaseId,
        before,
        after,
        moneyMoved: false,
        resolvedBy: 'ORDER_LOOKUP',
      };
    }

    if (before === 'CAPTURE_IN_FLIGHT' || before === 'CAPTURE_INDETERMINATE') {
      if (release.providerPaymentId === null) {
        // We recorded an intent to capture without a payment id, which should be
        // impossible. Leave it stuck rather than guessing: a human should look.
        return {
          releaseId: release.releaseId,
          before,
          after: before,
          moneyMoved: false,
          resolvedBy: 'NOT_RESOLVED',
        };
      }

      const payment = await this.deps.paymentReader.getPayment(release.providerPaymentId);
      if (payment === null) {
        // The provider is unreachable or does not know this payment. Staying
        // stuck is correct: assuming either outcome could be badly wrong.
        return {
          releaseId: release.releaseId,
          before,
          after: before,
          moneyMoved: false,
          resolvedBy: 'NOT_RESOLVED',
        };
      }

      // The provider is the authority on whether money moved. We adopt its
      // answer rather than inferring one from our own timeout.
      const captured = payment.status === 'captured';
      const after = await this.apply(
        release,
        captured ? 'CAPTURE_RECONCILED_CAPTURED' : 'CAPTURE_RECONCILED_NOT_CAPTURED',
        { inFlightSince: null },
      );

      if (captured) {
        await this.deps.authorizations.transition(release.authorizationId, ['ACTIVE'], 'CONSUMED', {
          consumedByReleaseId: release.releaseId,
        });
      }

      await this.record(release, before, after, 'PAYMENT_LOOKUP');
      return {
        releaseId: release.releaseId,
        before,
        after,
        moneyMoved: moneyHasMoved(after),
        resolvedBy: 'PAYMENT_LOOKUP',
      };
    }

    return {
      releaseId: release.releaseId,
      before,
      after: before,
      moneyMoved: moneyHasMoved(before),
      resolvedBy: 'NOT_RESOLVED',
    };
  }

  /**
   * Has this release been in flight long enough that an empty lookup means
   * something?
   *
   * Below the window, "not found" and "not yet indexed" are indistinguishable,
   * and the safe reading of an ambiguous fact is that we do not know.
   */
  private pastLookupConsistencyWindow(release: ReleaseRecord): boolean {
    if (release.inFlightSince === null) return true;
    const ageSeconds = millisBetween(release.inFlightSince, this.deps.clock.now()) / 1000;
    return ageSeconds >= this.deps.config.providerLookupConsistencySeconds;
  }

  private async apply(
    release: ReleaseRecord,
    trigger: Parameters<typeof nextState>[1],
    patch: { providerOrderId?: string | null; inFlightSince: null },
  ): Promise<ReleaseState> {
    const target = nextState(release.state, trigger);
    if (target === null) return release.state;
    const updated = await this.deps.releases.transition(
      release.releaseId,
      [release.state],
      target,
      patch,
      this.deps.clock.now(),
    );
    return updated?.state ?? release.state;
  }

  private async record(
    release: ReleaseRecord,
    before: ReleaseState,
    after: ReleaseState,
    method: string,
  ): Promise<void> {
    await this.deps.evidence.append({
      chainId: release.authorizationId,
      kind: 'RELEASE_TRANSITION',
      recordedAt: this.deps.clock.now(),
      body: {
        releaseId: release.releaseId,
        reason: 'RECONCILIATION',
        method,
        before,
        after,
        provider: this.deps.paymentReader.name,
      },
    });
  }
}
