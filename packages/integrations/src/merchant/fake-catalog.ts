/**
 * Deterministic merchant catalogue with a scripted mutation timeline.
 *
 * TOCTOU scenarios need the world to change at a controlled moment between the
 * quote and the capture. Rather than mutating state from inside a test and
 * hoping the ordering holds, a scenario declares the drift up front and then
 * advances a tick. The same script replayed produces the same reads, every time.
 *
 * This is a test double. It is not, and must not be presented as, a merchant
 * integration: a real one would read a merchant's authoritative store or call a
 * signed probe endpoint, and would have to reason about its own staleness.
 */

import { money, type Attribute, type CartAdjustment, type CurrencyCode } from '@capturelock/core';
import type {
  FeeQuoteRequest,
  LiveItemState,
  LiveStateResult,
  MerchantId,
  MerchantStateProvider,
  Sku,
  Timestamp,
} from '@capturelock/core';

export interface CatalogItemSpec {
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly attributes: readonly Attribute[];
  readonly unitPriceMinor: number;
  readonly availableStock: number;
  readonly available?: boolean;
  readonly subscriptionOnly?: boolean;
}

export type CatalogMutation =
  | { readonly kind: 'SET_PRICE'; readonly sku: string; readonly unitPriceMinor: number }
  | { readonly kind: 'SET_STOCK'; readonly sku: string; readonly availableStock: number }
  | { readonly kind: 'SET_AVAILABLE'; readonly sku: string; readonly available: boolean }
  | {
      readonly kind: 'SET_ATTRIBUTES';
      readonly sku: string;
      readonly attributes: readonly Attribute[];
    }
  | { readonly kind: 'SET_CATEGORY'; readonly sku: string; readonly category: string }
  | { readonly kind: 'SET_SUBSCRIPTION_ONLY'; readonly sku: string; readonly value: boolean }
  | { readonly kind: 'REMOVE'; readonly sku: string }
  | { readonly kind: 'SET_FEES'; readonly adjustments: readonly CartAdjustment[] }
  | { readonly kind: 'GO_OFFLINE'; readonly reason: string }
  | { readonly kind: 'COME_ONLINE' };

export interface FakeCatalogOptions {
  readonly merchantId: MerchantId;
  readonly currency: CurrencyCode;
  readonly items: readonly CatalogItemSpec[];
  readonly fees: readonly CartAdjustment[];
  readonly clock: () => Timestamp;
  /** Mutations applied when `advance()` reaches the given tick. */
  readonly timeline?: ReadonlyMap<number, readonly CatalogMutation[]>;
}

export class FakeMerchantCatalog implements MerchantStateProvider {
  public readonly name = 'fake-catalog';

  private items = new Map<string, LiveItemState>();
  private fees: CartAdjustment[];
  private offlineReason: string | null = null;
  private tick = 0;
  public reads = 0;

  constructor(private readonly options: FakeCatalogOptions) {
    for (const spec of options.items) {
      this.items.set(spec.sku, {
        sku: spec.sku as Sku,
        merchantId: options.merchantId,
        name: spec.name,
        category: spec.category,
        attributes: [...spec.attributes],
        unitPrice: money(options.currency, spec.unitPriceMinor),
        available: spec.available ?? true,
        availableStock: spec.availableStock,
        subscriptionOnly: spec.subscriptionOnly ?? false,
        updatedAt: options.clock(),
      });
    }
    this.fees = [...options.fees];
  }

  /** Advances the timeline by one tick, applying any mutations scheduled for it. */
  advance(): void {
    this.tick += 1;
    for (const mutation of this.options.timeline?.get(this.tick) ?? []) {
      this.apply(mutation);
    }
  }

  /** Applies a mutation immediately, for scenarios that do not need a timeline. */
  apply(mutation: CatalogMutation): void {
    const at = this.options.clock();
    switch (mutation.kind) {
      case 'SET_PRICE':
        this.patch(mutation.sku, item => ({
          ...item,
          unitPrice: money(this.options.currency, mutation.unitPriceMinor),
          updatedAt: at,
        }));
        return;
      case 'SET_STOCK':
        this.patch(mutation.sku, item => ({
          ...item,
          availableStock: mutation.availableStock,
          updatedAt: at,
        }));
        return;
      case 'SET_AVAILABLE':
        this.patch(mutation.sku, item => ({
          ...item,
          available: mutation.available,
          updatedAt: at,
        }));
        return;
      case 'SET_ATTRIBUTES':
        this.patch(mutation.sku, item => ({
          ...item,
          attributes: [...mutation.attributes],
          updatedAt: at,
        }));
        return;
      case 'SET_CATEGORY':
        this.patch(mutation.sku, item => ({ ...item, category: mutation.category, updatedAt: at }));
        return;
      case 'SET_SUBSCRIPTION_ONLY':
        this.patch(mutation.sku, item => ({
          ...item,
          subscriptionOnly: mutation.value,
          updatedAt: at,
        }));
        return;
      case 'REMOVE':
        this.items.delete(mutation.sku);
        return;
      case 'SET_FEES':
        this.fees = [...mutation.adjustments];
        return;
      case 'GO_OFFLINE':
        this.offlineReason = mutation.reason;
        return;
      case 'COME_ONLINE':
        this.offlineReason = null;
        return;
    }
  }

  async read(request: FeeQuoteRequest): Promise<LiveStateResult> {
    this.reads += 1;

    if (this.offlineReason !== null) {
      return { kind: 'UNAVAILABLE', reason: this.offlineReason };
    }

    const items = new Map<Sku, LiveItemState>();
    for (const line of request.lines) {
      const item = this.items.get(line.sku);
      if (item !== undefined) items.set(line.sku, item);
    }

    return {
      kind: 'OK',
      state: {
        merchantId: request.merchantId,
        items,
        feeQuote: {
          merchantId: this.options.merchantId,
          currency: this.options.currency,
          adjustments: [...this.fees],
          quotedAt: this.options.clock(),
        },
        fetchedAt: this.options.clock(),
      },
    };
  }

  private patch(sku: string, update: (item: LiveItemState) => LiveItemState): void {
    const item = this.items.get(sku);
    if (item !== undefined) this.items.set(sku, update(item));
  }
}
