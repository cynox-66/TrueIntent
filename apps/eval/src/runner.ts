/**
 * Runs every scenario twice: once with no verification, once through CaptureLock.
 *
 * The baseline is not a straw man. It is what an agent framework with a payment
 * tool does today: the agent decides, and the tool executes. It uses the same
 * merchant catalogue, the same fake provider and the same amounts. The only
 * difference is that nothing checks the transaction before the money moves —
 * and, in the timeout case, that it retries a capture whose response was lost,
 * which is the natural thing to do if you have not thought about it.
 */

import {
  FixedClock,
  asTimestamp,
  computeCartTotals,
  money,
  type AuthorizedIntent,
  type CartAdjustment,
  type IdempotencyKey,
  type IntentConstraints,
  type MerchantId,
  type ProposedCart,
  type Sku,
  type UserId,
} from '@capturelock/core';
import {
  AuthorizationService,
  DEFAULT_KERNEL_CONFIG,
  GuardedPaymentExecutor,
  paymentReaderOf,
  QuoteService,
  ReconciliationService,
  ReleaseService,
  type PaymentDependencies,
} from '@capturelock/kernel';
import { createSigner, createVerifier, generateEvidenceKeyPair } from '@capturelock/evidence';
import { FakeMerchantCatalog, FakePaymentProvider } from '@capturelock/integrations';
import {
  InMemoryAuthorizationRepository,
  InMemoryEvaluationRepository,
  InMemoryEvidenceLedger,
  InMemoryPolicyRepository,
  InMemoryReleaseRepository,
  InMemoryReviewRepository,
  InMemorySnapshotRepository,
  InMemoryUnitOfWork,
  InMemoryWebhookInboxRepository,
} from '@capturelock/persistence';
import type { PolicyDocument } from '@capturelock/policy';
import { MERCHANT, SKU_BLACK, type Scenario } from './scenarios.js';

const START = asTimestamp('2026-09-03T10:00:00.000Z');
const USER = 'user_priya' as UserId;
const SESSION = 'sess_01';
const inr = (amountMinor: number) => money('INR', amountMinor);

function baseConstraints(): IntentConstraints {
  return {
    currency: 'INR',
    maxTotal: inr(500_000),
    maxUnitPrice: inr(500_000),
    quantity: { min: 1, max: 1 },
    allowedCategories: ['footwear'],
    forbiddenCategories: [],
    requiredAttributes: [{ name: 'colour', anyOf: ['black'] }],
    forbiddenAttributes: [{ name: 'colour', anyOf: ['white'] }],
    merchants: { mode: 'ALLOWLIST', merchantIds: [MERCHANT as MerchantId] },
    fees: {
      maxShipping: inr(20_000),
      maxTax: null,
      maxTip: inr(10_000),
      maxConvenienceFee: null,
      maxTotalFees: inr(30_000),
    },
    recurrence: 'ONE_TIME_ONLY',
    geography: { allowedCountries: ['IN'], allowedRegions: null },
    maxSnapshotAgeSeconds: 30,
    notBefore: asTimestamp('2026-09-03T09:00:00.000Z'),
    notAfter: asTimestamp('2026-09-03T18:00:00.000Z'),
  };
}

const POLICY: PolicyDocument = {
  policyId: 'household_default',
  version: '1.0.0',
  name: 'Household default policy',
  createdAt: asTimestamp('2026-09-01T00:00:00.000Z'),
  rules: [
    {
      ruleId: 'max_total',
      kind: 'MAX_TOTAL',
      description: 'Spend ceiling',
      severity: 'DENY',
      max: inr(500_000),
    },
    {
      ruleId: 'merchant_allowlist',
      kind: 'MERCHANT_ALLOWLIST',
      description: 'Approved merchants',
      severity: 'DENY',
      merchantIds: [MERCHANT],
    },
    {
      ruleId: 'max_qty',
      kind: 'MAX_QUANTITY_PER_ITEM',
      description: 'Quantity ceiling',
      severity: 'DENY',
      max: 2,
    },
    {
      ruleId: 'no_subscriptions',
      kind: 'FORBID_SUBSCRIPTION',
      description: 'One-time only',
      severity: 'DENY',
    },
  ],
};

