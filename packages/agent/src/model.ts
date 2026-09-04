/**
 * The buyer model port.
 *
 * A model proposes actions. It decides nothing. The distinction is the reason
 * this interface is so narrow: it is handed a structured view of the world and
 * returns one structured action, and every action it returns is validated
 * against the session authority and the draft cart before it takes effect.
 *
 * What deliberately does not appear in `BuyerModelInput`: any credential, any
 * provider reference, any policy document, any release state, any verdict. The
 * model cannot see the machinery that moves money, so a prompt-injected model
 * cannot be talked into operating it. The worst a compromised model can do is
 * propose a cart that gets refused.
 *
 * The default implementation is deterministic and takes no dependency on a
 * network. That is not a placeholder apology — it is what makes the demo and
 * every scenario reproducible, and it means the safety properties are tested
 * against a model whose behaviour a reader can predict. An LLM-backed
 * implementation of this same interface changes nothing about those properties,
 * which is the entire point of having the interface.
 */

import type { CatalogProductView, Money, SessionBounds, Sku } from '@capturelock/core';
import { money } from '@capturelock/core';
import type { AgentAction } from './tools.js';

/** A line in the draft cart. Note the absence of a price: the server owns that. */
export interface DraftCartLine {
  readonly sku: string;
  readonly quantity: number;
}

/**
 * What the model is allowed to see.
 *
 * `remainingBudget` is included because an agent that cannot see its budget
 * proposes carts that are refused, which is a usability failure rather than a
 * security one. It is server-computed and read-only; the model restating it
 * would be ignored, because no action carries an amount.
 */
export interface BuyerModelInput {
  /** The user's own words. */
  readonly goal: string;
  readonly bounds: SessionBounds;
  readonly remainingBudget: Money;
  readonly cart: readonly DraftCartLine[];
  /** Products the agent has seen so far this run, keyed by SKU. */
  readonly observed: readonly CatalogProductView[];
  /** What happened to each earlier action, so the model can adapt. */
  readonly history: readonly string[];
  readonly stepsRemaining: number;
}

export interface BuyerModel {
  readonly name: string;
  /**
   * Proposes the next action.
   *
   * Returning `null` means "unavailable". Implementations must not throw: the
   * runtime treats an exception the same as unavailability, but a model that
   * signals absence explicitly produces a clearer record. Either way the run
   * ends without a purchase, because refusing to shop is safe and guessing is
   * not.
   */
  decide(input: BuyerModelInput): Promise<AgentAction | null>;
}

/**
 * A deterministic planner.
 *
 * It follows the obvious shopping strategy and nothing more: search once,
 * inspect what came back, add the cheapest items that fit the delegated
 * categories until the goal is plausibly met, then ask for the purchase. It
 * cannot do anything clever, and that is deliberate — a scenario is only
 * evidence about CaptureLock if the agent's behaviour is predictable.
 *
 * `preferSku` exists so an adversarial scenario can make this agent behave
 * badly on purpose: point it at the energy drinks and it will dutifully build a
 * cart that is numerically valid and semantically nonsense, which is exactly the
 * agent failure the deterministic checks have to catch. An agent that can only
 * behave well proves nothing.
 */
export class DeterministicBuyerModel implements BuyerModel {
  public readonly name: string;

  /** Preferred SKUs already looked up, so a missing one is not chased forever. */
  private readonly lookedUp = new Set<string>();

  /**
   * SKUs this planner has asked to add.
   *
   * On the next turn, a proposed SKU that is not in the cart was refused — the
   * server validated it and said no. Retrying it would produce the same answer
   * until the step budget ran out, which is a worse account of what happened
   * than "the agent tried, was told no, and bought something else".
   */
  private readonly proposedAdds = new Set<string>();

  constructor(
    private readonly options: {
      /** SKUs to reach for first, in order. Used by drift scenarios. */
      readonly preferSku?: readonly string[];
      /** Quantity to add per line. */
      readonly quantity?: number;
      /** Stop adding lines once this many are in the cart. */
      readonly maxLines?: number;
      readonly name?: string;
    } = {},
  ) {
    this.name = options.name ?? 'deterministic-planner';
  }

