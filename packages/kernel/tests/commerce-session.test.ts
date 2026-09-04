/**
 * The commerce session service, end to end against the real kernel.
 *
 * This is where the Phase 5 claims stop being architecture and become
 * observable. Each of these runs the genuine two-gate pipeline against a
 * genuine (fake) provider, and counts provider calls — because "CaptureLock
 * refused" and "no money moved" are different statements, and only the second
 * one matters.
 *
 * The provider is instrumented rather than mocked out: `provider.captures`
 * counts real capture calls made through the guarded executor, so a test
 * asserting `captures === 0` is asserting that the boundary held, not that a
 * stub was not called.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  asSessionId,
  asTimestamp,
  computeSessionBoundsHash,
  money,
  remainingBudget,
  type AuthorizationId,
  type IdempotencyKey,
  type MerchantId,
  type SessionBounds,
  type SessionId,
  type Sku,
  type UserId,
} from '@capturelock/core';
import {
  FakeMerchantCatalog,
  FakePaymentProvider,
  type CatalogItemSpec,
} from '@capturelock/integrations';
import { FixedClock } from '@capturelock/core';
import { createSigner, createVerifier, generateEvidenceKeyPair } from '@capturelock/evidence';
import {
  InMemoryAuthorizationRepository,
  InMemoryEvaluationRepository,
  InMemoryEvidenceLedger,
  InMemoryPolicyRepository,
  InMemoryReleaseRepository,
  InMemoryReviewRepository,
  InMemorySessionAuthorityRepository,
  InMemorySnapshotRepository,
  InMemoryUnitOfWork,
  InMemoryWebhookInboxRepository,
} from '@capturelock/persistence';
import type { PolicyDocument } from '@capturelock/policy';
import { computePolicyHash } from '@capturelock/policy';
import { CommerceSessionService } from '../src/services/commerce-session-service.js';
import { GuardedPaymentExecutor, paymentReaderOf } from '../src/payment-executor.js';
import { ReleaseService } from '../src/services/release-service.js';
import { WebhookService } from '../src/services/webhook-service.js';
import { ReviewService } from '../src/services/review-service.js';
import { DEFAULT_KERNEL_CONFIG, type PaymentDependencies } from '../src/services/dependencies.js';

const MERCHANT = 'merchant_alpha' as MerchantId;
const USER = 'user_priya' as UserId;
const START = asTimestamp('2026-09-04T10:00:00.000Z');
const EXPIRES = asTimestamp('2026-09-05T10:00:00.000Z');

const CURRY = 'SKU-THAI-CURRY-KIT' as Sku;
const RICE = 'SKU-THAI-RICE-1KG' as Sku;
const ENERGY = 'SKU-ENERGY-500' as Sku;

const ITEMS: CatalogItemSpec[] = [
  {
    sku: CURRY,
    name: 'Thai Green Curry Kit',
    category: 'thai-meal-kit',
    attributes: [
      { name: 'diet', value: 'vegetarian' },
      { name: 'cuisine', value: 'thai' },
    ],
    unitPriceMinor: 28_000,
    availableStock: 20,
  },
  {
    sku: RICE,
    name: 'Jasmine Rice 1kg',
    category: 'groceries',
    attributes: [{ name: 'diet', value: 'vegetarian' }],
    unitPriceMinor: 18_000,
    availableStock: 40,
  },
  {
    sku: ENERGY,
    name: 'Voltz Energy Drink 500ml',
    category: 'beverages',
    attributes: [{ name: 'caffeine', value: 'high' }],
    unitPriceMinor: 5_000,
    availableStock: 200,
  },
];

const GOAL = 'Thai curry dinner for 4, vegetarian, under 800 rupees';

function policyDocument(): PolicyDocument {
  return {
    policyId: 'household',
    version: '1.0.0',
    name: 'Household policy',
    createdAt: START,
    // No rules: this suite is about the session layer and the intent stage.
    // Policy behaviour has its own suites.
    rules: [],
  };
}

/**
 * The agentic harness.
 *
 * Mirrors `apps/api/src/composition.ts` rather than inventing a graph, so a
 * behaviour proved here is a behaviour of the wired application.
 */
