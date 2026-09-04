/**
 * A complete TrueIntent stack, driven programmatically.
 *
 * Unlike the in-process harness the 24-scenario evaluation uses, this builds the
 * *same object graph the API builds* — the same services, the same guarded
 * executor, the same unit of work — and can run against either Postgres or the
 * in-memory doubles. That matters: a scenario that only ever exercised
 * in-memory stores would not prove the end-to-end flow persists.
 *
 * The payer-authorizes step goes through the real webhook service with a real
 * signature, exactly as the API's simulation endpoint does. Nothing here
 * shortcuts the state machine.
 */

import { createHmac, randomUUID } from 'node:crypto';
import {
  asTimestamp,
  money,
  systemClock,
  type AuthorizedIntent,
  type CartAdjustment,
  type IdempotencyKey,
  type IntentConstraints,
  type MerchantId,
  type ReleaseId,
  type Sku,
  type UserId,
} from '@capturelock/core';
import {
  AuthorizationService,
  GuardedPaymentExecutor,
  QuoteService,
  ReconciliationService,
  ReleaseService,
  ReviewService,
  WebhookService,
  DEFAULT_KERNEL_CONFIG,
  paymentReaderOf,
  type CoreDependencies,
  type PaymentDependencies,
  type Repositories,
  type UnitOfWork,
} from '@capturelock/kernel';
import {
  createSigner,
  createVerifier,
  generateEvidenceKeyPair,
  type EvidenceKeyPair,
} from '@capturelock/evidence';
import {
  FakeMerchantCatalog,
  FakePaymentProvider,
  RazorpayWebhookVerifier,
  type CatalogItemSpec,
  type CatalogMutation,
} from '@capturelock/integrations';
import {
  Database,
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
  PostgresUnitOfWork,
  buildRepositories,
  runMigrations,
} from '@capturelock/persistence';
import type { PolicyDocument } from '@capturelock/policy';

export const MERCHANT = 'merchant_alpha' as MerchantId;
export const SKU_BLACK = 'SKU-BLK-RUN-42' as Sku;
export const SKU_WHITE = 'SKU-WHT-RUN-42' as Sku;
export const OTHER_MERCHANT = 'merchant_omega' as MerchantId;
const USER = 'user_priya' as UserId;
const SESSION = 'sess_01';
const WEBHOOK_SECRET = 'scenario_webhook_secret';
const inr = (amountMinor: number) => money('INR', amountMinor);

export const BLACK_SHOE: CatalogItemSpec = {
  sku: SKU_BLACK,
  name: 'Trailblaze Runner',
  category: 'footwear',
  attributes: [
    { name: 'colour', value: 'black' },
    { name: 'size', value: 'UK9' },
  ],
  unitPriceMinor: 479_900,
  availableStock: 12,
};

export const WHITE_SHOE: CatalogItemSpec = {
  ...BLACK_SHOE,
  sku: SKU_WHITE,
  name: 'Trailblaze Runner (White)',
  attributes: [{ name: 'colour', value: 'white' }],
  unitPriceMinor: 459_900,
};

export const STANDARD_FEES: CartAdjustment[] = [
  { type: 'SHIPPING', label: 'Standard delivery', amount: inr(15_000) },
];

export const POLICY: PolicyDocument = {
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
      ruleId: 'no_subscriptions',
      kind: 'FORBID_SUBSCRIPTION',
      description: 'One-time only',
      severity: 'DENY',
    },
  ],
};

/**
 * A policy whose spend ceiling pauses rather than denies.
 *
 * Every rule in `POLICY` is a DENY, so a release bound to it can only ever be
 * allowed or refused outright — the PAUSE path, and with it the entire operator
 * review flow, is unreachable. PAUSE severity is the one thing a policy author
 * may choose, precisely because the policy is server-side and bound at
 * issuance, so an agent cannot select it.
 */
export const REVIEW_POLICY: PolicyDocument = {
  policyId: 'household_review',
  version: '1.0.0',
  name: 'Household policy requiring review above a low ceiling',
  createdAt: asTimestamp('2026-09-01T00:00:00.000Z'),
  rules: [
    {
      ruleId: 'review_above_ceiling',
      kind: 'MAX_TOTAL',
      description: 'Spend above this ceiling needs a human',
      severity: 'PAUSE',
      max: inr(100_000),
    },
    {
      ruleId: 'merchant_allowlist',
      kind: 'MERCHANT_ALLOWLIST',
      description: 'Approved merchants',
      severity: 'DENY',
      merchantIds: [MERCHANT],
    },
  ],
};

