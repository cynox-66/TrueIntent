/**
 * End-to-end harness: a complete TrueIntent wired to in-memory stores, a
 * deterministic clock, a scripted merchant catalogue and the fake provider.
 *
 * Everything is real except the two edges. The kernel, the release service, the
 * state machine, the evidence ledger and the repositories are the production
 * code paths; only the merchant and the payment provider are doubles, and both
 * reproduce the semantics of the systems they stand in for.
 */

import {
  DEFAULT_KERNEL_CONFIG,
  AuthorizationService,
  GuardedPaymentExecutor,
  paymentReaderOf,
  QuoteService,
  ReconciliationService,
  ReleaseService,
  ReviewService,
  WebhookService,
  type PaymentDependencies,
} from '../src/index.js';
import {
  FixedClock,
  asTimestamp,
  money,
  type AuthorizedIntent,
  type CartAdjustment,
  type IdempotencyKey,
  type IntentConstraints,
  type MerchantId,
  type Sku,
  type UserId,
} from '@capturelock/core';
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
import { createSigner, createVerifier, generateEvidenceKeyPair } from '@capturelock/evidence';
import {
  FakeMerchantCatalog,
  FakePaymentProvider,
  type CatalogItemSpec,
} from '@capturelock/integrations';

export const START = asTimestamp('2026-09-03T10:00:00.000Z');
export const MERCHANT = 'merchant_alpha' as MerchantId;
export const SKU = 'SKU-BLK-RUN-42' as Sku;
export const USER = 'user_priya' as UserId;
export const SESSION = 'sess_01';
export const inr = (minor: number) => money('INR', minor);

export const DEFAULT_ITEM: CatalogItemSpec = {
  sku: SKU,
  name: 'Trailblaze Runner',
  category: 'footwear',
  attributes: [
    { name: 'colour', value: 'black' },
    { name: 'size', value: 'UK9' },
  ],
  unitPriceMinor: 479_900,
  availableStock: 12,
};

export const DEFAULT_FEES: CartAdjustment[] = [
  { type: 'SHIPPING', label: 'Standard delivery', amount: inr(15_000) },
];

export function defaultConstraints(): IntentConstraints {
  return {
    currency: 'INR',
    maxTotal: inr(500_000),
    maxUnitPrice: inr(500_000),
    quantity: { min: 1, max: 1 },
    allowedCategories: ['footwear'],
    forbiddenCategories: [],
    requiredAttributes: [{ name: 'colour', anyOf: ['black'] }],
    forbiddenAttributes: [{ name: 'colour', anyOf: ['white'] }],
    merchants: { mode: 'ALLOWLIST', merchantIds: [MERCHANT] },
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
    notAfter: asTimestamp('2026-09-03T12:00:00.000Z'),
  };
}

export function defaultPolicy(): PolicyDocument {
  return {
    policyId: 'household_default',
    version: '1.0.0',
    name: 'Household default policy',
    createdAt: asTimestamp('2026-09-01T00:00:00.000Z'),
    rules: [
      {
        ruleId: 'max_total',
        kind: 'MAX_TOTAL',
        description: 'Operator spend ceiling',
        severity: 'DENY',
        max: inr(500_000),
      },
      {
        ruleId: 'merchant_allowlist',
        kind: 'MERCHANT_ALLOWLIST',
        description: 'Approved merchants only',
        severity: 'DENY',
        merchantIds: [MERCHANT],
      },
      {
        ruleId: 'no_subscriptions',
        kind: 'FORBID_SUBSCRIPTION',
        description: 'One-time purchases only',
        severity: 'DENY',
      },
    ],
  };
}

export interface HarnessOptions {
  readonly items?: readonly CatalogItemSpec[];
  readonly fees?: readonly CartAdjustment[];
  readonly constraints?: Partial<IntentConstraints>;
  readonly policy?: PolicyDocument;
  readonly maxAttemptsInWindow?: number;
}

export class Harness {
  readonly clock: FixedClock;
  readonly catalog: FakeMerchantCatalog;
  readonly provider: FakePaymentProvider;
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

  readonly authorizationService: AuthorizationService;
  readonly quoteService: QuoteService;
  readonly releaseService: ReleaseService;
  readonly webhookService: WebhookService;
  readonly reconciliationService: ReconciliationService;
  readonly reviewService: ReviewService;

