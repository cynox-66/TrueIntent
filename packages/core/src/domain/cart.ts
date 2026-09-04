/**
 * The cart an agent proposes, and the arithmetic TrueIntent recomputes over it.
 *
 * Everything in `ProposedCart` is untrusted input. The agent's declared total is
 * kept only so we can compare it against our own recomputation: a mismatch is
 * itself a signal, and refusing to charge a total we did not compute is the
 * whole point.
 */

import { z } from 'zod';
import { AttributeListSchema, normalizeAttributes, type Attribute } from './attributes.js';
import {
  CurrencyCodeSchema,
  MoneySchema,
  add,
  multiply,
  money,
  sum,
  zero,
  type CurrencyCode,
  type Money,
} from '../money.js';
import { MerchantIdSchema, SkuSchema, type MerchantId, type Sku } from '../ids.js';

/**
 * Adjustment kinds.
 *
 * Fees are first-class rather than folded into the total, because "₹4,500 plus
 * ₹900 shipping" must be checkable against a shipping ceiling separately from
 * the grand total. A system that only sees ₹5,400 cannot tell the user why it
 * refused.
 */
export const AdjustmentTypeSchema = z.enum([
  'SHIPPING',
  'TAX',
  'TIP',
  'CONVENIENCE_FEE',
  'DISCOUNT',
  'OTHER',
]);
export type AdjustmentType = z.infer<typeof AdjustmentTypeSchema>;

/** Adjustment kinds that add to what the user pays. DISCOUNT is the only reducer. */
export const FEE_ADJUSTMENT_TYPES = [
  'SHIPPING',
  'TAX',
  'TIP',
  'CONVENIENCE_FEE',
  'OTHER',
] as const satisfies readonly AdjustmentType[];

export function isFeeAdjustment(type: AdjustmentType): boolean {
  return (FEE_ADJUSTMENT_TYPES as readonly AdjustmentType[]).includes(type);
}

export const CartAdjustmentSchema = z
  .object({
    type: AdjustmentTypeSchema,
    label: z.string().min(1).max(128),
    /** Non-negative magnitude. DISCOUNT subtracts; every other type adds. */
    amount: MoneySchema.refine(
      m => m.amountMinor >= 0,
      'Adjustment magnitude must be non-negative',
    ),
  })
  .strict();
export type CartAdjustment = z.infer<typeof CartAdjustmentSchema>;

/**
 * What the agent claims about an item.
 *
 * These fields are never used to satisfy a constraint. They exist so that the
 * kernel can compare the agent's claim against the live merchant record: an
 * agent asserting `colour=black` on an item the merchant lists as white is
 * caught by `AGENT_MISREPRESENTED_ITEM` rather than quietly passing an
 * attribute check against its own assertion.
 */
export const AgentAssertionSchema = z
  .object({
    name: z.string().min(1).max(256),
    category: z.string().min(1).max(64),
    attributes: AttributeListSchema,
  })
  .strict();
export type AgentAssertion = z.infer<typeof AgentAssertionSchema>;

export const CartLineSchema = z
  .object({
    sku: SkuSchema,
    quantity: z.number().int().min(1).max(10_000),
    unitPrice: MoneySchema.refine(m => m.amountMinor >= 0, 'Unit price must be non-negative'),
    asserted: AgentAssertionSchema,
  })
  .strict();
export type CartLine = z.infer<typeof CartLineSchema>;

export const MAX_CART_LINES = 50;
export const MAX_CART_ADJUSTMENTS = 20;

export const ShipToSchema = z
  .object({
    country: z.string().regex(/^[A-Z]{2}$/, 'Country must be ISO-3166-1 alpha-2 uppercase'),
    region: z.string().min(1).max(64).nullable(),
  })
  .strict();
export type ShipTo = z.infer<typeof ShipToSchema>;