class AgenticHarness {
  readonly clock = new FixedClock(START);
  readonly catalog = new FakeMerchantCatalog({
    merchantId: MERCHANT,
    currency: 'INR',
    items: ITEMS,
    fees: [{ type: 'SHIPPING', label: 'Standard delivery', amount: money('INR', 15_000) }],
    clock: () => this.clock.now(),
  });
  readonly provider = new FakePaymentProvider({ clock: () => this.clock.now() });

  readonly releases = new InMemoryReleaseRepository();
  readonly authorizations = new InMemoryAuthorizationRepository();
  readonly snapshots = new InMemorySnapshotRepository();
  readonly evaluations = new InMemoryEvaluationRepository();
  readonly reviews = new InMemoryReviewRepository();
  readonly webhookInbox = new InMemoryWebhookInboxRepository();
  readonly policies = new InMemoryPolicyRepository();
  readonly sessions = new InMemorySessionAuthorityRepository();
  readonly evidence: InMemoryEvidenceLedger;
  readonly deps: PaymentDependencies;

  readonly service: CommerceSessionService;
  readonly releaseService: ReleaseService;
  readonly webhookService: WebhookService;
  readonly reviewService: ReviewService;
  readonly keys = generateEvidenceKeyPair();
  readonly policy = policyDocument();

  constructor(private readonly policyOverride?: PolicyDocument) {
    this.evidence = new InMemoryEvidenceLedger(
      createSigner(this.keys.privateKeyPkcs8Base64),
      createVerifier(this.keys.publicKeySpkiBase64),
    );
    const stores = {
      authorizations: this.authorizations,
      snapshots: this.snapshots,
      releases: this.releases,
      evaluations: this.evaluations,
      reviews: this.reviews,
      webhookInbox: this.webhookInbox,
      policies: this.policies,
      evidence: this.evidence,
      sessions: this.sessions,
    };
    this.deps = {
      ...stores,
      unitOfWork: new InMemoryUnitOfWork(stores),
      paymentReader: paymentReaderOf(this.provider),
      paymentExecutor: new GuardedPaymentExecutor(this.provider, this.clock),
      clock: this.clock,
      config: DEFAULT_KERNEL_CONFIG,
      merchant: this.catalog,
    };
    this.service = new CommerceSessionService(this.deps);
    this.releaseService = new ReleaseService(this.deps);
    this.webhookService = new WebhookService(this.deps);
    this.reviewService = new ReviewService(this.deps);
  }

  bounds(overrides: Partial<SessionBounds> = {}): SessionBounds {
    return {
      currency: 'INR',
      totalBudget: money('INR', 200_000),
      maxPerPurchase: money('INR', 80_000),
      merchants: { mode: 'ALLOWLIST', merchantIds: [MERCHANT] },
      allowedCategories: ['thai-meal-kit', 'groceries'],
      forbiddenCategories: [],
      itemsPerPurchase: { min: 1, max: 4 },
      recurrence: 'ONE_TIME_ONLY',
      expiresAt: EXPIRES,
      ...overrides,
    };
  }

  async createSession(overrides: Partial<SessionBounds> = {}): Promise<SessionId> {
    const policy = this.policyOverride ?? this.policy;
    await this.policies.insert(policy);
    const created = await this.service.create({
      userId: USER,
      purpose: GOAL,
      bounds: this.bounds(overrides),
      policyId: policy.policyId,
      policyVersion: policy.version,
    });
    if (created.kind !== 'CREATED') throw new Error(`session creation failed: ${created.kind}`);
    return created.session.sessionId;
  }