export function constraints(overrides: Partial<IntentConstraints> = {}): IntentConstraints {
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
    maxSnapshotAgeSeconds: 300,
    notBefore: asTimestamp('2020-01-01T00:00:00.000Z'),
    notAfter: asTimestamp('2099-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

export interface StackOptions {
  readonly items?: readonly CatalogItemSpec[];
  readonly fees?: readonly CartAdjustment[];
  /** Postgres connection string. Omitted means in-memory doubles. */
  readonly databaseUrl?: string;
  /** Defaults to `POLICY`. The operator scenario binds to `REVIEW_POLICY`. */
  readonly policy?: PolicyDocument;
}

export class Stack {
  readonly catalog: FakeMerchantCatalog;
  readonly provider: FakePaymentProvider;
  readonly deps: PaymentDependencies;
  readonly authorizations: AuthorizationService;
  readonly quotes: QuoteService;
  readonly releases: ReleaseService;
  readonly reconciliation: ReconciliationService;
  readonly reviews: ReviewService;
  readonly webhooks: WebhookService;
  readonly keys: EvidenceKeyPair;
  readonly backend: 'postgres' | 'memory';
  private readonly webhookVerifier: RazorpayWebhookVerifier;
  private readonly db: Database | null;
  private readonly policy: PolicyDocument;

  private constructor(
    options: StackOptions,
    repositories: Repositories,
    unitOfWork: UnitOfWork,
    keys: EvidenceKeyPair,
    db: Database | null,
  ) {
    const clock = systemClock;
    this.keys = keys;
    this.db = db;
    this.backend = db === null ? 'memory' : 'postgres';

    this.catalog = new FakeMerchantCatalog({
      merchantId: MERCHANT,
      currency: 'INR',
      items: options.items ?? [BLACK_SHOE, WHITE_SHOE],
      fees: options.fees ?? STANDARD_FEES,
      clock: () => clock.now(),
    });
    this.provider = new FakePaymentProvider({ clock: () => clock.now() });
    this.webhookVerifier = new RazorpayWebhookVerifier(WEBHOOK_SECRET);

    const core: CoreDependencies = {
      ...repositories,
      clock,
      config: DEFAULT_KERNEL_CONFIG,
      unitOfWork,
      merchant: this.catalog,
    };
    this.deps = {
      ...core,
      paymentReader: paymentReaderOf(this.provider),
      paymentExecutor: new GuardedPaymentExecutor(this.provider, clock),
    };

    this.authorizations = new AuthorizationService(core);
    this.quotes = new QuoteService(core);
    this.releases = new ReleaseService(this.deps);
    this.reconciliation = new ReconciliationService({
      ...core,
      paymentReader: this.deps.paymentReader,
    });
    this.reviews = new ReviewService(core);
    this.webhooks = new WebhookService(core);
    this.policy = options.policy ?? POLICY;
  }

  static async create(options: StackOptions = {}): Promise<Stack> {
    const keys = generateEvidenceKeyPair();
    const signer = createSigner(keys.privateKeyPkcs8Base64);
    const verifier = createVerifier(keys.publicKeySpkiBase64);

    if (options.databaseUrl === undefined) {
      const stores = {
        authorizations: new InMemoryAuthorizationRepository(),
        snapshots: new InMemorySnapshotRepository(),
        releases: new InMemoryReleaseRepository(),
        evaluations: new InMemoryEvaluationRepository(),
        reviews: new InMemoryReviewRepository(),
        webhookInbox: new InMemoryWebhookInboxRepository(),
        policies: new InMemoryPolicyRepository(),
        evidence: new InMemoryEvidenceLedger(signer, verifier),
        sessions: new InMemorySessionAuthorityRepository(),
      };
      return new Stack(options, stores, new InMemoryUnitOfWork(stores), keys, null);
    }

    const db = new Database({ connectionString: options.databaseUrl });
    await runMigrations(db, migrationsDir());
    return new Stack(
      options,
      buildRepositories(db, signer, verifier, { ownsTransaction: true }),
      new PostgresUnitOfWork(db, signer, verifier),
      keys,
      db,
    );
  }

  async close(): Promise<void> {
    await this.db?.close();
  }

  intent(overrides: Partial<IntentConstraints> = {}): AuthorizedIntent {
    return {
      rawText: 'Find me the cheapest pair of black running shoes under 5,000 rupees.',
      constraints: constraints(overrides),
      normalization: { method: 'LLM_ASSISTED', modelId: 'scenario', confirmedByUser: true },
    };
  }

  principal(): { userId: UserId; sessionId: string } {
    return { userId: USER, sessionId: SESSION };
  }

  /**
   * A fresh idempotency key.
   *
   * Unique per call, because these scenarios may run repeatedly against a
   * shared Postgres database and a reused key would (correctly) be refused as
   * a replay of different input.
   */
  key(label: string): IdempotencyKey {
    return `idem-${label}-${randomUUID().replace(/-/g, '')}`.slice(0, 200) as IdempotencyKey;
  }

  async setup(overrides: Partial<IntentConstraints> = {}): Promise<string> {
    await this.deps.policies.insert(this.policy);
    const created = await this.authorizations.create({
      userId: USER,
      sessionId: SESSION,
      intent: this.intent(overrides),
      policyId: this.policy.policyId,
      policyVersion: this.policy.version,
    });
    if (created.kind !== 'CREATED') throw new Error(`setup failed: ${created.kind}`);
    return created.authorization.authorizationId;
  }

  async quote(
    authorizationId: string,
    spec: { sku?: Sku; quantity?: number; merchantId?: MerchantId } = {},
  ): Promise<string | { failed: string }> {
    const result = await this.quotes.issue({
      authorizationId: authorizationId as never,
      merchantId: spec.merchantId ?? MERCHANT,
      lines: [{ sku: spec.sku ?? SKU_BLACK, quantity: spec.quantity ?? 1 }],
      shipTo: { country: 'IN', region: null },
      recurring: false,
    });
    return result.kind === 'ISSUED' ? result.snapshot.snapshotId : { failed: result.kind };
  }

  /**
   * Delivers a genuinely signed `payment.authorized` webhook.
   *
   * The signature is real and the payload is Razorpay-shaped, so this runs the
   * production verification, deduplication and state-machine path rather than
   * writing `PAYMENT_AUTHORIZED` into the database directly.
   */
  async simulatePayerAuthorization(releaseId: string): Promise<string> {
    const release = await this.deps.releases.findById(releaseId as ReleaseId);
    if (release?.providerOrderId == null) throw new Error('release has no provider order');

    const payment = this.provider.seedAuthorizedPayment(release.providerOrderId, release.amount);
    const payload = {
      event: 'payment.authorized',
      payload: {
        payment: {
          entity: {
            id: payment.paymentId,
            order_id: release.providerOrderId,
            amount: release.amount.amountMinor,
            currency: release.amount.currency,
            status: 'authorized',
          },
        },
      },
    };
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');

    const verification = this.webhookVerifier.verify(raw, signature, {
      'x-razorpay-event-id': `evt_${payment.paymentId}`,
    });
    if (!verification.valid) throw new Error('scenario produced an invalid signature');

    const result = await this.webhooks.ingest({
      providerEventId: verification.eventId!,
      eventType: verification.eventType ?? 'unknown',
      signatureValid: true,
      payload,
      providerEventAt: null,
      paymentId: payment.paymentId,
      orderId: release.providerOrderId,
    });
    if (result.kind !== 'APPLIED') {
      throw new Error(`webhook was not applied: ${result.kind}`);
    }
    return payment.paymentId;
  }

  /**
   * Resolves the review currently open on a release, as the console does.
   *
   * Goes through `ReviewService`, so the state machine and the evidence append
   * are the production ones; only the HTTP layer that authenticates the
   * operator is absent, and that layer is tested separately.
   */
  async resolveOpenReview(
    releaseId: string,
    resolution: 'APPROVED' | 'REJECTED',
    operator: string,
  ): Promise<{ reviewId: string; state: string }> {
    const review = await this.deps.reviews.findOpenByRelease(releaseId as ReleaseId);
    if (review === null) throw new Error('no open review to resolve');
    const resolved = await this.reviews.resolve(review.reviewId, resolution, operator);
    if (resolved.kind !== 'RESOLVED') throw new Error(`resolve failed: ${resolved.kind}`);
    return { reviewId: review.reviewId, state: resolved.state };
  }

  drift(mutation: CatalogMutation): void {
    this.catalog.apply(mutation);
  }

  async chainValid(authorizationId: string): Promise<boolean> {
    return (await this.deps.evidence.verifyChain(authorizationId)).valid;
  }
}

function migrationsDir(): string {
  // Resolved from source: `tsc` does not copy .sql into dist.
  return new URL('../../../packages/persistence/src/postgres/migrations', import.meta.url).pathname;
}
