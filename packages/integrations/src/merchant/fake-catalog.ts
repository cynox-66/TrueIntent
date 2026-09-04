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

import { createHash } from 'node:crypto';
import { money, type Attribute, type CartAdjustment, type CurrencyCode } from '@capturelock/core';
import type {
  CatalogProductResult,
  CatalogProductView,
  CatalogSearchRequest,
  CatalogSearchResult,
  CatalogVersion,
  FeeQuoteRequest,
  LiveItemState,
  LiveStateResult,
  MerchantCatalogProvider,
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

/**
 * One store, two boundaries.
 *
 * The browse surface and the kernel's live-state read are served from the same
 * mutable map, which is the point: an agent browses at one moment, the timeline
 * advances, and the gate re-reads a genuinely different world. Drift here is a
 * property of the fixture rather than something a test stages by hand, so the
 * ordering cannot be got wrong by accident.
 */
export class FakeMerchantCatalog implements MerchantStateProvider, MerchantCatalogProvider {
  public readonly name = 'fake-catalog';

  private items = new Map<string, LiveItemState>();
  private fees: CartAdjustment[];
  private offlineReason: string | null = null;
  private tick = 0;
  public reads = 0;
  public searches = 0;

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

  /**
   * The catalogue version.
   *
   * Content-addressed over everything an agent could have browsed, so any
   * mutation changes it and an unchanged catalogue always produces the same
   * value. Derived rather than incremented because a counter would let two
   * different catalogues share a version after a replay.
   */
  async catalogVersion(): Promise<CatalogVersion> {
    return this.computeCatalogVersion();
  }

  /**
   * Free-text search over the same items `read` serves.
   *
   * Matching is a deliberately crude token overlap against name, category and
   * attribute values. It is not a search engine and is not presented as one:
   * its job is to give the agent grounded candidates so it reasons over
   * merchant-stated facts instead of inventing them. A real connector would
   * call the merchant's own search and inherit its ranking.
   *
   * Unavailable items are still returned, with `available: false`. Hiding them
   * would deny the agent the information it needs to explain why it could not
   * fulfil an intent, and the deterministic checks refuse them anyway.
   */
  async search(request: CatalogSearchRequest): Promise<CatalogSearchResult> {
    this.searches += 1;

    if (this.offlineReason !== null) {
      return { kind: 'UNAVAILABLE', reason: this.offlineReason };
    }
    if (request.merchantId !== this.options.merchantId) {
      return { kind: 'OK', catalogVersion: this.computeCatalogVersion(), products: [] };
    }

    const wanted = tokens(request.query);
    const scored: { view: CatalogProductView; score: number }[] = [];

    for (const item of this.items.values()) {
      const offered = tokens(
        `${item.name} ${item.category} ${item.attributes.map(a => a.value).join(' ')}`,
      );
      let score = 0;
      for (const token of wanted) if (offered.has(token)) score += 1;
      // An empty query lists the catalogue; a query with no overlap matches
      // nothing, so an agent asking for something the merchant does not sell
      // gets an honest empty answer rather than an arbitrary substitute.
      if (wanted.size === 0 || score > 0) scored.push({ view: this.toView(item), score });
    }

    // Sorted by score then SKU so the same catalogue and query always produce
    // the same ordering. A scenario that depended on insertion order would pass
    // or fail depending on fixture construction.
    scored.sort((a, b) => b.score - a.score || a.view.sku.localeCompare(b.view.sku, 'en'));

    return {
      kind: 'OK',
      catalogVersion: this.computeCatalogVersion(),
      products: scored.slice(0, request.limit).map(entry => entry.view),
    };
  }

  async getProduct(merchantId: MerchantId, sku: Sku): Promise<CatalogProductResult> {
    if (this.offlineReason !== null) {
      return { kind: 'UNAVAILABLE', reason: this.offlineReason };
    }
    const item = merchantId === this.options.merchantId ? this.items.get(sku) : undefined;
    if (item === undefined) return { kind: 'NOT_FOUND' };
    return {
      kind: 'OK',
      catalogVersion: this.computeCatalogVersion(),
      product: this.toView(item),
    };
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

  /**
   * Projects a live item into a browse view.
   *
   * Note what is *not* preserved: the view is a distinct type from
   * `LiveItemState`, so a browse result cannot be handed to the kernel by
   * accident. The price it carries is indicative, and the server re-reads the
   * authoritative one at quote time from the very same map — which is why drift
   * in this fake is genuine rather than staged.
   */
  private toView(item: LiveItemState): CatalogProductView {
    return {
      sku: item.sku,
      merchantId: item.merchantId,
      name: item.name,
      category: item.category,
      attributes: [...item.attributes],
      unitPrice: item.unitPrice,
      available: item.available,
      availableStock: item.availableStock,
      subscriptionOnly: item.subscriptionOnly,
      observedAt: this.options.clock(),
    };
  }

  private computeCatalogVersion(): string {
    const digest = createHash('sha256');
    digest.update('capturelock.fake-catalog.v1');
    for (const sku of [...this.items.keys()].sort()) {
      const item = this.items.get(sku)!;
      digest.update(
        [
          sku,
          item.name,
          item.category,
          String(item.unitPrice.amountMinor),
          item.unitPrice.currency,
          String(item.available),
          String(item.availableStock),
          String(item.subscriptionOnly),
          [...item.attributes]
            .map(a => `${a.name}=${a.value}`)
            .sort()
            .join(','),
        ].join(' '),
      );
    }
    for (const fee of [...this.fees].sort(
      (a, b) => a.type.localeCompare(b.type, 'en') || a.label.localeCompare(b.label, 'en'),
    )) {
      digest.update(`${fee.type} ${fee.label} ${String(fee.amount.amountMinor)}`);
    }
    return `cat_${digest.digest('hex').slice(0, 16)}`;
  }
}

/** Lowercased word tokens, long enough to be discriminating. */
function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(word => word.length > 2),
  );
}
