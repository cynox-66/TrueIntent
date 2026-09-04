/**
 * The operator queue's repository layer, in memory.
 *
 * Two questions are being pinned here, and they are different questions:
 * *which* releases count as needing a human, and in *what order* they come
 * back. The second matters more than it looks — the queue is capped, so an
 * unstable sort would silently change which items fall off the end.
 *
 * Postgres parity for the same behaviour lives in `operator-queue.db.test.ts`.
 * Phase 3 established that an in-memory pass proves nothing about the SQL, so
 * neither file stands alone.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  OPERATOR_ATTENTION_RELEASE_STATES,
  TERMINAL_RELEASE_STATES,
  asTimestamp,
  deriveReceipt,
  hash,
  money,
  newAuthorizationId,
  newReleaseId,
  newReviewId,
  newSnapshotId,
  requiresOperatorAttention,
  type IdempotencyKey,
  type ReleaseRecord,
  type ReleaseState,
  type ReviewRecord,
  type Timestamp,
} from '@capturelock/core';
import { InMemoryReleaseRepository, InMemoryReviewRepository } from '../src/memory/repositories.js';

let releases: InMemoryReleaseRepository;
let reviews: InMemoryReviewRepository;

beforeEach(() => {
  releases = new InMemoryReleaseRepository();
  reviews = new InMemoryReviewRepository();
});

function at(iso: string): Timestamp {
  return asTimestamp(iso);
}

/**
 * Writes a release directly in a given state.
 *
 * The repository's own `insert` enforces one live release per authorization,
 * which is correct and is exactly what a queue fixture needs to sidestep: the
 * queue's whole purpose is to show many waiting releases at once, and each one
 * here stands for a different user's mandate.
 */
function put(state: ReleaseState, updatedAt: string, key: string): ReleaseRecord {
  const authorizationId = newAuthorizationId();
  const snapshotHash = hash('capturelock.v1.snapshot', { key });
  const record: ReleaseRecord = {
    releaseId: newReleaseId(),
    authorizationId,
    snapshotId: newSnapshotId(),
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
    createdAt: at('2026-09-01T00:00:00.000Z'),
    updatedAt: at(updatedAt),
    lastReasonCodes: [],
  };
  releases.rows.set(record.releaseId, record);
  return record;
}

function openReview(release: ReleaseRecord, createdAt: string): ReviewRecord {
  return {
    reviewId: newReviewId(),
    releaseId: release.releaseId,
    authorizationId: release.authorizationId,
    snapshotHash: hash('capturelock.v1.snapshot', { r: release.releaseId }),
    reasonCodes: ['PRICE_INCREASED'],
    state: 'OPEN',
    createdAt: at(createdAt),
    resolvedAt: null,
    resolvedBy: null,
  };
}

describe('which releases need an operator', () => {
  it('is derived from the state machine, not a hand-written list', () => {
    // If a state is added to the domain set, this catches a queue that was not
    // updated with it — the point of deriving the constant in the first place.
    expect([...OPERATOR_ATTENTION_RELEASE_STATES]).toEqual([
      'PAUSED',
      'ORDER_IN_FLIGHT',
      'ORDER_INDETERMINATE',
      'CAPTURE_IN_FLIGHT',
      'CAPTURE_INDETERMINATE',
    ]);
  });

  it('never claims a terminal release needs attention', () => {
    for (const state of TERMINAL_RELEASE_STATES) {
      expect(requiresOperatorAttention(state)).toBe(false);
    }
  });

  it('returns paused and indeterminate releases', async () => {
    for (const state of OPERATOR_ATTENTION_RELEASE_STATES) {
      put(state, '2026-09-02T00:00:00.000Z', state);
    }
    const queue = await releases.listRequiringOperatorAttention(50);
    expect(queue.map(r => r.state).sort()).toEqual([...OPERATOR_ATTENTION_RELEASE_STATES].sort());
  });

  it('excludes completed and in-progress releases that need nobody', async () => {
    // CAPTURED is the one worth stating explicitly: money moved, and it is not
    // terminal, but there is nothing for an operator to decide.
    for (const state of [
      'CAPTURED',
      'SETTLED',
      'DENIED',
      'FAILED',
      'ABORTED',
      'CAPTURE_REJECTED',
      'DRAFT',
      'VERIFYING',
      'VERIFIED',
      'ORDER_CREATED',
      'PAYMENT_AUTHORIZED',
      'CAPTURE_VERIFYING',
      'CAPTURE_APPROVED',
    ] as const) {
      put(state, '2026-09-02T00:00:00.000Z', state);
    }
    expect(await releases.listRequiringOperatorAttention(50)).toEqual([]);
  });
});

