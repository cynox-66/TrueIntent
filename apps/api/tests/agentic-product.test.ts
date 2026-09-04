/**
 * The product-level invariants of the agentic commerce surface.
 *
 * These are deliberately not more kernel tests. The kernel's behaviour is
 * covered elsewhere; what is checked here is the set of promises the *product*
 * makes to someone watching it for the first time:
 *
 *   - the two protections are distinct, and neither stands in for the other
 *   - the quote is the server's, and the agent has no way to state one
 *   - a refusal costs nothing: the budget is released, not consumed
 *   - the timeline a screen renders is the server's account, including for the
 *     refused purchases that a naive "active release" query would omit
 *
 * The last one exists because it was a real bug: the first version of the
 * timeline used `findActiveByAuthorization`, which excludes terminal states, so
 * the refused purchases — the whole point of the demonstration — rendered blank.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApplication, type Application } from '../src/composition.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { seedDemoData } from '../src/seed.js';

const WEBHOOK_SECRET = 'whsec_test_agentic_product';

const DINNER_SKU = 'SKU-THAI-DINNER-2';
const TASTING_SKU = 'SKU-THAI-DINNER-DLX';
/** 4,799 + 150 service = 4,949 all-in. */
const DINNER_UNIT_MINOR = 479_900;
const DRIFTED_UNIT_MINOR = 534_900;
const DINNER_TOTAL_MINOR = 494_900;
const DELEGATED_MINOR = 500_000;

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

/** Delegates through the dev route, exactly as both demos do. */
async function delegate(): Promise<{
  sessionId: string;
  headers: Record<string, string>;
  merchantId: string;
}> {
  const response = await server.inject({ method: 'POST', url: '/v1/dev/demo-session' });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { sessionId: string; merchantId: string };
  return {
    sessionId: body.sessionId,
    merchantId: body.merchantId,
    headers: {
      'x-capturelock-user': 'user_priya',
      'x-capturelock-session': body.sessionId,
    },
  };
}

function purchaseBody(
  sku: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    merchantId: 'merchant_alpha',
    lines: [{ sku, quantity: 1 }],
    idempotencyKey: `idem-${sku}-${Math.random().toString(36).slice(2, 12).padEnd(10, '0')}`,
    rationale: 'Closest catalogue match to a Thai dinner for two.',
    agentModel: 'deterministic-planner',
    agentSteps: 3,
    agentRefusedSteps: 0,
    catalogVersion: 'test',
    ...overrides,
  };
}

async function setPrice(sku: string, unitPriceMinor: number): Promise<void> {
  const response = await server.inject({
    method: 'POST',
    url: '/v1/dev/catalog',
    payload: { kind: 'SET_PRICE', sku, unitPriceMinor },
  });
  expect(response.statusCode).toBe(200);
}

describe('delegating the demo session', () => {
  it('does not require the browser to hold an issuer key', async () => {
    // The reason this route exists. Shipping an issuer key to a page so it
    // could call POST /v1/sessions itself would hand the agent-facing surface
    // the exact key the architecture keeps away from it.
    const response = await server.inject({ method: 'POST', url: '/v1/dev/demo-session' });
    expect(response.statusCode).toBe(201);

    const body = response.json() as { principal: { userId: string; sessionId: string } };
    // What comes back is a principal, which confers nothing an unauthenticated
    // caller could not claim — not a credential.
    expect(Object.keys(body.principal).sort()).toEqual(['sessionId', 'userId']);
    expect(JSON.stringify(body)).not.toContain('issuer');
  });

  it('states a delegation the agent had no part in choosing', async () => {
    const response = await server.inject({ method: 'POST', url: '/v1/dev/demo-session' });
    const body = response.json() as {
      bounds: { totalBudget: { amountMinor: number }; allowedCategories: string[] };
    };
    expect(body.bounds.totalBudget.amountMinor).toBe(DELEGATED_MINOR);
    expect(body.bounds.allowedCategories).toEqual(['dining']);
  });
});