export const ProposedCartSchema = z
  .object({
    merchantId: MerchantIdSchema,
    currency: CurrencyCodeSchema,
    lines: z.array(CartLineSchema).min(1).max(MAX_CART_LINES),
    adjustments: z.array(CartAdjustmentSchema).max(MAX_CART_ADJUSTMENTS),
    /** The agent's own arithmetic. Compared against ours; never used in its place. */
    declaredTotal: MoneySchema,
    /** Whether this establishes a recurring charge. */
    recurring: z.boolean(),
    shipTo: ShipToSchema.nullable(),
  })
  .strict();
export type ProposedCart = z.infer<typeof ProposedCartSchema>;

export interface CartTotals {
  readonly itemSubtotal: Money;
  readonly feeTotal: Money;
  readonly discountTotal: Money;
  readonly computedTotal: Money;
  readonly byAdjustmentType: ReadonlyMap<AdjustmentType, Money>;
}

/**
 * Recomputes every total from line items and adjustments.
 *
 * All arithmetic is integer minor units through the `money` module, so a
 * currency mismatch or an overflow throws rather than producing a wrong number.
 * The caller treats a throw as a structural failure, never as a pass.
 */
export function computeCartTotals(cart: ProposedCart): CartTotals {
  const currency: CurrencyCode = cart.currency;

  const lineTotals = cart.lines.map(line => {
    if (line.unitPrice.currency !== currency) {
      throw new Error(
        `Line ${line.sku} is priced in ${line.unitPrice.currency}, cart is ${currency}`,
      );
    }
    return multiply(line.unitPrice, line.quantity);
  });
  const itemSubtotal = sum(currency, lineTotals);

  const byType = new Map<AdjustmentType, Money>();
  let feeTotal = zero(currency);
  let discountTotal = zero(currency);

  for (const adjustment of cart.adjustments) {
    if (adjustment.amount.currency !== currency) {
      throw new Error(
        `Adjustment ${adjustment.label} is in ${adjustment.amount.currency}, cart is ${currency}`,
      );
    }
    const running = byType.get(adjustment.type) ?? zero(currency);
    byType.set(adjustment.type, add(running, adjustment.amount));
    if (adjustment.type === 'DISCOUNT') {
      discountTotal = add(discountTotal, adjustment.amount);
    } else {
      feeTotal = add(feeTotal, adjustment.amount);
    }
  }

  const computedTotal = money(
    currency,
    itemSubtotal.amountMinor + feeTotal.amountMinor - discountTotal.amountMinor,
  );

  return { itemSubtotal, feeTotal, discountTotal, computedTotal, byAdjustmentType: byType };
}

/** Canonical projection of a cart for hashing. Attribute lists are normalized first. */
export function cartHashInput(cart: ProposedCart): Record<string, unknown> {
  return {
    merchantId: cart.merchantId,
    currency: cart.currency,
    recurring: cart.recurring,
    shipTo:
      cart.shipTo === null ? null : { country: cart.shipTo.country, region: cart.shipTo.region },
    lines: cart.lines.map(line => ({
      sku: line.sku,
      quantity: line.quantity,
      unitPriceMinor: line.unitPrice.amountMinor,
      unitPriceCurrency: line.unitPrice.currency,
      assertedName: line.asserted.name,
      assertedCategory: line.asserted.category,
      assertedAttributes: attributesForHash(line.asserted.attributes),
    })),
    adjustments: [...cart.adjustments]
      .map(a => ({
        type: a.type,
        label: a.label,
        amountMinor: a.amount.amountMinor,
        currency: a.amount.currency,
      }))
      .sort(compareAdjustments),
    declaredTotalMinor: cart.declaredTotal.amountMinor,
    declaredTotalCurrency: cart.declaredTotal.currency,
  };
}

function attributesForHash(attributes: readonly Attribute[]): Record<string, unknown>[] {
  return normalizeAttributes(attributes).map(a => ({ name: a.name, value: a.value }));
}

function compareAdjustments(
  a: { type: string; label: string; amountMinor: number },
  b: { type: string; label: string; amountMinor: number },
): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.label !== b.label) return a.label < b.label ? -1 : 1;
  return a.amountMinor - b.amountMinor;
}

export type { MerchantId, Sku, Money };
