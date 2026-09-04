/**
 * The bounded buyer agent runtime.
 *
 * A loop with a step budget, around a model that proposes and a validator that
 * refuses. The loop is the whole framework: there is no planner hierarchy, no
 * tool registry abstraction, no multi-agent negotiation, because none of that
 * would make the boundary safer and all of it would make the boundary harder to
 * read.
 *
 * Three properties hold by construction:
 *
 *  - **The runtime holds no payment reference.** Its dependencies are a
 *    catalogue and a model. It cannot call a provider because it has nothing to
 *    call one with — the same structural argument `CoreDependencies` makes for
 *    the quote and webhook services.
 *  - **Every action is validated against the delegated authority before it
 *    takes effect.** Not after, and not by the model. A proposal that would
 *    leave the cart outside the session bounds is recorded as refused and the
 *    cart is unchanged.
 *  - **The run ends in a request, never in an execution.** The best outcome
 *    this code can produce is `REQUEST_PURCHASE` and a draft cart of SKUs and
 *    quantities. Deciding whether money may move happens somewhere else
 *    entirely, on data this runtime never touches.
 *
 * The draft cart carries no prices. That is worth stating twice, because it is
 * what makes "the agent lied about the price" unrepresentable rather than
 * merely detected.
 */

import {
  remainingBudget,
  type CatalogProductView,
  type MerchantCatalogProvider,
  type MerchantId,
  type ReasonCode,
  type SessionAuthorityRecord,
  type Sku,
} from '@capturelock/core';
import type { BuyerModel, DraftCartLine } from './model.js';
import { parseAgentAction, type AgentAction } from './tools.js';

/** Default ceiling on model turns. Generous for the demo, finite by design. */
export const DEFAULT_MAX_STEPS = 12;
export const SEARCH_RESULT_LIMIT = 10;

/** One model turn, and what the runtime did about it. */
export interface AgentStep {
  readonly index: number;
  /** The action as proposed, or null when the model produced nothing usable. */
  readonly action: AgentAction | null;
  readonly accepted: boolean;
  /** Why an action was refused. Uses the shared reason vocabulary. */
  readonly refusedWith: ReasonCode | null;
  /** Human-readable outcome, carried into evidence. */
  readonly detail: string;
}

export type AgentRunOutcome =
  /** The agent wants this cart bought. Nothing has been bought. */
  | {
      readonly kind: 'PURCHASE_REQUESTED';
      readonly cart: readonly DraftCartLine[];
      readonly reason: string;
      readonly catalogVersion: string;
    }
  /** The agent gave up, and said why. */
  | { readonly kind: 'ABANDONED'; readonly reason: string }
  /** The run ended without a decision. Always a refusal, never a purchase. */
  | { readonly kind: 'FAILED'; readonly reasonCode: ReasonCode; readonly detail: string };

export interface AgentRunResult {
  readonly outcome: AgentRunOutcome;
  readonly steps: readonly AgentStep[];
  readonly model: string;
  /** Everything the agent saw, for grounding checks and evidence. */
  readonly observed: readonly CatalogProductView[];
}

export interface AgentRuntimeDependencies {
  readonly catalog: MerchantCatalogProvider;
  readonly model: BuyerModel;
  readonly maxSteps?: number;
}

export interface AgentRunRequest {
  readonly session: SessionAuthorityRecord;
  readonly merchantId: MerchantId;
  /** The user's words. Passed to the model; never read by a validator. */
  readonly goal: string;
}

export class BuyerAgentRuntime {
  constructor(private readonly deps: AgentRuntimeDependencies) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const maxSteps = this.deps.maxSteps ?? DEFAULT_MAX_STEPS;
    const steps: AgentStep[] = [];
    const observed = new Map<string, CatalogProductView>();
    const history: string[] = [];
    let cart: DraftCartLine[] = [];
    let catalogVersion = 'unknown';

