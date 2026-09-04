/**
 * Server-issued verified snapshot.
 *
 * The Phase 0 design had the agent supply a `snapshotHash` alongside the cart it
 * hashed — integrity theatre, since nothing recomputed it and the agent chose
 * both sides of the comparison.
 *
 * Here the snapshot is issued by TrueIntent. The agent proposes SKUs,
 * quantities and a destination; the server reads live merchant state, prices the
 * cart itself, computes the total itself, and returns an opaque snapshot id. At
 * release the agent can only point at that id. The agent never gets to state a
 * price it will be charged.
 */

import { z } from 'zod';
import { hash, type Sha256Hex } from '../canonical.js';
import { cartHashInput, computeCartTotals, type ProposedCart } from './cart.js';
import type { MerchantId, Sku } from '../ids.js';
import type { CurrencyCode, Money } from '../money.js';
import type { Timestamp } from '../time.js';

export const SnapshotStateSchema = z.enum(['ISSUED', 'REDEEMED', 'SUPERSEDED', 'EXPIRED']);
export type SnapshotState = z.infer<typeof SnapshotStateSchema>;

export interface VerifiedSnapshot {
  readonly snapshotId: string;
  readonly authorizationId: string;
  readonly merchantId: MerchantId;
  readonly currency: CurrencyCode;
  /**
   * The cart as TrueIntent priced it: line unit prices and fee adjustments come
   * from the live merchant read, not from the agent.
   */
  readonly cart: ProposedCart;
  readonly itemSubtotal: Money;
  readonly feeTotal: Money;
  readonly discountTotal: Money;
  readonly total: Money;
  /** Per-SKU row hashes at issuance, so drift can be attributed line by line. */
  readonly rowHashes: ReadonlyMap<Sku, Sha256Hex>;
  readonly liveStateDigest: Sha256Hex;
  readonly observedAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly snapshotHash: Sha256Hex;
  readonly state: SnapshotState;
  readonly redeemedByReleaseId: string | null;
}

/** Everything a snapshot commits to, in the exact shape that gets hashed. */
export function snapshotHashInput(
  snapshot: Omit<VerifiedSnapshot, 'snapshotHash' | 'state' | 'redeemedByReleaseId'>,
): Record<string, unknown> {
  const rowHashes = [...snapshot.rowHashes.entries()]
    .map(([sku, rowHash]) => ({ sku, rowHash }))
    .sort((a, b) => a.sku.localeCompare(b.sku, 'en'));

  return {
    snapshotId: snapshot.snapshotId,
    authorizationId: snapshot.authorizationId,
    merchantId: snapshot.merchantId,
    currency: snapshot.currency,
    cart: cartHashInput(snapshot.cart),
    itemSubtotalMinor: snapshot.itemSubtotal.amountMinor,
    feeTotalMinor: snapshot.feeTotal.amountMinor,
    discountTotalMinor: snapshot.discountTotal.amountMinor,
    totalMinor: snapshot.total.amountMinor,
    rowHashes,
    liveStateDigest: snapshot.liveStateDigest,
    observedAt: snapshot.observedAt,
    expiresAt: snapshot.expiresAt,
  };
}

export function computeSnapshotHash(
  snapshot: Omit<VerifiedSnapshot, 'snapshotHash' | 'state' | 'redeemedByReleaseId'>,
): Sha256Hex {
  return hash('capturelock.v1.snapshot', snapshotHashInput(snapshot));
}

/**
 * Recomputes the snapshot hash and reports whether the stored value still holds.
 *
 * This is the check that catches a snapshot row edited in the database between
 * issuance and redemption.
 */
export function verifySnapshotIntegrity(snapshot: VerifiedSnapshot): {
  readonly valid: boolean;
  readonly recomputed: Sha256Hex;
} {
  const recomputed = computeSnapshotHash(snapshot);
  return { valid: recomputed === snapshot.snapshotHash, recomputed };
}

/**
 * Checks that the totals recorded on a snapshot are the ones its own cart
 * implies. A snapshot whose stored total disagrees with its lines is corrupt
 * regardless of whether its hash matches.
 */
export function snapshotTotalsAreSelfConsistent(snapshot: VerifiedSnapshot): boolean {
  const totals = computeCartTotals(snapshot.cart);
  return (
    totals.itemSubtotal.amountMinor === snapshot.itemSubtotal.amountMinor &&
    totals.feeTotal.amountMinor === snapshot.feeTotal.amountMinor &&
    totals.discountTotal.amountMinor === snapshot.discountTotal.amountMinor &&
    totals.computedTotal.amountMinor === snapshot.total.amountMinor &&
    totals.computedTotal.currency === snapshot.total.currency
  );
}