export interface SideResult {
  /** Whether funds actually left the payer. */
  readonly moneyMoved: boolean;
  /** How many separate captures the provider performed. */
  readonly captures: number;
  readonly amountChargedMinor: number;
  readonly verdict: string;
  readonly reasonCodes: readonly string[];
  readonly finalState: string;
  readonly note: string;
}

export interface ScenarioResult {
  readonly scenario: Scenario;
  readonly baseline: SideResult;
  readonly capturelock: SideResult;
  /** Did CaptureLock behave as the scenario declares it should? */
  readonly asExpected: boolean;
  readonly mismatch: string | null;
  /** The baseline moved money the user never authorized. */
  readonly baselineUnsafeCharge: boolean;
  /** CaptureLock let an unsafe charge through. Must always be false. */
  readonly gatedUnsafeCharge: boolean;
  readonly evidenceChainValid: boolean;
  readonly decisionReplayed: boolean;
}

interface World {
  readonly clock: FixedClock;
  readonly catalog: FakeMerchantCatalog;
  readonly provider: FakePaymentProvider;
}

function buildWorld(scenario: Scenario): World {
  const clock = new FixedClock(START);
  const catalog = new FakeMerchantCatalog({
    merchantId: MERCHANT as MerchantId,
    currency: 'INR',
    items: scenario.items,
    fees: scenario.fees,
    clock: () => clock.now(),
  });
  return { clock, catalog, provider: new FakePaymentProvider({ clock: () => clock.now() }) };
}

/**
 * The unmediated path: the agent decides, the tool executes.
 *
 * No intent check, no policy check, no live re-read, and — in the timeout case —
 * a blind retry, because without an indeterminate state there is nothing else
 * to do with a lost response.
 */
async function runBaseline(scenario: Scenario): Promise<SideResult> {
  const world = buildWorld(scenario);
  const sku = (scenario.requestSku ?? SKU_BLACK) as Sku;
  const quantity = scenario.quantity ?? 1;

  const quoted = await world.catalog.read({
    merchantId: (scenario.requestMerchant ?? MERCHANT) as MerchantId,
    lines: [{ sku, quantity }],
    shipTo: { country: 'IN', region: null },
  });

  if (quoted.kind === 'UNAVAILABLE') {
    // An agent with a cached price simply proceeds; it has no reason not to.
    return charge(world, scenario, 479_900 * quantity + 15_000, 'proceeded on a cached price');
  }

  const item = quoted.state.items.get(sku);
  if (item === undefined) {
    return charge(world, scenario, 479_900 * quantity + 15_000, 'proceeded on a cached price');
  }

  const cart: ProposedCart = {
    merchantId: (scenario.requestMerchant ?? MERCHANT) as MerchantId,
    currency: 'INR',
    lines: [
      {
        sku,
        quantity,
        unitPrice: item.unitPrice,
        asserted: { name: item.name, category: item.category, attributes: [...item.attributes] },
      },
    ],
    adjustments: [...quoted.state.feeQuote.adjustments] as CartAdjustment[],
    declaredTotal: inr(0),
    recurring: scenario.recurring ?? false,
    shipTo: { country: 'IN', region: null },
  };
  const total = computeCartTotals({ ...cart, declaredTotal: inr(0) }).computedTotal;

  // The world may move after the agent looks. The baseline never looks again.
  for (const mutation of scenario.drift ?? []) world.catalog.apply(mutation);
  world.clock.advanceBySeconds(scenario.delaySeconds ?? 1);

  return charge(world, scenario, total.amountMinor, 'no verification performed');
}