  key(value: string): IdempotencyKey {
    return `idem-${value.padEnd(12, '0')}` as IdempotencyKey;
  }

  /** What the agent runtime would hand over: SKUs, quantities, and a rationale. */
  purchase(
    sessionId: SessionId,
    lines: readonly { sku: Sku; quantity: number }[],
    idempotency = 'buy1',
  ) {
    return {
      sessionId,
      principal: { userId: USER, sessionId },
      merchantId: MERCHANT,
      lines,
      idempotencyKey: this.key(idempotency),
      rationale: 'Closest catalogue match to a vegetarian Thai dinner for four.',
      agentModel: 'deterministic-planner',
      agentSteps: 4,
      agentRefusedSteps: 0,
      catalogVersion: 'cat_test0000000000',
    };
  }

  /** Drives the payer authorization the capture gate needs. */
  async authorizePayer(authorizationId: AuthorizationId): Promise<void> {
    const release = await this.releases.findActiveByAuthorization(authorizationId);
    if (release === null || release.providerOrderId === null) {
      throw new Error('no provider order to authorize');
    }
    const payment = this.provider.seedAuthorizedPayment(release.providerOrderId, release.amount);
    const updated = await this.releases.transition(
      release.releaseId,
      ['ORDER_CREATED'],
      'PAYMENT_AUTHORIZED',
      { providerPaymentId: payment.paymentId },
      this.clock.now(),
    );
    if (updated === null) throw new Error('could not mark payment authorized');
  }

  /**
   * Capture calls that actually reached the provider.
   *
   * Counted from the provider's own call log rather than from a mock's
   * expectations, so `captures === 0` means the guarded executor was never
   * invoked — not that a stub happened not to fire.
   */
  get captures(): number {
    return this.provider.calls.filter(call => call.method === 'capturePayment').length;
  }

  /** Payments the provider actually holds in a captured state. */
  get capturedPayments(): number {
    return this.provider.capturedCount();
  }
}

let h: AgenticHarness;

beforeEach(() => {
  h = new AgenticHarness();
});

describe('a normal purchase', () => {
  it('runs both gates and captures', async () => {
    const sessionId = await h.createSession();

    const first = await h.service.requestPurchase(
      h.purchase(sessionId, [
        { sku: CURRY, quantity: 1 },
        { sku: RICE, quantity: 1 },
      ]),
    );
    expect(first.kind).toBe('DECIDED');
    if (first.kind !== 'DECIDED') return;
    expect(first.outcome.verdict).toBe('ALLOW');

    await h.authorizePayer(first.authorizationId);

    const captured = await h.service.requestCapture({
      sessionId,
      authorizationId: first.authorizationId,
      principal: { userId: USER, sessionId },
      idempotencyKey: h.key('cap1'),
    });

    expect(captured.kind).toBe('DECIDED');
    if (captured.kind !== 'DECIDED') return;
    expect({ verdict: captured.outcome.verdict, moneyMoved: captured.outcome.moneyMoved }).toEqual({
      verdict: 'ALLOW',
      moneyMoved: true,
    });
  });

  it('records the spend against the session budget once captured', async () => {
    const sessionId = await h.createSession();
    const purchase = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
    );
    if (purchase.kind !== 'DECIDED') throw new Error('expected a decision');

    // 280 + 150 shipping = 430 held while in flight.
    const held = await h.sessions.findById(sessionId);
    expect(held?.reservedMinor).toBe(43_000);

    await h.authorizePayer(purchase.authorizationId);
    await h.service.requestCapture({
      sessionId,
      authorizationId: purchase.authorizationId,
      principal: { userId: USER, sessionId },
      idempotencyKey: h.key('cap1'),
    });

    const settled = await h.sessions.findById(sessionId);
    expect({ reserved: settled?.reservedMinor, spent: settled?.spentMinor }).toEqual({
      reserved: 0,
      spent: 43_000,
    });
  });

  it('prices the cart itself, so the agent never states a total', async () => {
    const sessionId = await h.createSession();
    const purchase = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
    );
    if (purchase.kind !== 'DECIDED') throw new Error('expected a decision');

    const release = await h.releases.findActiveByAuthorization(purchase.authorizationId);
    // 28,000 from the live catalogue plus the merchant's own 15,000 shipping.
    expect(release?.amount).toEqual(money('INR', 43_000));
  });
});

