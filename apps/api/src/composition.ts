/**
 * The composition root.
 *
 * This is the *only* module that constructs a payment provider, and it never
 * hands the raw provider to anything. It splits it into two halves and gives
 * each to exactly the service that needs it:
 *
 *   GuardedPaymentExecutor  → ReleaseService only. Every method requires an
 *                             ExecutionGrant, which only the kernel can mint,
 *                             and only for an ALLOW.
 *   PaymentReader           → ReconciliationService only. Read-only, so
 *                             unattended background work structurally cannot
 *                             capture.
 *
 * Everything else — quotes, webhooks, reviews, authorizations — receives
 * `CoreDependencies`, which has no provider field at all. Those services cannot
 * call a provider because they hold no reference to one. See ADR-012.
 */

import {
  systemClock,
  type Clock,
  type MerchantCatalogProvider,
  type MerchantStateProvider,
  type PaymentProvider,
} from '@capturelock/core';
import {
  AuthorizationService,
  CommerceSessionService,
  GuardedPaymentExecutor,
  QuoteService,
  ReconciliationService,
  ReleaseService,
  ReviewService,
  WebhookService,
  paymentReaderOf,
  type CoreDependencies,
  type KernelConfig,
  type PaymentDependencies,
  type Repositories,
  type UnitOfWork,
} from '@capturelock/kernel';
import {
  createSigner,
  createVerifier,
  generateEvidenceKeyPair,
  publicKeyFromPrivate,
  type EvidenceSigner,
  type EvidenceVerifier,
} from '@capturelock/evidence';
import {
  FakeMerchantCatalog,
  FakePaymentProvider,
  RazorpayTestClient,
  RazorpayWebhookVerifier,
} from '@capturelock/integrations';
import {
  Database,
  InMemoryAuthorizationRepository,
  InMemoryEvaluationRepository,
  InMemoryEvidenceLedger,
  InMemorySessionAuthorityRepository,
  InMemoryPolicyRepository,
  InMemoryReleaseRepository,
  InMemoryReviewRepository,
  InMemorySnapshotRepository,
  InMemoryUnitOfWork,
  InMemoryWebhookInboxRepository,
  PostgresUnitOfWork,
  buildRepositories,
} from '@capturelock/persistence';
import type { AppConfig } from './config.js';
import {
  InMemoryIdempotencyStore,
  PostgresIdempotencyStore,
  type IdempotencyStore,
} from './idempotency.js';

export interface Application {
  readonly config: AppConfig;
  readonly authorizationService: AuthorizationService;
  readonly quoteService: QuoteService;
  readonly releaseService: ReleaseService;
  readonly webhookService: WebhookService;
  readonly reconciliationService: ReconciliationService;
  readonly reviewService: ReviewService;
  /**
   * The agent-facing commerce layer.
   *
   * Holds issuer authority server-side so an agent never does, and reaches the
   * provider only through the release service's guarded executor. It receives
   * `PaymentDependencies` for that reason and no other — it mints no grant and
   * calls no provider itself.
   */
  readonly commerceSessionService: CommerceSessionService;
  /**
   * The buyer agent's view of the catalogue.
   *
   * The same instance the kernel reads live state from, exposed through its
   * browse interface. Two views of one store, which is what makes drift between
   * "what the agent saw" and "what the gate re-reads" genuine.
   */
  readonly productCatalog: MerchantCatalogProvider;
  readonly idempotency: IdempotencyStore;
  readonly evidenceVerifier: EvidenceVerifier;
  readonly evidencePublicKey: string;
  readonly webhookVerifier: RazorpayWebhookVerifier | null;
  readonly deps: CoreDependencies;
  /**
   * The catalogue, exposed for the demo seed and the scenario engine.
   *
   * Not reachable from any route: nothing in `server.ts` touches it.
   */
  readonly catalog: FakeMerchantCatalog;
  /**
   * The raw provider, exposed ONLY for the fake-provider simulation endpoint,
   * which is itself unreachable outside development. Route handlers receive
   * services, never this.
   */
  readonly rawProvider: PaymentProvider;
  readonly providerName: string;
  close(): Promise<void>;
}