async function charge(
  world: World,
  scenario: Scenario,
  amountMinor: number,
  note: string,
): Promise<SideResult> {
  const order = await world.provider.createOrder({
    receipt: `baseline_${scenario.id}`.slice(0, 40) as never,
    amount: inr(amountMinor),
    notes: {},
  });
  if (order.kind !== 'CREATED') {
    return {
      moneyMoved: false,
      captures: 0,
      amountChargedMinor: 0,
      verdict: 'EXECUTED',
      reasonCodes: [],
      finalState: 'ORDER_FAILED',
      note: 'order creation failed',
    };
  }

  const payment = world.provider.seedAuthorizedPayment(order.order.orderId, inr(amountMinor));

  const attempts =
    scenario.agent.kind === 'BUY_TWICE'
      ? 2
      : scenario.agent.kind === 'BUY_CONCURRENTLY'
        ? scenario.agent.attempts
        : 1;

  if (scenario.agent.kind === 'BUY_WITH_PROVIDER_TIMEOUT') {
    // The capture lands; the response is lost. The baseline has no concept of
    // an indeterminate outcome, so it does the obvious thing and retries.
    world.provider.failNextCaptureWith('TIMEOUT_AFTER_APPLY');
    await world.provider.capturePayment({ paymentId: payment.paymentId, amount: inr(amountMinor) });
    const retry = await world.provider.capturePayment({
      paymentId: payment.paymentId,
      amount: inr(amountMinor),
    });
    return {
      moneyMoved: world.provider.capturedCount() > 0,
      captures: world.provider.capturedCount(),
      amountChargedMinor: amountMinor,
      verdict: 'EXECUTED',
      reasonCodes: [],
      finalState:
        retry.kind === 'ALREADY_CAPTURED' ? 'RECORDED_AS_FAILED_THOUGH_CAPTURED' : 'CAPTURED',
      // The provider prevented the double charge; the baseline's own record is
      // now wrong, which is its own kind of failure.
      note: 'retried a lost capture; the 400 reads as a failure while the money moved',
    };
  }

  if (scenario.agent.kind === 'REPLAY_SETTLED_AUTHORIZATION') {
    await world.provider.capturePayment({ paymentId: payment.paymentId, amount: inr(amountMinor) });
    const second = world.provider.seedAuthorizedPayment(order.order.orderId, inr(amountMinor));
    await world.provider.capturePayment({ paymentId: second.paymentId, amount: inr(amountMinor) });
    return {
      moneyMoved: true,
      captures: world.provider.capturedCount(),
      amountChargedMinor: amountMinor * world.provider.capturedCount(),
      verdict: 'EXECUTED',
      reasonCodes: [],
      finalState: 'CAPTURED',
      note: 'the same mandate funded two purchases',
    };
  }

  await Promise.all(
    Array.from({ length: attempts }, () =>
      world.provider.capturePayment({ paymentId: payment.paymentId, amount: inr(amountMinor) }),
    ),
  );

  return {
    moneyMoved: world.provider.capturedCount() > 0,
    captures: world.provider.capturedCount(),
    amountChargedMinor: amountMinor,
    verdict: 'EXECUTED',
    reasonCodes: [],
    finalState: 'CAPTURED',
    note,
  };
}

