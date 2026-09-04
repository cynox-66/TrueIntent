/**
 * The agentic commerce HTTP surface.
 *
 * Two things are being checked, and the second is the reason this file exists
 * separately from the service tests.
 *
 * First, the authority split: an agent holding only a principal cannot delegate
 * itself a budget, cannot revoke, and cannot read another user's session.
 * That has to be tested at the HTTP layer, because the kernel faithfully
 * enforces whatever mandate it is given and cannot help here — the separation
 * is the boundary's job.
 *
 * Second, that the request schemas make the dangerous fields *unsayable*. Every
 * schema is `.strict()`, so a purchase body carrying an amount, a currency, a
 * total or a verdict is a 400 rather than a value quietly dropped. Asserted by
 * sending them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApplication, type Application } from '../src/composition.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { seedDemoData } from '../src/seed.js';

const WEBHOOK_SECRET = 'whsec_test_agent_surface';

/**
 * An agent holds a principal and nothing else.
 *
 * The session header is the *commerce session* it is operating in. That is the
 * load-bearing reuse: because the delegation's id is the principal's session id,
 * every mandate derived from it is bound to it by the kernel's existing
 * `SESSION_MISMATCH` check, with no new binding mechanism to get wrong.
 */
function agentFor(sessionId: string): Record<string, string> {
  return { 'x-capturelock-user': 'user_priya', 'x-capturelock-session': sessionId };
}

/** Before a session exists, only the user is known. */
const AGENT = { 'x-capturelock-user': 'user_priya', 'x-capturelock-session': 'sess_none' };

/**
 * The trusted user-facing application. An agent never has this.
 *
 * Carries a principal as well, because the pre-existing `/v1/authorizations`
 * route requires one — a mandate is issued *for* a user.
 */
const ISSUER = { ...AGENT, 'x-capturelock-issuer-key': 'dev-issuer-key-not-for-production' };

/** A human operator's console. An agent never has this either. */
const OPERATOR = {
  'x-capturelock-operator-key': 'dev-operator-key-not-for-prod',
  'x-capturelock-operator': 'operator_dev',
};

const MERCHANT = 'merchant_alpha';
const CURRY = 'SKU-THAI-CURRY-KIT';
const ENERGY = 'SKU-ENERGY-500';
const GOAL = 'Thai curry dinner for 4, vegetarian, under 800 rupees';

function bounds(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    currency: 'INR',
    totalBudget: { currency: 'INR', amountMinor: 200_000 },
    maxPerPurchase: { currency: 'INR', amountMinor: 80_000 },
    merchants: { mode: 'ALLOWLIST', merchantIds: [MERCHANT] },
    allowedCategories: ['thai-meal-kit', 'groceries'],
    forbiddenCategories: [],
    itemsPerPurchase: { min: 1, max: 4 },
    recurrence: 'ONE_TIME_ONLY',
    expiresAt: '2027-01-01T00:00:00.000Z',
    ...overrides,
  };
}

let app: Application;
let server: FastifyInstance;

beforeEach(async () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    PAYMENT_PROVIDER: 'fake',
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  } as NodeJS.ProcessEnv);
  app = buildApplication(config);
  await seedDemoData(app);
  server = await buildServer({ logger: false, app });
  await server.ready();
});

afterEach(async () => {
  await server.close();
  await app.close();
});

async function createSession(
  headers: Record<string, string> = ISSUER,
  overrides: Record<string, unknown> = {},
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const response = await server.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers,
    payload: { userId: 'user_priya', purpose: GOAL, bounds: bounds(overrides) },
  });
  return { statusCode: response.statusCode, body: response.json() as Record<string, unknown> };
}

function purchasePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    merchantId: MERCHANT,
    lines: [{ sku: CURRY, quantity: 1 }],
    idempotencyKey: 'idem-agent-purchase-1',
    rationale: 'Closest catalogue match to a vegetarian Thai dinner.',
    agentModel: 'deterministic-planner',
    agentSteps: 4,
    agentRefusedSteps: 0,
    catalogVersion: 'cat_test0000000000',
    ...overrides,
  };
}

