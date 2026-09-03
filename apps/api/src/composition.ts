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
  type MerchantStateProvider,
  type PaymentProvider,
} from '@capturelock/core';
import {
  AuthorizationService,
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
