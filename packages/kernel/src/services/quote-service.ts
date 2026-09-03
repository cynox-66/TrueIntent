/**
 * Issues verified snapshots.
 *
 * The agent proposes SKUs, quantities and a destination. It does *not* propose
 * prices. The server reads live merchant state, prices every line from that
 * read, takes the merchant's own fee quote, computes the total itself, and
 * commits to the result with a hash.
 *
 * That inversion is the reason the Phase 0 `snapshotHash` was theatre and this
 * is not: previously the agent supplied both the cart and the hash of the cart,
 * so the comparison could only ever succeed. Here the agent never states an
 * amount it will be charged.
 */

import {
  addSeconds,
  computeCartTotals,
  computeSnapshotHash,
  liveItemRowHash,
  liveStateDigest,
  newSnapshotId,
  type AuthorizationId,
  type CartLine,
  type MerchantId,
  type ProposedCart,
  type Sha256Hex,
  type ShipTo,
  type Sku,
  type VerifiedSnapshot,
} from '@capturelock/core';
import type { CoreDependencies } from './dependencies.js';

export interface QuoteRequest {
  readonly authorizationId: AuthorizationId;
  readonly merchantId: MerchantId;
  readonly lines: readonly { readonly sku: Sku; readonly quantity: number }[];
  readonly shipTo: ShipTo | null;
  readonly recurring: boolean;
}

export type QuoteResult =
  | { readonly kind: 'ISSUED'; readonly snapshot: VerifiedSnapshot }
  | { readonly kind: 'AUTHORIZATION_NOT_FOUND' }
  | { readonly kind: 'LIVE_STATE_UNAVAILABLE'; readonly reason: string }
  | { readonly kind: 'ITEM_NOT_FOUND'; readonly sku: Sku };

export class QuoteService {
  constructor(private readonly deps: CoreDependencies) {}

  async issue(request: QuoteRequest): Promise<QuoteResult> {
    const authorization = await this.deps.authorizations.findById(request.authorizationId);
    if (authorization === null) return { kind: 'AUTHORIZATION_NOT_FOUND' };

    const live = await this.deps.merchant.read({
      merchantId: request.merchantId,
      lines: request.lines.map(line => ({ sku: line.sku, quantity: line.quantity })),
      shipTo: request.shipTo,
    });

    if (live.kind === 'UNAVAILABLE') {
      // No quote is issued from a merchant we could not read. Issuing one from
      // remembered prices would create exactly the stale artefact the freshness
      // stage exists to reject.
      return { kind: 'LIVE_STATE_UNAVAILABLE', reason: live.reason };
    }

    const now = this.deps.clock.now();
    const currency = authorization.intent.constraints.currency;

    const lines: CartLine[] = [];
    const rowHashes = new Map<Sku, Sha256Hex>();

    for (const requested of request.lines) {
      const item = live.state.items.get(requested.sku);
      if (item === undefined) return { kind: 'ITEM_NOT_FOUND', sku: requested.sku };

      lines.push({
        sku: item.sku,
        quantity: requested.quantity,
        // Server-priced from the live read.
        unitPrice: item.unitPrice,
        // Recorded as the merchant described the item at quote time, so a later
        // change is visible as a difference rather than being overwritten.
        asserted: {
          name: item.name,
          category: item.category,
          attributes: [...item.attributes],
        },
      });
      rowHashes.set(item.sku, liveItemRowHash(item));
    }

    const cartWithoutTotal: ProposedCart = {
      merchantId: request.merchantId,
      currency,
      lines,
      // Fees come from the merchant's quote, not from the agent.
      adjustments: [...live.state.feeQuote.adjustments],
      declaredTotal: { currency, amountMinor: 0 },
      recurring: request.recurring,
      shipTo: request.shipTo,
    };

    const totals = computeCartTotals(cartWithoutTotal);
    const cart: ProposedCart = { ...cartWithoutTotal, declaredTotal: totals.computedTotal };

    const unsealed = {
      snapshotId: newSnapshotId(),
      authorizationId: request.authorizationId,
      merchantId: request.merchantId,
      currency,
      cart,
      itemSubtotal: totals.itemSubtotal,
      feeTotal: totals.feeTotal,
      discountTotal: totals.discountTotal,
      total: totals.computedTotal,
      rowHashes,
      liveStateDigest: liveStateDigest(live.state),
      observedAt: now,
      expiresAt: addSeconds(
        now,
        Math.min(
          this.deps.config.snapshotTtlSeconds,
          authorization.intent.constraints.maxSnapshotAgeSeconds,
        ),
      ),
    };

    const snapshot: VerifiedSnapshot = {
      ...unsealed,
      snapshotHash: computeSnapshotHash(unsealed),
      state: 'ISSUED',
      redeemedByReleaseId: null,
    };

    await this.deps.snapshots.insert(snapshot);
    return { kind: 'ISSUED', snapshot };
  }
}
