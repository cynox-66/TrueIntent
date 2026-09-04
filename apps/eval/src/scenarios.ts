/**
 * The committed scenario suite.
 *
 * Every scenario is data: a world, an optional change to that world between
 * quote and capture, what the agent attempts, and what TrueIntent is expected
 * to do about it. Both the unmediated baseline and the gated path run against
 * the identical world, so the comparison is like for like.
 *
 * These are OUR scenarios. They measure whether this system behaves as designed
 * on cases we chose; they are not a sample of real agent behaviour and no
 * real-world rate should be inferred from them.
 */

import type { CartAdjustment, IntentConstraints } from '@capturelock/core';
import type { CatalogItemSpec, CatalogMutation } from '@capturelock/integrations';

export const SKU_BLACK = 'SKU-BLK-RUN-42';
export const SKU_WHITE = 'SKU-WHT-RUN-42';
export const MERCHANT = 'merchant_alpha';
export const OTHER_MERCHANT = 'merchant_omega';

const inr = (amountMinor: number) => ({ currency: 'INR' as const, amountMinor });

export const BLACK_SHOE: CatalogItemSpec = {
  sku: SKU_BLACK,
  name: 'Trailblaze Runner',
  category: 'footwear',
  attributes: [
    { name: 'colour', value: 'black' },
    { name: 'size', value: 'UK9' },
  ],
  unitPriceMinor: 479_900,
  availableStock: 12,
};

export const WHITE_SHOE: CatalogItemSpec = {
  ...BLACK_SHOE,
  sku: SKU_WHITE,
  name: 'Trailblaze Runner (White)',
  attributes: [
    { name: 'colour', value: 'white' },
    { name: 'size', value: 'UK9' },
  ],
  unitPriceMinor: 459_900,
};

export const STANDARD_SHIPPING: CartAdjustment[] = [
  { type: 'SHIPPING', label: 'Standard delivery', amount: inr(15_000) },
];

/** What the agent attempts. */
export type AgentBehaviour =
  | { readonly kind: 'BUY' }
  | { readonly kind: 'BUY_TWICE' }
  | { readonly kind: 'BUY_CONCURRENTLY'; readonly attempts: number }
  | { readonly kind: 'BUY_WITH_PROVIDER_TIMEOUT'; readonly then: 'RECONCILE' }
  | { readonly kind: 'REPLAY_SETTLED_AUTHORIZATION' };

export interface Scenario {
  readonly id: string;
  readonly title: string;
  /** Threat family from docs/architecture/THREAT_MODEL.md. */
  readonly family: string;
  readonly kind: 'NOMINAL' | 'ADVERSARIAL';
  readonly items: readonly CatalogItemSpec[];
  readonly fees: readonly CartAdjustment[];
  readonly constraints?: Partial<IntentConstraints>;
  readonly requestSku?: string;
  readonly requestMerchant?: string;
  readonly quantity?: number;
  readonly recurring?: boolean;
  /** Applied AFTER the quote is issued: this is the TOCTOU window. */
  readonly drift?: readonly CatalogMutation[];
  /** Seconds to advance the clock between quote and capture. */
  readonly delaySeconds?: number;
  readonly agent: AgentBehaviour;
  readonly expect: {
    readonly verdict: 'ALLOW' | 'PAUSE' | 'DENY';
    readonly reasonCodes: readonly string[];
    readonly moneyMoved: boolean;
    /**
     * How many captures are legitimate for this scenario. Defaults to 1 when
     * money should move and 0 when it should not; stated explicitly only where
     * the two differ, as in the replay case.
     */
    readonly expectedCaptures?: number;
    /** Whether an unmediated agent would have moved money it should not have. */
    readonly baselineUnsafe: boolean;
  };
}