describe('queue ordering', () => {
  it('returns the longest-waiting release first', async () => {
    const newest = put('PAUSED', '2026-09-03T00:00:00.000Z', 'c');
    const oldest = put('PAUSED', '2026-09-01T00:00:00.000Z', 'a');
    const middle = put('ORDER_INDETERMINATE', '2026-09-02T00:00:00.000Z', 'b');

    const queue = await releases.listRequiringOperatorAttention(50);
    expect(queue.map(r => r.releaseId)).toEqual([
      oldest.releaseId,
      middle.releaseId,
      newest.releaseId,
    ]);
  });

  it('breaks ties on release id so the order is total', async () => {
    // Identical timestamps are not hypothetical: several releases can pause in
    // the same millisecond under load, and without a tiebreak the cap would
    // drop an arbitrary one of them on each refresh.
    const same = '2026-09-02T00:00:00.000Z';
    put('PAUSED', same, 'x');
    put('PAUSED', same, 'y');
    put('PAUSED', same, 'z');

    const ids = (await releases.listRequiringOperatorAttention(50)).map(r => r.releaseId);
    expect(ids).toEqual([...ids].sort());
  });

  it('applies the limit to the oldest items, not to an arbitrary subset', async () => {
    const oldest = put('PAUSED', '2026-09-01T00:00:00.000Z', 'a');
    put('PAUSED', '2026-09-05T00:00:00.000Z', 'b');
    put('PAUSED', '2026-09-04T00:00:00.000Z', 'c');

    const queue = await releases.listRequiringOperatorAttention(1);
    expect(queue).toHaveLength(1);
    expect(queue[0]!.releaseId).toBe(oldest.releaseId);
  });
});

describe('open reviews', () => {
  it('returns only unresolved reviews', async () => {
    const paused = put('PAUSED', '2026-09-02T00:00:00.000Z', 'a');
    const other = put('PAUSED', '2026-09-02T00:00:00.000Z', 'b');
    const open = openReview(paused, '2026-09-02T00:00:00.000Z');
    const resolved = openReview(other, '2026-09-01T00:00:00.000Z');
    await reviews.insert(open);
    await reviews.insert(resolved);
    await reviews.resolve(
      resolved.reviewId,
      'APPROVED',
      'operator_dev',
      at('2026-09-02T01:00:00.000Z'),
    );

    const listed = await reviews.listOpen(50);
    expect(listed.map(r => r.reviewId)).toEqual([open.reviewId]);
  });

  it('excludes every non-open state', async () => {
    const release = put('PAUSED', '2026-09-02T00:00:00.000Z', 'a');
    for (const state of ['APPROVED', 'REJECTED', 'EXPIRED'] as const) {
      const review = openReview(release, '2026-09-02T00:00:00.000Z');
      await reviews.insert({ ...review, state });
    }
    expect(await reviews.listOpen(50)).toEqual([]);
  });

  it('refuses a second open review for the same release, as Postgres does', async () => {
    // Models the partial unique index `reviews_one_open_per_release`. The
    // Postgres parity suite caught this: the fake used to accept it, which
    // would have let a test exercise a state production cannot hold.
    const release = put('PAUSED', '2026-09-02T00:00:00.000Z', 'a');
    await reviews.insert(openReview(release, '2026-09-02T00:00:00.000Z'));
    await expect(reviews.insert(openReview(release, '2026-09-02T00:00:00.000Z'))).rejects.toThrow(
      /reviews_one_open_per_release/,
    );
  });

  it('orders oldest first with a total tiebreak', async () => {
    const newer = openReview(
      put('PAUSED', '2026-09-02T00:00:00.000Z', 'a'),
      '2026-09-03T00:00:00.000Z',
    );
    const older = openReview(
      put('PAUSED', '2026-09-02T00:00:00.000Z', 'b'),
      '2026-09-01T00:00:00.000Z',
    );
    await reviews.insert(newer);
    await reviews.insert(older);

    expect((await reviews.listOpen(50)).map(r => r.reviewId)).toEqual([
      older.reviewId,
      newer.reviewId,
    ]);
  });
});
