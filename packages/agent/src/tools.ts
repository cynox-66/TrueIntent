/**
 * The agent's tool surface, and the actions it may propose.
 *
 * This file is the boundary the whole phase exists to draw, so it is worth
 * being explicit about what is *absent*. There is no `charge_card`, no
 * `capture_payment`, no `call_provider`, no `set_price`, no `resolve_review`.
 * Not "present but guarded" — absent. An agent cannot ask for something there
 * is no word for, and a model that hallucinates `capture_payment` produces an
 * action that fails schema validation like any other malformed output.
 *
 * Two further properties of the vocabulary matter:
 *
 *  - **No action carries money.** `ADD_ITEM` names a SKU and a quantity. There
 *    is no `unitPrice` field, no `total` field, no `currency` field, because the
 *    server prices the cart from live merchant state and the agent has nothing
 *    to lie about. `REQUEST_PURCHASE` carries a reason string for evidence and
 *    nothing else.
 *  - **No action carries a verdict.** The agent asks CaptureLock to verify a
 *    purchase; it cannot state the outcome. There is no field for one.
 *
 * Every schema is `.strict()`, so an extra property is a validation failure
 * rather than something silently dropped. That is the difference between "we
 * ignore what the agent claims" and "the agent cannot claim it".
 */

import { z } from 'zod';
import { SkuSchema } from '@capturelock/core';

/** Bounds on model-authored text. Free text reaches evidence, so it is capped. */
export const MAX_QUERY_LENGTH = 200;
export const MAX_REASON_LENGTH = 500;

/**
 * The closed set of things an agent may do.
 *
 * Named as intents rather than as effects — `REQUEST_PURCHASE`, not
 * `MAKE_PURCHASE` — because that is what they are. Every one of them is a
 * request the server validates and may refuse.
 */
export const AGENT_ACTION_KINDS = [
  'SEARCH_PRODUCTS',
  'GET_PRODUCT',
  'ADD_ITEM',
  'REMOVE_ITEM',
  'INSPECT_CART',
  'REQUEST_PURCHASE',
  'ABANDON',
] as const;

export type AgentActionKind = (typeof AGENT_ACTION_KINDS)[number];

export const AgentActionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('SEARCH_PRODUCTS'),
      query: z.string().min(1).max(MAX_QUERY_LENGTH),
    })
    .strict(),
  z
    .object({
      action: z.literal('GET_PRODUCT'),
      sku: SkuSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('ADD_ITEM'),
      sku: SkuSchema,
      // Bounded here as well as by the session authority. A quantity of 10^9
      // should be refused by the schema, before any arithmetic runs on it.
      quantity: z.number().int().min(1).max(10_000),
    })
    .strict(),
  z
    .object({
      action: z.literal('REMOVE_ITEM'),
      sku: SkuSchema,
    })
    .strict(),
  z.object({ action: z.literal('INSPECT_CART') }).strict(),
  z
    .object({
      action: z.literal('REQUEST_PURCHASE'),
      /** Why the agent believes this cart satisfies the intent. Evidence only. */
      reason: z.string().min(1).max(MAX_REASON_LENGTH),
    })
    .strict(),
  z
    .object({
      action: z.literal('ABANDON'),
      reason: z.string().min(1).max(MAX_REASON_LENGTH),
    })
    .strict(),
]);

export type AgentAction = z.infer<typeof AgentActionSchema>;

/**
 * Parses model output into an action.
 *
 * Returns a result rather than throwing: malformed model output is an expected
 * condition, not an exception. A model will eventually emit prose where JSON
 * belongs, and that has to end in a recorded `INVALID_AGENT_ACTION` step rather
 * than an exception someone might catch and treat as a no-op.
 */
export type ParseActionResult =
  | { readonly kind: 'PARSED'; readonly action: AgentAction }
  | { readonly kind: 'INVALID'; readonly detail: string };

export function parseAgentAction(value: unknown): ParseActionResult {
  const result = AgentActionSchema.safeParse(value);
  if (result.success) return { kind: 'PARSED', action: result.data };

  const detail = result.error.issues
    .slice(0, 4)
    .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return { kind: 'INVALID', detail };
}

/**
 * The tool names the agent is told about.
 *
 * Exported so a test can assert the surface has not grown a payment tool, and
 * so a model prompt is generated from one source rather than restated in prose
 * that could drift from the schema.
 */
export const TOOL_DESCRIPTIONS: Readonly<Record<AgentActionKind, string>> = Object.freeze({
  SEARCH_PRODUCTS: 'Search the merchant catalogue by free text. Returns merchant-stated facts.',
  GET_PRODUCT: 'Fetch one product by SKU to inspect its category, attributes and stock.',
  ADD_ITEM: 'Add a SKU and quantity to the draft cart. You cannot set a price.',
  REMOVE_ITEM: 'Remove a SKU from the draft cart.',
  INSPECT_CART: 'Review the current draft cart.',
  REQUEST_PURCHASE:
    'Ask CaptureLock to verify and, if it permits, execute the purchase. You do not decide the outcome.',
  ABANDON: 'Give up on this goal, stating why. Use this when the catalogue cannot satisfy it.',
});

/**
 * Words that must never name a tool.
 *
 * Asserted by a test rather than merely intended. If someone later adds a
 * provider-facing tool to this surface, that test fails and says why.
 */
export const FORBIDDEN_TOOL_SUBSTRINGS = Object.freeze([
  'charge',
  'capture',
  'razorpay',
  'provider',
  'payment',
  'refund',
  'grant',
  'approve',
  'operator',
  'price',
]);