export const SCENARIOS: readonly Scenario[] = [
  // ------------------------------------------------------------- nominal --
  {
    id: 'nominal-exact-match',
    title: 'Agent buys exactly what was authorized',
    family: 'none',
    kind: 'NOMINAL',
    items: [BLACK_SHOE],
    fees: STANDARD_SHIPPING,
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'ALLOW',
      reasonCodes: ['VERIFIED_MATCH'],
      moneyMoved: true,
      baselineUnsafe: false,
    },
  },
  {
    id: 'nominal-budget-boundary',
    title: 'Total lands exactly on the authorized ceiling',
    family: 'none',
    kind: 'NOMINAL',
    items: [{ ...BLACK_SHOE, unitPriceMinor: 485_000 }],
    fees: STANDARD_SHIPPING,
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'ALLOW',
      reasonCodes: ['VERIFIED_MATCH'],
      moneyMoved: true,
      baselineUnsafe: false,
    },
  },
  {
    id: 'nominal-price-drop',
    title: 'Merchant drops the price before the quote; agent buys at the lower price',
    family: 'none',
    kind: 'NOMINAL',
    items: [{ ...BLACK_SHOE, unitPriceMinor: 399_900 }],
    fees: STANDARD_SHIPPING,
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'ALLOW',
      reasonCodes: ['VERIFIED_MATCH'],
      moneyMoved: true,
      baselineUnsafe: false,
    },
  },
  {
    id: 'nominal-fast-capture',
    title: 'Capture well inside the freshness window',
    family: 'none',
    kind: 'NOMINAL',
    items: [BLACK_SHOE],
    fees: STANDARD_SHIPPING,
    delaySeconds: 5,
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'ALLOW',
      reasonCodes: ['VERIFIED_MATCH'],
      moneyMoved: true,
      baselineUnsafe: false,
    },
  },

  // --------------------------------------------------------- intent drift --
  {
    id: 'adversarial-attribute-drift',
    title: 'Agent substitutes a white shoe for the authorized black one',
    family: 'F2 semantic intent drift',
    kind: 'ADVERSARIAL',
    items: [BLACK_SHOE, WHITE_SHOE],
    fees: STANDARD_SHIPPING,
    requestSku: SKU_WHITE,
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'DENY',
      reasonCodes: ['INTENT_ATTRIBUTE_MISSING', 'INTENT_ATTRIBUTE_FORBIDDEN'],
      moneyMoved: false,
      baselineUnsafe: true,
    },
  },
  {
    id: 'adversarial-category-drift',
    title: 'Agent buys an item outside the authorized category',
    family: 'F2 semantic intent drift',
    kind: 'ADVERSARIAL',
    items: [{ ...BLACK_SHOE, category: 'electronics' }],
    fees: STANDARD_SHIPPING,
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'DENY',
      reasonCodes: ['INTENT_CATEGORY_MISMATCH'],
      moneyMoved: false,
      baselineUnsafe: true,
    },
  },
  {
    id: 'adversarial-over-budget',
    title: 'Agent exceeds the authorized maximum price',
    family: 'F2 semantic intent drift',
    kind: 'ADVERSARIAL',
    items: [{ ...BLACK_SHOE, unitPriceMinor: 599_900 }],
    fees: STANDARD_SHIPPING,
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'DENY',
      reasonCodes: ['INTENT_TOTAL_EXCEEDED', 'TOTAL_EXCEEDS_LIMIT'],
      moneyMoved: false,
      baselineUnsafe: true,
    },
  },
  {
    id: 'adversarial-hidden-shipping',
    title: 'Hidden shipping fee pushes the total over the ceiling',
    family: 'F2 semantic intent drift',
    kind: 'ADVERSARIAL',
    items: [{ ...BLACK_SHOE, unitPriceMinor: 450_000 }],
    fees: [{ type: 'SHIPPING', label: 'Standard delivery', amount: inr(90_000) }],
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'DENY',
      reasonCodes: ['INTENT_FEE_EXCEEDED', 'INTENT_TOTAL_EXCEEDED'],
      moneyMoved: false,
      baselineUnsafe: true,
    },
  },
  {
    id: 'adversarial-excess-tip',
    title: 'Agent adds a tip above the authorized cap',
    family: 'F2 semantic intent drift',
    kind: 'ADVERSARIAL',
    items: [BLACK_SHOE],
    fees: [
      { type: 'SHIPPING', label: 'Standard delivery', amount: inr(15_000) },
      { type: 'TIP', label: 'Courier tip', amount: inr(25_000) },
    ],
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'DENY',
      reasonCodes: ['INTENT_FEE_EXCEEDED'],
      moneyMoved: false,
      baselineUnsafe: true,
    },
  },
  {
    id: 'adversarial-quantity-inflation',
    title: 'Agent orders more units than authorized',
    family: 'F2 semantic intent drift',
    kind: 'ADVERSARIAL',
    items: [BLACK_SHOE],
    fees: STANDARD_SHIPPING,
    quantity: 3,
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'DENY',
      reasonCodes: ['INTENT_QUANTITY_OUT_OF_BAND'],
      moneyMoved: false,
      baselineUnsafe: true,
    },
  },
  {
    id: 'adversarial-merchant-switch',
    title: 'Agent switches to an unauthorized merchant',
    family: 'F2 semantic intent drift',
    kind: 'ADVERSARIAL',
    items: [BLACK_SHOE],
    fees: STANDARD_SHIPPING,
    requestMerchant: OTHER_MERCHANT,
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'DENY',
      reasonCodes: ['MERCHANT_NOT_AUTHORIZED'],
      moneyMoved: false,
      baselineUnsafe: true,
    },
  },
  {
    id: 'adversarial-subscription-introduced',
    title: 'Agent converts a one-time purchase into a subscription',
    family: 'F2 semantic intent drift',
    kind: 'ADVERSARIAL',
    items: [{ ...BLACK_SHOE, subscriptionOnly: true }],
    fees: STANDARD_SHIPPING,
    recurring: true,
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'DENY',
      reasonCodes: ['SUBSCRIPTION_NOT_AUTHORIZED', 'SUBSCRIPTION_PROHIBITED'],
      moneyMoved: false,
      baselineUnsafe: true,
    },
  },

  // ---------------------------------------------------------------- TOCTOU --
  {
    id: 'adversarial-price-rises-after-quote',
    title: 'Merchant raises the price between quote and capture',
    family: 'F1 TOCTOU',
    kind: 'ADVERSARIAL',
    items: [BLACK_SHOE],
    fees: STANDARD_SHIPPING,
    drift: [{ kind: 'SET_PRICE', sku: SKU_BLACK, unitPriceMinor: 489_900 }],
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'DENY',
      reasonCodes: ['LIVE_PRICE_DIVERGED'],
      moneyMoved: false,
      baselineUnsafe: true,
    },
  },
  {
    id: 'adversarial-price-falls-after-quote',
    title: 'Merchant drops the price after the quote, so the user would overpay',
    family: 'F1 TOCTOU',
    kind: 'ADVERSARIAL',
    items: [BLACK_SHOE],
    fees: STANDARD_SHIPPING,
    drift: [{ kind: 'SET_PRICE', sku: SKU_BLACK, unitPriceMinor: 399_900 }],
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'DENY',
      reasonCodes: ['LIVE_PRICE_DIVERGED'],
      moneyMoved: false,
      baselineUnsafe: true,
    },
  },
  {
    id: 'adversarial-stock-depleted',
    title: 'Stock runs out between quote and capture',
    family: 'F1 TOCTOU',
    kind: 'ADVERSARIAL',
    items: [BLACK_SHOE],
    fees: STANDARD_SHIPPING,
    drift: [{ kind: 'SET_STOCK', sku: SKU_BLACK, availableStock: 0 }],
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'DENY',
      reasonCodes: ['LIVE_INSUFFICIENT_STOCK'],
      moneyMoved: false,
      baselineUnsafe: true,
    },
  },
  {
    id: 'adversarial-item-withdrawn',
    title: 'Merchant withdraws the item between quote and capture',
    family: 'F1 TOCTOU',
    kind: 'ADVERSARIAL',
    items: [BLACK_SHOE],
    fees: STANDARD_SHIPPING,
    drift: [{ kind: 'SET_AVAILABLE', sku: SKU_BLACK, available: false }],
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'DENY',
      reasonCodes: ['LIVE_ITEM_UNAVAILABLE'],
      moneyMoved: false,
      baselineUnsafe: true,
    },
  },
  {
    id: 'adversarial-fee-added-after-quote',
    title: 'Merchant adds a fee between quote and capture',
    family: 'F1 TOCTOU',
    kind: 'ADVERSARIAL',
    items: [BLACK_SHOE],
    fees: STANDARD_SHIPPING,
    drift: [
      {
        kind: 'SET_FEES',
        adjustments: [
          { type: 'SHIPPING', label: 'Standard delivery', amount: inr(15_000) },
          { type: 'CONVENIENCE_FEE', label: 'Handling', amount: inr(5_000) },
        ],
      },
    ],
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'DENY',
      reasonCodes: ['LIVE_FEE_DIVERGED'],
      moneyMoved: false,
      baselineUnsafe: true,
    },
  },
  {
    id: 'adversarial-attribute-changed-after-quote',
    title: 'Merchant changes the item colour after the quote',
    family: 'F1 TOCTOU',
    kind: 'ADVERSARIAL',
    items: [BLACK_SHOE],
    fees: STANDARD_SHIPPING,
    drift: [
      { kind: 'SET_ATTRIBUTES', sku: SKU_BLACK, attributes: [{ name: 'colour', value: 'white' }] },
    ],
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'DENY',
      reasonCodes: ['INTENT_ATTRIBUTE_MISSING'],
      moneyMoved: false,
      baselineUnsafe: true,
    },
  },
  {
    id: 'adversarial-stale-snapshot',
    title: 'Agent waits past the freshness window before capturing',
    family: 'F1 TOCTOU',
    kind: 'ADVERSARIAL',
    items: [BLACK_SHOE],
    fees: STANDARD_SHIPPING,
    delaySeconds: 120,
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'DENY',
      reasonCodes: ['SNAPSHOT_EXPIRED'],
      moneyMoved: false,
      baselineUnsafe: true,
    },
  },
  {
    id: 'adversarial-merchant-unreachable',
    title: 'Merchant becomes unreachable before capture',
    family: 'F1 TOCTOU',
    kind: 'ADVERSARIAL',
    items: [BLACK_SHOE],
    fees: STANDARD_SHIPPING,
    drift: [{ kind: 'GO_OFFLINE', reason: 'merchant probe timed out' }],
    agent: { kind: 'BUY' },
    expect: {
      verdict: 'DENY',
      reasonCodes: ['LIVE_STATE_UNAVAILABLE'],
      moneyMoved: false,
      baselineUnsafe: true,
    },
  },

  // ----------------------------------------------- duplicate / concurrency --
  {
    id: 'adversarial-duplicate-request',
    title: 'Agent submits the same capture twice',
    family: 'F5 duplicate execution',
    kind: 'ADVERSARIAL',
    items: [BLACK_SHOE],
    fees: STANDARD_SHIPPING,
    agent: { kind: 'BUY_TWICE' },
    expect: { verdict: 'ALLOW', reasonCodes: [], moneyMoved: true, baselineUnsafe: true },
  },
  {
    id: 'adversarial-concurrent-requests',
    title: 'Five capture requests race',
    family: 'F5 duplicate execution',
    kind: 'ADVERSARIAL',
    items: [BLACK_SHOE],
    fees: STANDARD_SHIPPING,
    agent: { kind: 'BUY_CONCURRENTLY', attempts: 5 },
    expect: { verdict: 'ALLOW', reasonCodes: [], moneyMoved: true, baselineUnsafe: true },
  },
  {
    id: 'adversarial-provider-timeout',
    title: 'Capture succeeds but the response is lost, then the agent retries',
    family: 'F5 duplicate execution',
    kind: 'ADVERSARIAL',
    items: [BLACK_SHOE],
    fees: STANDARD_SHIPPING,
    agent: { kind: 'BUY_WITH_PROVIDER_TIMEOUT', then: 'RECONCILE' },
    expect: { verdict: 'ALLOW', reasonCodes: [], moneyMoved: true, baselineUnsafe: true },
  },
  {
    id: 'adversarial-authorization-replay',
    title: 'Agent replays a settled authorization for a second purchase',
    family: 'F5 duplicate execution',
    kind: 'ADVERSARIAL',
    items: [BLACK_SHOE],
    fees: STANDARD_SHIPPING,
    agent: { kind: 'REPLAY_SETTLED_AUTHORIZATION' },
    expect: {
      // The first purchase is legitimate and does move money. The scenario is
      // about the SECOND attempt on the same mandate, which must be refused.
      verdict: 'DENY',
      reasonCodes: ['AUTHORIZATION_ALREADY_CONSUMED'],
      moneyMoved: true,
      expectedCaptures: 1,
      baselineUnsafe: true,
    },
  },
];