    for (let index = 0; index < maxSteps; index += 1) {
      const proposal = await this.propose({
        request,
        cart,
        observed: [...observed.values()],
        history,
        stepsRemaining: maxSteps - index,
      });

      if (proposal.kind === 'UNAVAILABLE') {
        steps.push({
          index,
          action: null,
          accepted: false,
          refusedWith: 'AGENT_MODEL_UNAVAILABLE',
          detail: proposal.detail,
        });
        return {
          outcome: {
            kind: 'FAILED',
            reasonCode: 'AGENT_MODEL_UNAVAILABLE',
            detail: proposal.detail,
          },
          steps,
          model: this.deps.model.name,
          observed: [...observed.values()],
        };
      }

      if (proposal.kind === 'INVALID') {
        // Recorded and survived, not thrown. The model gets to see that its
        // output was rejected and try again inside the same step budget.
        steps.push({
          index,
          action: null,
          accepted: false,
          refusedWith: 'INVALID_AGENT_ACTION',
          detail: proposal.detail,
        });
        history.push(`step ${String(index)}: rejected malformed action (${proposal.detail})`);
        continue;
      }

      const action = proposal.action;

      switch (action.action) {
        case 'SEARCH_PRODUCTS': {
          const result = await this.deps.catalog.search({
            merchantId: request.merchantId,
            query: action.query,
            limit: SEARCH_RESULT_LIMIT,
          });
          if (result.kind === 'UNAVAILABLE') {
            steps.push(
              refused(index, action, 'CART_NOT_GROUNDED', `merchant unreachable: ${result.reason}`),
            );
            history.push(`step ${String(index)}: search failed, merchant unreachable`);
            break;
          }
          catalogVersion = result.catalogVersion;
          for (const product of result.products) observed.set(product.sku, product);
          steps.push(
            accepted(
              index,
              action,
              `search "${action.query}" returned ${String(result.products.length)} product(s)`,
            ),
          );
          history.push(
            `step ${String(index)}: searched "${action.query}", saw ${result.products
              .map(p => p.sku)
              .join(', ')}`,
          );
          break;
        }

        case 'GET_PRODUCT': {
          const result = await this.deps.catalog.getProduct(request.merchantId, action.sku);
          if (result.kind === 'UNAVAILABLE') {
            steps.push(
              refused(index, action, 'CART_NOT_GROUNDED', `merchant unreachable: ${result.reason}`),
            );
            history.push(`step ${String(index)}: could not read ${action.sku}`);
            break;
          }
          if (result.kind === 'NOT_FOUND') {
            // A hallucinated SKU. Refused here, and it could not have been
            // added anyway — `ADD_ITEM` re-checks grounding independently.
            steps.push(
              refused(index, action, 'CART_NOT_GROUNDED', `${action.sku} is not in the catalogue`),
            );
            history.push(`step ${String(index)}: ${action.sku} does not exist`);
            break;
          }
          catalogVersion = result.catalogVersion;
          observed.set(result.product.sku, result.product);
          steps.push(accepted(index, action, `read ${action.sku}`));
          history.push(
            `step ${String(index)}: ${action.sku} is ${result.product.name} in category ${result.product.category}`,
          );
          break;
        }

        case 'ADD_ITEM': {
          const validation = await this.validateAddition(
            request,
            cart,
            action.sku,
            action.quantity,
          );
          if (validation.kind === 'REFUSED') {
            steps.push(refused(index, action, validation.reasonCode, validation.detail));
            history.push(`step ${String(index)}: refused ${action.sku} — ${validation.detail}`);
            break;
          }
          catalogVersion = validation.catalogVersion;
          observed.set(validation.product.sku, validation.product);
          cart = [
            ...cart.filter(line => line.sku !== action.sku),
            { sku: action.sku, quantity: action.quantity },
          ];
          steps.push(
            accepted(
              index,
              action,
              `added ${String(action.quantity)}x ${action.sku} to the draft cart`,
            ),
          );
          history.push(`step ${String(index)}: added ${String(action.quantity)}x ${action.sku}`);
          break;
        }

        case 'REMOVE_ITEM': {
          const before = cart.length;
          cart = cart.filter(line => line.sku !== action.sku);
          steps.push(
            accepted(
              index,
              action,
              before === cart.length
                ? `${action.sku} was not in the cart`
                : `removed ${action.sku}`,
            ),
          );
          history.push(`step ${String(index)}: removed ${action.sku}`);
          break;
        }

        case 'INSPECT_CART': {
          const summary =
            cart.length === 0
              ? 'the draft cart is empty'
              : cart.map(line => `${String(line.quantity)}x ${line.sku}`).join(', ');
          steps.push(accepted(index, action, summary));
          history.push(`step ${String(index)}: cart is ${summary}`);
          break;
        }

        case 'REQUEST_PURCHASE': {
          if (cart.length === 0) {
            steps.push(
              refused(
                index,
                action,
                'INVALID_AGENT_ACTION',
                'cannot request a purchase of an empty cart',
              ),
            );
            history.push(`step ${String(index)}: refused purchase of an empty cart`);
            break;
          }
          steps.push(accepted(index, action, 'requested verification of the draft cart'));
          return {
            // The end of this runtime's authority. It has produced a request
            // and a list of SKUs. Everything that decides whether money moves
            // happens elsewhere, on server-resolved data.
            outcome: {
              kind: 'PURCHASE_REQUESTED',
              cart,
              reason: action.reason,
              catalogVersion,
            },
            steps,
            model: this.deps.model.name,
            observed: [...observed.values()],
          };
        }

        case 'ABANDON': {
          steps.push(accepted(index, action, 'abandoned the goal'));
          return {
            outcome: { kind: 'ABANDONED', reason: action.reason },
            steps,
            model: this.deps.model.name,
            observed: [...observed.values()],
          };
        }
      }
    }

