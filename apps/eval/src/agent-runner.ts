/**
 * Runs the agentic scenarios against the real service graph.
 *
 * "Real" is load-bearing: this builds the same object graph as
 * `apps/api/src/composition.ts`, runs the genuine two-gate pipeline, and counts
 * capture calls from the fake provider's own call log. A scenario reporting
 * `providerCaptures: 0` is reporting that the guarded executor was never
 * invoked, not that a stub happened not to fire.
 *
 * The only fakes are the merchant catalogue and the payment provider, both of
 * which are the repository's existing deterministic doubles. Everything between
 * the agent and them is production code.
 */

import {
  DEFAULT_KERNEL_CONFIG,
  CommerceSessionService,
  GuardedPaymentExecutor,
  paymentReaderOf,
  type PaymentDependencies,
} from '@capturelock/kernel';
import {
  BuyerAgentRuntime,
  DeterministicBuyerModel,
  MalformedBuyerModel,
  UnavailableBuyerModel,
  type AgentAction,
  type BuyerModel,
} from '@capturelock/agent';
import {
  FixedClock,
  asTimestamp,
  money,
  type AuthorizationId,
  type IdempotencyKey,
  type MerchantId,
  type SessionBounds,
  type Sku,
  type UserId,
} from '@capturelock/core';
import { FakeMerchantCatalog, FakePaymentProvider } from '@capturelock/integrations';
import { createSigner, createVerifier, generateEvidenceKeyPair } from '@capturelock/evidence';
import type { PolicyDocument } from '@capturelock/policy';
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
import { AGENT_SCENARIOS, DEFAULT_ITEMS, type AgentScenario } from './agent-scenarios.js';

const MERCHANT = 'merchant_alpha' as MerchantId;
const USER = 'user_priya' as UserId;
const START = asTimestamp('2026-09-04T10:00:00.000Z');
const EXPIRES = asTimestamp('2026-09-05T10:00:00.000Z');
const GOAL = 'Thai curry dinner for 4, vegetarian, under 800 rupees';

export interface AgentScenarioOutcome {
  readonly moneyMoved: boolean;
  readonly providerCaptures: number;
  readonly releases: number;
  readonly spentMinor: number;
  readonly reasonCodes: readonly string[];
  readonly evidenceChainValid: boolean;
  readonly agenticContextRecorded: boolean;
  /** The step log, so the report can show what the agent actually did. */
  readonly agentSteps: number;
  readonly agentRefusedSteps: number;
}

export interface AgentScenarioResult {
  readonly scenario: AgentScenario;
  readonly outcome: AgentScenarioOutcome;
  readonly asExpected: boolean;
  readonly mismatch: string | null;
}

/** A model that plays a fixed script. Used for the injected-payment case. */
class ScriptedBuyerModel implements BuyerModel {
  public readonly name: string;

  constructor(
    private readonly script: readonly unknown[],
    name = 'scripted',
  ) {
    this.name = name;
  }

  async decide(): Promise<AgentAction> {
    return (this.script[0] ?? { action: 'ABANDON', reason: 'exhausted' }) as AgentAction;
  }
}

function policyDocument(): PolicyDocument {
  return {
    policyId: 'household_default',
    version: '1.0.0',
    name: 'Household default policy',
    createdAt: START,
    rules: [
      {
        ruleId: 'max_total',
        kind: 'MAX_TOTAL',
        description: 'Operator spend ceiling',
        severity: 'DENY',
        max: { currency: 'INR', amountMinor: 500_000 },
      },
      {
        ruleId: 'no_alcohol',
        kind: 'PROHIBITED_CATEGORIES',
        description: 'Household policy forbids alcohol',
        severity: 'DENY',
        categories: ['alcohol'],
      },
    ],
  };
}

class World {
  readonly clock = new FixedClock(START);
  readonly catalog: FakeMerchantCatalog;
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
  readonly policy = policyDocument();

