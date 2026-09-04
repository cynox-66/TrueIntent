/**
 * Operator queue, against a real Postgres.
 *
 * The in-memory suite proves the intent; this proves the SQL. Phase 3 is the
 * reason both exist: a fake that agreed with our expectations while the real
 * thing disagreed is exactly how the capture-gate bypass stayed invisible.
 *
 * What only this file can establish: that `state = ANY($1)` binds the domain
 * constant correctly, that `ORDER BY updated_at, release_id` is stable when
 * timestamps collide, that the release/review relationship produces no
 * duplicate rows, and that NULL columns survive the round trip.
 *
 * Opt in with:  pnpm db:up && pnpm test:db
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  OPERATOR_ATTENTION_RELEASE_STATES,
  asTimestamp,
  deriveReceipt,
  hash,
  money,
  newAuthorizationId,
  newReleaseId,
  newReviewId,
  newSnapshotId,
  type AuthorizationId,
  type IdempotencyKey,
  type ReleaseRecord,
  type ReleaseState,
  type SnapshotId,
  type Timestamp,
} from '@capturelock/core';
import { Database } from '../src/postgres/client.js';
import { PostgresReleaseRepository } from '../src/postgres/release-repository.js';
import { PostgresReviewRepository } from '../src/postgres/simple-repositories.js';

const CONNECTION =
  process.env['DATABASE_URL'] ??
  'postgresql://capturelock:capturelock@localhost:5432/capturelock_dev';

let db: Database;
let releases: PostgresReleaseRepository;
let reviews: PostgresReviewRepository;

const AT = asTimestamp('2026-09-03T10:00:00.000Z');

beforeAll(async () => {
  db = new Database({ connectionString: CONNECTION, max: 5 });
  await db.reset();
  await db.migrate();
  releases = new PostgresReleaseRepository(db);
  reviews = new PostgresReviewRepository(db);
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.query(
    `TRUNCATE review_requests, webhook_inbox, evidence_envelopes, evaluations,
     releases, verified_snapshots, authorizations, policies CASCADE`,
  );
});

async function seedAuthorization(): Promise<AuthorizationId> {
  await db.query(
    `INSERT INTO policies (policy_id, version, name, rules, policy_hash, created_at)
     VALUES ('p','1.0.0','test','[]'::jsonb,$1,$2)
     ON CONFLICT DO NOTHING`,
    ['a'.repeat(64), AT],
  );
  const id = newAuthorizationId();
  await db.query(
    `INSERT INTO authorizations (
       authorization_id, user_id, session_id, raw_intent_text, constraints,
       normalization, intent_hash, policy_id, policy_version, policy_hash,
       state, created_at, updated_at
     ) VALUES ($1,'u','s','text','{}'::jsonb,'{}'::jsonb,$2,'p','1.0.0',$3,'ACTIVE',$4,$4)`,
    [id, 'b'.repeat(64), 'a'.repeat(64), AT],
  );
  return id;
}

async function seedSnapshot(authorizationId: AuthorizationId): Promise<SnapshotId> {
  const id = newSnapshotId();
  await db.query(
    `INSERT INTO verified_snapshots (
       snapshot_id, authorization_id, merchant_id, currency, cart,
       item_subtotal_minor, fee_total_minor, discount_total_minor, total_minor,
       row_hashes, live_state_digest, snapshot_hash, observed_at, expires_at, state
     ) VALUES ($1,$2,'m','INR','{}'::jsonb,479900,15000,0,494900,'{}'::jsonb,$3,$4,$5,$6,'ISSUED')`,
    [
      id,
      authorizationId,
      'c'.repeat(64),
      hash('capturelock.v1.snapshot', { id }),
      AT,
      asTimestamp('2026-09-03T10:00:30.000Z'),
    ],
  );
  return id;
}

/**
 * Inserts a release directly in a given state at a given `updated_at`.
 *
 * Written as raw SQL rather than through `insert` + `transition` because the
 * point is to control `updated_at` exactly — `transition` stamps its own, and
 * the ordering assertions need timestamps that collide on purpose.
 */
