/**
 * The bounded buyer agent runtime.
 *
 * Two families of case here, and the second is the one that matters. The first
 * checks the agent can shop. The second checks that a *misbehaving* agent — a
 * model emitting prose, inventing SKUs, demanding quantities outside the
 * delegated band, reaching for a category the user excluded, or simply gone —
 * produces a refusal and a record, never a purchase and never an exception.
 *
 * Every terminal state this runtime can reach is either a request or a refusal.
 * There is no third outcome, which is asserted rather than asserted about.
 */

import { describe, expect, it } from 'vitest';
import {
  FixedClock,
  asTimestamp,
  computeSessionBoundsHash,
  money,
  type MerchantId,
  type SessionAuthorityRecord,
  type SessionBounds,
  type SessionId,
  type UserId,
} from '@capturelock/core';
import { FakeMerchantCatalog, type CatalogItemSpec } from '@capturelock/integrations';
import {
  BuyerAgentRuntime,
  DeterministicBuyerModel,
  MalformedBuyerModel,
  UnavailableBuyerModel,
  type AgentAction,
  type BuyerModel,
  type BuyerModelInput,
} from '../src/index.js';

const MERCHANT = 'merchant_alpha' as MerchantId;
const EXPIRES = asTimestamp('2026-09-05T10:00:00.000Z');
const GOAL = 'Thai curry dinner for 4, vegetarian, under 800 rupees';

const CURRY: CatalogItemSpec = {
  sku: 'SKU-THAI-CURRY-KIT',
  name: 'Thai Green Curry Kit',
  category: 'thai-meal-kit',
  attributes: [
    { name: 'diet', value: 'vegetarian' },
    { name: 'cuisine', value: 'thai' },
  ],
  unitPriceMinor: 28_000,
  availableStock: 20,
};

const RICE: CatalogItemSpec = {
  sku: 'SKU-THAI-RICE-1KG',
  name: 'Jasmine Rice 1kg',
  category: 'groceries',
  attributes: [{ name: 'diet', value: 'vegetarian' }],
  unitPriceMinor: 18_000,
  availableStock: 40,
};

const ENERGY: CatalogItemSpec = {
  sku: 'SKU-ENERGY-500',
  name: 'Voltz Energy Drink 500ml',
  category: 'beverages',
  attributes: [{ name: 'caffeine', value: 'high' }],
  unitPriceMinor: 5_000,
  availableStock: 200,
};

const SUBSCRIPTION: CatalogItemSpec = {
  sku: 'SKU-MEAL-PLAN',
  name: 'Thai Meal Plan',
  category: 'thai-meal-kit',
  attributes: [{ name: 'diet', value: 'vegetarian' }],
  unitPriceMinor: 20_000,
  availableStock: 50,
  subscriptionOnly: true,
};

function catalog(items: readonly CatalogItemSpec[] = [CURRY, RICE, ENERGY]): FakeMerchantCatalog {
  const clock = new FixedClock(asTimestamp('2026-09-04T10:00:00.000Z'));
  return new FakeMerchantCatalog({
    merchantId: MERCHANT,
    currency: 'INR',
    items,
    fees: [{ type: 'SHIPPING', label: 'Standard delivery', amount: money('INR', 15_000) }],
    clock: () => clock.now(),
  });
}

function bounds(overrides: Partial<SessionBounds> = {}): SessionBounds {
  return {
    currency: 'INR',
    totalBudget: money('INR', 200_000),
    maxPerPurchase: money('INR', 80_000),
    merchants: { mode: 'ALLOWLIST', merchantIds: [MERCHANT] },
    allowedCategories: ['thai-meal-kit', 'groceries'],
    forbiddenCategories: ['alcohol'],
    itemsPerPurchase: { min: 1, max: 4 },
    recurrence: 'ONE_TIME_ONLY',
    expiresAt: EXPIRES,
    ...overrides,
  };
}

function session(overrides: Partial<SessionBounds> = {}): SessionAuthorityRecord {
  const b = bounds(overrides);
  return {
    sessionId: 'sess_00000000000000000000000000000001' as SessionId,
    userId: 'user_priya' as UserId,
    purpose: GOAL,
    bounds: b,
    boundsHash: computeSessionBoundsHash(b),
    policyId: 'household',
    policyVersion: '1.0.0',
    state: 'ACTIVE',
    reservedMinor: 0,
    spentMinor: 0,
    createdAt: asTimestamp('2026-09-04T09:00:00.000Z'),
    expiresAt: EXPIRES,
    revokedAt: null,
  };
}