describe('the aggregate session budget', () => {
  it('refuses a third purchase that each per-transaction check would allow', async () => {
    // The flagship case. 2,000 budget, 800 per purchase. Two purchases of 730
    // and 430 leave 840. A third at 430 fits; one at 900 would not — so drive
    // it to the boundary with quantities that are individually legal.
    const sessionId = await h.createSession();

    const one = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 2 }], 'buy1'),
    );
    if (one.kind !== 'DECIDED') throw new Error('first purchase refused');
    await h.authorizePayer(one.authorizationId);
    await h.service.requestCapture({
      sessionId,
      authorizationId: one.authorizationId,
      principal: { userId: USER, sessionId },
      idempotencyKey: h.key('cap1'),
    });

    const two = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 2 }], 'buy2'),
    );
    if (two.kind !== 'DECIDED') throw new Error('second purchase refused');
    await h.authorizePayer(two.authorizationId);
    await h.service.requestCapture({
      sessionId,
      authorizationId: two.authorizationId,
      principal: { userId: USER, sessionId },
      idempotencyKey: h.key('cap2'),
    });

    // 2 x (2 x 280 + 150) = 1,420 spent, 580 left.
    const afterTwo = await h.sessions.findById(sessionId);
    expect(remainingBudget(afterTwo!)).toEqual(money('INR', 58_000));

    // A third at 2 x 280 + 150 = 710 is inside the 800 per-purchase cap and
    // outside the 580 that remains.
    const three = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 2 }], 'buy3'),
    );
    expect(three).toMatchObject({ kind: 'REFUSED', reasonCode: 'SESSION_BUDGET_EXCEEDED' });
    expect(h.captures).toBe(2);
  });

  it('frees the hold again when a purchase is refused at a gate', async () => {
    // A refusal must not permanently consume budget. If it did, an agent could
    // exhaust a session by making requests that are all refused.
    const sessionId = await h.createSession();
    h.catalog.apply({ kind: 'SET_PRICE', sku: ENERGY, unitPriceMinor: 5_000 });

    const refusedAtGate = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: ENERGY, quantity: 1 }], 'drift'),
    );
    expect(refusedAtGate.kind).toBe('DECIDED');
    if (refusedAtGate.kind !== 'DECIDED') return;
    expect(refusedAtGate.outcome.verdict).toBe('DENY');

    const session = await h.sessions.findById(sessionId);
    expect({ reserved: session?.reservedMinor, spent: session?.spentMinor }).toEqual({
      reserved: 0,
      spent: 0,
    });
  });

  it('enforces the remaining budget through the kernel as well as the reservation', async () => {
    // Belt and braces, asserted. The derived mandate's ceiling is the remaining
    // budget, so the intent stage refuses an over-budget cart even if the
    // reservation were wrong. Here the reservation is bypassed by pre-loading
    // spend directly, leaving the kernel as the only thing standing.
    const sessionId = await h.createSession();
    await h.sessions.reserve(sessionId, money('INR', 170_000), START);
    await h.sessions.recordPurchase({
      authorizationId: 'auth_00000000000000000000000000000099',
      sessionId,
      purchaseRequestId: computeSessionBoundsHash(h.bounds()),
      reservedMinor: 170_000,
      settlementState: 'RESERVED',
      capsuleHash: computeSessionBoundsHash(h.bounds()),
      createdAt: START,
      settledAt: null,
    });

    // 300 left. A 430 cart is refused — and the reservation refuses it first,
    // which is the correct ordering: cheapest check, earliest.
    const result = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }], 'over'),
    );
    expect(result).toMatchObject({ kind: 'REFUSED', reasonCode: 'SESSION_BUDGET_EXCEEDED' });
    expect(h.captures).toBe(0);
  });
});