function demoCatalog(clock: Clock): FakeMerchantCatalog {
  return new FakeMerchantCatalog({
    merchantId: 'merchant_alpha' as never,
    currency: 'INR',
    items: [
      {
        sku: 'SKU-BLK-RUN-42',
        name: 'Trailblaze Runner',
        category: 'footwear',
        attributes: [
          { name: 'colour', value: 'black' },
          { name: 'size', value: 'UK9' },
        ],
        unitPriceMinor: 479_900,
        availableStock: 12,
      },
      {
        sku: 'SKU-WHT-RUN-42',
        name: 'Trailblaze Runner (White)',
        category: 'footwear',
        attributes: [
          { name: 'colour', value: 'white' },
          { name: 'size', value: 'UK9' },
        ],
        unitPriceMinor: 459_900,
        availableStock: 5,
      },

      // ---------------------------------------------------------------------
      // Grocery lines, for the bounded buyer agent.
      //
      // Priced so the agentic demo's three scenes are all reachable against one
      // authority of 800 per purchase:
      //
      //   scene 1  curry kit 280 + rice 180 + tofu 120 + shipping 150 = 730
      //   scene 2  the curry kit moves 280 -> 340 between quote and capture
      //   scene 3  12 energy drinks at 50 + shipping = 750, numerically inside
      //            the ceiling and nowhere near a vegetarian Thai dinner
      //
      // Scene 3 is the one worth reading twice: it passes every arithmetic
      // check, and is refused on category. The numbers are chosen so that
      // "under budget" and "what the user asked for" genuinely come apart.
      {
        sku: 'SKU-THAI-CURRY-KIT',
        name: 'Thai Green Curry Kit',
        category: 'thai-meal-kit',
        attributes: [
          { name: 'diet', value: 'vegetarian' },
          { name: 'cuisine', value: 'thai' },
          { name: 'serves', value: '4' },
        ],
        unitPriceMinor: 28_000,
        availableStock: 20,
      },
      {
        sku: 'SKU-THAI-RICE-1KG',
        name: 'Jasmine Rice 1kg',
        category: 'groceries',
        attributes: [
          { name: 'diet', value: 'vegetarian' },
          { name: 'cuisine', value: 'thai' },
        ],
        unitPriceMinor: 18_000,
        availableStock: 40,
      },
      {
        sku: 'SKU-THAI-TOFU-400',
        name: 'Firm Tofu 400g',
        category: 'groceries',
        attributes: [
          { name: 'diet', value: 'vegetarian' },
          { name: 'protein', value: 'tofu' },
        ],
        unitPriceMinor: 12_000,
        availableStock: 25,
      },
      {
        sku: 'SKU-THAI-VEG-BOX',
        name: 'Thai Stir-fry Vegetable Box',
        category: 'groceries',
        attributes: [
          { name: 'diet', value: 'vegetarian' },
          { name: 'cuisine', value: 'thai' },
        ],
        unitPriceMinor: 15_000,
        availableStock: 30,
      },
      {
        // The intent-drift bait. Cheap enough that a naive optimiser reaches
        // for it, and in a category the user never authorized.
        sku: 'SKU-ENERGY-500',
        name: 'Voltz Energy Drink 500ml',
        category: 'beverages',
        attributes: [
          { name: 'caffeine', value: 'high' },
          { name: 'diet', value: 'vegetarian' },
        ],
        unitPriceMinor: 5_000,
        availableStock: 200,
      },
    ],
    fees: [
      {
        type: 'SHIPPING',
        label: 'Standard delivery',
        amount: { currency: 'INR', amountMinor: 15_000 },
      },
    ],
    clock: () => clock.now(),
  });
}

interface Persistence {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly idempotency: IdempotencyStore;
  close(): Promise<void>;
}

function inMemoryPersistence(signer: EvidenceSigner, verifier: EvidenceVerifier): Persistence {
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
  return {
    repositories: stores,
    unitOfWork: new InMemoryUnitOfWork(stores),
    idempotency: new InMemoryIdempotencyStore(),
    close: async () => undefined,
  };
}