/** A model that plays a fixed script, for cases the planner would not produce. */
class ScriptedBuyerModel implements BuyerModel {
  public readonly name = 'scripted';
  private index = 0;

  constructor(private readonly script: readonly unknown[]) {}

  async decide(_input: BuyerModelInput): Promise<AgentAction | null> {
    const next = this.script[this.index] ?? {
      action: 'ABANDON',
      reason: 'script exhausted',
    };
    this.index += 1;
    return next as AgentAction;
  }
}

describe('a well-behaved agent', () => {
  it('searches, builds a cart and requests a purchase', async () => {
    const runtime = new BuyerAgentRuntime({
      catalog: catalog(),
      model: new DeterministicBuyerModel({ maxLines: 2 }),
    });

    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });

    expect(result.outcome.kind).toBe('PURCHASE_REQUESTED');
    if (result.outcome.kind !== 'PURCHASE_REQUESTED') return;
    expect(result.outcome.cart.map(line => line.sku).sort()).toEqual([
      'SKU-THAI-CURRY-KIT',
      'SKU-THAI-RICE-1KG',
    ]);
    expect(result.outcome.catalogVersion).toMatch(/^cat_[0-9a-f]{16}$/);
  });

  it('never puts a price in the cart it hands on', async () => {
    // The structural reason "the agent lied about the price" is
    // unrepresentable: a draft line has two fields, and neither is money.
    const runtime = new BuyerAgentRuntime({
      catalog: catalog(),
      model: new DeterministicBuyerModel({ maxLines: 2 }),
    });
    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });

    if (result.outcome.kind !== 'PURCHASE_REQUESTED') throw new Error('expected a request');
    for (const line of result.outcome.cart) {
      expect(Object.keys(line).sort()).toEqual(['quantity', 'sku']);
    }
  });

  it('records every step it took, for evidence', async () => {
    const runtime = new BuyerAgentRuntime({
      catalog: catalog(),
      model: new DeterministicBuyerModel({ maxLines: 1 }),
    });
    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });

    expect(result.steps.length).toBeGreaterThan(1);
    expect(result.steps[0]?.action?.action).toBe('SEARCH_PRODUCTS');
    expect(result.steps.at(-1)?.action?.action).toBe('REQUEST_PURCHASE');
  });

  it('abandons rather than substituting when the catalogue cannot satisfy the goal', async () => {
    // Only out-of-scope stock available. Giving up is the correct answer; a
    // "close enough" substitution is how an agent buys the wrong thing.
    const runtime = new BuyerAgentRuntime({
      catalog: catalog([ENERGY]),
      model: new DeterministicBuyerModel(),
    });
    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });
    expect(result.outcome.kind).toBe('ABANDONED');
  });
});