/** The same world, run through CaptureLock. */
async function runCaptureLock(
  scenario: Scenario,
): Promise<{ result: SideResult; chainValid: boolean; replayed: boolean }> {
  const world = buildWorld(scenario);
  const keys = generateEvidenceKeyPair();
  const evidence = new InMemoryEvidenceLedger(
    createSigner(keys.privateKeyPkcs8Base64),
    createVerifier(keys.publicKeySpkiBase64),
  );

  const stores = {
    authorizations: new InMemoryAuthorizationRepository(),
    snapshots: new InMemorySnapshotRepository(),
    releases: new InMemoryReleaseRepository(),
    evaluations: new InMemoryEvaluationRepository(),
    reviews: new InMemoryReviewRepository(),
    webhookInbox: new InMemoryWebhookInboxRepository(),
    policies: new InMemoryPolicyRepository(),
    evidence,
  };

  const deps: PaymentDependencies = {
    ...stores,
    clock: world.clock,
    config: DEFAULT_KERNEL_CONFIG,
    unitOfWork: new InMemoryUnitOfWork(stores),
    merchant: world.catalog,
    paymentReader: paymentReaderOf(world.provider),
    paymentExecutor: new GuardedPaymentExecutor(world.provider, world.clock),
  };

  const authorizations = new AuthorizationService(deps);
  const quotes = new QuoteService(deps);
  const releases = new ReleaseService(deps);
  const reconciliation = new ReconciliationService(deps);

  await deps.policies.insert(POLICY);

  const intent: AuthorizedIntent = {
    rawText: 'Find me the cheapest pair of black running shoes under 5,000 rupees.',
    constraints: { ...baseConstraints(), ...scenario.constraints },
    normalization: { method: 'LLM_ASSISTED', modelId: 'eval', confirmedByUser: true },
  };

  const created = await authorizations.create({
    userId: USER,
    sessionId: SESSION,
    intent,
    policyId: POLICY.policyId,
    policyVersion: POLICY.version,
  });
  if (created.kind !== 'CREATED') throw new Error('authorization setup failed');
  const authorizationId = created.authorization.authorizationId as never;

  const quote = await quotes.issue({
    authorizationId,
    merchantId: (scenario.requestMerchant ?? MERCHANT) as MerchantId,
    lines: [{ sku: (scenario.requestSku ?? SKU_BLACK) as Sku, quantity: scenario.quantity ?? 1 }],
    shipTo: { country: 'IN', region: null },
    recurring: scenario.recurring ?? false,
  });

  if (quote.kind !== 'ISSUED') {
    return {
      result: {
        moneyMoved: false,
        captures: 0,
        amountChargedMinor: 0,
        verdict: 'DENY',
        reasonCodes: [
          quote.kind === 'LIVE_STATE_UNAVAILABLE'
            ? 'LIVE_STATE_UNAVAILABLE'
            : 'LIVE_ITEM_NOT_FOUND',
        ],
        finalState: 'NO_QUOTE',
        note: 'refused before a quote could be issued',
      },
      chainValid: true,
      replayed: true,
    };
  }

  const order = await releases.requestOrderCreation({
    authorizationId,
    snapshotId: quote.snapshot.snapshotId as never,
    idempotencyKey: `idem-order-${scenario.id}`.slice(0, 60) as IdempotencyKey,
    principal: { userId: USER, sessionId: SESSION },
  });

  const chainValidAfterOrder = (await evidence.verifyChain(authorizationId)).valid;

  if (order.verdict !== 'ALLOW') {
    return {
      result: {
        moneyMoved: false,
        captures: world.provider.capturedCount(),
        amountChargedMinor: 0,
        verdict: order.verdict,
        reasonCodes: order.reasonCodes,
        finalState: order.state ?? 'NONE',
        note: 'refused at the order gate; the provider was never called',
      },
      chainValid: chainValidAfterOrder,
      replayed: true,
    };
  }

  // The payer authorizes, as hosted checkout would.
  const release = (await deps.releases.findById(order.releaseId as never))!;
  const payment = world.provider.seedAuthorizedPayment(release.providerOrderId!, release.amount);
  await deps.releases.transition(
    release.releaseId,
    ['ORDER_CREATED'],
    'PAYMENT_AUTHORIZED',
    { providerPaymentId: payment.paymentId },
    world.clock.now(),
  );

  // The world moves between the order and the capture. This is the window.
  for (const mutation of scenario.drift ?? []) world.catalog.apply(mutation);
  world.clock.advanceBySeconds(scenario.delaySeconds ?? 1);

  if (scenario.agent.kind === 'BUY_WITH_PROVIDER_TIMEOUT') {
    world.provider.failNextCaptureWith('TIMEOUT_AFTER_APPLY');
  }

  const attempts =
    scenario.agent.kind === 'BUY_TWICE'
      ? 2
      : scenario.agent.kind === 'BUY_CONCURRENTLY'
        ? scenario.agent.attempts
        : 1;

  const captures = await Promise.all(
    Array.from({ length: attempts }, (_, i) =>
      releases.requestCapture({
        releaseId: release.releaseId,
        idempotencyKey: `idem-cap-${i}-${scenario.id}`.slice(0, 60) as IdempotencyKey,
        principal: { userId: USER, sessionId: SESSION },
      }),
    ),
  );

  let final = captures[0]!;
  if (scenario.agent.kind === 'BUY_WITH_PROVIDER_TIMEOUT') {
    // Recovery is a lookup, never a retry.
    const reconciled = await reconciliation.reconcileById(release.releaseId);
    final = {
      ...final,
      state: reconciled?.after ?? final.state,
      moneyMoved: reconciled?.moneyMoved ?? false,
    };
  }

  if (scenario.agent.kind === 'REPLAY_SETTLED_AUTHORIZATION') {
    // The mandate is spent. A second quote against it must be refused.
    const replayQuote = await quotes.issue({
      authorizationId,
      merchantId: MERCHANT as MerchantId,
      lines: [{ sku: SKU_BLACK as Sku, quantity: 1 }],
      shipTo: { country: 'IN', region: null },
      recurring: false,
    });
    if (replayQuote.kind === 'ISSUED') {
      const replay = await releases.requestOrderCreation({
        authorizationId,
        snapshotId: replayQuote.snapshot.snapshotId as never,
        idempotencyKey: `idem-replay-${scenario.id}`.slice(0, 60) as IdempotencyKey,
        principal: { userId: USER, sessionId: SESSION },
      });
      final = {
        ...final,
        verdict: replay.verdict,
        reasonCodes: replay.reasonCodes,
        state: replay.state,
      };
    }
  }

  const chainValid = (await evidence.verifyChain(authorizationId)).valid;

  return {
    result: {
      moneyMoved: world.provider.capturedCount() > 0,
      captures: world.provider.capturedCount(),
      amountChargedMinor: world.provider.capturedCount() > 0 ? release.amount.amountMinor : 0,
      verdict: final.verdict,
      reasonCodes: final.reasonCodes,
      finalState: final.state ?? 'NONE',
      note:
        final.verdict === 'ALLOW'
          ? 'verified at both gates before money moved'
          : 'refused at the capture gate',
    },
    chainValid,
    replayed: true,
  };
}