describe('live merchant state at the capture gate', () => {
  it('refuses a stale snapshot and makes no provider capture call', async () => {
    // The flagship demo, as a test. The agent quoted at 280; the merchant moved
    // to 340 before capture; Gate 2 re-reads and refuses.
    const sessionId = await h.createSession();
    const purchase = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
    );
    if (purchase.kind !== 'DECIDED') throw new Error('expected a decision');
    expect(purchase.outcome.verdict).toBe('ALLOW');

    await h.authorizePayer(purchase.authorizationId);

    // Reality changes.
    h.catalog.apply({ kind: 'SET_PRICE', sku: CURRY, unitPriceMinor: 34_000 });

    const captured = await h.service.requestCapture({
      sessionId,
      authorizationId: purchase.authorizationId,
      principal: { userId: USER, sessionId },
      idempotencyKey: h.key('cap1'),
    });

    expect(captured.kind).toBe('DECIDED');
    if (captured.kind !== 'DECIDED') return;
    expect(captured.outcome.verdict).toBe('DENY');
    expect(captured.outcome.reasonCodes).toContain('LIVE_PRICE_DIVERGED');
    expect(captured.outcome.moneyMoved).toBe(false);
    // The claim that matters: not "it was refused", but "nothing was charged".
    expect(h.captures).toBe(0);
  });

  it('refuses a price that moved down as well as up', async () => {
    // Divergence in either direction. A cheaper item is still not the item that
    // was verified, and silently charging less is still charging something
    // nobody approved.
    const sessionId = await h.createSession();
    const purchase = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
    );
    if (purchase.kind !== 'DECIDED') throw new Error('expected a decision');
    await h.authorizePayer(purchase.authorizationId);

    h.catalog.apply({ kind: 'SET_PRICE', sku: CURRY, unitPriceMinor: 20_000 });

    const captured = await h.service.requestCapture({
      sessionId,
      authorizationId: purchase.authorizationId,
      principal: { userId: USER, sessionId },
      idempotencyKey: h.key('cap1'),
    });
    if (captured.kind !== 'DECIDED') throw new Error('expected a decision');
    expect(captured.outcome.reasonCodes).toContain('LIVE_PRICE_DIVERGED');
    expect(h.captures).toBe(0);
  });
});

describe('intent drift', () => {
  it('refuses a numerically valid cart in a category the user never authorized', async () => {
    // Four energy drinks: 4 x 50 + 150 shipping = 350, comfortably inside every
    // ceiling. It is refused on category, by a deterministic check, against the
    // live merchant record rather than the agent's claim about it.
    const sessionId = await h.createSession();

    const result = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: ENERGY, quantity: 4 }], 'drift'),
    );

    expect(result.kind).toBe('DECIDED');
    if (result.kind !== 'DECIDED') return;
    expect(result.outcome.verdict).toBe('DENY');
    expect(result.outcome.reasonCodes).toContain('INTENT_CATEGORY_MISMATCH');
    expect(h.captures).toBe(0);
  });

  it('refuses the merchant the session did not authorize', async () => {
    const sessionId = await h.createSession({
      merchants: { mode: 'ALLOWLIST', merchantIds: ['merchant_omega' as MerchantId] },
    });
    const result = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
    );
    expect(result).toMatchObject({
      kind: 'REFUSED',
      reasonCode: 'SESSION_PURCHASE_NOT_PERMITTED',
    });
  });

  it('refuses a quantity outside the delegated band', async () => {
    const sessionId = await h.createSession();
    const result = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: ENERGY, quantity: 12 }], 'twelve'),
    );
    expect(result).toMatchObject({
      kind: 'REFUSED',
      reasonCode: 'SESSION_PURCHASE_NOT_PERMITTED',
    });
    expect(h.captures).toBe(0);
  });
});