describe('a misbehaving model', () => {
  it('cannot execute a payment, because no such tool exists', async () => {
    // The model asks for `CAPTURE_PAYMENT` outright. There is no word for it,
    // so it fails validation like any other malformed output — and the run ends
    // without a purchase.
    const runtime = new BuyerAgentRuntime({
      catalog: catalog(),
      model: new MalformedBuyerModel(),
      maxSteps: 3,
    });
    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });

    expect(result.outcome).toEqual({
      kind: 'FAILED',
      reasonCode: 'AGENT_STEP_LIMIT_EXCEEDED',
      detail: 'The agent used all 3 steps without reaching a decision.',
    });
    expect(result.steps.every(step => step.refusedWith === 'INVALID_AGENT_ACTION')).toBe(true);
  });

  it('survives malformed output and keeps going within its budget', async () => {
    const runtime = new BuyerAgentRuntime({
      catalog: catalog(),
      model: new ScriptedBuyerModel([
        'not json at all',
        { action: 'SEARCH_PRODUCTS' },
        { action: 'SEARCH_PRODUCTS', query: 'thai curry' },
        { action: 'ADD_ITEM', sku: 'SKU-THAI-CURRY-KIT', quantity: 1 },
        { action: 'REQUEST_PURCHASE', reason: 'one curry kit' },
      ]),
    });
    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });

    expect(result.outcome.kind).toBe('PURCHASE_REQUESTED');
    expect(result.steps.filter(step => step.refusedWith === 'INVALID_AGENT_ACTION')).toHaveLength(
      2,
    );
  });

  it('refuses a SKU the catalogue does not offer', async () => {
    // A hallucinated SKU. Refused on grounding, not on a guess about intent.
    const runtime = new BuyerAgentRuntime({
      catalog: catalog(),
      model: new ScriptedBuyerModel([
        { action: 'ADD_ITEM', sku: 'SKU-INVENTED', quantity: 1 },
        { action: 'ABANDON', reason: 'done' },
      ]),
    });
    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });

    expect(result.steps[0]).toMatchObject({
      accepted: false,
      refusedWith: 'CART_NOT_GROUNDED',
    });
  });

  it('refuses a quantity outside the delegated band', async () => {
    const runtime = new BuyerAgentRuntime({
      catalog: catalog(),
      model: new ScriptedBuyerModel([
        { action: 'ADD_ITEM', sku: 'SKU-THAI-CURRY-KIT', quantity: 12 },
        { action: 'ABANDON', reason: 'done' },
      ]),
    });
    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });

    expect(result.steps[0]).toMatchObject({
      accepted: false,
      refusedWith: 'SESSION_PURCHASE_NOT_PERMITTED',
    });
  });

  it('refuses a category the user did not authorize, even when it is cheap', async () => {
    // Twelve energy drinks would be numerically comfortable. The delegated
    // categories are what refuse it, and they refuse it here as well as at the
    // kernel — two independent checks, neither relying on the other.
    const runtime = new BuyerAgentRuntime({
      catalog: catalog(),
      model: new ScriptedBuyerModel([
        { action: 'ADD_ITEM', sku: 'SKU-ENERGY-500', quantity: 4 },
        { action: 'ABANDON', reason: 'done' },
      ]),
    });
    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });

    expect(result.steps[0]).toMatchObject({
      accepted: false,
      refusedWith: 'SESSION_PURCHASE_NOT_PERMITTED',
    });
  });

  it('refuses a subscription-only item under a one-time authority', async () => {
    const runtime = new BuyerAgentRuntime({
      catalog: catalog([SUBSCRIPTION]),
      model: new ScriptedBuyerModel([
        { action: 'ADD_ITEM', sku: 'SKU-MEAL-PLAN', quantity: 1 },
        { action: 'ABANDON', reason: 'done' },
      ]),
    });
    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });

    expect(result.steps[0]).toMatchObject({
      accepted: false,
      refusedWith: 'SESSION_PURCHASE_NOT_PERMITTED',
    });
  });

  it('refuses an out-of-stock item', async () => {
    const store = catalog();
    store.apply({ kind: 'SET_STOCK', sku: CURRY.sku, availableStock: 0 });
    const runtime = new BuyerAgentRuntime({
      catalog: store,
      model: new ScriptedBuyerModel([
        { action: 'ADD_ITEM', sku: 'SKU-THAI-CURRY-KIT', quantity: 1 },
        { action: 'ABANDON', reason: 'done' },
      ]),
    });
    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });

    expect(result.steps[0]).toMatchObject({
      accepted: false,
      refusedWith: 'CART_NOT_GROUNDED',
    });
  });

  it('refuses to request a purchase of an empty cart', async () => {
    const runtime = new BuyerAgentRuntime({
      catalog: catalog(),
      model: new ScriptedBuyerModel([
        { action: 'REQUEST_PURCHASE', reason: 'buy nothing please' },
        { action: 'ABANDON', reason: 'done' },
      ]),
    });
    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });

    expect(result.steps[0]).toMatchObject({
      accepted: false,
      refusedWith: 'INVALID_AGENT_ACTION',
    });
  });

  it('leaves the cart unchanged when an addition is refused', async () => {
    // A refusal must not half-apply. If the cart moved on a refused action, the
    // snapshot would be taken over something no check ever approved.
    const runtime = new BuyerAgentRuntime({
      catalog: catalog(),
      model: new ScriptedBuyerModel([
        { action: 'ADD_ITEM', sku: 'SKU-THAI-CURRY-KIT', quantity: 1 },
        { action: 'ADD_ITEM', sku: 'SKU-ENERGY-500', quantity: 1 },
        { action: 'REQUEST_PURCHASE', reason: 'curry only' },
      ]),
    });
    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });

    if (result.outcome.kind !== 'PURCHASE_REQUESTED') throw new Error('expected a request');
    expect(result.outcome.cart).toEqual([{ sku: 'SKU-THAI-CURRY-KIT', quantity: 1 }]);
  });

  it('ends without a purchase when the model is unavailable', async () => {
    const runtime = new BuyerAgentRuntime({
      catalog: catalog(),
      model: new UnavailableBuyerModel(),
    });
    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });

    expect(result.outcome).toMatchObject({
      kind: 'FAILED',
      reasonCode: 'AGENT_MODEL_UNAVAILABLE',
    });
  });

  it('treats a model that throws as unavailable rather than crashing', async () => {
    const throwing: BuyerModel = {
      name: 'throwing',
      decide: () => Promise.reject(new Error('upstream exploded')),
    };
    const runtime = new BuyerAgentRuntime({ catalog: catalog(), model: throwing });
    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });

    expect(result.outcome).toMatchObject({
      kind: 'FAILED',
      reasonCode: 'AGENT_MODEL_UNAVAILABLE',
    });
  });

  it('stops at its step budget rather than looping forever', async () => {
    const runtime = new BuyerAgentRuntime({
      catalog: catalog(),
      model: new ScriptedBuyerModel(Array.from({ length: 50 }, () => ({ action: 'INSPECT_CART' }))),
      maxSteps: 5,
    });
    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });

    expect(result.outcome).toMatchObject({
      kind: 'FAILED',
      reasonCode: 'AGENT_STEP_LIMIT_EXCEEDED',
    });
    expect(result.steps).toHaveLength(5);
  });

  it('gives up safely when the merchant is unreachable', async () => {
    // Either terminal state is safe — what matters is that no purchase is
    // requested and the reason the agent could not proceed is on the record.
    // The agent gives up; the step log, not the agent's own wording, is what
    // says the merchant was unreachable.
    const store = catalog();
    store.apply({ kind: 'GO_OFFLINE', reason: 'connector down' });
    const runtime = new BuyerAgentRuntime({
      catalog: store,
      model: new DeterministicBuyerModel(),
      maxSteps: 3,
    });
    const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });

    expect(result.outcome.kind).toBe('ABANDONED');
    expect(result.steps.some(step => step.refusedWith === 'CART_NOT_GROUNDED')).toBe(true);
    expect(result.steps.some(step => step.detail.includes('connector down'))).toBe(true);
  });
});