    // Out of steps. A run that cannot decide ends in a refusal, because the
    // alternative — treating exhaustion as tacit approval — is the failure mode
    // this whole layer exists to prevent.
    return {
      outcome: {
        kind: 'FAILED',
        reasonCode: 'AGENT_STEP_LIMIT_EXCEEDED',
        detail: `The agent used all ${String(maxSteps)} steps without reaching a decision.`,
      },
      steps,
      model: this.deps.model.name,
      observed: [...observed.values()],
    };
  }

  /**
   * Asks the model for one action and parses it.
   *
   * An exception from the model is treated exactly as unavailability. A model
   * that throws must not be able to take the runtime down, and it must not be
   * able to skip a step silently either.
   */
  private async propose(context: {
    readonly request: AgentRunRequest;
    readonly cart: readonly DraftCartLine[];
    readonly observed: readonly CatalogProductView[];
    readonly history: readonly string[];
    readonly stepsRemaining: number;
  }): Promise<
    | { kind: 'PARSED'; action: AgentAction }
    | { kind: 'INVALID'; detail: string }
    | { kind: 'UNAVAILABLE'; detail: string }
  > {
    let raw: unknown;
    try {
      raw = await this.deps.model.decide({
        goal: context.request.goal,
        bounds: context.request.session.bounds,
        remainingBudget: remainingBudget(context.request.session),
        cart: context.cart,
        observed: context.observed,
        history: context.history,
        stepsRemaining: context.stepsRemaining,
      });
    } catch (error) {
      return {
        kind: 'UNAVAILABLE',
        detail: `The buyer model threw: ${error instanceof Error ? error.message : 'unknown'}`,
      };
    }

    if (raw === null || raw === undefined) {
      return { kind: 'UNAVAILABLE', detail: 'The buyer model reported itself unavailable.' };
    }
    return parseAgentAction(raw);
  }

  /**
   * Validates one addition against the delegated authority and live catalogue.
   *
   * Grounding is re-checked here even when the model has already inspected the
   * product, because the model's memory is not evidence: a SKU it "saw" may
   * have been invented, and a product it saw may have been withdrawn since.
   *
   * Note what this does NOT check: the cart total against the budget. The
   * catalogue price is indicative, so a budget decision made on it would be a
   * decision made on stale data. Budget is enforced where the authoritative
   * total exists — the reservation and the kernel's intent stage, both against
   * a server-priced snapshot.
   */
  private async validateAddition(
    request: AgentRunRequest,
    cart: readonly DraftCartLine[],
    sku: Sku,
    quantity: number,
  ): Promise<
    | { kind: 'OK'; product: CatalogProductView; catalogVersion: string }
    | { kind: 'REFUSED'; reasonCode: ReasonCode; detail: string }
  > {
    const bounds = request.session.bounds;

    if (quantity < bounds.itemsPerPurchase.min || quantity > bounds.itemsPerPurchase.max) {
      return {
        kind: 'REFUSED',
        reasonCode: 'SESSION_PURCHASE_NOT_PERMITTED',
        detail: `quantity ${String(quantity)} is outside the delegated band ${String(
          bounds.itemsPerPurchase.min,
        )}-${String(bounds.itemsPerPurchase.max)}`,
      };
    }

    const result = await this.deps.catalog.getProduct(request.merchantId, sku);
    if (result.kind === 'UNAVAILABLE') {
      return {
        kind: 'REFUSED',
        reasonCode: 'CART_NOT_GROUNDED',
        detail: `merchant unreachable: ${result.reason}`,
      };
    }
    if (result.kind === 'NOT_FOUND') {
      return {
        kind: 'REFUSED',
        reasonCode: 'CART_NOT_GROUNDED',
        detail: `${sku} is not offered by ${request.merchantId}`,
      };
    }

    const product = result.product;

    if (
      bounds.merchants.mode === 'ALLOWLIST' &&
      !bounds.merchants.merchantIds.includes(product.merchantId)
    ) {
      return {
        kind: 'REFUSED',
        reasonCode: 'SESSION_PURCHASE_NOT_PERMITTED',
        detail: `${product.merchantId} is not a merchant this session may buy from`,
      };
    }
    if (bounds.forbiddenCategories.includes(product.category)) {
      return {
        kind: 'REFUSED',
        reasonCode: 'SESSION_PURCHASE_NOT_PERMITTED',
        detail: `category ${product.category} is excluded by the session`,
      };
    }
    if (
      bounds.allowedCategories.length > 0 &&
      !bounds.allowedCategories.includes(product.category)
    ) {
      return {
        kind: 'REFUSED',
        reasonCode: 'SESSION_PURCHASE_NOT_PERMITTED',
        detail: `category ${product.category} is not one this session authorized`,
      };
    }
    if (!product.available || product.availableStock < quantity) {
      return {
        kind: 'REFUSED',
        reasonCode: 'CART_NOT_GROUNDED',
        detail: `${sku} has ${String(product.availableStock)} in stock, ${String(quantity)} requested`,
      };
    }
    if (product.subscriptionOnly && bounds.recurrence === 'ONE_TIME_ONLY') {
      return {
        kind: 'REFUSED',
        reasonCode: 'SESSION_PURCHASE_NOT_PERMITTED',
        detail: `${sku} is subscription-only and this session authorized a one-time purchase`,
      };
    }

    const distinctLines = new Set([...cart.map(line => line.sku), sku]).size;
    if (distinctLines > MAX_DRAFT_CART_LINES) {
      return {
        kind: 'REFUSED',
        reasonCode: 'SESSION_PURCHASE_NOT_PERMITTED',
        detail: `a draft cart may hold at most ${String(MAX_DRAFT_CART_LINES)} distinct lines`,
      };
    }

    return { kind: 'OK', product, catalogVersion: result.catalogVersion };
  }
}

/**
 * Cap on draft cart lines.
 *
 * Below the kernel's `MAX_CART_LINES` so an agent cannot build a cart that the
 * structural stage would refuse for size. Refusing early gives a better reason.
 */
export const MAX_DRAFT_CART_LINES = 20;

function accepted(index: number, action: AgentAction, detail: string): AgentStep {
  return { index, action, accepted: true, refusedWith: null, detail };
}

function refused(
  index: number,
  action: AgentAction,
  reasonCode: ReasonCode,
  detail: string,
): AgentStep {
  return { index, action, accepted: false, refusedWith: reasonCode, detail };
}