  constructor(scenario: AgentScenario) {
    this.catalog = new FakeMerchantCatalog({
      merchantId: MERCHANT,
      currency: 'INR',
      items: scenario.items ?? DEFAULT_ITEMS,
      fees: [{ type: 'SHIPPING', label: 'Standard delivery', amount: money('INR', 15_000) }],
      clock: () => this.clock.now(),
    });

    const keys = generateEvidenceKeyPair();
    this.evidence = new InMemoryEvidenceLedger(
      createSigner(keys.privateKeyPkcs8Base64),
      createVerifier(keys.publicKeySpkiBase64),
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
  }

  get providerCaptures(): number {
    return this.provider.calls.filter(call => call.method === 'capturePayment').length;
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

  /** Drives the payer authorization the capture gate needs. */
  async authorizePayer(authorizationId: AuthorizationId): Promise<boolean> {
    const release = await this.releases.findActiveByAuthorization(authorizationId);
    if (release === null || release.providerOrderId === null) return false;
    const payment = this.provider.seedAuthorizedPayment(release.providerOrderId, release.amount);
    const updated = await this.releases.transition(
      release.releaseId,
      ['ORDER_CREATED'],
      'PAYMENT_AUTHORIZED',
      { providerPaymentId: payment.paymentId },
      this.clock.now(),
    );
    return updated !== null;
  }
}

function modelFor(scenario: AgentScenario): BuyerModel {
  switch (scenario.behaviour.kind) {
    case 'MALFORMED_MODEL':
      return new MalformedBuyerModel();
    case 'ABSENT_MODEL':
      return new UnavailableBuyerModel();
    case 'MODEL_DEMANDS_PAYMENT':
      // What a prompt-injected model looks like once its output is parsed.
      return new ScriptedBuyerModel([{ action: 'CAPTURE_PAYMENT', amount: 999_999 }], 'injected');
    case 'SHOP_PREFERRING':
      return new DeterministicBuyerModel({
        preferSku: scenario.behaviour.skus,
        quantity: scenario.behaviour.quantity,
        maxLines: 1,
      });
    default:
      return new DeterministicBuyerModel({ maxLines: 2 });
  }
}

let keyCounter = 0;
function nextKey(label: string): IdempotencyKey {
  keyCounter += 1;
  return `idem-${label}-${String(keyCounter).padStart(10, '0')}` as IdempotencyKey;
}

export async function runAgentScenario(scenario: AgentScenario): Promise<AgentScenarioResult> {
  const world = new World(scenario);
  await world.policies.insert(world.policy);

  const created = await world.service.create({
    userId: USER,
    purpose: GOAL,
    bounds: world.bounds(scenario.bounds),
    policyId: world.policy.policyId,
    policyVersion: world.policy.version,
  });
  if (created.kind !== 'CREATED') {
    return {
      scenario,
      outcome: emptyOutcome(),
      asExpected: false,
      mismatch: `session creation failed: ${created.kind}`,
    };
  }
  const sessionId = created.session.sessionId;
  const principal = { userId: USER, sessionId };
  const reasonCodes = new Set<string>();
  let agentSteps = 0;
  let agentRefusedSteps = 0;

  if (scenario.revokeSession) await world.service.revoke(sessionId);

  if (scenario.tamperWithBounds) {
    // Raise the stored budget behind TrueIntent's back.
    const stored = await world.sessions.findById(sessionId);
    world.sessions.rows.set(sessionId, {
      ...stored!,
      bounds: { ...stored!.bounds, totalBudget: money('INR', 100_000_000) },
    });
  }

  // ---- decide what to buy ------------------------------------------------
  let lines: readonly { sku: Sku; quantity: number }[] = [];
  let catalogVersion = 'unknown';
  let rationale = 'Selected from the merchant catalogue for the stated goal.';
  let modelName = 'deterministic-planner';

  const needsAgentRun =
    scenario.behaviour.kind === 'SHOP' ||
    scenario.behaviour.kind === 'SHOP_PREFERRING' ||
    scenario.behaviour.kind === 'MALFORMED_MODEL' ||
    scenario.behaviour.kind === 'ABSENT_MODEL' ||
    scenario.behaviour.kind === 'MODEL_DEMANDS_PAYMENT';

  if (needsAgentRun) {
    const model = modelFor(scenario);
    modelName = model.name;
    const runtime = new BuyerAgentRuntime({ catalog: world.catalog, model, maxSteps: 8 });
    const run = await runtime.run({ session: created.session, merchantId: MERCHANT, goal: GOAL });

    agentSteps = run.steps.length;
    agentRefusedSteps = run.steps.filter(step => !step.accepted).length;
    for (const step of run.steps) {
      if (step.refusedWith !== null) reasonCodes.add(step.refusedWith);
    }

    if (run.outcome.kind !== 'PURCHASE_REQUESTED') {
      // The agent never got as far as asking. Nothing was charged, and the
      // reason is on the record.
      if (run.outcome.kind === 'FAILED') reasonCodes.add(run.outcome.reasonCode);
      return finish(world, scenario, {
        reasonCodes,
        agentSteps,
        agentRefusedSteps,
        agenticContextRecorded: false,
      });
    }

    lines = run.outcome.cart.map(line => ({ sku: line.sku as Sku, quantity: line.quantity }));
    catalogVersion = run.outcome.catalogVersion;
    rationale = run.outcome.reason;
  } else if ('lines' in scenario.behaviour) {
    lines = scenario.behaviour.lines.map(line => ({
      sku: line.sku as Sku,
      quantity: line.quantity,
    }));
  }

  const purchaseRequest = (key: IdempotencyKey) => ({
    sessionId,
    principal,
    merchantId: MERCHANT,
    lines,
    idempotencyKey: key,
    rationale,
    agentModel: modelName,
    agentSteps,
    agentRefusedSteps,
    catalogVersion,
  });

  // ---- ask TrueIntent ---------------------------------------------------
  const attempts: AuthorizationId[] = [];

  if (scenario.behaviour.kind === 'BUY_CONCURRENTLY') {
    const key = nextKey('concurrent');
    const results = await Promise.all(
      Array.from({ length: scenario.behaviour.attempts }, () =>
        world.service.requestPurchase(purchaseRequest(key)),
      ),
    );
    for (const result of results) {
      if (result.kind === 'REFUSED') reasonCodes.add(result.reasonCode);
      else {
        for (const code of result.outcome.reasonCodes) reasonCodes.add(code);
        if (!attempts.includes(result.authorizationId)) attempts.push(result.authorizationId);
      }
    }
  } else if (scenario.behaviour.kind === 'DRAIN_BUDGET') {
    // Keep buying until the session refuses one. Each purchase is individually
    // within the per-transaction cap; the aggregate is what eventually says no.
    for (let i = 0; i < 6; i += 1) {
      const result = await world.service.requestPurchase(
        purchaseRequest(nextKey(`drain${String(i)}`)),
      );
      if (result.kind === 'REFUSED') {
        reasonCodes.add(result.reasonCode);
        break;
      }
      for (const code of result.outcome.reasonCodes) reasonCodes.add(code);
      if (result.outcome.verdict !== 'ALLOW') break;
      attempts.push(result.authorizationId);
      if (await world.authorizePayer(result.authorizationId)) {
        const captured = await world.service.requestCapture({
          sessionId,
          authorizationId: result.authorizationId,
          principal,
          idempotencyKey: nextKey(`draincap${String(i)}`),
        });
        if (captured.kind === 'DECIDED') {
          for (const code of captured.outcome.reasonCodes) reasonCodes.add(code);
        }
      }
    }
  } else {
    const repeats = scenario.behaviour.kind === 'BUY_TWICE' ? 2 : 1;
    const key = nextKey('buy');
    for (let i = 0; i < repeats; i += 1) {
      const result = await world.service.requestPurchase(purchaseRequest(key));
      if (result.kind === 'REFUSED') {
        reasonCodes.add(result.reasonCode);
        break;
      }
      for (const code of result.outcome.reasonCodes) reasonCodes.add(code);
      if (!attempts.includes(result.authorizationId)) attempts.push(result.authorizationId);
    }
  }

  // ---- drive to capture, applying any drift in between -------------------
  for (const authorizationId of attempts) {
    if (!(await world.authorizePayer(authorizationId))) continue;

    for (const mutation of scenario.drift ?? []) world.catalog.apply(mutation);
    if (scenario.delaySeconds !== undefined) {
      world.clock.set(
        asTimestamp(
          new Date(
            Date.parse(START) + scenario.delaySeconds * 1_000,
          ).toISOString() as unknown as string,
        ),
      );
    }

    const captured = await world.service.requestCapture({
      sessionId,
      authorizationId,
      principal,
      idempotencyKey: nextKey('cap'),
    });
    if (captured.kind === 'REFUSED') reasonCodes.add(captured.reasonCode);
    else for (const code of captured.outcome.reasonCodes) reasonCodes.add(code);

    if (scenario.behaviour.kind === 'BUY_TWICE') {
      // Retry the capture too: exactly-once must hold on both gates.
      const again = await world.service.requestCapture({
        sessionId,
        authorizationId,
        principal,
        idempotencyKey: nextKey('cap'),
      });
      if (again.kind === 'DECIDED') {
        for (const code of again.outcome.reasonCodes) reasonCodes.add(code);
      }
    }
  }

  const agenticContextRecorded =
    attempts.length > 0 &&
    (await world.evidence.listByChain(attempts[0]!)).some(e => e.kind === 'AGENT_CONTEXT');

  return finish(world, scenario, {
    reasonCodes,
    agentSteps,
    agentRefusedSteps,
    agenticContextRecorded,
  });
}

async function finish(
  world: World,
  scenario: AgentScenario,
  extra: {
    reasonCodes: Set<string>;
    agentSteps: number;
    agentRefusedSteps: number;
    agenticContextRecorded: boolean;
  },
): Promise<AgentScenarioResult> {
  const sessions = [...world.sessions.rows.values()];
  const spentMinor = sessions.reduce((sum, s) => sum + s.spentMinor, 0);
  const releases = world.releases.rows.size;
  const captures = world.providerCaptures;

  let evidenceChainValid = true;
  for (const authorization of world.authorizations.rows.values()) {
    const verification = await world.evidence.verifyChain(authorization.authorizationId);
    if (!verification.valid) evidenceChainValid = false;
  }

  const outcome: AgentScenarioOutcome = {
    moneyMoved: captures > 0 && spentMinor > 0,
    providerCaptures: captures,
    releases,
    spentMinor,
    reasonCodes: [...extra.reasonCodes].sort(),
    evidenceChainValid,
    agenticContextRecorded: extra.agenticContextRecorded,
    agentSteps: extra.agentSteps,
    agentRefusedSteps: extra.agentRefusedSteps,
  };

  const mismatch = compare(scenario, outcome);
  return { scenario, outcome, asExpected: mismatch === null, mismatch };
}

/**
 * Compares an outcome against what the scenario declared.
 *
 * The reason-code check matters as much as the verdict: a scenario that was
 * refused for an unrelated reason would pass a verdict-only assertion while
 * hiding the very regression it exists to catch.
 */
function compare(scenario: AgentScenario, outcome: AgentScenarioOutcome): string | null {
  const problems: string[] = [];

  if (outcome.moneyMoved !== scenario.expect.moneyMoved) {
    problems.push(
      `moneyMoved ${String(outcome.moneyMoved)}, expected ${String(scenario.expect.moneyMoved)}`,
    );
  }
  if (outcome.providerCaptures !== scenario.expect.providerCaptures) {
    problems.push(
      `providerCaptures ${String(outcome.providerCaptures)}, expected ${String(
        scenario.expect.providerCaptures,
      )}`,
    );
  }
  if (scenario.expect.releases !== undefined && outcome.releases !== scenario.expect.releases) {
    problems.push(
      `releases ${String(outcome.releases)}, expected ${String(scenario.expect.releases)}`,
    );
  }
  if (
    scenario.expect.spentMinor !== undefined &&
    outcome.spentMinor !== scenario.expect.spentMinor
  ) {
    problems.push(
      `spentMinor ${String(outcome.spentMinor)}, expected ${String(scenario.expect.spentMinor)}`,
    );
  }
  if (scenario.expect.anyReasonCode !== undefined) {
    const matched = scenario.expect.anyReasonCode.some(code => outcome.reasonCodes.includes(code));
    if (!matched) {
      problems.push(
        `none of [${scenario.expect.anyReasonCode.join(', ')}] appeared; saw [${outcome.reasonCodes.join(
          ', ',
        )}]`,
      );
    }
  }
  if (!outcome.evidenceChainValid) problems.push('an evidence chain failed verification');

  return problems.length === 0 ? null : problems.join('; ');
}

function emptyOutcome(): AgentScenarioOutcome {
  return {
    moneyMoved: false,
    providerCaptures: 0,
    releases: 0,
    spentMinor: 0,
    reasonCodes: [],
    evidenceChainValid: true,
    agenticContextRecorded: false,
    agentSteps: 0,
    agentRefusedSteps: 0,
  };
}

export async function runAllAgentScenarios(): Promise<readonly AgentScenarioResult[]> {
  const results: AgentScenarioResult[] = [];
  for (const scenario of AGENT_SCENARIOS) {
    results.push(await runAgentScenario(scenario));
  }
  return results;
}