describe('the runtime holds no authority of its own', () => {
  it('can only ever return a request, an abandonment or a failure', async () => {
    // An exhaustive check on the outcome union. If someone later adds an
    // outcome that represents an execution, this fails.
    const kinds = new Set<string>();
    for (const model of [
      new DeterministicBuyerModel({ maxLines: 1 }),
      new MalformedBuyerModel(),
      new UnavailableBuyerModel(),
      new ScriptedBuyerModel([{ action: 'ABANDON', reason: 'no' }]),
    ]) {
      const runtime = new BuyerAgentRuntime({ catalog: catalog(), model, maxSteps: 4 });
      const result = await runtime.run({ session: session(), merchantId: MERCHANT, goal: GOAL });
      kinds.add(result.outcome.kind);
    }
    for (const kind of kinds) {
      expect(['PURCHASE_REQUESTED', 'ABANDONED', 'FAILED']).toContain(kind);
    }
  });

  it('shows the model no credential, provider or verdict', async () => {
    // Captured from a real run rather than asserted about the type, so adding a
    // field to BuyerModelInput without thinking shows up here.
    let seen: BuyerModelInput | null = null;
    const spy: BuyerModel = {
      name: 'spy',
      decide: async input => {
        seen = input;
        return { action: 'ABANDON', reason: 'inspected' };
      },
    };
    await new BuyerAgentRuntime({ catalog: catalog(), model: spy }).run({
      session: session(),
      merchantId: MERCHANT,
      goal: GOAL,
    });

    expect(Object.keys(seen ?? {}).sort()).toEqual([
      'bounds',
      'cart',
      'goal',
      'history',
      'observed',
      'remainingBudget',
      'stepsRemaining',
    ]);
  });
});
