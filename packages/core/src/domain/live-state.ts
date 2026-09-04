/**
 * Live merchant state read at the moment of decision.
 *
 * The Phase 0 threat model placed the merchant's catalogue inside the trusted
 * realm. That is wrong: the merchant is the party that changes the price. The
 * correct framing, and the one this module encodes, is
 * *authoritative-but-adversarial* — the merchant is the authority on what it
 * will charge, and is untrusted to stay inside the user's authorization.
 *
 * So the freshness check is not "does the agent's remembered hash still match?"
 * — a malicious agent would simply send the current hash. It is "do the terms
 * being paid match the terms the merchant will honour, right now?". Row hashes
 * exist to *attribute* drift in the evidence, not to gate it. See ADR-008.
 */

import { hash, type Sha256Hex } from '../canonical.js';
import { normalizeAttributes, type Attribute } from './attributes.js';
import type { CartAdjustment } from './cart.js';
import type { CurrencyCode, Money } from '../money.js';
import type { MerchantId, Sku } from '../ids.js';
import type { Timestamp } from '../time.js';

export interface LiveItemState {
  readonly sku: Sku;
  readonly merchantId: MerchantId;
  readonly name: string;
  readonly category: string;
  readonly attributes: readonly Attribute[];
  readonly unitPrice: Money;
  readonly available: boolean;
  readonly availableStock: number;
  /** True when the merchant only sells this item on a recurring plan. */
  readonly subscriptionOnly: boolean;
  readonly updatedAt: Timestamp;
}

/**
 * The merchant's authoritative quote for non-item charges.
 *
 * Fees are quoted by the merchant rather than asserted by the agent, so a
 * shipping charge that appears between quote and capture is detectable as
 * divergence, not merely as a policy ceiling breach.
 */
export interface LiveFeeQuote {
  readonly merchantId: MerchantId;
  readonly currency: CurrencyCode;
  readonly adjustments: readonly CartAdjustment[];
  readonly quotedAt: Timestamp;
}

export interface LiveMerchantState {
  readonly merchantId: MerchantId;
  readonly items: ReadonlyMap<Sku, LiveItemState>;
  readonly feeQuote: LiveFeeQuote;
  readonly fetchedAt: Timestamp;
}

/**
 * Reading live state either succeeds or does not.
 *
 * Modelled as a discriminated union rather than a nullable value so that
 * "the merchant was unreachable" cannot be silently coerced into "nothing
 * changed". Every consumer must handle UNAVAILABLE, and the only correct
 * handling in the money path is to refuse.
 */
export type LiveStateResult =
  | { readonly kind: 'OK'; readonly state: LiveMerchantState }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string };

/** Canonical projection of one live item, used for drift attribution in evidence. */
export function liveItemHashInput(item: LiveItemState): Record<string, unknown> {
  return {
    sku: item.sku,
    merchantId: item.merchantId,
    name: item.name,
    category: item.category,
    attributes: normalizeAttributes(item.attributes).map(a => ({ name: a.name, value: a.value })),
    unitPriceMinor: item.unitPrice.amountMinor,
    unitPriceCurrency: item.unitPrice.currency,
    available: item.available,
    availableStock: item.availableStock,
    subscriptionOnly: item.subscriptionOnly,
    updatedAt: item.updatedAt,
  };
}

/**
 * Row hash over the live item.
 *
 * Computed by TrueIntent over the merchant's values rather than accepted from
 * the merchant, so the merchant cannot supply a hash that hides a change.
 */
export function liveItemRowHash(item: LiveItemState): Sha256Hex {
  return hash('capturelock.v1.item_row', liveItemHashInput(item));
}

/** Digest over the whole live read, recorded in evidence so a replay can be checked. */
export function liveStateDigest(state: LiveMerchantState): Sha256Hex {
  const items = [...state.items.values()]
    .map(liveItemHashInput)
    .sort((a, b) => String(a['sku']).localeCompare(String(b['sku']), 'en'));
  return hash('capturelock.v1.live_state', {
    merchantId: state.merchantId,
    fetchedAt: state.fetchedAt,
    items,
    feeQuote: {
      merchantId: state.feeQuote.merchantId,
      currency: state.feeQuote.currency,
      quotedAt: state.feeQuote.quotedAt,
      adjustments: [...state.feeQuote.adjustments]
        .map(a => ({
          type: a.type,
          label: a.label,
          amountMinor: a.amount.amountMinor,
          currency: a.amount.currency,
        }))
        .sort((a, b) =>
          a.type === b.type
            ? a.label.localeCompare(b.label, 'en')
            : a.type.localeCompare(b.type, 'en'),
        ),
    },
  });
}