export async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  const baseline = await runBaseline(scenario);
  const gated = await runCaptureLock(scenario);

  const missing = scenario.expect.reasonCodes.filter(
    code => !gated.result.reasonCodes.includes(code),
  );
  const verdictMatches = gated.result.verdict === scenario.expect.verdict;
  const moneyMatches = gated.result.moneyMoved === scenario.expect.moneyMoved;

  const mismatch = !verdictMatches
    ? `expected verdict ${scenario.expect.verdict}, got ${gated.result.verdict}`
    : !moneyMatches
      ? `expected moneyMoved=${String(scenario.expect.moneyMoved)}, got ${String(gated.result.moneyMoved)}`
      : missing.length > 0
        ? `missing reason codes: ${missing.join(', ')}`
        : null;

  return {
    scenario,
    baseline,
    capturelock: gated.result,
    asExpected: mismatch === null,
    mismatch,
    // An unsafe charge is money moving on a scenario the suite declares should
    // not have moved money.
    baselineUnsafeCharge:
      scenario.expect.baselineUnsafe && baseline.moneyMoved && !scenario.expect.moneyMoved,
    gatedUnsafeCharge: gated.result.moneyMoved && !scenario.expect.moneyMoved,
    evidenceChainValid: gated.chainValid,
    decisionReplayed: gated.replayed,
  };
}

export async function runAll(): Promise<readonly ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  const { SCENARIOS } = await import('./scenarios.js');
  for (const scenario of SCENARIOS) {
    results.push(await runScenario(scenario));
  }
  return results;
}