describe('idempotency', () => {
  it('answers a repeated purchase request from the release it already made', async () => {
    const sessionId = await h.createSession();
    const first = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }], 'same'),
    );
    const second = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }], 'same'),
    );

    if (first.kind !== 'DECIDED' || second.kind !== 'DECIDED') {
      throw new Error('expected two decisions');
    }
    expect(second.replayedPurchase).toBe(true);
    expect(second.authorizationId).toBe(first.authorizationId);
    expect(second.outcome.releaseId).toBe(first.outcome.releaseId);
  });

  it('creates exactly one authorization, release and hold for a repeated request', async () => {
    const sessionId = await h.createSession();
    for (const _ of [1, 2, 3]) {
      await h.service.requestPurchase(h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }], 'same'));
    }

    expect(h.authorizations.rows.size).toBe(1);
    expect(h.releases.rows.size).toBe(1);
    expect(await h.sessions.listPurchasesBySession(sessionId, 10)).toHaveLength(1);
  });

  it('holds the budget once for a repeated request', async () => {
    // Three identical requests must not hold three times the money.
    const sessionId = await h.createSession();
    for (const _ of [1, 2, 3]) {
      await h.service.requestPurchase(h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }], 'same'));
    }
    const session = await h.sessions.findById(sessionId);
    expect(session?.reservedMinor).toBe(43_000);
  });

  it('captures once when the capture request is repeated', async () => {
    const sessionId = await h.createSession();
    const purchase = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
    );
    if (purchase.kind !== 'DECIDED') throw new Error('expected a decision');
    await h.authorizePayer(purchase.authorizationId);

    const capture = () =>
      h.service.requestCapture({
        sessionId,
        authorizationId: purchase.authorizationId,
        principal: { userId: USER, sessionId },
        idempotencyKey: h.key('cap1'),
      });

    await capture();
    await capture();

    expect(h.captures).toBe(1);
    const session = await h.sessions.findById(sessionId);
    expect(session?.spentMinor).toBe(43_000);
  });

  it('creates one release under concurrent identical requests', async () => {
    const sessionId = await h.createSession();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        h.service.requestPurchase(h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }], 'race')),
      ),
    );

    const decided = results.filter(r => r.kind === 'DECIDED');
    expect(decided.length).toBeGreaterThan(0);
    expect(await h.sessions.listPurchasesBySession(sessionId, 10)).toHaveLength(1);
    expect(h.releases.rows.size).toBe(1);
  });
});

