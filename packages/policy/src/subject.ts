/**
 * What policy rules are evaluated against.
 *
 * Every field here is server-derived. In particular `category` and `attributes`
 * come from the *live merchant record*, never from the agent's assertion about
 * the item — otherwise an agent could satisfy a "must be black" rule simply by
 * claiming the shoe is black.
 *
 * The subject is assembled once by the kernel and handed to the policy engine
 * as a frozen value, so a rule cannot reach back into the request.
 */

import type {
  AdjustmentType,
  Attribute,
  CartTotals,
  CurrencyCode,
  MerchantId,
  Money,
  Sku,
} from '@capturelock/core';

export interface PolicySubjectLine {
  readonly sku: Sku;
  readonly quantity: number;
  /** Price actually being paid for one unit. */
  readonly unitPrice: Money;
  readonly lineTotal: Money;
  /** From the live merchant record. */
  readonly category: string;
  /** From the live merchant record. */
  readonly attributes: readonly Attribute[];
}

export interface PolicySubject {
  readonly merchantId: MerchantId;
  readonly currency: CurrencyCode;
  readonly lines: readonly PolicySubjectLine[];
  readonly totals: CartTotals;
  readonly feeByType: ReadonlyMap<AdjustmentType, Money>;
  readonly recurring: boolean;
  /** Age of the verified snapshot at the moment of evaluation. */
  readonly snapshotAgeSeconds: number;
}
