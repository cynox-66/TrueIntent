/**
 * HTTP surface tests.
 *
 * The important assertions are about what the API *refuses*: unauthenticated
 * money endpoints, agent-supplied prices, forged webhooks, and any request that
 * would reach a provider without a kernel verdict.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApplication } from '../src/composition.js';
import { loadConfig } from '../src/config.js';
import { buildServer } from '../src/server.js';
import { seedDemoData } from '../src/seed.js';
import type { Application } from '../src/composition.js';

const WEBHOOK_SECRET = 'test_webhook_secret';

const PRINCIPAL = {
  'x-capturelock-user': 'user_priya',
  'x-capturelock-session': 'sess_01',
};

/** The trusted user-facing application's authority. An agent never has this. */
const ISSUER = { ...PRINCIPAL, 'x-capturelock-issuer-key': 'dev-issuer-key-not-for-production' };

/** A human operator's authority. An agent never has this either. */
const OPERATOR = {
  'x-capturelock-operator-key': 'dev-operator-key-not-for-prod',
  'x-capturelock-operator': 'operator_dev',
};

function futureConstraints(): Record<string, unknown> {
  return {
    currency: 'INR',
    maxTotal: { currency: 'INR', amountMinor: 500_000 },
    maxUnitPrice: { currency: 'INR', amountMinor: 500_000 },
    quantity: { min: 1, max: 1 },
    allowedCategories: ['footwear'],
    forbiddenCategories: [],
    requiredAttributes: [{ name: 'colour', anyOf: ['black'] }],
    forbiddenAttributes: [{ name: 'colour', anyOf: ['white'] }],
    merchants: { mode: 'ALLOWLIST', merchantIds: ['merchant_alpha'] },
    fees: {
      maxShipping: { currency: 'INR', amountMinor: 20_000 },
      maxTax: null,
      maxTip: { currency: 'INR', amountMinor: 10_000 },
      maxConvenienceFee: null,
      maxTotalFees: { currency: 'INR', amountMinor: 30_000 },
    },
    recurrence: 'ONE_TIME_ONLY',
    geography: { allowedCountries: ['IN'], allowedRegions: null },
    maxSnapshotAgeSeconds: 300,
    notBefore: '2020-01-01T00:00:00.000Z',
    notAfter: '2099-01-01T00:00:00.000Z',
  };
}

let server: FastifyInstance;
let app: Application;

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

async function createAuthorization(): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: '/v1/authorizations',
    headers: ISSUER,
    payload: {
      rawIntent: 'Find me the cheapest pair of black running shoes under 5,000 rupees.',
      policyId: 'household_default',
      policyVersion: '1.0.0',
      constraints: futureConstraints(),
      normalization: { method: 'LLM_ASSISTED', modelId: 'demo', confirmedByUser: true },
    },
  });
  expect(response.statusCode).toBe(201);
  return (JSON.parse(response.body) as { authorizationId: string }).authorizationId;
}

async function createQuote(authorizationId: string, sku = 'SKU-BLK-RUN-42'): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    url: `/v1/authorizations/${authorizationId}/quotes`,
    headers: PRINCIPAL,
    payload: {
      merchantId: 'merchant_alpha',
      lines: [{ sku, quantity: 1 }],
      shipTo: { country: 'IN', region: null },
      recurring: false,
    },
  });
  expect(response.statusCode).toBe(201);
  return (JSON.parse(response.body) as { snapshotId: string }).snapshotId;
}

describe('status', () => {
  it('reports which payment adapter is wired', async () => {
    const response = await server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ status: 'ok', paymentProvider: 'fake' });
  });
});