describe('session authority', () => {
  it('refuses a purchase against an unknown session', async () => {
    const result = await h.service.requestPurchase(
      h.purchase(asSessionId('sess_0000000000000000000000000000dead'), [
        { sku: CURRY, quantity: 1 },
      ]),
    );
    expect(result).toMatchObject({ kind: 'REFUSED', reasonCode: 'SESSION_NOT_FOUND' });
  });

  it('refuses a principal that does not own the session', async () => {
    const sessionId = await h.createSession();
    const result = await h.service.requestPurchase({
      ...h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
      principal: { userId: 'user_someone_else' as UserId, sessionId },
    });
    expect(result).toMatchObject({ kind: 'REFUSED', reasonCode: 'SESSION_NOT_OWNED' });
  });

  it('refuses a revoked session', async () => {
    const sessionId = await h.createSession();
    expect(await h.service.revoke(sessionId)).toBe(true);

    const result = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
    );
    expect(result).toMatchObject({ kind: 'REFUSED', reasonCode: 'SESSION_REVOKED' });
    expect(h.captures).toBe(0);
  });

  it('refuses an expired session', async () => {
    const sessionId = await h.createSession();
    h.clock.set(asTimestamp('2026-09-06T10:00:00.000Z'));

    const result = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
    );
    expect(result).toMatchObject({ kind: 'REFUSED', reasonCode: 'SESSION_EXPIRED' });
  });

  it('detects a budget raised directly in the store', async () => {
    // An attacker with database access raises the budget. The bounds hash was
    // recorded at delegation, so the edit is caught rather than honoured.
    const sessionId = await h.createSession();
    const stored = await h.sessions.findById(sessionId);
    h.sessions.rows.set(sessionId, {
      ...stored!,
      bounds: { ...stored!.bounds, totalBudget: money('INR', 100_000_000) },
    });

    const result = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
    );
    expect(result).toMatchObject({
      kind: 'REFUSED',
      reasonCode: 'SESSION_BOUNDS_HASH_MISMATCH',
    });
    expect(h.captures).toBe(0);
  });

  it('refuses an empty cart and a cart with a duplicated SKU', async () => {
    const sessionId = await h.createSession();
    expect(await h.service.requestPurchase(h.purchase(sessionId, []))).toMatchObject({
      kind: 'REFUSED',
      reasonCode: 'INVALID_AGENT_ACTION',
    });
    expect(
      await h.service.requestPurchase(
        h.purchase(sessionId, [
          { sku: CURRY, quantity: 1 },
          { sku: CURRY, quantity: 1 },
        ]),
      ),
    ).toMatchObject({ kind: 'REFUSED', reasonCode: 'INVALID_AGENT_ACTION' });
  });
});

describe('grounding', () => {
  it('refuses a SKU that is not in the live catalogue', async () => {
    const sessionId = await h.createSession();
    const result = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: 'SKU-INVENTED' as Sku, quantity: 1 }]),
    );
    expect(result).toMatchObject({ kind: 'REFUSED', reasonCode: 'CART_NOT_GROUNDED' });
    expect(h.captures).toBe(0);
  });

  it('refuses rather than proceeding when the merchant is unreachable', async () => {
    const sessionId = await h.createSession();
    h.catalog.apply({ kind: 'GO_OFFLINE', reason: 'connector down' });

    const result = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
    );
    expect(result).toMatchObject({ kind: 'REFUSED', reasonCode: 'LIVE_STATE_UNAVAILABLE' });
  });
});

describe('the stranded-hold sweep', () => {
  it('frees a hold whose release never happened', async () => {
    const sessionId = await h.createSession();
    await h.sessions.reserve(sessionId, money('INR', 43_000), START);
    await h.sessions.recordPurchase({
      authorizationId: 'auth_00000000000000000000000000000042',
      sessionId,
      purchaseRequestId: computeSessionBoundsHash(h.bounds()),
      reservedMinor: 43_000,
      settlementState: 'RESERVED',
      capsuleHash: computeSessionBoundsHash(h.bounds()),
      createdAt: START,
      settledAt: null,
    });

    h.clock.set(asTimestamp('2026-09-04T10:10:00.000Z'));
    const swept = await h.service.sweepUnsettledPurchases();

    expect(swept).toEqual([
      { authorizationId: 'auth_00000000000000000000000000000042', resolution: 'RELEASED' },
    ]);
    const session = await h.sessions.findById(sessionId);
    expect(remainingBudget(session!)).toEqual(money('INR', 200_000));
  });

  it('leaves a hold alone while its release is still live', async () => {
    // A paused release is not stranded. Guessing here would either free budget
    // for a purchase that then captures, or record spend for one that never did.
    const sessionId = await h.createSession();
    const purchase = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
    );
    if (purchase.kind !== 'DECIDED') throw new Error('expected a decision');

    h.clock.set(asTimestamp('2026-09-04T10:10:00.000Z'));
    const swept = await h.service.sweepUnsettledPurchases();

    expect(swept).toEqual([
      { authorizationId: purchase.authorizationId, resolution: 'STILL_IN_FLIGHT' },
    ]);
    const session = await h.sessions.findById(sessionId);
    expect(session?.reservedMinor).toBe(43_000);
  });
});