async function put(state: ReleaseState, updatedAt: Timestamp, key: string): Promise<ReleaseRecord> {
  const authorizationId = await seedAuthorization();
  const snapshotId = await seedSnapshot(authorizationId);
  const snapshotHash = hash('capturelock.v1.snapshot', { key });
  const record: ReleaseRecord = {
    releaseId: newReleaseId(),
    authorizationId,
    snapshotId,
    state,
    clientIdempotencyKey: `idem-${key.padEnd(12, '0')}` as IdempotencyKey,
    requestFingerprint: hash('capturelock.v1.request_fingerprint', { key }),
    receipt: deriveReceipt(authorizationId, snapshotHash),
    amount: money('INR', 494_900),
    currency: 'INR',
    providerOrderId: null,
    providerPaymentId: null,
    attemptCount: 0,
    inFlightSince: null,
    createdAt: AT,
    updatedAt,
    lastReasonCodes: [],
  };
  await db.query(
    `INSERT INTO releases (
       release_id, authorization_id, snapshot_id, state, client_idempotency_key,
       request_fingerprint, receipt, amount_minor, currency, attempt_count,
       last_reason_codes, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,494900,'INR',0,'[]'::jsonb,$8,$9)`,
    [
      record.releaseId,
      authorizationId,
      snapshotId,
      state,
      record.clientIdempotencyKey,
      record.requestFingerprint,
      record.receipt,
      AT,
      updatedAt,
    ],
  );
  return record;
}

