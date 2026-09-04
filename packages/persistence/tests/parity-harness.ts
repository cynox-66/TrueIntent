/**
 * The parity harness: one operation sequence, two backends, one comparison.
 *
 * This exists because of a defect that actually shipped. Postgres carried a
 * constraint the in-memory double did not model, so the offline suite passed
 * while the real store rejected the write — and security reasoning had, without
 * anyone noticing, come to rest on the fake's behaviour rather than the
 * database's.
 *
 * The rule this harness enforces is not "the implementations are the same".
 * They are not, and should not be. It is:
 *
 *   For every operation sequence a caller can perform, the OBSERVABLE result
 *   is the same on both backends.
 *
 * Observable means what a caller can actually see: return values, the state
 * visible through subsequent reads, and whether an operation was refused.
 * Deliberately NOT observable, and therefore normalised away below:
 *
 *  - **Error types.** A driver raises a `DatabaseError`; the fake raises a
 *    `CaptureLockError`. Requiring identical classes would be requiring the
 *    fake to impersonate `pg`, which teaches nothing. What must match is
 *    *whether* the store refused, and on which kind of constraint.
 *  - **Generated identifiers.** Evidence envelope ids are minted per append, so
 *    the two backends necessarily produce different ones — and because the
 *    chain hash commits to the envelope id, different chain hashes too. What
 *    must match is the chain's *shape*: sequence numbering, prev-hash linkage,
 *    ordering, and whether it verifies.
 *  - **Key order in JSON.** Postgres `jsonb` does not preserve it.
 *
 * A case that cannot be expressed identically on both backends does not belong
 * here; it belongs in the Postgres suite with a note saying why. Faking a
 * process restart, for instance, is not something an in-process Map can do, and
 * pretending otherwise would be the exact failure this harness exists to catch.
 */

import { createHash } from 'node:crypto';
import { CaptureLockError } from '@capturelock/core';
import type {
  AuthorizationId,
  AuthorizationRecord,
  IdempotencyKey,
  Receipt,
  ReleaseId,
  ReleaseRecord,
  ReleaseState,
  ReviewId,
  ReviewRecord,
  Sha256Hex,
  SnapshotId,
  Timestamp,
  VerifiedSnapshot,
  WebhookInboxRecord,
} from '@capturelock/core';
import { asTimestamp, money } from '@capturelock/core';
import type { PolicyDocument } from '@capturelock/policy';
import type { Repositories } from '@capturelock/kernel';
import { createSigner, createVerifier, generateEvidenceKeyPair } from '@capturelock/evidence';
import { Database, isUniqueViolation } from '../src/index.js';
import {
  InMemoryAuthorizationRepository,
  InMemoryEvaluationRepository,
  InMemoryPolicyRepository,
  InMemoryReleaseRepository,
  InMemoryReviewRepository,
  InMemorySnapshotRepository,
  InMemoryUnitOfWork,
  InMemoryWebhookInboxRepository,
} from '../src/index.js';
import { InMemoryEvidenceLedger } from '../src/memory/ledger.js';
import { PostgresUnitOfWork, buildRepositories } from '../src/index.js';
import type { UnitOfWork } from '@capturelock/kernel';

export const CONNECTION =
  process.env['DATABASE_URL'] ??
  'postgresql://capturelock:capturelock@localhost:5432/capturelock_dev';

export const T0 = asTimestamp('2026-09-03T10:00:00.000Z');
export const T1 = asTimestamp('2026-09-03T10:01:00.000Z');
export const T2 = asTimestamp('2026-09-03T10:02:00.000Z');
export const T3 = asTimestamp('2026-09-03T10:03:00.000Z');

/**
 * Deterministic 64-hex value, so both backends receive byte-identical input.
 *
 * Hashed directly rather than through `hash()`, whose domain separators are a
 * closed union on purpose. Widening that union so a test fixture could join it
 * would weaken a production type to serve a test — and these values are opaque
 * to both stores anyway; only their stability matters.
 */
export function sha(seed: string): Sha256Hex {
  return createHash('sha256').update(`capturelock.parity:${seed}`).digest('hex') as Sha256Hex;
}

// --------------------------------------------------------------- fixtures --

export const POLICY_ID = 'parity_policy';
export const POLICY_VERSION = '1.0.0';

export function policy(overrides: Partial<PolicyDocument> = {}): PolicyDocument {
  return {
    policyId: POLICY_ID,
    version: POLICY_VERSION,
    name: 'Parity policy',
    createdAt: T0,
    rules: [],
    ...overrides,
  };
}

/**
 * Fixed identifiers.
 *
 * Every id in a parity case is fixed rather than generated, because the two
 * backends must receive byte-identical input for their outputs to be
 * comparable at all. Generated ids appear only where the *store* mints them.
 */