  async decide(input: BuyerModelInput): Promise<AgentAction> {
    // 1. Nothing seen yet: look at the catalogue — but only once. Re-issuing
    //    the same query against an unchanged catalogue would produce the same
    //    empty answer until the step budget ran out, and "ran out of steps" is
    //    a much worse account of what happened than "nothing here fits".
    if (input.observed.length === 0) {
      if (input.history.length === 0) {
        return { action: 'SEARCH_PRODUCTS', query: searchQueryFor(input.goal) };
      }
      // Worded neutrally on purpose. From here the planner cannot tell an
      // empty catalogue from an unreachable one, and claiming the former when
      // the latter happened would put a false explanation into evidence. The
      // step log records which it actually was.
      return {
        action: 'ABANDON',
        reason: 'Nothing usable was found in the merchant catalogue for this goal.',
      };
    }

    const quantity = this.options.quantity ?? 1;
    const maxLines = this.options.maxLines ?? 3;
    const inCart = new Set(input.cart.map(line => line.sku));

    // 2. Add the preferred SKUs first, if a scenario named any.
    //
    //    A preferred SKU that the search did not surface is looked up rather
    //    than skipped: "I know what I want, let me check the catalogue for it"
    //    is what an agent with a fixed idea does, and skipping it would mean a
    //    scenario steering the agent at an out-of-scope item quietly never
    //    reached the check that refuses it.
    for (const preferred of this.options.preferSku ?? []) {
      if (inCart.has(preferred)) continue;
      // Proposed before and still not in the cart: it was refused.
      if (this.proposedAdds.has(preferred)) continue;

      const product = input.observed.find(candidate => candidate.sku === preferred);
      if (product !== undefined) {
        this.proposedAdds.add(product.sku);
        return { action: 'ADD_ITEM', sku: product.sku, quantity };
      }
      // Not seen yet: look it up once. `lookedUp` stops a SKU the catalogue
      // genuinely does not carry from being chased until the step budget runs
      // out — the agent asks, learns it does not exist, and moves on.
      if (!this.lookedUp.has(preferred)) {
        this.lookedUp.add(preferred);
        // Cast rather than validated here on purpose: the runtime runs every
        // action through `parseAgentAction`, so a malformed SKU is refused
        // there. Validating in two places invites the two to disagree.
        return { action: 'GET_PRODUCT', sku: preferred as Sku };
      }
    }

    // 3. Otherwise fill the cart with affordable, in-scope, in-stock items,
    //    cheapest first. Cheapest-first is a plausible agent heuristic and it
    //    is also what makes the drift bait attractive without special-casing.
    if (inCart.size < maxLines) {
      const candidate = this.pickCandidate(input, inCart, quantity);
      if (candidate !== null) {
        this.proposedAdds.add(candidate.sku);
        return { action: 'ADD_ITEM', sku: candidate.sku, quantity };
      }
    }

    // 4. A cart with something in it is worth asking about; an empty one is not.
    if (input.cart.length > 0) {
      return {
        action: 'REQUEST_PURCHASE',
        reason: this.explain(input),
      };
    }

    return {
      action: 'ABANDON',
      reason: 'No catalogue item matched the delegated categories and budget.',
    };
  }

  private pickCandidate(
    input: BuyerModelInput,
    inCart: ReadonlySet<string>,
    quantity: number,
  ): CatalogProductView | null {
    const allowed = new Set(input.bounds.allowedCategories);
    const forbidden = new Set(input.bounds.forbiddenCategories);

    // The model checks scope as a courtesy, so it does not waste steps on
    // proposals the server will refuse. It is not a security check: the server
    // validates every action regardless, and the drift scenarios rely on this
    // filter being bypassable via `preferSku`.
    const eligible = input.observed
      .filter(product => !inCart.has(product.sku))
      .filter(product => !this.proposedAdds.has(product.sku))
      .filter(product => product.available && product.availableStock >= quantity)
      .filter(product => !forbidden.has(product.category))
      .filter(product => allowed.size === 0 || allowed.has(product.category))
      .filter(product => fitsRemaining(product, quantity, input.remainingBudget))
      .sort(
        (a, b) =>
          a.unitPrice.amountMinor - b.unitPrice.amountMinor || a.sku.localeCompare(b.sku, 'en'),
      );

    return eligible[0] ?? null;
  }

  private explain(input: BuyerModelInput): string {
    const names = input.cart
      .map(line => {
        const product = input.observed.find(p => p.sku === line.sku);
        return product === undefined ? line.sku : `${String(line.quantity)}x ${product.name}`;
      })
      .join(', ');
    return `Selected ${names} as the closest catalogue match to: ${input.goal}`.slice(0, 500);
  }
}

/**
 * A model that always emits something unparseable.
 *
 * Exists so the "malformed model action" path is exercised by a real model
 * rather than by hand-injecting a bad object, which would test the parser
 * without testing the runtime's handling of it.
 */
export class MalformedBuyerModel implements BuyerModel {
  public readonly name = 'malformed';

  async decide(): Promise<AgentAction> {
    // Cast deliberately: this is what a model returning prose looks like once
    // it has been JSON-parsed, and the runtime must survive it.
    return { action: 'CAPTURE_PAYMENT', amount: 1 } as unknown as AgentAction;
  }
}

/** A model that is simply not there. */
export class UnavailableBuyerModel implements BuyerModel {
  public readonly name = 'unavailable';

  async decide(): Promise<null> {
    return null;
  }
}

function fitsRemaining(product: CatalogProductView, quantity: number, remaining: Money): boolean {
  if (product.unitPrice.currency !== remaining.currency) return false;
  return product.unitPrice.amountMinor * quantity <= remaining.amountMinor;
}

/**
 * Reduces the goal to catalogue search terms.
 *
 * Strips the money words, because "under 800 rupees" is a constraint the
 * authority already carries and matching a catalogue against the digit 800
 * finds nothing.
 */
function searchQueryFor(goal: string): string {
  const words = goal
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(word => word.length > 2 && !BUDGET_WORDS.has(word) && !/^\d+$/.test(word));
  const query = words.slice(0, 8).join(' ');
  return query.length === 0 ? goal.slice(0, 200) : query;
}

const BUDGET_WORDS = new Set([
  'under',
  'below',
  'max',
  'maximum',
  'budget',
  'rupees',
  'rupee',
  'inr',
  'cheap',
  'cheapest',
  'for',
  'and',
  'the',
  'with',
  'please',
  'buy',
  'order',
  'get',
  'find',
  'want',
  'need',
]);

export { money };