describe('listRequiringOperatorAttention against Postgres', () => {
  it('returns every state the domain constant names, and nothing else', async () => {
    for (const state of OPERATOR_ATTENTION_RELEASE_STATES) {
      await put(state, AT, state);
    }
    // Terminal and healthy in-progress states must not appear.
    for (const state of ['CAPTURED', 'SETTLED', 'DENIED', 'FAILED', 'ORDER_CREATED'] as const) {
      await put(state, AT, state);
    }

    const queue = await releases.listRequiringOperatorAttention(50);
    expect(queue.map(r => r.state).sort()).toEqual([...OPERATOR_ATTENTION_RELEASE_STATES].sort());
  });

  it('orders longest-waiting first', async () => {
    const newest = await put('PAUSED', asTimestamp('2026-09-03T12:00:00.000Z'), 'c');
    const oldest = await put('PAUSED', asTimestamp('2026-09-03T08:00:00.000Z'), 'a');
    const middle = await put('CAPTURE_INDETERMINATE', asTimestamp('2026-09-03T10:00:00.000Z'), 'b');

    const queue = await releases.listRequiringOperatorAttention(50);
    expect(queue.map(r => r.releaseId)).toEqual([
      oldest.releaseId,
      middle.releaseId,
      newest.releaseId,
    ]);
  });

  it('is stable when updated_at collides, because release_id breaks the tie', async () => {
    // Without the secondary sort Postgres may return colliding rows in any
    // order, and the cap would then drop a different one on each refresh.
    for (const key of ['x', 'y', 'z', 'w']) await put('PAUSED', AT, key);

    const first = (await releases.listRequiringOperatorAttention(50)).map(r => r.releaseId);
    const second = (await releases.listRequiringOperatorAttention(50)).map(r => r.releaseId);
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort());
  });

  it('applies the limit after ordering, not before', async () => {
    const oldest = await put('PAUSED', asTimestamp('2026-09-03T08:00:00.000Z'), 'a');
    await put('PAUSED', asTimestamp('2026-09-03T09:00:00.000Z'), 'b');
    await put('PAUSED', asTimestamp('2026-09-03T11:00:00.000Z'), 'c');

    const queue = await releases.listRequiringOperatorAttention(1);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.releaseId).toBe(oldest.releaseId);
  });

  it('returns one row per release even when a release has several reviews', async () => {
    // Guards the shape of the composition: if this ever became a SQL join, a
    // release with a history of reviews would duplicate in the queue. Only one
    // may be OPEN at a time, so the earlier one is resolved first.
    const release = await put('PAUSED', AT, 'a');
    const first = newReviewId();
    await reviews.insert({
      reviewId: first,
      releaseId: release.releaseId,
      authorizationId: release.authorizationId,
      snapshotHash: hash('capturelock.v1.snapshot', { n: 1 }),
      reasonCodes: ['PRICE_INCREASED'],
      state: 'OPEN',
      createdAt: AT,
      resolvedAt: null,
      resolvedBy: null,
    });
    await reviews.resolve(first, 'REJECTED', 'operator_dev', AT);
    await reviews.insert({
      reviewId: newReviewId(),
      releaseId: release.releaseId,
      authorizationId: release.authorizationId,
      snapshotHash: hash('capturelock.v1.snapshot', { n: 2 }),
      reasonCodes: ['STOCK_CHANGED'],
      state: 'OPEN',
      createdAt: AT,
      resolvedAt: null,
      resolvedBy: null,
    });

    const queue = await releases.listRequiringOperatorAttention(50);
    expect(queue).toHaveLength(1);
  });

  it('refuses a second open review for the same release', async () => {
    // The partial unique index `reviews_one_open_per_release`. Two open reviews
    // would mean two live decisions for one release, and resolving either would
    // leave the other dangling.
    const release = await put('PAUSED', AT, 'a');
    const review = {
      releaseId: release.releaseId,
      authorizationId: release.authorizationId,
      snapshotHash: hash('capturelock.v1.snapshot', { r: release.releaseId }),
      reasonCodes: ['PRICE_INCREASED'],
      state: 'OPEN' as const,
      createdAt: AT,
      resolvedAt: null,
      resolvedBy: null,
    };
    await reviews.insert({ ...review, reviewId: newReviewId() });
    await expect(reviews.insert({ ...review, reviewId: newReviewId() })).rejects.toThrow(
      /reviews_one_open_per_release/,
    );
  });

  it('round-trips nullable provider columns as null', async () => {
    await put('ORDER_INDETERMINATE', AT, 'a');
    const [row] = await releases.listRequiringOperatorAttention(50);
    expect(row!.providerOrderId).toBeNull();
    expect(row!.providerPaymentId).toBeNull();
    expect(row!.inFlightSince).toBeNull();
  });

  it('returns an empty list rather than failing when nothing is waiting', async () => {
    expect(await releases.listRequiringOperatorAttention(50)).toEqual([]);
  });
});