function postgresPersistence(
  connectionString: string,
  signer: EvidenceSigner,
  verifier: EvidenceVerifier,
): Persistence {
  const db = new Database({ connectionString });
  return {
    // Pool-backed for reads outside a transaction. Writes that must be atomic
    // go through the unit of work, which rebinds every repository to one client.
    repositories: buildRepositories(db, signer, verifier, { ownsTransaction: true }),
    unitOfWork: new PostgresUnitOfWork(db, signer, verifier),
    idempotency: new PostgresIdempotencyStore(db),
    close: () => db.close(),
  };
}

export function buildApplication(config: AppConfig): Application {
  const clock = systemClock;

  const signingKey = config.evidenceSigningKey ?? generateEvidenceKeyPair().privateKeyPkcs8Base64;
  const publicKey = publicKeyFromPrivate(signingKey);
  const signer = createSigner(signingKey);
  const verifier = createVerifier(publicKey);

  const persistence =
    config.persistence === 'postgres'
      ? postgresPersistence(config.databaseUrl!, signer, verifier)
      : inMemoryPersistence(signer, verifier);

  const catalog = demoCatalog(clock);
  // Two views of one store. The kernel reads live state through `merchant`; the
  // buyer agent browses the same instance through its catalogue interface, so a
  // price the agent saw and a price the gate re-reads can genuinely disagree.
  const merchant: MerchantStateProvider = catalog;

  // The only construction site for a payment provider in the whole application.
  const rawProvider: PaymentProvider =
    config.paymentProvider === 'razorpay-test'
      ? new RazorpayTestClient({
          keyId: config.razorpayKeyId!,
          keySecret: config.razorpayKeySecret!,
          webhookSecret: config.razorpayWebhookSecret ?? 'unset',
          baseUrl: 'https://api.razorpay.com',
          timeoutMs: 10_000,
        })
      : new FakePaymentProvider({ clock: () => clock.now() });

  const kernelConfig: KernelConfig = {
    snapshotTtlSeconds: config.snapshotTtlSeconds,
    maxAttemptsInWindow: config.maxAttemptsInWindow,
    velocityWindowSeconds: config.velocityWindowSeconds,
    reconcileAfterSeconds: config.reconcileAfterSeconds,
    abandonTransientAfterSeconds: config.abandonTransientAfterSeconds,
    grantTtlSeconds: config.grantTtlSeconds,
    providerLookupConsistencySeconds: config.providerLookupConsistencySeconds,
  };

  const core: CoreDependencies = {
    ...persistence.repositories,
    clock,
    config: kernelConfig,
    unitOfWork: persistence.unitOfWork,
    merchant,
  };

  // Read-only half. Safe for unattended background work.
  const paymentReader = paymentReaderOf(rawProvider);
  // Write half. Every method demands a grant.
  const paymentExecutor = new GuardedPaymentExecutor(rawProvider, clock);

  const withPayments: PaymentDependencies = { ...core, paymentReader, paymentExecutor };

  return {
    config,
    // The only service that can move money, and only with a grant.
    releaseService: new ReleaseService(withPayments),
    // Reads provider state; structurally cannot capture.
    reconciliationService: new ReconciliationService({ ...core, paymentReader }),
    // Composed from the release service, so the agentic layer inherits every
    // check the two gates already make and cannot route around one.
    commerceSessionService: new CommerceSessionService(withPayments),
    productCatalog: catalog,
    // No provider reference of any kind.
    authorizationService: new AuthorizationService(core),
    quoteService: new QuoteService(core),
    webhookService: new WebhookService(core),
    reviewService: new ReviewService(core),
    idempotency: persistence.idempotency,
    evidenceVerifier: verifier,
    evidencePublicKey: publicKey,
    webhookVerifier:
      config.razorpayWebhookSecret === undefined
        ? null
        : new RazorpayWebhookVerifier(config.razorpayWebhookSecret),
    deps: core,
    catalog,
    rawProvider,
    providerName: rawProvider.name,
    close: () => persistence.close(),
  };
}
