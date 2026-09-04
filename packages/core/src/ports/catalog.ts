/**
 * The merchant catalogue browse boundary.
 *
 * `MerchantStateProvider` answers "what are these exact SKUs right now?" — the
 * question the kernel asks at each gate. It cannot answer "what does this
 * merchant sell that might suit a vegetarian Thai dinner?", which is the
 * question an agent has to ask before it has any SKUs at all. Discovery is that
 * second question, and it is deliberately a separate port.
 *
 * Separating them is not tidiness. The two have different trust properties:
 *
 *  - A browse result is **grounding, never authority.** It tells the agent what
 *    the merchant claims to offer, so the agent can reason over merchant-stated
 *    facts instead of inventing them. Nothing here is used to price anything.
 *  - Every price that will actually be charged comes from
 *    `MerchantStateProvider.read` at quote time and is re-read at both gates.
 *    A browse price is a hint that was true when it was read, and the gap
 *    between the two is exactly where price drift lives.
 *
 * So a browse view carries `observedAt` and the read carries `catalogVersion`:
 * they exist to make staleness visible rather than to be trusted. An
 * implementation must never be wired in as the source of a charged amount, and
 * the type system helps here only a little — `CatalogProductView` is not a
 * `LiveItemState`, and only the latter reaches the kernel.
 */

import type { Attribute } from '../domain/attributes.js';
import type { Money } from '../money.js';
import type { Timestamp } from '../time.js';
import type { MerchantId, Sku } from '../ids.js';

/**
 * What the merchant says about one product.
 *
 * Every field is the merchant's own claim. The agent may reason over these and
 * cite them; it may not restate them as inputs to a decision, because the cart
 * it submits carries only SKUs and quantities.
 */
export interface CatalogProductView {
  readonly sku: Sku;
  readonly merchantId: MerchantId;
  readonly name: string;
  readonly category: string;
  readonly attributes: readonly Attribute[];
  /** Indicative only. The charged price is resolved server-side at quote time. */
  readonly unitPrice: Money;
  readonly available: boolean;
  readonly availableStock: number;
  readonly subscriptionOnly: boolean;
  /** When this view was read. Present so staleness is visible, not assumed away. */
  readonly observedAt: Timestamp;
}

export interface CatalogSearchRequest {
  readonly merchantId: MerchantId;
  /**
   * Free text from the agent.
   *
   * Untrusted, and treated as a query rather than an instruction: an
   * implementation matches it against catalogue fields and must never interpret
   * it as a directive. This is the one place agent-authored text reaches a
   * merchant boundary, so it is bounded in length by the caller's schema.
   */
  readonly query: string;
  readonly limit: number;
}

/**
 * Opaque identifier for the state of a catalogue.
 *
 * Changes whenever anything an agent could have browsed changes. Recorded in
 * the ContextCapsule so evidence can say which version of reality the agent was
 * looking at when it chose — which is what makes "the merchant changed its
 * mind" a demonstrable claim rather than an assertion.
 */
export type CatalogVersion = string;

export type CatalogSearchResult =
  | {
      readonly kind: 'OK';
      readonly catalogVersion: CatalogVersion;
      readonly products: readonly CatalogProductView[];
    }
  /** Discriminated rather than thrown, matching `LiveStateResult`. */
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string };

export type CatalogProductResult =
  | {
      readonly kind: 'OK';
      readonly catalogVersion: CatalogVersion;
      readonly product: CatalogProductView;
    }
  /**
   * The SKU is not on offer.
   *
   * Distinct from UNAVAILABLE: "this does not exist" is a fact about the
   * catalogue, while "I could not look" is a fact about the connection, and an
   * agent that cannot tell them apart will retry the wrong one.
   */
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'UNAVAILABLE'; readonly reason: string };

export interface MerchantCatalogProvider {
  readonly name: string;

  /** The current catalogue version. Cheap; called once per agent decision. */
  catalogVersion(): Promise<CatalogVersion>;

  /**
   * Products matching a query.
   *
   * Returns a discriminated result rather than throwing, so an unreachable
   * merchant is something the agent runtime must handle explicitly rather than
   * an exception that might be caught somewhere permissive and read as "no
   * results".
   */
  search(request: CatalogSearchRequest): Promise<CatalogSearchResult>;

  /** One product by SKU, for the agent to inspect before adding it to a cart. */
  getProduct(merchantId: MerchantId, sku: Sku): Promise<CatalogProductResult>;
}