describe('listOpen against Postgres', () => {
  it('returns open reviews and excludes resolved ones', async () => {
    const a = await put('PAUSED', AT, 'a');
    const b = await put('PAUSED', AT, 'b');
    const open = newReviewId();
    const resolved = newReviewId();

    for (const [reviewId, release] of [
      [open, a],
      [resolved, b],
    ] as const) {
      await reviews.insert({
        reviewId,
        releaseId: release.releaseId,
        authorizationId: release.authorizationId,
        snapshotHash: hash('capturelock.v1.snapshot', { reviewId }),
        reasonCodes: ['PRICE_INCREASED'],
        state: 'OPEN',
        createdAt: AT,
        resolvedAt: null,
        resolvedBy: null,
      });
    }
    await reviews.resolve(resolved, 'APPROVED', 'operator_dev', AT);

    const listed = await reviews.listOpen(50);
    expect(listed.map(r => r.reviewId)).toEqual([open]);
  });

  it('returns the latest approval for a binding, which the kernel consumes', async () => {
    // The kernel reads this to clear the pause findings a human accepted. If it
    // returned the wrong review — or an unresolved one — an approval would
    // either not apply or would apply the wrong reason codes.
    const release = await put('PAUSED', AT, 'a');
    const older = newReviewId();
    const newer = newReviewId();
    const binding = hash('capturelock.v1.snapshot', { r: release.releaseId });

    const base = {
      releaseId: release.releaseId,
      authorizationId: release.authorizationId,
      snapshotHash: binding,
      reasonCodes: ['TOTAL_EXCEEDS_LIMIT'],
      state: 'OPEN' as const,
      createdAt: AT,
      resolvedAt: null,
      resolvedBy: null,
    };

    await reviews.insert({ ...base, reviewId: older });
    await reviews.resolve(older, 'APPROVED', 'operator_one', AT);
    await reviews.insert({ ...base, reviewId: newer });
    await reviews.resolve(
      newer,
      'APPROVED',
      'operator_two',
      asTimestamp('2026-09-03T12:00:00.000Z'),
    );

    const found = await reviews.findApprovedByReleaseAndBinding(release.releaseId, binding);
    expect(found?.reviewId).toBe(newer);
    expect(found?.resolvedBy).toBe('operator_two');
  });

  it('never returns an approval bound to a different request', async () => {
    // Parity with the in-memory suite, and the property the kernel depends on:
    // a release that paused at both gates carries an approval per gate, and
    // each is visible only to the request it was given for.
    const release = await put('PAUSED', AT, 'binding');
    const orderBinding = hash('capturelock.v1.request_fingerprint', { gate: 'ORDER_CREATION' });
    const captureBinding = hash('capturelock.v1.request_fingerprint', { gate: 'CAPTURE' });
    const atOrderGate = newReviewId();

    await reviews.insert({
      reviewId: atOrderGate,
      releaseId: release.releaseId,
      authorizationId: release.authorizationId,
      snapshotHash: orderBinding,
      reasonCodes: ['TOTAL_EXCEEDS_LIMIT'],
      state: 'OPEN',
      createdAt: AT,
      resolvedAt: null,
      resolvedBy: null,
    });
    await reviews.resolve(atOrderGate, 'APPROVED', 'operator_one', AT);

    expect(
      (await reviews.findApprovedByReleaseAndBinding(release.releaseId, orderBinding))?.reviewId,
    ).toBe(atOrderGate);
    expect(
      await reviews.findApprovedByReleaseAndBinding(release.releaseId, captureBinding),
    ).toBeNull();
  });

  it('never returns an open or rejected review as an approval', async () => {
    const release = await put('PAUSED', AT, 'a');
    const rejected = newReviewId();
    await reviews.insert({
      reviewId: rejected,
      releaseId: release.releaseId,
      authorizationId: release.authorizationId,
      snapshotHash: hash('capturelock.v1.snapshot', { n: 1 }),
      reasonCodes: ['TOTAL_EXCEEDS_LIMIT'],
      state: 'OPEN',
      createdAt: AT,
      resolvedAt: null,
      resolvedBy: null,
    });
    // Still OPEN: not an approval.
    expect(
      await reviews.findApprovedByReleaseAndBinding(
        release.releaseId,
        hash('capturelock.v1.snapshot', { n: 1 }),
      ),
    ).toBeNull();

    await reviews.resolve(rejected, 'REJECTED', 'operator_dev', AT);
    // Rejected: emphatically not an approval.
    expect(
      await reviews.findApprovedByReleaseAndBinding(
        release.releaseId,
        hash('capturelock.v1.snapshot', { n: 1 }),
      ),
    ).toBeNull();
  });

  it('orders oldest first and stays stable on identical timestamps', async () => {
    // One release per review: only one review may be open per release.
    for (let i = 0; i < 4; i += 1) {
      const release = await put('PAUSED', AT, `r${i}`);
      await reviews.insert({
        reviewId: newReviewId(),
        releaseId: release.releaseId,
        authorizationId: release.authorizationId,
        snapshotHash: hash('capturelock.v1.snapshot', { i }),
        reasonCodes: ['PRICE_INCREASED'],
        state: 'OPEN',
        createdAt: AT,
        resolvedAt: null,
        resolvedBy: null,
      });
    }
    const first = (await reviews.listOpen(50)).map(r => r.reviewId);
    const second = (await reviews.listOpen(50)).map(r => r.reviewId);
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort());
  });
});