describe('delegating a session is issuer authority', () => {
  it('creates a session for the issuer', async () => {
    const created = await createSession();
    expect(created.statusCode).toBe(201);
    expect(created.body['state']).toBe('ACTIVE');
    expect(created.body['sessionId']).toMatch(/^sess_[0-9a-f]{32}$/);
  });

  it('refuses an agent that tries to delegate itself a budget', async () => {
    // The whole separation, in one case. An agent that could create a session
    // would be choosing its own budget, and every check below it would be
    // ceremony.
    const created = await createSession(AGENT);
    expect(created.statusCode).toBe(403);
    expect(created.body['error']).toBe('FORBIDDEN');
  });

  it('refuses an agent that tries to revoke a session', async () => {
    const created = await createSession();
    const response = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${String(created.body['sessionId'])}/revoke`,
      headers: AGENT,
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets the issuer revoke, and then refuses purchases', async () => {
    const created = await createSession();
    const sessionId = String(created.body['sessionId']);

    const revoked = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/revoke`,
      headers: ISSUER,
    });
    expect(revoked.statusCode).toBe(200);

    const purchase = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/purchase`,
      headers: agentFor(sessionId),
      payload: purchasePayload(),
    });
    expect(purchase.statusCode).toBe(422);
    expect((purchase.json() as { error: string }).error).toBe('SESSION_REVOKED');
  });

  it('refuses bounds whose per-purchase cap exceeds the total budget', async () => {
    // The domain schema is reused at the boundary, so a nonsensical delegation
    // cannot be stored and later read as meaningful.
    const created = await createSession(ISSUER, {
      totalBudget: { currency: 'INR', amountMinor: 50_000 },
      maxPerPurchase: { currency: 'INR', amountMinor: 80_000 },
    });
    expect(created.statusCode).toBe(400);
    expect(created.body['error']).toBe('MALFORMED_REQUEST');
  });
});

describe('reading a session', () => {
  it('lets the owner read it', async () => {
    const created = await createSession();
    const response = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${String(created.body['sessionId'])}`,
      headers: agentFor(String(created.body['sessionId'])),
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { purpose: string }).purpose).toBe(GOAL);
  });

  it('refuses another user', async () => {
    const created = await createSession();
    const response = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${String(created.body['sessionId'])}`,
      headers: {
        ...agentFor(String(created.body['sessionId'])),
        'x-capturelock-user': 'user_someone_else',
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it('refuses an agent presenting a different session than the one it is spending', async () => {
    // Two sessions, one user. The agent tries to spend session A's budget while
    // presenting session B in its principal. Refused — and this is why the
    // delegation's id *is* the principal's session id: the binding is checked
    // here and again by the kernel's authority stage, with no new mechanism.
    const a = await createSession();
    const b = await createSession();

    const response = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${String(a.body['sessionId'])}/purchase`,
      headers: agentFor(String(b.body['sessionId'])),
      payload: purchasePayload(),
    });

    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: string }).error).toBe('SESSION_NOT_OWNED');
  });

  it('requires a principal at all', async () => {
    const created = await createSession();
    const response = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${String(created.body['sessionId'])}`,
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('the purchase schema makes the dangerous fields unsayable', () => {
  it.each([
    ['an amount', { amount: 79_900 }],
    ['a currency', { currency: 'INR' }],
    ['a total', { total: 79_900 }],
    ['a unit price', { unitPrice: 28_000 }],
    ['a verdict', { verdict: 'ALLOW' }],
    ['a user identity', { userId: 'user_attacker' }],
    ['a policy', { policyId: 'permissive' }],
    ['an execution grant', { grant: { nonce: 'x' } }],
  ])('rejects a purchase body carrying %s', async (_label, extra) => {
    const created = await createSession();
    const response = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${String(created.body['sessionId'])}/purchase`,
      headers: agentFor(String(created.body['sessionId'])),
      payload: purchasePayload(extra),
    });
    // 400, not 200-with-the-field-ignored. The difference matters: one says the
    // agent cannot state it, the other says we happen not to read it today.
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe('MALFORMED_REQUEST');
  });

  it('rejects a line that tries to carry its own price', async () => {
    const created = await createSession();
    const response = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${String(created.body['sessionId'])}/purchase`,
      headers: agentFor(String(created.body['sessionId'])),
      payload: purchasePayload({
        lines: [{ sku: CURRY, quantity: 1, unitPrice: { currency: 'INR', amountMinor: 1 } }],
      }),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('running the bounded agent', () => {
  it('returns a draft cart and a step log without buying anything', async () => {
    const created = await createSession();
    const response = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${String(created.body['sessionId'])}/agent`,
      headers: agentFor(String(created.body['sessionId'])),
      payload: { merchantId: MERCHANT, goal: GOAL },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      model: string;
      outcome: { kind: string; cart?: { sku: string; quantity: number }[] };
      steps: { action: { action: string } | null }[];
    };
    expect(body.model).toBe('deterministic-planner');
    expect(body.outcome.kind).toBe('PURCHASE_REQUESTED');
    expect(body.steps.length).toBeGreaterThan(1);

    // Nothing was bought: no release exists yet for this session.
    const purchases = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${String(created.body['sessionId'])}/purchases`,
      headers: agentFor(String(created.body['sessionId'])),
    });
    expect((purchases.json() as { purchases: unknown[] }).purchases).toEqual([]);
  });

  it('reports catalogue prices as indicative, never as authoritative', async () => {
    // The wire vocabulary matters: a field called `unitPrice` on a browse
    // result invites a reader to believe it is what will be charged.
    const created = await createSession();
    const response = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${String(created.body['sessionId'])}/agent`,
      headers: agentFor(String(created.body['sessionId'])),
      payload: { merchantId: MERCHANT, goal: GOAL },
    });
    const body = response.json() as { observed: Record<string, unknown>[] };
    for (const product of body.observed) {
      expect(Object.keys(product)).toContain('indicativeUnitPriceMinor');
      expect(Object.keys(product)).not.toContain('unitPrice');
    }
  });

  it('refuses to run the agent for another user', async () => {
    const created = await createSession();
    const response = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${String(created.body['sessionId'])}/agent`,
      headers: {
        ...agentFor(String(created.body['sessionId'])),
        'x-capturelock-user': 'user_someone_else',
      },
      payload: { merchantId: MERCHANT, goal: GOAL },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('the purchase path', () => {
  it('runs the order gate and returns TrueIntent verdict', async () => {
    const created = await createSession();
    const response = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${String(created.body['sessionId'])}/purchase`,
      headers: agentFor(String(created.body['sessionId'])),
      payload: purchasePayload(),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      verdict: string;
      capsuleHash: string;
      moneyMoved: boolean;
      reasonCodes: string[];
    };
    expect(body.verdict).toBe('ALLOW');
    expect(body.capsuleHash).toMatch(/^[0-9a-f]{64}$/);
    // The order gate binds terms. It does not move money.
    expect(body.moneyMoved).toBe(false);
  });

  it('refuses a category the session never authorized', async () => {
    const created = await createSession();
    const response = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${String(created.body['sessionId'])}/purchase`,
      headers: agentFor(String(created.body['sessionId'])),
      payload: purchasePayload({
        lines: [{ sku: ENERGY, quantity: 4 }],
        idempotencyKey: 'idem-agent-drift-01',
      }),
    });

    expect(response.statusCode).toBe(422);
    const body = response.json() as { reasonCodes?: string[]; error?: string };
    // Either the deterministic intent stage refused it, or the session layer
    // did before a mandate existed. Both are correct; neither charged anything.
    expect(body.reasonCodes?.includes('INTENT_CATEGORY_MISMATCH') ?? body.error).toBeTruthy();
  });

  it('refuses a SKU the merchant does not offer', async () => {
    const created = await createSession();
    const response = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${String(created.body['sessionId'])}/purchase`,
      headers: agentFor(String(created.body['sessionId'])),
      payload: purchasePayload({
        lines: [{ sku: 'SKU-INVENTED', quantity: 1 }],
        idempotencyKey: 'idem-agent-ghost-01',
      }),
    });
    expect(response.statusCode).toBe(422);
    expect((response.json() as { error: string }).error).toBe('CART_NOT_GROUNDED');
  });

  it('answers a repeated purchase request without creating a second release', async () => {
    const created = await createSession();
    const sessionId = String(created.body['sessionId']);
    const send = () =>
      server.inject({
        method: 'POST',
        url: `/v1/sessions/${sessionId}/purchase`,
        headers: agentFor(sessionId),
        payload: purchasePayload(),
      });

    const first = await send();
    const second = await send();

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);

    const purchases = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}/purchases`,
      headers: agentFor(sessionId),
    });
    expect((purchases.json() as { purchases: unknown[] }).purchases).toHaveLength(1);
  });

  it('requires a principal', async () => {
    const created = await createSession();
    const response = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${String(created.body['sessionId'])}/purchase`,
      payload: purchasePayload(),
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('the agent context read', () => {
  it('is operator authority, because it discloses intent and reasoning', async () => {
    const created = await createSession();
    const purchase = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${String(created.body['sessionId'])}/purchase`,
      headers: agentFor(String(created.body['sessionId'])),
      payload: purchasePayload(),
    });
    const releaseId = String((purchase.json() as { releaseId: string }).releaseId);

    const asAgent = await server.inject({
      method: 'GET',
      url: `/v1/releases/${releaseId}/agent-context`,
      headers: AGENT,
    });
    expect(asAgent.statusCode).toBe(403);

    const asOperator = await server.inject({
      method: 'GET',
      url: `/v1/releases/${releaseId}/agent-context`,
      headers: OPERATOR,
    });
    expect(asOperator.statusCode).toBe(200);

    const body = asOperator.json() as {
      agentic: boolean;
      capsule: { intentText: string; totalMinor: number };
      session: { purpose: string };
    };
    expect(body.agentic).toBe(true);
    expect(body.capsule.intentText).toBe(GOAL);
    // 280 curry + 150 shipping, priced by the server.
    expect(body.capsule.totalMinor).toBe(43_000);
    expect(body.session.purpose).toBe(GOAL);
  });

  it('reports a non-agentic release as such rather than failing', async () => {
    // The console asks about every release it shows, including ones created
    // through the plain API. That is not an error.
    const authorization = await server.inject({
      method: 'POST',
      url: '/v1/authorizations',
      headers: ISSUER,
      payload: {
        rawIntent: 'A pair of black running shoes under 5,000 rupees.',
        policyId: 'household_default',
        policyVersion: '1.0.0',
        constraints: {
          currency: 'INR',
          maxTotal: { currency: 'INR', amountMinor: 500_000 },
          maxUnitPrice: null,
          quantity: { min: 1, max: 2 },
          allowedCategories: ['footwear'],
          forbiddenCategories: [],
          requiredAttributes: [],
          forbiddenAttributes: [],
          merchants: { mode: 'ANY' },
          fees: {
            maxShipping: null,
            maxTax: null,
            maxTip: null,
            maxConvenienceFee: null,
            maxTotalFees: null,
          },
          recurrence: 'ONE_TIME_ONLY',
          geography: null,
          maxSnapshotAgeSeconds: 300,
          notBefore: '2026-01-01T00:00:00.000Z',
          notAfter: '2027-01-01T00:00:00.000Z',
        },
        normalization: { method: 'MANUAL', modelId: null, confirmedByUser: true },
      },
    });
    const authorizationId = String(
      (authorization.json() as { authorizationId: string }).authorizationId,
    );

    const quote = await server.inject({
      method: 'POST',
      url: `/v1/authorizations/${authorizationId}/quotes`,
      headers: AGENT,
      payload: {
        merchantId: MERCHANT,
        lines: [{ sku: 'SKU-BLK-RUN-42', quantity: 1 }],
        shipTo: { country: 'IN', region: null },
        recurring: false,
      },
    });
    const snapshotId = String((quote.json() as { snapshotId: string }).snapshotId);

    const release = await server.inject({
      method: 'POST',
      url: '/v1/releases',
      headers: AGENT,
      payload: { authorizationId, snapshotId, idempotencyKey: 'idem-plain-release-1' },
    });
    const releaseId = String((release.json() as { releaseId: string }).releaseId);

    const context = await server.inject({
      method: 'GET',
      url: `/v1/releases/${releaseId}/agent-context`,
      headers: OPERATOR,
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({ agentic: false, capsule: null });
  });
});

describe('the capture path', () => {
  it('captures only after the payer authorizes, and settles the budget', async () => {
    const created = await createSession();
    const sessionId = String(created.body['sessionId']);

    const purchase = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/purchase`,
      headers: agentFor(sessionId),
      payload: purchasePayload(),
    });
    const { authorizationId, releaseId } = purchase.json() as {
      authorizationId: string;
      releaseId: string;
    };

    // Drive the payer authorization through the real signed-webhook route.
    const simulated = await server.inject({
      method: 'POST',
      url: '/v1/dev/simulate-authorization',
      payload: { releaseId },
    });
    expect(simulated.statusCode).toBe(200);

    const captured = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/capture`,
      headers: agentFor(sessionId),
      payload: { authorizationId, idempotencyKey: 'idem-agent-capture-01' },
    });

    expect(captured.statusCode).toBe(200);
    expect(captured.json()).toMatchObject({ verdict: 'ALLOW', moneyMoved: true });

    const session = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
      headers: agentFor(sessionId),
    });
    expect(session.json()).toMatchObject({ spentMinor: 43_000, reservedMinor: 0 });
  });

  it('refuses a capture when the merchant price moved after the order gate', async () => {
    // The flagship narrative, over HTTP. The agent quoted at 280; the merchant
    // moved to 340; Gate 2 re-reads and refuses.
    const created = await createSession();
    const sessionId = String(created.body['sessionId']);

    const purchase = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/purchase`,
      headers: agentFor(sessionId),
      payload: purchasePayload(),
    });
    const { authorizationId, releaseId } = purchase.json() as {
      authorizationId: string;
      releaseId: string;
    };

    await server.inject({
      method: 'POST',
      url: '/v1/dev/simulate-authorization',
      payload: { releaseId },
    });

    // Reality changes at the merchant, not in TrueIntent's copy of it.
    const drift = await server.inject({
      method: 'POST',
      url: '/v1/dev/catalog',
      payload: { kind: 'SET_PRICE', sku: CURRY, unitPriceMinor: 34_000 },
    });
    expect(drift.statusCode).toBe(200);

    const captured = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/capture`,
      headers: agentFor(sessionId),
      payload: { authorizationId, idempotencyKey: 'idem-agent-capture-02' },
    });

    expect(captured.statusCode).toBe(422);
    const body = captured.json() as { reasonCodes: string[]; moneyMoved: boolean };
    expect(body.reasonCodes).toContain('LIVE_PRICE_DIVERGED');
    expect(body.moneyMoved).toBe(false);

    // And the budget was freed rather than consumed by a refusal.
    const session = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${sessionId}`,
      headers: agentFor(sessionId),
    });
    expect(session.json()).toMatchObject({ spentMinor: 0 });
  });
});