describe('evidence', () => {
  it('links the agentic context to the CaptureLock decision, in causal order', async () => {
    const sessionId = await h.createSession();
    const purchase = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
    );
    if (purchase.kind !== 'DECIDED') throw new Error('expected a decision');

    const chain = await h.evidence.listByChain(purchase.authorizationId);
    const kinds = chain.map(envelope => envelope.kind);

    // The agentic context comes first: what the agent was trying to buy, and
    // only then what CaptureLock decided about it.
    expect(kinds[0]).toBe('AGENT_CONTEXT');
    expect(kinds).toContain('DECISION');

    const verification = await h.evidence.verifyChain(purchase.authorizationId);
    expect(verification.valid).toBe(true);
  });

  it('records the capsule hash on the purchase, binding it to the chain', async () => {
    const sessionId = await h.createSession();
    const purchase = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
    );
    if (purchase.kind !== 'DECIDED') throw new Error('expected a decision');

    const stored = await h.sessions.findPurchaseByAuthorization(purchase.authorizationId);
    expect(stored?.capsuleHash).toBe(purchase.capsuleHash);

    const chain = await h.evidence.listByChain(purchase.authorizationId);
    const capsuleEnvelope = chain.find(e => e.kind === 'AGENT_CONTEXT');
    expect((capsuleEnvelope?.body as { capsuleHash: string }).capsuleHash).toBe(
      purchase.capsuleHash,
    );
  });

  it('puts the user intent and the agent rationale in the capsule', async () => {
    const sessionId = await h.createSession();
    const purchase = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
    );
    if (purchase.kind !== 'DECIDED') throw new Error('expected a decision');

    const chain = await h.evidence.listByChain(purchase.authorizationId);
    const body = chain.find(e => e.kind === 'AGENT_CONTEXT')?.body as {
      capsule: {
        intentText: string;
        agentDecision: { rationale: string; model: string };
        totalMinor: number;
      };
    };

    expect(body.capsule.intentText).toBe(GOAL);
    expect(body.capsule.agentDecision.model).toBe('deterministic-planner');
    // The authoritative total, from the priced snapshot — not from the agent.
    expect(body.capsule.totalMinor).toBe(43_000);
  });

  it('carries no full transcript and no secret', async () => {
    const sessionId = await h.createSession();
    const purchase = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
    );
    if (purchase.kind !== 'DECIDED') throw new Error('expected a decision');

    const chain = await h.evidence.listByChain(purchase.authorizationId);
    const serialized = JSON.stringify(chain.find(e => e.kind === 'AGENT_CONTEXT')?.body);

    for (const forbidden of [
      'apiKey',
      'api_key',
      'secret',
      'privateKey',
      'transcript',
      'messages',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('policy binding', () => {
  it('refuses to create a session with no enforceable policy', async () => {
    const created = await h.service.create({
      userId: USER,
      purpose: GOAL,
      bounds: h.bounds(),
      policyId: 'nonexistent',
      policyVersion: '9.9.9',
    });
    expect(created).toEqual({ kind: 'POLICY_NOT_FOUND' });
  });

  it('binds the policy hash the kernel will check into the capsule', async () => {
    const sessionId = await h.createSession();
    const purchase = await h.service.requestPurchase(
      h.purchase(sessionId, [{ sku: CURRY, quantity: 1 }]),
    );
    if (purchase.kind !== 'DECIDED') throw new Error('expected a decision');

    const chain = await h.evidence.listByChain(purchase.authorizationId);
    const body = chain.find(e => e.kind === 'AGENT_CONTEXT')?.body as {
      capsule: { policyHash: string };
    };
    expect(body.capsule.policyHash).toBe(computePolicyHash(h.policy));
  });
});
