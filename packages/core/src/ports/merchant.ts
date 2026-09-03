/**
 * The merchant live-state boundary.
 *
 * Two reads, both authoritative and both untrusted to respect the user's
 * authorization: what the items currently are, and what the merchant will
 * charge on top of them.
 *
 * Fees are quoted here rather than asserted by the agent so that a shipping
 * charge appearing between quote and capture shows up as divergence from the
 * merchant's own earlier quote, not merely as a policy ceiling breach.
 */

import type { LiveFeeQuote, LiveItemState, LiveStateResult } from '../domain/live-state.js';
import type { ShipTo } from '../domain/cart.js';
import type { MerchantId, Sku } from '../ids.js';

export interface FeeQuoteRequest {
  readonly merchantId: MerchantId;
  readonly lines: readonly { readonly sku: Sku; readonly quantity: number }[];
  readonly shipTo: ShipTo | null;
}

export interface MerchantStateProvider {
  readonly name: string;

  /**
   * Reads the current state of the given SKUs and the merchant's fee quote.
   *
   * Returns a discriminated result rather than throwing, so an unreachable
   * merchant is a decision input the kernel must handle rather than an
   * exception that might be caught somewhere permissive.
   */
  read(request: FeeQuoteRequest): Promise<LiveStateResult>;
}

export type { LiveItemState, LiveFeeQuote, LiveStateResult };