export function authorizationId(n: number): AuthorizationId {
  return `auth_${String(n).padStart(32, '0')}` as AuthorizationId;
}
export function snapshotId(n: number): SnapshotId {
  return `snap_${String(n).padStart(32, '0')}` as SnapshotId;
}
export function releaseId(n: number): ReleaseId {
  return `rel_${String(n).padStart(32, '0')}` as ReleaseId;
}
export function reviewId(n: number): ReviewId {
  return `rev_${String(n).padStart(32, '0')}` as ReviewId;
}

export function authorization(n: number): AuthorizationRecord {
  return {
    authorizationId: authorizationId(n),
    userId: 'user_parity' as AuthorizationRecord['userId'],
    sessionId: 'sess_parity',
    intent: {
      rawText: 'parity',
      // Only the fields the mappers touch; the rest is opaque JSON on both sides.
      constraints: {
        notBefore: T0,
        notAfter: asTimestamp('2099-01-01T00:00:00.000Z'),
      } as AuthorizationRecord['intent']['constraints'],
      normalization: { method: 'MANUAL', modelId: null, confirmedByUser: true },
    },
    intentHash: sha(`intent-${String(n)}`),
    policyId: POLICY_ID,
    policyVersion: POLICY_VERSION,
    policyHash: sha('policy'),
    state: 'ACTIVE',
    createdAt: T0,
    revokedAt: null,
    consumedByReleaseId: null,
  };
}

export function snapshot(n: number, forAuthorization = n): VerifiedSnapshot {
  return {
    snapshotId: snapshotId(n),
    authorizationId: authorizationId(forAuthorization),
    merchantId: 'merchant_alpha' as VerifiedSnapshot['merchantId'],
    currency: 'INR',
    cart: {
      merchantId: 'merchant_alpha',
      currency: 'INR',
      lines: [],
      adjustments: [],
      declaredTotal: money('INR', 494_900),
      recurring: false,
      shipTo: null,
    } as unknown as VerifiedSnapshot['cart'],
    itemSubtotal: money('INR', 479_900),
    feeTotal: money('INR', 15_000),
    discountTotal: money('INR', 0),
    total: money('INR', 494_900),
    rowHashes: new Map([['SKU-A' as never, sha(`row-${String(n)}`)]]),
    liveStateDigest: sha(`live-${String(n)}`),
    observedAt: T0,
    expiresAt: T3,
    snapshotHash: sha(`snapshot-${String(n)}`),
    state: 'ISSUED',
    redeemedByReleaseId: null,
  };
}

export function release(n: number, overrides: Partial<ReleaseRecord> = {}): ReleaseRecord {
  return {
    releaseId: releaseId(n),
    authorizationId: authorizationId(n),
    snapshotId: snapshotId(n),
    state: 'DRAFT',
    clientIdempotencyKey: `idem-parity-${String(n).padStart(12, '0')}` as IdempotencyKey,
    requestFingerprint: sha(`fingerprint-${String(n)}`),
    receipt: `cl_parity_receipt_${String(n).padStart(8, '0')}` as Receipt,
    amount: money('INR', 494_900),
    currency: 'INR',
    providerOrderId: null,
    providerPaymentId: null,
    attemptCount: 0,
    inFlightSince: null,
    createdAt: T0,
    updatedAt: T0,
    lastReasonCodes: [],
    ...overrides,
  };
}