  readonly keys = generateEvidenceKeyPair();
  readonly policyDocument: PolicyDocument;
  private readonly constraints: IntentConstraints;

  constructor(options: HarnessOptions = {}) {
    this.clock = new FixedClock(START);
    this.catalog = new FakeMerchantCatalog({
      merchantId: MERCHANT,
      currency: 'INR',
      items: options.items ?? [DEFAULT_ITEM],
      fees: options.fees ?? DEFAULT_FEES,
      clock: () => this.clock.now(),
    });
    this.provider = new FakePaymentProvider({ clock: () => this.clock.now() });
    this.evidence = new InMemoryEvidenceLedger(
      createSigner(this.keys.privateKeyPkcs8Base64),
      createVerifier(this.keys.publicKeySpkiBase64),
    );

    this.policyDocument = options.policy ?? defaultPolicy();
    this.constraints = { ...defaultConstraints(), ...options.constraints };

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
      config: {
        ...DEFAULT_KERNEL_CONFIG,
        maxAttemptsInWindow:
          options.maxAttemptsInWindow ?? DEFAULT_KERNEL_CONFIG.maxAttemptsInWindow,
      },
      merchant: this.catalog,
    };

    this.authorizationService = new AuthorizationService(this.deps);
    this.quoteService = new QuoteService(this.deps);
    this.releaseService = new ReleaseService(this.deps);
    this.webhookService = new WebhookService(this.deps);
    this.reconciliationService = new ReconciliationService(this.deps);
    this.reviewService = new ReviewService(this.deps);
  }

  intent(): AuthorizedIntent {
    return {
      rawText: 'Find me the cheapest pair of black running shoes under 5,000 rupees.',
      constraints: this.constraints,
      normalization: { method: 'LLM_ASSISTED', modelId: 'test-normalizer', confirmedByUser: true },
    };
  }

  principal(): { userId: UserId; sessionId: string } {
    return { userId: USER, sessionId: SESSION };
  }

  key(value: string): IdempotencyKey {
    return `idem-${value.padEnd(12, '0')}` as IdempotencyKey;
  }

  /** Creates the policy and an active authorization, returning its id. */
  async setup(): Promise<string> {
    await this.policies.insert(this.policyDocument);
    const created = await this.authorizationService.create({
      userId: USER,
      sessionId: SESSION,
      intent: this.intent(),
      policyId: this.policyDocument.policyId,
      policyVersion: this.policyDocument.version,
    });
    if (created.kind !== 'CREATED') throw new Error(`setup failed: ${created.kind}`);
    return created.authorization.authorizationId;
  }

  /** Issues a quote for a single unit of the default SKU. */
  async quote(authorizationId: string, quantity = 1): Promise<string> {
    const result = await this.quoteService.issue({
      authorizationId: authorizationId as never,
      merchantId: MERCHANT,
      lines: [{ sku: SKU, quantity }],
      shipTo: { country: 'IN', region: null },
      recurring: false,
    });
    if (result.kind !== 'ISSUED') throw new Error(`quote failed: ${result.kind}`);
    return result.snapshot.snapshotId;
  }

  /** Runs authorization -> quote -> order creation, returning both ids. */
  async openOrder(idempotency = 'order1'): Promise<{
    authorizationId: string;
    snapshotId: string;
    releaseId: string;
  }> {
    const authorizationId = await this.setup();
    const snapshotId = await this.quote(authorizationId);
    const outcome = await this.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: this.key(idempotency),
      principal: this.principal(),
    });
    if (outcome.verdict !== 'ALLOW') {
      throw new Error(`order creation refused: ${outcome.reasonCodes.join(',')}`);
    }
    return { authorizationId, snapshotId, releaseId: outcome.releaseId! };
  }

  /** Simulates the payer authorizing the payment, as hosted checkout would. */
  async authorizePayment(releaseId: string): Promise<string> {
    const release = await this.releases.findById(releaseId as never);
    if (release === null || release.providerOrderId === null) {
      throw new Error('release has no provider order');
    }
    const payment = this.provider.seedAuthorizedPayment(release.providerOrderId, release.amount);
    const updated = await this.releases.transition(
      releaseId as never,
      ['ORDER_CREATED'],
      'PAYMENT_AUTHORIZED',
      { providerPaymentId: payment.paymentId },
      this.clock.now(),
    );
    if (updated === null) throw new Error('could not mark payment authorized');
    return payment.paymentId;
  }
}