describe('the money endpoints require an authenticated principal', () => {
  it('refuses a release with no principal headers', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/releases',
      payload: {
        authorizationId: 'auth_' + 'a'.repeat(32),
        snapshotId: 'snap_' + 'b'.repeat(32),
        idempotencyKey: 'idem-0123456789abcdef',
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a capture with no principal headers', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/v1/releases/rel_${'a'.repeat(32)}/capture`,
      payload: { idempotencyKey: 'idem-0123456789abcdef' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('the quote endpoint prices from live state', () => {
  it('returns a server-computed total the caller never supplied', async () => {
    const authorizationId = await createAuthorization();
    const response = await server.inject({
      method: 'POST',
      url: `/v1/authorizations/${authorizationId}/quotes`,
      headers: PRINCIPAL,
      payload: {
        merchantId: 'merchant_alpha',
        lines: [{ sku: 'SKU-BLK-RUN-42', quantity: 1 }],
        shipTo: { country: 'IN', region: null },
        recurring: false,
      },
    });

    const body = JSON.parse(response.body) as {
      total: { amountMinor: number };
      snapshotHash: string;
    };
    expect(body.total.amountMinor).toBe(494_900);
    expect(body.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a request that tries to state its own price', async () => {
    const authorizationId = await createAuthorization();
    const response = await server.inject({
      method: 'POST',
      url: `/v1/authorizations/${authorizationId}/quotes`,
      headers: PRINCIPAL,
      payload: {
        merchantId: 'merchant_alpha',
        lines: [
          { sku: 'SKU-BLK-RUN-42', quantity: 1, unitPrice: { currency: 'INR', amountMinor: 1 } },
        ],
        shipTo: null,
        recurring: false,
      },
    });
    // The schema is strict: there is no field for a price, so supplying one is
    // a validation failure rather than something quietly ignored.
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('MALFORMED_REQUEST');
  });
});

describe('the release path', () => {
  it('runs a full order-creation and capture', async () => {
    const authorizationId = await createAuthorization();
    const snapshotId = await createQuote(authorizationId);

    const order = await server.inject({
      method: 'POST',
      url: '/v1/releases',
      headers: PRINCIPAL,
      payload: { authorizationId, snapshotId, idempotencyKey: 'idem-order-0000001' },
    });
    expect(order.statusCode).toBe(200);
    const orderBody = JSON.parse(order.body) as {
      releaseId: string;
      verdict: string;
      providerOrderId: string;
      evidenceChainHead: string;
    };
    expect(orderBody.verdict).toBe('ALLOW');
    expect(orderBody.evidenceChainHead).toMatch(/^[0-9a-f]{64}$/);

    // Simulate the payer authorizing, as hosted checkout would.
    const release = await app.deps.releases.findById(orderBody.releaseId as never);
    const payment = app.rawProvider as unknown as {
      seedAuthorizedPayment: (orderId: string, amount: unknown) => { paymentId: string };
    };
    const seeded = payment.seedAuthorizedPayment(release!.providerOrderId!, release!.amount);
    await app.deps.releases.transition(
      orderBody.releaseId as never,
      ['ORDER_CREATED'],
      'PAYMENT_AUTHORIZED',
      { providerPaymentId: seeded.paymentId },
      app.deps.clock.now(),
    );

    const capture = await server.inject({
      method: 'POST',
      url: `/v1/releases/${orderBody.releaseId}/capture`,
      headers: PRINCIPAL,
      payload: { idempotencyKey: 'idem-capture-000001' },
    });
    expect(capture.statusCode).toBe(200);
    expect(JSON.parse(capture.body)).toMatchObject({
      verdict: 'ALLOW',
      state: 'CAPTURED',
      moneyMoved: true,
    });
  });

  it('refuses with 422 and structured reason codes when intent is violated', async () => {
    const authorizationId = await createAuthorization();
    // The white shoe is in the catalogue but excluded by the authorization.
    const snapshotId = await createQuote(authorizationId, 'SKU-WHT-RUN-42');

    const response = await server.inject({
      method: 'POST',
      url: '/v1/releases',
      headers: PRINCIPAL,
      payload: { authorizationId, snapshotId, idempotencyKey: 'idem-white-000001' },
    });

    expect(response.statusCode).toBe(422);
    const body = JSON.parse(response.body) as { verdict: string; reasonCodes: string[] };
    expect(body.verdict).toBe('DENY');
    expect(body.reasonCodes).toContain('INTENT_ATTRIBUTE_FORBIDDEN');
    expect(body.reasonCodes).toContain('INTENT_ATTRIBUTE_MISSING');
  });

  it('rejects a malformed release request before anything else happens', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/releases',
      headers: PRINCIPAL,
      payload: { authorizationId: 'not-an-id', snapshotId: 'nope', idempotencyKey: 'x' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('MALFORMED_REQUEST');
  });

  it('rejects unknown fields rather than ignoring them', async () => {
    const authorizationId = await createAuthorization();
    const snapshotId = await createQuote(authorizationId);
    const response = await server.inject({
      method: 'POST',
      url: '/v1/releases',
      headers: PRINCIPAL,
      payload: {
        authorizationId,
        snapshotId,
        idempotencyKey: 'idem-extra-000001',
        overrideVerification: true,
        amount: 1,
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('webhooks', () => {
  function sign(body: unknown): { payload: string; signature: string } {
    const payload = JSON.stringify(body);
    return {
      payload,
      signature: createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex'),
    };
  }

  it('rejects an unsigned event with 401', async () => {
    const { payload } = sign({ event: 'payment.captured' });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/webhooks/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'deadbeef' },
      payload,
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a tampered body even with a signature for the original', async () => {
    const { signature } = sign({ event: 'payment.captured' });
    const response = await server.inject({
      method: 'POST',
      url: '/v1/webhooks/razorpay',
      headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature },
      payload: JSON.stringify({ event: 'payment.failed' }),
    });
    expect(response.statusCode).toBe(401);
  });

  it('accepts a correctly signed event and reports what it did with it', async () => {
    const body = {
      event: 'payment.captured',
      payload: { payment: { entity: { id: 'pay_unknown', order_id: 'order_unknown' } } },
    };
    const { payload, signature } = sign(body);
    const response = await server.inject({
      method: 'POST',
      url: '/v1/webhooks/razorpay',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': 'evt_1',
      },
      payload,
    });
    // 200 even though nothing matched: a verified event must be acknowledged so
    // the provider stops retrying it.
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).kind).toBe('NO_MATCHING_RELEASE');
  });
});

describe('evidence', () => {
  it('publishes the public key an auditor needs', async () => {
    const response = await server.inject({ method: 'GET', url: '/v1/evidence/public-key' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ algorithm: 'Ed25519' });
  });

  it('replays a recorded decision and reports that it reproduced', async () => {
    const authorizationId = await createAuthorization();
    const snapshotId = await createQuote(authorizationId);
    const order = await server.inject({
      method: 'POST',
      url: '/v1/releases',
      headers: PRINCIPAL,
      payload: { authorizationId, snapshotId, idempotencyKey: 'idem-evidence-0001' },
    });
    const { evidenceEnvelopeId } = JSON.parse(order.body) as { evidenceEnvelopeId: string };

    const response = await server.inject({
      method: 'GET',
      url: `/v1/evidence/${evidenceEnvelopeId}`,
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { replay: { reproduced: boolean } };
    expect(body.replay.reproduced).toBe(true);
  });

  it('verifies the chain for an authorization', async () => {
    const authorizationId = await createAuthorization();
    const snapshotId = await createQuote(authorizationId);
    await server.inject({
      method: 'POST',
      url: '/v1/releases',
      headers: PRINCIPAL,
      payload: { authorizationId, snapshotId, idempotencyKey: 'idem-chain-000001' },
    });

    const response = await server.inject({
      method: 'GET',
      url: `/v1/evidence/chain/${authorizationId}/verify`,
    });
    expect(JSON.parse(response.body)).toMatchObject({ valid: true });
  });
});

describe('separation of authority: an agent cannot grant itself anything', () => {
  const AUTHORIZATION_BODY = {
    rawIntent: 'Buy something.',
    policyId: 'household_default',
    policyVersion: '1.0.0',
    constraints: futureConstraints(),
    normalization: { method: 'MANUAL', modelId: null, confirmedByUser: true },
  };

  it('refuses to issue an authorization to a caller holding only agent credentials', async () => {
    // The heart of it. An agent that could mint its own mandate would set its
    // own budget, and every check downstream would be enforcing a mandate the
    // agent authored.
    const response = await server.inject({
      method: 'POST',
      url: '/v1/authorizations',
      headers: PRINCIPAL,
      payload: AUTHORIZATION_BODY,
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toBe('FORBIDDEN');
  });

  it('refuses an issuer key that is wrong', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/authorizations',
      headers: { ...PRINCIPAL, 'x-capturelock-issuer-key': 'not-the-real-key-at-all' },
      payload: AUTHORIZATION_BODY,
    });
    expect(response.statusCode).toBe(403);
  });

  it('takes the mandate owner from the principal, not from the request body', async () => {
    // Supplying a userId is a schema violation, so an issuer cannot mint a
    // mandate for someone else even with a valid key.
    const response = await server.inject({
      method: 'POST',
      url: '/v1/authorizations',
      headers: ISSUER,
      payload: { ...AUTHORIZATION_BODY, userId: 'user_someone_else' },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error).toBe('MALFORMED_REQUEST');
  });

  it("refuses to let an agent quote against someone else's authorization", async () => {
    const authorizationId = await createAuthorization();
    const response = await server.inject({
      method: 'POST',
      url: `/v1/authorizations/${authorizationId}/quotes`,
      headers: { 'x-capturelock-user': 'user_mallory', 'x-capturelock-session': 'sess_m' },
      payload: {
        merchantId: 'merchant_alpha',
        lines: [{ sku: 'SKU-BLK-RUN-42', quantity: 1 }],
        shipTo: null,
        recurring: false,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body).error).toBe('USER_MISMATCH');
  });

  it('refuses to let an agent resolve a paused release', async () => {
    // A PAUSE exists so a human looks. If the agent can clear it, PAUSE and
    // ALLOW are the same thing.
    const response = await server.inject({
      method: 'POST',
      url: `/v1/reviews/rev_${'a'.repeat(32)}/resolve`,
      headers: PRINCIPAL,
      payload: { resolution: 'APPROVED' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('requires an operator to be named, so a resolution is attributable', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/v1/reviews/rev_${'a'.repeat(32)}/resolve`,
      headers: { 'x-capturelock-operator-key': 'dev-operator-key-not-for-prod' },
      payload: { resolution: 'APPROVED' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a self-declared approver name in the body', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/v1/reviews/rev_${'a'.repeat(32)}/resolve`,
      headers: OPERATOR,
      payload: { resolution: 'APPROVED', resolvedBy: 'definitely-a-human' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses to let an agent force reconciliation', async () => {
    const response = await server.inject({
      method: 'POST',
      url: `/v1/releases/rel_${'a'.repeat(32)}/reconcile`,
      headers: PRINCIPAL,
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('configuration guards', () => {
  it('refuses to start with a live-mode Razorpay key', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        PAYMENT_PROVIDER: 'razorpay-test',
        RAZORPAY_KEY_ID: 'rzp_live_dangerous',
        RAZORPAY_KEY_SECRET: 's',
      } as NodeJS.ProcessEnv),
    ).toThrow(/live-mode/);
  });

  it('refuses a razorpay provider with no credentials', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', PAYMENT_PROVIDER: 'razorpay-test' } as NodeJS.ProcessEnv),
    ).toThrow(/requires/);
  });

  it('refuses production without an evidence signing key', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /EVIDENCE_SIGNING_KEY/,
    );
  });

  it('defaults to the fake provider so a fresh checkout cannot reach a real API', () => {
    expect(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv).paymentProvider).toBe('fake');
  });

  it('refuses production without an issuer key, which would let anything mint a mandate', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PERSISTENCE: 'postgres',
        DATABASE_URL: 'postgresql://x/y',
        EVIDENCE_SIGNING_KEY: 'k',
        OPERATOR_API_KEY: 'operator-key-long-enough',
      } as NodeJS.ProcessEnv),
    ).toThrow(/ISSUER_API_KEY/);
  });

  it('refuses production without an operator key', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PERSISTENCE: 'postgres',
        DATABASE_URL: 'postgresql://x/y',
        EVIDENCE_SIGNING_KEY: 'k',
        ISSUER_API_KEY: 'issuer-key-long-enough',
      } as NodeJS.ProcessEnv),
    ).toThrow(/OPERATOR_API_KEY/);
  });

  it('refuses in-memory persistence in production, which would lose every record on restart', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PERSISTENCE: 'memory',
        EVIDENCE_SIGNING_KEY: 'k',
        ISSUER_API_KEY: 'issuer-key-long-enough',
        OPERATOR_API_KEY: 'operator-key-long-enough',
      } as NodeJS.ProcessEnv),
    ).toThrow(/in-memory persistence/);
  });

  it('does not hand out dev authority keys in production', () => {
    // The dev defaults are predictable, which is only safe because they cannot
    // exist where they would matter.
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        PERSISTENCE: 'postgres',
        DATABASE_URL: 'postgresql://x/y',
        EVIDENCE_SIGNING_KEY: 'k',
      } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});