export function review(n: number, overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    reviewId: reviewId(n),
    releaseId: releaseId(n),
    authorizationId: authorizationId(n),
    snapshotHash: sha(`binding-${String(n)}`),
    reasonCodes: ['TOTAL_EXCEEDS_LIMIT'],
    state: 'OPEN',
    createdAt: T0,
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

export function inboxRecord(
  eventId: string,
  overrides: Partial<WebhookInboxRecord> = {},
): WebhookInboxRecord {
  return {
    providerEventId: eventId,
    eventType: 'payment.authorized',
    payloadHash: sha(`payload-${eventId}`),
    payload: { event: 'payment.authorized', nested: { a: 1, b: null } },
    signatureValid: true,
    receivedAt: T0,
    processedAt: null,
    status: 'RECEIVED',
    releaseId: null,
    providerEventAt: null,
    ...overrides,
  };
}

// ------------------------------------------------------------- observation --

/**
 * How an operation was refused, in terms both backends can express.
 *
 * A driver error and a hand-rolled one carry different classes and different
 * messages; what a caller can actually act on is the *category*. Anything that
 * is not recognisably a constraint violation is reported as `OTHER` along with
 * its message, so an unexpected difference still fails loudly rather than being
 * flattened into a match.
 */
export function classifyError(error: unknown): string {
  // `pg` reports the offending index on the error; the fake carries the same
  // name in its details. Comparing that, rather than merely "something threw",
  // is what makes the assertion meaningful — two stores can both refuse a write
  // for entirely different reasons.
  const constraint =
    (error as { constraint?: unknown } | null)?.constraint ??
    (error instanceof CaptureLockError
      ? (error.details as { constraint?: unknown } | undefined)?.constraint
      : undefined);

  if (isUniqueViolation(error)) return `UNIQUE_VIOLATION:${String(constraint ?? 'unnamed')}`;
  if (error instanceof CaptureLockError && error.code === 'UNIQUE_VIOLATION') {
    return `UNIQUE_VIOLATION:${String(constraint ?? 'unnamed')}`;
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/violates foreign key constraint/.test(message)) return 'FOREIGN_KEY_VIOLATION';
  if (/violates check constraint/.test(message)) return 'CHECK_VIOLATION';
  return `OTHER: ${message}`;
}

/** Runs one operation and records either its value or how it was refused. */
export async function observe<T>(fn: () => Promise<T>): Promise<unknown> {
  try {
    return { ok: normalize(await fn()) };
  } catch (error) {
    return { refused: classifyError(error) };
  }
}

/**
 * Strips everything that is legitimately backend-specific.
 *
 * Object keys are sorted because `jsonb` does not preserve insertion order.
 * `Map` becomes a sorted entry list because that is how the Postgres mapper
 * rebuilds it. `undefined` is dropped, matching what `JSON.stringify` does on
 * the way into the database — which is itself worth knowing, and is asserted
 * directly by the evidence body case rather than hidden here.
 */
export function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([k, v]) => [String(k), normalize(v)] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, normalize(v)] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
    return Object.fromEntries(entries);
  }
  return value;
}

/** Evidence, compared by shape rather than by the ids and hashes it mints. */
export function evidenceShape(
  envelopes: readonly {
    sequence: number;
    prevChainHash: string;
    chainHash: string;
    kind: string;
    body: unknown;
  }[],
): unknown {
  return envelopes.map((envelope, index) => ({
    sequence: envelope.sequence,
    kind: envelope.kind,
    body: normalize(envelope.body),
    // Linkage, expressed without naming a hash: entry N's prev must be entry
    // N-1's own hash, and the first must start from genesis.
    linksToPrevious:
      index === 0
        ? envelope.prevChainHash === '0'.repeat(64)
        : envelope.prevChainHash === envelopes[index - 1]!.chainHash,
  }));
}

// ----------------------------------------------------------------- backends --

export interface Backend {
  readonly name: 'memory' | 'postgres';
  readonly repos: Repositories;
  readonly unitOfWork: UnitOfWork;
}

const KEYS = generateEvidenceKeyPair();

export function memoryBackend(): Backend {
  const signer = createSigner(KEYS.privateKeyPkcs8Base64);
  const verifier = createVerifier(KEYS.publicKeySpkiBase64);
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
  return { name: 'memory', repos: stores, unitOfWork: new InMemoryUnitOfWork(stores) };
}

export function postgresBackend(db: Database): Backend {
  const signer = createSigner(KEYS.privateKeyPkcs8Base64);
  const verifier = createVerifier(KEYS.publicKeySpkiBase64);
  return {
    name: 'postgres',
    repos: buildRepositories(db, signer, verifier, { ownsTransaction: true }),
    unitOfWork: new PostgresUnitOfWork(db, signer, verifier),
  };
}

export async function truncate(db: Database): Promise<void> {
  await db.query(
    `TRUNCATE idempotency_records, review_requests, webhook_inbox, evidence_envelopes,
     evaluations, releases, verified_snapshots, authorizations, policies CASCADE`,
  );
}

/**
 * Seeds the rows every case needs before it can insert a release.
 *
 * Not part of the comparison. Postgres has foreign keys from releases to
 * authorizations and snapshots, and from authorizations to policies; a case
 * that skipped this would be comparing "Postgres rejected on a foreign key"
 * against "the fake did not notice", which is a real divergence but a different
 * one, asserted on its own below rather than tripping every other case.
 */
export async function seed(
  backend: Backend,
  options: { authorizations?: readonly number[]; snapshots?: readonly [number, number][] } = {},
): Promise<void> {
  await backend.repos.policies.insert(policy());
  for (const n of options.authorizations ?? [1]) {
    await backend.repos.authorizations.insert(authorization(n));
  }
  for (const [snap, auth] of options.snapshots ?? [[1, 1]]) {
    await backend.repos.snapshots.insert(snapshot(snap, auth));
  }
}

export type ReleaseStateName = ReleaseState;
export type { Timestamp };