describe('the two protections are distinct', () => {
  it('refuses an over-budget purchase before any mandate exists', async () => {
    // AUTHORITY VIOLATION. The merchant is never consulted; whether the price
    // was right does not enter into it.
    const session = await delegate();

    const response = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${session.sessionId}/purchase`,
      headers: session.headers,
      payload: purchaseBody(TASTING_SKU),
    });

    expect(response.statusCode).toBe(422);
    const body = response.json() as { error: string; releaseId?: string | null };
    expect(body.error).toBe('SESSION_BUDGET_EXCEEDED');
    expect(body.releaseId ?? null).toBeNull();

    // And no gate ran, because there was nothing to verify.
    const timeline = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${session.sessionId}/timeline`,
      headers: session.headers,
    });
    expect((timeline.json() as { purchases: unknown[] }).purchases).toEqual([]);
  });

  it('refuses a drifted price at the capture gate, after allowing it at the first', async () => {
    // REALITY DRIFT. The opposite shape: allowed on the way in, refused on the
    // way out, because the world moved in between.
    const session = await delegate();
    await setPrice(DINNER_SKU, DINNER_UNIT_MINOR);

    const purchase = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${session.sessionId}/purchase`,
      headers: session.headers,
      payload: purchaseBody(DINNER_SKU),
    });
    expect(purchase.statusCode).toBe(200);
    const { authorizationId, releaseId } = purchase.json() as {
      authorizationId: string;
      releaseId: string;
    };

    await server.inject({
      method: 'POST',
      url: '/v1/dev/simulate-authorization',
      payload: { releaseId },
    });
    await setPrice(DINNER_SKU, DRIFTED_UNIT_MINOR);

    const captured = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${session.sessionId}/capture`,
      headers: session.headers,
      payload: { authorizationId, idempotencyKey: 'idem-drift-capture-01' },
    });

    expect(captured.statusCode).toBe(422);
    const body = captured.json() as { reasonCodes: string[]; moneyMoved: boolean };
    expect(body.reasonCodes).toContain('LIVE_PRICE_DIVERGED');
    expect(body.moneyMoved).toBe(false);
  });

  it('does not confuse the two: an over-budget request never reaches a gate', async () => {
    // If the authority check were doing the drift check's job, the over-budget
    // request would produce a gate decision. It must not.
    const session = await delegate();
    await server.inject({
      method: 'POST',
      url: `/v1/sessions/${session.sessionId}/purchase`,
      headers: session.headers,
      payload: purchaseBody(TASTING_SKU),
    });

    // No evaluation was recorded anywhere for this session.
    const timeline = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${session.sessionId}/timeline`,
      headers: session.headers,
    });
    const purchases = (timeline.json() as { purchases: { gates: unknown[] }[] }).purchases;
    expect(purchases.flatMap(p => p.gates)).toEqual([]);
  });
});

describe('the quote is the server’s', () => {
  it('charges the price the server read, not one the agent could name', async () => {
    const session = await delegate();
    await setPrice(DINNER_SKU, DINNER_UNIT_MINOR);

    const purchase = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${session.sessionId}/purchase`,
      headers: session.headers,
      payload: purchaseBody(DINNER_SKU),
    });

    const timeline = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${session.sessionId}/timeline`,
      headers: session.headers,
    });
    const purchases = (
      timeline.json() as {
        purchases: { amount: { amountMinor: number } | null }[];
      }
    ).purchases;

    expect(purchase.statusCode).toBe(200);
    // 4,799 item + 150 service, both from the merchant, neither from the agent.
    expect(purchases[0]?.amount?.amountMinor).toBe(DINNER_TOTAL_MINOR);
  });

  it.each([
    ['an amount', { amount: 100 }],
    ['a total', { total: 100 }],
    ['a currency', { currency: 'INR' }],
    ['a verdict', { verdict: 'ALLOW' }],
  ])('refuses a purchase body carrying %s', async (_label, extra) => {
    const session = await delegate();
    const response = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${session.sessionId}/purchase`,
      headers: session.headers,
      payload: purchaseBody(DINNER_SKU, extra),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('a refusal costs nothing', () => {
  it('releases the budget hold when the capture gate refuses', async () => {
    const session = await delegate();
    await setPrice(DINNER_SKU, DINNER_UNIT_MINOR);

    const purchase = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${session.sessionId}/purchase`,
      headers: session.headers,
      payload: purchaseBody(DINNER_SKU),
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
    await setPrice(DINNER_SKU, DRIFTED_UNIT_MINOR);
    await server.inject({
      method: 'POST',
      url: `/v1/sessions/${session.sessionId}/capture`,
      headers: session.headers,
      payload: { authorizationId, idempotencyKey: 'idem-refused-capture-1' },
    });

    const timeline = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${session.sessionId}/timeline`,
      headers: session.headers,
    });
    const body = timeline.json() as {
      session: { spentMinor: number; reservedMinor: number; remaining: { amountMinor: number } };
      anyMoneyMoved: boolean;
    };

    // The delegation is whole again. An agent cannot exhaust a budget by making
    // requests that are all refused.
    expect(body.session.spentMinor).toBe(0);
    expect(body.session.reservedMinor).toBe(0);
    expect(body.session.remaining.amountMinor).toBe(DELEGATED_MINOR);
    expect(body.anyMoneyMoved).toBe(false);
  });

  it('consumes the budget only for the purchase that actually captured', async () => {
    const session = await delegate();
    await setPrice(DINNER_SKU, DINNER_UNIT_MINOR);

    const purchase = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${session.sessionId}/purchase`,
      headers: session.headers,
      payload: purchaseBody(DINNER_SKU),
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
    const captured = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${session.sessionId}/capture`,
      headers: session.headers,
      payload: { authorizationId, idempotencyKey: 'idem-good-capture-001' },
    });
    expect(captured.json()).toMatchObject({ moneyMoved: true });

    const timeline = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${session.sessionId}/timeline`,
      headers: session.headers,
    });
    expect(timeline.json()).toMatchObject({
      session: { spentMinor: DINNER_TOTAL_MINOR, reservedMinor: 0 },
      anyMoneyMoved: true,
    });
  });
});

describe('the evaluation proof point', () => {
  it('serves the counterfactual from the committed report', async () => {
    // The figures must come from reports/evaluation.json, so the screen can
    // never state a number the report does not.
    const response = await server.inject({ method: 'GET', url: '/v1/evaluation/summary' });
    expect(response.statusCode).toBe(200);

    const body = response.json() as Record<string, unknown>;
    if (body['available'] !== true) {
      // A missing report is a legitimate state; it renders nothing rather than
      // a placeholder. Nothing more to assert.
      expect(body).toHaveProperty('reason');
      return;
    }

    const report = JSON.parse(
      readFileSync(join(process.cwd(), 'reports', 'evaluation.json'), 'utf8'),
    ) as { metrics: Record<string, number> };

    expect(body['baselineUnsafeCharges']).toBe(report.metrics['baselineUnsafeCharges']);
    expect(body['baselineUnauthorizedSpendMinor']).toBe(
      report.metrics['baselineUnauthorizedSpendMinor'],
    );
    expect(body['gatedUnsafeCharges']).toBe(report.metrics['gatedUnsafeCharges']);
    expect(body['totalScenarios']).toBe(report.metrics['total']);
  });

  it('reports zero unauthorized charges under CaptureLock, or the suite is lying', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/evaluation/summary' });
    const body = response.json() as Record<string, unknown>;
    if (body['available'] !== true) return;
    expect(body['gatedUnsafeCharges']).toBe(0);
  });

  it('needs no credential, and discloses nothing about any user', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/evaluation/summary' });
    expect(response.statusCode).toBe(200);
    const serialized = JSON.stringify(response.json());
    for (const forbidden of ['user_', 'sess_', 'auth_', 'apiKey', 'secret']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('the timeline is the server’s account', () => {
  it('includes a refused purchase, whose release is terminal', async () => {
    // The bug this exists to prevent: a timeline built on
    // `findActiveByAuthorization` shows nothing for a refused purchase, which
    // is exactly the case the product is built to demonstrate.
    const session = await delegate();
    await setPrice(DINNER_SKU, DINNER_UNIT_MINOR);

    const purchase = await server.inject({
      method: 'POST',
      url: `/v1/sessions/${session.sessionId}/purchase`,
      headers: session.headers,
      payload: purchaseBody(DINNER_SKU),
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
    await setPrice(DINNER_SKU, DRIFTED_UNIT_MINOR);
    await server.inject({
      method: 'POST',
      url: `/v1/sessions/${session.sessionId}/capture`,
      headers: session.headers,
      payload: { authorizationId, idempotencyKey: 'idem-terminal-capture-1' },
    });

    const timeline = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${session.sessionId}/timeline`,
      headers: session.headers,
    });
    const entry = (
      timeline.json() as {
        purchases: {
          state: string | null;
          gates: {
            gate: string;
            verdict: string;
            findings: { detail: Record<string, unknown> }[];
          }[];
          evidence: { kinds: string[]; valid: boolean };
        }[];
      }
    ).purchases[0];

    expect(entry?.state).toBe('DENIED');
    expect(entry?.gates.map(gate => `${gate.gate}:${gate.verdict}`)).toEqual([
      'ORDER_CREATION:ALLOW',
      'CAPTURE:DENY',
    ]);

    // The screen renders both prices from this, so both must be present.
    const capture = entry?.gates.find(gate => gate.gate === 'CAPTURE');
    const drift = capture?.findings.find(
      finding => finding.detail['liveUnitPriceMinor'] !== undefined,
    );
    expect(drift?.detail).toMatchObject({
      chargedUnitPriceMinor: DINNER_UNIT_MINOR,
      liveUnitPriceMinor: DRIFTED_UNIT_MINOR,
    });

    expect(entry?.evidence.kinds[0]).toBe('AGENT_CONTEXT');
    expect(entry?.evidence.valid).toBe(true);
  });

  it('states which provider is wired, so a screen never has to guess', async () => {
    const session = await delegate();
    const timeline = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${session.sessionId}/timeline`,
      headers: session.headers,
    });
    expect((timeline.json() as { paymentProvider: string }).paymentProvider).toBe('fake');
  });

  it('refuses to show another user’s session', async () => {
    const session = await delegate();
    const response = await server.inject({
      method: 'GET',
      url: `/v1/sessions/${session.sessionId}/timeline`,
      headers: { ...session.headers, 'x-capturelock-user': 'user_someone_else' },
    });
    expect(response.statusCode).toBe(403);
  });
});
