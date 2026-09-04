/**
 * Fake-versus-Postgres behavioural parity.
 *
 * Every case here runs the *same operation sequence* against the in-memory
 * repositories and against real Postgres, and asserts the two produce the same
 * observable result. The point is not coverage. It is to close the specific
 * failure that already happened once in this repository: Postgres enforced a
 * constraint the fake did not model, the offline suite stayed green, and
 * security reasoning quietly came to rest on the fake.
 *
 * A case that passes here means an offline test exercising that sequence proves
 * something about production. A case that fails means the offline suite is
 * lying, and is a bug in the fake — or, occasionally, in the SQL.
 *
 * What is deliberately not attempted, because an in-process Map cannot do it
 * and pretending otherwise would be the very failure this file exists to catch:
 * process-restart durability, cross-process contention, and real transaction
 * isolation between connections. Those belong to `postgres.db.test.ts` and
 * `lifecycle.db.test.ts`, which assert them against Postgres alone.
 *
 * Opt in with:  pnpm db:up && pnpm test:db
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { asTimestamp, newEvaluationId, type ReleaseState } from '@capturelock/core';
import { Database } from '../src/index.js';
import {
  CONNECTION,
  T0,
  T1,
  T2,
  T3,
  authorization,
  authorizationId,
  evidenceShape,
  inboxRecord,
  memoryBackend,
  normalize,
  observe,
  policy,
  postgresBackend,
  release,
  releaseId,
  review,
  reviewId,
  seed,
  sha,
  snapshot,
  snapshotId,
  truncate,
  type Backend,
} from './parity-harness.js';

let db: Database;

beforeAll(async () => {
  db = new Database({ connectionString: CONNECTION, max: 5 });
  await db.reset();
  await db.migrate();
}, 60_000);

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await truncate(db);
});

/**
 * Runs one sequence against both backends and asserts they agree.
 *
 * The memory backend is rebuilt per case; Postgres is truncated by the hook.
 * Both therefore start empty, which is what makes the two observation lists
 * comparable at all.
 */
async function parity(
  sequence: (backend: Backend) => Promise<unknown>,
): Promise<{ memory: unknown; postgres: unknown }> {
  const memory = await sequence(memoryBackend());
  const postgres = await sequence(postgresBackend(db));
  expect(normalize(postgres), 'postgres and memory disagree on observable behaviour').toEqual(
    normalize(memory),
  );
  return { memory: normalize(memory), postgres: normalize(postgres) };
}

// ================================================================= releases ==

describe('releases: the one-active-per-authorization constraint', () => {
  it('refuses a second live release for one authorization, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend, {
        authorizations: [1],
        snapshots: [
          [1, 1],
          [2, 1],
        ],
      });
      const first = await observe(() => backend.repos.releases.insert(release(1)));
      // Different release, different key, different snapshot — same mandate.
      const second = await observe(() =>
        backend.repos.releases.insert(
          release(2, { authorizationId: authorizationId(1), snapshotId: snapshotId(2) }),
        ),
      );
      return { first, second };
    });

    expect(memory).toMatchObject({
      first: { ok: { kind: 'INSERTED' } },
      second: { ok: { kind: 'AUTHORIZATION_BUSY' } },
    });
  });

  it('admits a new release once the first reaches a terminal state, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend, {
        authorizations: [1],
        snapshots: [
          [1, 1],
          [2, 1],
        ],
      });
      await backend.repos.releases.insert(release(1));
      await backend.repos.releases.transition(releaseId(1), ['DRAFT'], 'DENIED', {}, T1);
      const second = await observe(() =>
        backend.repos.releases.insert(
          release(2, { authorizationId: authorizationId(1), snapshotId: snapshotId(2) }),
        ),
      );
      const active = await observe(() =>
        backend.repos.releases.findActiveByAuthorization(authorizationId(1)),
      );
      return { second, activeReleaseId: (active as { ok: { releaseId?: string } }).ok?.releaseId };
    });

    expect(memory).toMatchObject({ second: { ok: { kind: 'INSERTED' } } });
  });

  it('reports a reused idempotency key ahead of a busy authorization, identically', async () => {
    // Both conditions hold at once. Which one the caller is told about decides
    // the reason code the agent receives, so the precedence has to match.
    const { memory } = await parity(async backend => {
      await seed(backend, {
        authorizations: [1],
        snapshots: [
          [1, 1],
          [2, 1],
        ],
      });
      await backend.repos.releases.insert(release(1));
      return observe(() =>
        backend.repos.releases.insert(
          release(2, {
            authorizationId: authorizationId(1),
            snapshotId: snapshotId(2),
            clientIdempotencyKey: release(1).clientIdempotencyKey,
          }),
        ),
      );
    });

    expect(memory).toMatchObject({
      ok: { kind: 'DUPLICATE_IDEMPOTENCY_KEY', existing: { releaseId: releaseId(1) } },
    });
  });
});

describe('releases: the uniqueness constraints that are not the active-release index', () => {
  /**
   * `receipt` is UNIQUE in the schema, and it is a security constraint: the
   * receipt is derived from (authorization, snapshot hash), so a duplicate one
   * means the same cart is about to be sent to the provider twice.
   */
  it('refuses a duplicate receipt, identically', async () => {
    await parity(async backend => {
      await seed(backend, {
        authorizations: [1, 2],
        snapshots: [
          [1, 1],
          [2, 2],
        ],
      });
      await backend.repos.releases.insert(release(1));
      const duplicate = await observe(() =>
        backend.repos.releases.insert(release(2, { receipt: release(1).receipt })),
      );
      const stored = await observe(() => backend.repos.releases.findByReceipt(release(1).receipt));
      return {
        duplicate,
        // Whatever the store decided, the receipt must still resolve to the
        // first release. A fake that overwrote its index would point at the
        // second and hand a later lookup the wrong release.
        resolvesTo: (stored as { ok: { releaseId?: string } }).ok?.releaseId,
      };
    });
  });

  /**
   * `provider_payment_id` is UNIQUE, and this is the constraint that stops two
   * releases claiming one payment. A webhook that named a payment already bound
   * elsewhere must not be able to bind it again.
   */
  it('refuses a provider payment id already held by another release, identically', async () => {
    await parity(async backend => {
      await seed(backend, {
        authorizations: [1, 2],
        snapshots: [
          [1, 1],
          [2, 2],
        ],
      });
      await backend.repos.releases.insert(release(1, { state: 'ORDER_CREATED' }));
      await backend.repos.releases.insert(release(2, { state: 'ORDER_CREATED' }));

      const first = await observe(() =>
        backend.repos.releases.transition(
          releaseId(1),
          ['ORDER_CREATED'],
          'PAYMENT_AUTHORIZED',
          { providerPaymentId: 'pay_shared' },
          T1,
        ),
      );
      const second = await observe(() =>
        backend.repos.releases.transition(
          releaseId(2),
          ['ORDER_CREATED'],
          'PAYMENT_AUTHORIZED',
          { providerPaymentId: 'pay_shared' },
          T2,
        ),
      );
      const owner = await observe(() =>
        backend.repos.releases.findByProviderPaymentId('pay_shared'),
      );
      const releaseTwo = await observe(() => backend.repos.releases.findById(releaseId(2)));
      return {
        firstBound: (first as { ok: { providerPaymentId?: string } }).ok?.providerPaymentId,
        second,
        ownerReleaseId: (owner as { ok: { releaseId?: string } }).ok?.releaseId,
        releaseTwoState: (releaseTwo as { ok: { state?: string } }).ok?.state,
      };
    });
  });

  it('refuses a provider order id already held by another release, identically', async () => {
    await parity(async backend => {
      await seed(backend, {
        authorizations: [1, 2],
        snapshots: [
          [1, 1],
          [2, 2],
        ],
      });
      await backend.repos.releases.insert(release(1, { state: 'VERIFIED' }));
      await backend.repos.releases.insert(release(2, { state: 'VERIFIED' }));
      await backend.repos.releases.transition(
        releaseId(1),
        ['VERIFIED'],
        'ORDER_CREATED',
        { providerOrderId: 'order_shared' },
        T1,
      );
      const second = await observe(() =>
        backend.repos.releases.transition(
          releaseId(2),
          ['VERIFIED'],
          'ORDER_CREATED',
          { providerOrderId: 'order_shared' },
          T2,
        ),
      );
      const owner = await observe(() =>
        backend.repos.releases.findByProviderOrderId('order_shared'),
      );
      return { second, ownerReleaseId: (owner as { ok: { releaseId?: string } }).ok?.releaseId };
    });
  });
});

describe('releases: compare-and-set semantics', () => {
  it('refuses a transition from a state not in the source list, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend);
      await backend.repos.releases.insert(release(1, { state: 'ORDER_CREATED' }));
      const wrong = await observe(() =>
        backend.repos.releases.transition(releaseId(1), ['DRAFT'], 'VERIFYING', {}, T1),
      );
      const right = await observe(() =>
        backend.repos.releases.transition(
          releaseId(1),
          ['ORDER_CREATED'],
          'PAYMENT_AUTHORIZED',
          {},
          T1,
        ),
      );
      const missing = await observe(() =>
        backend.repos.releases.transition(releaseId(99), ['DRAFT'], 'VERIFYING', {}, T1),
      );
      return { wrong, right, missing };
    });

    expect(memory).toMatchObject({ wrong: { ok: null }, missing: { ok: null } });
  });

  /**
   * Patch semantics are where a fake most easily drifts, because Postgres uses
   * `COALESCE` for some columns and a `CASE` for others, and those are not the
   * same rule. An omitted field must leave the column alone; `in_flight_since`
   * must additionally be clearable to null, which is how a release stops being
   * visible to the reconciliation sweep.
   */
  it('applies every patch field with the same rules, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend);
      await backend.repos.releases.insert(release(1, { state: 'VERIFIED' }));
      await backend.repos.releases.transition(
        releaseId(1),
        ['VERIFIED'],
        'ORDER_IN_FLIGHT',
        {
          providerOrderId: 'order_1',
          inFlightSince: T1,
          incrementAttempt: true,
          lastReasonCodes: ['A'],
        },
        T1,
      );
      // Omit everything: nothing may change but the state and updatedAt.
      const omitted = await observe(() =>
        backend.repos.releases.transition(
          releaseId(1),
          ['ORDER_IN_FLIGHT'],
          'ORDER_CREATED',
          {},
          T2,
        ),
      );
      // Explicit null on in_flight_since must clear it.
      const cleared = await observe(() =>
        backend.repos.releases.transition(
          releaseId(1),
          ['ORDER_CREATED'],
          'PAYMENT_AUTHORIZED',
          { inFlightSince: null, lastReasonCodes: [] },
          T3,
        ),
      );
      return { omitted, cleared };
    });

    expect(memory).toMatchObject({
      omitted: {
        ok: {
          providerOrderId: 'order_1',
          inFlightSince: T1,
          attemptCount: 1,
          lastReasonCodes: ['A'],
        },
      },
      cleared: { ok: { inFlightSince: null, providerOrderId: 'order_1', lastReasonCodes: [] } },
    });
  });
});

describe('releases: the sweep and queue queries', () => {
  const AGES: readonly [number, ReleaseState, string][] = [
    [11, 'ORDER_IN_FLIGHT', '2026-09-03T10:00:03.000Z'],
    [12, 'CAPTURE_INDETERMINATE', '2026-09-03T10:00:01.000Z'],
    [13, 'ORDER_INDETERMINATE', '2026-09-03T10:00:02.000Z'],
  ];

  /**
   * Ordering and the limit interact, and that interaction is the whole point.
   * A store that filters in insertion order and then truncates returns a
   * *different set* from one that orders first — so under a limit the sweeper
   * would pick up different work on the two backends.
   */
  it('returns reconciliation work oldest-first under a limit, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend, {
        authorizations: AGES.map(a => a[0]),
        snapshots: AGES.map(a => [a[0], a[0]] as [number, number]),
      });
      for (const [n, state, at] of AGES) {
        await backend.repos.releases.insert(
          release(n, { state, authorizationId: authorizationId(n), snapshotId: snapshotId(n) }),
        );
        await backend.repos.releases.transition(
          releaseId(n),
          [state],
          state,
          { inFlightSince: asTimestamp(at) },
          asTimestamp(at),
        );
      }
      const all = await backend.repos.releases.findRequiringReconciliation(T3, 10);
      const limited = await backend.repos.releases.findRequiringReconciliation(T3, 2);
      return {
        all: all.map(r => r.releaseId),
        limited: limited.map(r => r.releaseId),
      };
    });

    // Oldest in_flight_since first: 12 (…01), 13 (…02), 11 (…03).
    expect(memory).toEqual({
      all: [releaseId(12), releaseId(13), releaseId(11)],
      limited: [releaseId(12), releaseId(13)],
    });
  });

  it('returns abandoned transient releases oldest-first under a limit, identically', async () => {
    const rows: readonly [number, string][] = [
      [21, '2026-09-03T10:00:03.000Z'],
      [22, '2026-09-03T10:00:01.000Z'],
      [23, '2026-09-03T10:00:02.000Z'],
    ];
    const { memory } = await parity(async backend => {
      await seed(backend, {
        authorizations: rows.map(r => r[0]),
        snapshots: rows.map(r => [r[0], r[0]] as [number, number]),
      });
      for (const [n, at] of rows) {
        await backend.repos.releases.insert(
          release(n, {
            state: 'VERIFYING',
            authorizationId: authorizationId(n),
            snapshotId: snapshotId(n),
            updatedAt: asTimestamp(at),
          }),
        );
        await backend.repos.releases.transition(
          releaseId(n),
          ['VERIFYING'],
          'VERIFYING',
          {},
          asTimestamp(at),
        );
      }
      const all = await backend.repos.releases.findAbandonedInTransientState(T3, 10);
      const limited = await backend.repos.releases.findAbandonedInTransientState(T3, 2);
      return { all: all.map(r => r.releaseId), limited: limited.map(r => r.releaseId) };
    });

    expect(memory).toEqual({
      all: [releaseId(22), releaseId(23), releaseId(21)],
      limited: [releaseId(22), releaseId(23)],
    });
  });

  it('orders the operator queue identically, including on tied timestamps', async () => {
    const { memory } = await parity(async backend => {
      const ns = [31, 32, 33];
      await seed(backend, {
        authorizations: ns,
        snapshots: ns.map(n => [n, n] as [number, number]),
      });
      for (const n of ns) {
        await backend.repos.releases.insert(
          release(n, {
            state: 'PAUSED',
            authorizationId: authorizationId(n),
            snapshotId: snapshotId(n),
          }),
        );
        // Identical updatedAt for all three: the release id breaks the tie.
        await backend.repos.releases.transition(releaseId(n), ['PAUSED'], 'PAUSED', {}, T1);
      }
      const queue = await backend.repos.releases.listRequiringOperatorAttention(10);
      const limited = await backend.repos.releases.listRequiringOperatorAttention(2);
      return { queue: queue.map(r => r.releaseId), limited: limited.map(r => r.releaseId) };
    });

    expect(memory).toEqual({
      queue: [releaseId(31), releaseId(32), releaseId(33)],
      limited: [releaseId(31), releaseId(32)],
    });
  });
});

// ================================================================== reviews ==

describe('reviews', () => {
  /**
   * The exact shape of the defect that shipped.
   *
   * A release can pause twice, and the two stores disagreed about what happens
   * when a review id repeats: Postgres kept the original row, the fake replaced
   * it — destroying a resolved review's attribution, in a table that is part of
   * the audit record.
   */
  it('keeps the original row when a review id is reused, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend);
      await backend.repos.releases.insert(release(1, { state: 'PAUSED' }));
      await backend.repos.reviews.insert(review(1));
      await backend.repos.reviews.resolve(reviewId(1), 'APPROVED', 'operator_first', T1);

      const reinsert = await observe(() =>
        backend.repos.reviews.insert(
          review(1, { reasonCodes: ['SOMETHING_ELSE'], snapshotHash: sha('different') }),
        ),
      );
      const stored = await observe(() => backend.repos.reviews.findById(reviewId(1)));
      return { reinsert, stored };
    });

    expect(memory).toMatchObject({
      // The resolved review survives, with its operator attribution intact.
      stored: { ok: { state: 'APPROVED', resolvedBy: 'operator_first' } },
    });
  });

  it('refuses a second OPEN review for one release, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend);
      await backend.repos.releases.insert(release(1, { state: 'PAUSED' }));
      await backend.repos.reviews.insert(review(1));
      const second = await observe(() =>
        backend.repos.reviews.insert(review(1, { reviewId: reviewId(2) })),
      );
      const open = await observe(() => backend.repos.reviews.findOpenByRelease(releaseId(1)));
      return { second, openReviewId: (open as { ok: { reviewId?: string } }).ok?.reviewId };
    });

    expect(memory).toMatchObject({
      second: { refused: 'UNIQUE_VIOLATION:reviews_one_open_per_release' },
      openReviewId: reviewId(1),
    });
  });

  it('admits a new OPEN review once the previous one is resolved, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend);
      await backend.repos.releases.insert(release(1, { state: 'PAUSED' }));
      await backend.repos.reviews.insert(review(1));
      await backend.repos.reviews.resolve(reviewId(1), 'APPROVED', 'operator_one', T1);
      const second = await observe(() =>
        backend.repos.reviews.insert(
          review(1, { reviewId: reviewId(2), snapshotHash: sha('binding-capture') }),
        ),
      );
      const open = await observe(() => backend.repos.reviews.findOpenByRelease(releaseId(1)));
      return { second, openReviewId: (open as { ok: { reviewId?: string } }).ok?.reviewId };
    });

    expect(memory).toMatchObject({ second: { ok: null }, openReviewId: reviewId(2) });
  });

  it('resolves from OPEN once and refuses the second attempt, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend);
      await backend.repos.releases.insert(release(1, { state: 'PAUSED' }));
      await backend.repos.reviews.insert(review(1));
      const first = await observe(() =>
        backend.repos.reviews.resolve(reviewId(1), 'APPROVED', 'operator_one', T1),
      );
      // A second resolution must not be able to flip a decision.
      const second = await observe(() =>
        backend.repos.reviews.resolve(reviewId(1), 'REJECTED', 'operator_two', T2),
      );
      const stored = await observe(() => backend.repos.reviews.findById(reviewId(1)));
      return { first, second, stored };
    });

    expect(memory).toMatchObject({
      second: { ok: null },
      stored: { ok: { state: 'APPROVED', resolvedBy: 'operator_one' } },
    });
  });

  /**
   * The lookup the kernel consumes. An approval for one request must be
   * invisible to another — this is what stops a gate-1 approval clearing a
   * gate-2 pause.
   */
  it('finds an approval only under its own binding, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend);
      await backend.repos.releases.insert(release(1, { state: 'PAUSED' }));
      await backend.repos.reviews.insert(review(1, { snapshotHash: sha('order-gate') }));
      await backend.repos.reviews.resolve(reviewId(1), 'APPROVED', 'operator_one', T1);

      const own = await observe(() =>
        backend.repos.reviews.findApprovedByReleaseAndBinding(releaseId(1), sha('order-gate')),
      );
      const other = await observe(() =>
        backend.repos.reviews.findApprovedByReleaseAndBinding(releaseId(1), sha('capture-gate')),
      );
      return {
        ownReviewId: (own as { ok: { reviewId?: string } }).ok?.reviewId,
        other,
      };
    });

    expect(memory).toMatchObject({ ownReviewId: reviewId(1), other: { ok: null } });
  });

  it('never returns an OPEN or REJECTED review as an approval, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend);
      await backend.repos.releases.insert(release(1, { state: 'PAUSED' }));
      await backend.repos.reviews.insert(review(1, { snapshotHash: sha('b') }));
      const whileOpen = await observe(() =>
        backend.repos.reviews.findApprovedByReleaseAndBinding(releaseId(1), sha('b')),
      );
      await backend.repos.reviews.resolve(reviewId(1), 'REJECTED', 'operator_one', T1);
      const whenRejected = await observe(() =>
        backend.repos.reviews.findApprovedByReleaseAndBinding(releaseId(1), sha('b')),
      );
      return { whileOpen, whenRejected };
    });

    expect(memory).toEqual({ whileOpen: { ok: null }, whenRejected: { ok: null } });
  });

  it('lists open reviews oldest-first under a limit, identically', async () => {
    const { memory } = await parity(async backend => {
      const ns = [41, 42, 43];
      await seed(backend, {
        authorizations: ns,
        snapshots: ns.map(n => [n, n] as [number, number]),
      });
      const at = ['10:00:03', '10:00:01', '10:00:02'];
      for (const [index, n] of ns.entries()) {
        await backend.repos.releases.insert(
          release(n, {
            state: 'PAUSED',
            authorizationId: authorizationId(n),
            snapshotId: snapshotId(n),
          }),
        );
        await backend.repos.reviews.insert(
          review(n, {
            releaseId: releaseId(n),
            authorizationId: authorizationId(n),
            createdAt: asTimestamp(`2026-09-03T${at[index]!}.000Z`),
          }),
        );
      }
      const all = await backend.repos.reviews.listOpen(10);
      const limited = await backend.repos.reviews.listOpen(2);
      return { all: all.map(r => r.reviewId), limited: limited.map(r => r.reviewId) };
    });

    expect(memory).toEqual({
      all: [reviewId(42), reviewId(43), reviewId(41)],
      limited: [reviewId(42), reviewId(43)],
    });
  });
});

// ============================================================== evaluations ==

describe('evaluations', () => {
  function evaluation(n: number, evaluatedAt: string, gate: 'ORDER_CREATION' | 'CAPTURE') {
    return {
      evaluationId: `evl_${String(n).padStart(32, '0')}` as ReturnType<typeof newEvaluationId>,
      authorizationId: authorizationId(1),
      releaseId: releaseId(1),
      gate,
      decision: {
        verdict: gate === 'CAPTURE' ? ('DENY' as const) : ('ALLOW' as const),
        gate,
        evaluatedAt: asTimestamp(evaluatedAt),
        reasonCodes: gate === 'CAPTURE' ? ['LIVE_PRICE_DIVERGED'] : ['VERIFIED_MATCH'],
        findings: [],
        stages: [],
      } as never,
      contextHash: sha(`ctx-${String(n)}`),
      decisionHash: sha(`dec-${String(n)}`),
      evaluatedAt: asTimestamp(evaluatedAt),
    };
  }

  /**
   * Ordering here is not cosmetic. The console reads the last evaluation
   * recorded at each gate to decide which two verdicts it is contrasting, so a
   * store that returns them in a different order shows a different story.
   */
  it('lists evaluations oldest-first regardless of insertion order, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend);
      await backend.repos.releases.insert(release(1));
      // Appended out of chronological order on purpose.
      await backend.repos.evaluations.append(
        evaluation(2, '2026-09-03T10:00:02.000Z', 'CAPTURE') as never,
      );
      await backend.repos.evaluations.append(
        evaluation(1, '2026-09-03T10:00:01.000Z', 'ORDER_CREATION') as never,
      );
      const listed = await backend.repos.evaluations.listByRelease(releaseId(1));
      return listed.map(e => ({ id: e.evaluationId, gate: e.gate }));
    });

    expect(memory).toEqual([
      { id: `evl_${'1'.padStart(32, '0')}`, gate: 'ORDER_CREATION' },
      { id: `evl_${'2'.padStart(32, '0')}`, gate: 'CAPTURE' },
    ]);
  });

  it('refuses a duplicate evaluation id, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend);
      await backend.repos.releases.insert(release(1));
      await backend.repos.evaluations.append(
        evaluation(1, '2026-09-03T10:00:01.000Z', 'ORDER_CREATION') as never,
      );
      return observe(() =>
        backend.repos.evaluations.append(
          evaluation(1, '2026-09-03T10:00:09.000Z', 'CAPTURE') as never,
        ),
      );
    });

    expect(memory).toMatchObject({ refused: 'UNIQUE_VIOLATION:evaluations_pkey' });
  });

  it('round-trips a stored decision without losing its findings, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend);
      await backend.repos.releases.insert(release(1));
      const record = {
        ...evaluation(3, '2026-09-03T10:00:01.000Z', 'CAPTURE'),
        decision: {
          verdict: 'DENY',
          gate: 'CAPTURE',
          evaluatedAt: T0,
          reasonCodes: ['LIVE_PRICE_DIVERGED'],
          findings: [
            {
              code: 'LIVE_PRICE_DIVERGED',
              severity: 'DENY',
              stage: 'FRESHNESS',
              message: 'The live unit price is not the price this transaction would charge.',
              detail: {
                sku: 'SKU-A',
                liveUnitPriceMinor: 549_900,
                chargedUnitPriceMinor: 479_900,
                direction: 'INCREASED',
                nullable: null,
                flag: true,
              },
            },
          ],
          stages: [{ stage: 'FRESHNESS', status: 'COMPLETED', findingCount: 1 }],
        },
      };
      await backend.repos.evaluations.append(record as never);
      const listed = await backend.repos.evaluations.listByRelease(releaseId(1));
      return listed[0]?.decision;
    });

    // The finding detail is what the console renders as "what changed"; losing
    // a scalar type on the way through jsonb would silently change the story.
    expect(memory).toMatchObject({
      findings: [{ detail: { liveUnitPriceMinor: 549_900, flag: true, nullable: null } }],
    });
  });
});

// =========================================================== webhook inbox ==

describe('webhook inbox', () => {
  it('claims an event id exactly once, identically', async () => {
    const { memory } = await parity(async backend => {
      const first = await observe(() => backend.repos.webhookInbox.claim(inboxRecord('evt_1')));
      const second = await observe(() =>
        backend.repos.webhookInbox.claim(inboxRecord('evt_1', { eventType: 'payment.captured' })),
      );
      return { first, second };
    });

    expect(memory).toMatchObject({
      first: { ok: { kind: 'CLAIMED' } },
      // The duplicate is told about the ORIGINAL record, not its own.
      second: { ok: { kind: 'DUPLICATE', existing: { eventType: 'payment.authorized' } } },
    });
  });

  /**
   * `markProcessed` is called with a null release id on the paths where no
   * release matched. It must not use that null to erase a binding an earlier
   * call established — the release id on an inbox row is the only record of
   * which release an event was applied to.
   */
  it('does not let a null release id erase an existing binding, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend);
      await backend.repos.releases.insert(release(1));
      await backend.repos.webhookInbox.claim(inboxRecord('evt_2'));
      await backend.repos.webhookInbox.markProcessed('evt_2', 'PROCESSED', T1, releaseId(1));
      await backend.repos.webhookInbox.markProcessed('evt_2', 'FAILED', T2, null);
      const stored = await observe(() => backend.repos.webhookInbox.findByEventId('evt_2'));
      return stored;
    });

    expect(memory).toMatchObject({ ok: { status: 'FAILED', releaseId: releaseId(1) } });
  });

  it('ignores markProcessed for an unknown event, identically', async () => {
    const { memory } = await parity(async backend => {
      const marked = await observe(() =>
        backend.repos.webhookInbox.markProcessed('evt_missing', 'PROCESSED', T1, null),
      );
      const stored = await observe(() => backend.repos.webhookInbox.findByEventId('evt_missing'));
      return { marked, stored };
    });

    expect(memory).toMatchObject({ marked: { ok: null }, stored: { ok: null } });
  });

  it('round-trips a nested payload, identically', async () => {
    await parity(async backend => {
      await backend.repos.webhookInbox.claim(
        inboxRecord('evt_3', {
          payload: {
            event: 'payment.authorized',
            payload: { payment: { entity: { id: 'pay_1', amount: 494_900, notes: null } } },
            list: [1, 'two', false, null],
          },
        }),
      );
      const stored = await observe(() => backend.repos.webhookInbox.findByEventId('evt_3'));
      return stored;
    });
  });
});

// ================================================================ snapshots ==

describe('snapshots', () => {
  it('claims a snapshot for one release and refuses every other, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend, {
        authorizations: [1, 2],
        snapshots: [
          [1, 1],
          [2, 2],
        ],
      });
      await backend.repos.releases.insert(release(1));
      await backend.repos.releases.insert(release(2));

      const first = await observe(() =>
        backend.repos.snapshots.claimForRelease(snapshotId(1), releaseId(1)),
      );
      // Idempotent for the owner.
      const again = await observe(() =>
        backend.repos.snapshots.claimForRelease(snapshotId(1), releaseId(1)),
      );
      // Refused for anyone else: this is what stops one quote being paid twice.
      const other = await observe(() =>
        backend.repos.snapshots.claimForRelease(snapshotId(1), releaseId(2)),
      );
      const missing = await observe(() =>
        backend.repos.snapshots.claimForRelease(snapshotId(99), releaseId(1)),
      );
      return {
        firstState: (first as { ok: { state?: string } }).ok?.state,
        againOwner: (again as { ok: { redeemedByReleaseId?: string } }).ok?.redeemedByReleaseId,
        other,
        missing,
      };
    });

    expect(memory).toMatchObject({
      firstState: 'REDEEMED',
      againOwner: releaseId(1),
      other: { ok: null },
      missing: { ok: null },
    });
  });

  it('refuses a duplicate snapshot hash, identically', async () => {
    // `snapshot_hash` is UNIQUE: it is the content address of a priced cart, so
    // two rows sharing one would mean two snapshots claiming to be the same
    // quote.
    await parity(async backend => {
      await seed(backend, { authorizations: [1], snapshots: [[1, 1]] });
      return observe(() =>
        backend.repos.snapshots.insert({
          ...snapshot(2, 1),
          snapshotHash: snapshot(1).snapshotHash,
        }),
      );
    });
  });

  it('round-trips row hashes and money fields, identically', async () => {
    await parity(async backend => {
      await seed(backend, { authorizations: [1], snapshots: [] });
      await backend.repos.snapshots.insert(snapshot(1, 1));
      const stored = await observe(() => backend.repos.snapshots.findById(snapshotId(1)));
      return stored;
    });
  });
});

// =========================================================== authorizations ==

describe('authorizations', () => {
  it('compare-and-sets state and preserves omitted patch fields, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend, { authorizations: [1], snapshots: [] });
      const wrongFrom = await observe(() =>
        backend.repos.authorizations.transition(authorizationId(1), ['CONSUMED'], 'REVOKED', {}),
      );
      const consumed = await observe(() =>
        backend.repos.authorizations.transition(authorizationId(1), ['ACTIVE'], 'CONSUMED', {
          consumedByReleaseId: releaseId(1),
        }),
      );
      // An omitted patch field must not clear what a previous call set.
      const later = await observe(() =>
        backend.repos.authorizations.transition(authorizationId(1), ['CONSUMED'], 'REVOKED', {}),
      );
      const missing = await observe(() =>
        backend.repos.authorizations.transition(authorizationId(9), ['ACTIVE'], 'CONSUMED', {}),
      );
      return { wrongFrom, consumed, later, missing };
    });

    expect(memory).toMatchObject({
      wrongFrom: { ok: null },
      consumed: { ok: { state: 'CONSUMED', consumedByReleaseId: releaseId(1) } },
      later: { ok: { state: 'REVOKED', consumedByReleaseId: releaseId(1) } },
      missing: { ok: null },
    });
  });

  it('refuses a duplicate authorization id, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend, { authorizations: [1], snapshots: [] });
      return observe(() => backend.repos.authorizations.insert(authorization(1)));
    });

    expect(memory).toMatchObject({ refused: 'UNIQUE_VIOLATION:authorizations_pkey' });
  });
});

// ================================================================= policies ==

describe('policies', () => {
  /**
   * A policy is bound to an authorization by hash at issuance, and the kernel
   * refuses when the loaded document no longer hashes to that value. Whether a
   * re-insert under the same id and version replaces the stored rules therefore
   * decides whether that check ever fires — a store that silently accepted a
   * substitution would be the substitution.
   */
  it('keeps the original document when the same version is inserted twice, identically', async () => {
    const { memory } = await parity(async backend => {
      await backend.repos.policies.insert(policy());
      await backend.repos.policies.insert(
        policy({
          rules: [
            {
              ruleId: 'raised_ceiling',
              kind: 'MAX_TOTAL',
              description: 'substituted',
              severity: 'DENY',
              max: { currency: 'INR', amountMinor: 99_999_999 },
            },
          ] as never,
        }),
      );
      const stored = await backend.repos.policies.findByIdAndVersion('parity_policy', '1.0.0');
      return { ruleCount: stored?.rules.length ?? -1 };
    });

    expect(memory).toEqual({ ruleCount: 0 });
  });
});

// ================================================================= evidence ==

describe('evidence', () => {
  it('numbers and links a chain identically', async () => {
    const { memory } = await parity(async backend => {
      const chainId = authorizationId(1);
      for (const kind of ['DECISION', 'PROVIDER_OUTCOME', 'WEBHOOK'] as const) {
        await backend.repos.evidence.append({
          chainId,
          kind,
          recordedAt: T1,
          body: { kind, nested: { a: 1, b: null }, list: [1, 'two', false] },
        });
      }
      const listed = await backend.repos.evidence.listByChain(chainId);
      const head = await backend.repos.evidence.head(chainId);
      const verification = await backend.repos.evidence.verifyChain(chainId);
      return {
        shape: evidenceShape(listed as never),
        headSequence: head?.sequence,
        headIsLast: head?.chainHash === listed[listed.length - 1]?.chainHash,
        valid: verification.valid,
        defects: verification.defects.length,
        verifiedCount: verification.verifiedCount,
      };
    });

    expect(memory).toMatchObject({
      headSequence: 2,
      headIsLast: true,
      valid: true,
      defects: 0,
      verifiedCount: 3,
    });
  });

  it('reports an empty chain identically', async () => {
    const { memory } = await parity(async backend => {
      const chainId = authorizationId(7);
      const listed = await backend.repos.evidence.listByChain(chainId);
      const head = await backend.repos.evidence.head(chainId);
      const verification = await backend.repos.evidence.verifyChain(chainId);
      return { count: listed.length, head, valid: verification.valid };
    });

    expect(memory).toEqual({ count: 0, head: null, valid: true });
  });

  /**
   * A body has to survive the round trip byte-for-byte in the sense the chain
   * hash cares about, because verification recomputes that hash from what came
   * back out. Postgres stores `jsonb`, which normalises key order and drops
   * `undefined`; if the fake returned the original object instead, an offline
   * test could verify a chain that production could not.
   */
  it('verifies a chain after a round trip through storage, identically', async () => {
    const { memory } = await parity(async backend => {
      const chainId = authorizationId(1);
      await backend.repos.evidence.append({
        chainId,
        kind: 'DECISION',
        recordedAt: T1,
        body: {
          zeta: 'last key alphabetically',
          alpha: 'first',
          nested: { deep: { deeper: [1, 2, { three: null }] } },
          numeric: 494_900,
          negative: -1,
          bool: false,
        },
      });
      const verification = await backend.repos.evidence.verifyChain(chainId);
      const listed = await backend.repos.evidence.listByChain(chainId);
      return {
        valid: verification.valid,
        defects: verification.defects.map(d => d.kind),
        body: normalize(listed[0]?.body),
      };
    });

    expect(memory).toMatchObject({ valid: true, defects: [] });
  });

  it('detects a chain that does not end at an expected head, identically', async () => {
    const { memory } = await parity(async backend => {
      const chainId = authorizationId(1);
      await backend.repos.evidence.append({
        chainId,
        kind: 'DECISION',
        recordedAt: T1,
        body: { a: 1 },
      });
      const wrongHead = await backend.repos.evidence.verifyChain(chainId, sha('not-the-head'));
      return { valid: wrongHead.valid, defects: wrongHead.defects.map(d => d.kind) };
    });

    expect(memory).toEqual({ valid: false, defects: ['HEAD_MISMATCH'] });
  });
});

// ============================================================= transactions ==

describe('the unit of work', () => {
  /**
   * A rolled-back transaction must leave nothing behind on either backend.
   * The fake achieves this by snapshotting its maps rather than by being a real
   * transaction, which is a legitimate difference in mechanism — but the
   * observable result has to be the same, because the release service relies on
   * evidence and the state change it justifies committing together.
   */
  it('leaves no partial state after a rollback, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend);
      const failed = await observe(async () =>
        backend.unitOfWork.withTransaction(async repos => {
          await repos.releases.insert(release(1));
          await repos.evidence.append({
            chainId: authorizationId(1),
            kind: 'DECISION',
            recordedAt: T1,
            body: { rolled: 'back' },
          });
          throw new Error('deliberate rollback');
        }),
      );
      const stored = await backend.repos.releases.findById(releaseId(1));
      const envelopes = await backend.repos.evidence.listByChain(authorizationId(1));
      return { failed, release: stored, envelopeCount: envelopes.length };
    });

    expect(memory).toMatchObject({
      failed: { refused: 'OTHER: deliberate rollback' },
      release: null,
      envelopeCount: 0,
    });
  });

  it('commits both the release and its evidence together, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend);
      await backend.unitOfWork.withTransaction(async repos => {
        await repos.releases.insert(release(1));
        await repos.evidence.append({
          chainId: authorizationId(1),
          kind: 'DECISION',
          recordedAt: T1,
          body: { committed: true },
        });
      });
      const stored = await backend.repos.releases.findById(releaseId(1));
      const envelopes = await backend.repos.evidence.listByChain(authorizationId(1));
      return { releaseState: stored?.state, envelopeCount: envelopes.length };
    });

    expect(memory).toEqual({ releaseState: 'DRAFT', envelopeCount: 1 });
  });
});

// ============================================================== concurrency ==

describe('concurrency', () => {
  /**
   * Ten simultaneous attempts to spend one mandate.
   *
   * Postgres decides this with a partial unique index across connections; the
   * fake decides it by performing its read and write in one synchronous block.
   * The mechanisms are not comparable and are not meant to be. The *outcome* is:
   * exactly one caller may be told INSERTED.
   */
  it('admits exactly one release per authorization under contention, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend, {
        authorizations: [1],
        snapshots: Array.from({ length: 10 }, (_, i) => [100 + i, 1] as [number, number]),
      });
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          observe(() =>
            backend.repos.releases.insert(
              release(100 + i, {
                authorizationId: authorizationId(1),
                snapshotId: snapshotId(100 + i),
              }),
            ),
          ),
        ),
      );
      const kinds = results.map(
        r => (r as { ok?: { kind: string }; refused?: string }).ok?.kind ?? 'REFUSED',
      );
      return {
        inserted: kinds.filter(k => k === 'INSERTED').length,
        busy: kinds.filter(k => k === 'AUTHORIZATION_BUSY').length,
      };
    });

    expect(memory).toEqual({ inserted: 1, busy: 9 });
  });

  it('lets exactly one caller win a compare-and-set, identically', async () => {
    const { memory } = await parity(async backend => {
      await seed(backend);
      await backend.repos.releases.insert(release(1, { state: 'CAPTURE_APPROVED' }));
      const attempts = await Promise.all(
        [1, 2, 3].map(() =>
          backend.repos.releases.transition(
            releaseId(1),
            ['CAPTURE_APPROVED'],
            'CAPTURE_IN_FLIGHT',
            { inFlightSince: T1 },
            T1,
          ),
        ),
      );
      return { winners: attempts.filter(a => a !== null).length };
    });

    expect(memory).toEqual({ winners: 1 });
  });

  it('claims one webhook event once under simultaneous delivery, identically', async () => {
    const { memory } = await parity(async backend => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () => backend.repos.webhookInbox.claim(inboxRecord('evt_race'))),
      );
      return { claimed: results.filter(r => r.kind === 'CLAIMED').length };
    });

    expect(memory).toEqual({ claimed: 1 });
  });

  it('never forks an evidence chain under concurrent appends, identically', async () => {
    const { memory } = await parity(async backend => {
      const chainId = authorizationId(1);
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          backend.repos.evidence.append({
            chainId,
            kind: 'DECISION',
            recordedAt: T1,
            body: { n: i },
          }),
        ),
      );
      const listed = await backend.repos.evidence.listByChain(chainId);
      const verification = await backend.repos.evidence.verifyChain(chainId);
      return {
        sequences: listed.map(e => e.sequence),
        valid: verification.valid,
      };
    });

    expect(memory).toEqual({ sequences: [0, 1, 2, 3, 4], valid: true });
  });
});

// ================================================= what the fake cannot model ==

/**
 * Constraints Postgres enforces that the in-memory store deliberately does not,
 * asserted against Postgres alone.
 *
 * These are not parity failures. Referential integrity across tables is a
 * property of a relational store, and building a foreign-key graph into a set
 * of `Map`s would be reimplementing a database in a test double — the cost is
 * real and the benefit is not, because every production write goes through a
 * service that has already resolved the parent row.
 *
 * They are recorded here so the boundary is explicit and checked, rather than
 * being an unstated assumption. If a future service writes a child row without
 * resolving its parent, the offline suite will pass and this will not.
 */
describe('constraints only Postgres enforces', () => {
  it('refuses a release whose authorization does not exist', async () => {
    const backend = postgresBackend(db);
    await backend.repos.policies.insert(policy());
    const result = await observe(() =>
      backend.repos.releases.insert(release(1, { authorizationId: authorizationId(404) })),
    );
    expect(result).toMatchObject({ refused: 'FOREIGN_KEY_VIOLATION' });

    // And the in-memory store accepts it, which is the documented difference.
    const fake = memoryBackend();
    await expect(
      fake.repos.releases.insert(release(1, { authorizationId: authorizationId(404) })),
    ).resolves.toMatchObject({ kind: 'INSERTED' });
  });

  it('refuses an authorization whose policy version does not exist', async () => {
    const backend = postgresBackend(db);
    const result = await observe(() => backend.repos.authorizations.insert(authorization(1)));
    expect(result).toMatchObject({ refused: 'FOREIGN_KEY_VIOLATION' });
  });

  it('refuses an UPDATE against the append-only evidence table', async () => {
    const backend = postgresBackend(db);
    await backend.repos.policies.insert(policy());
    await backend.repos.authorizations.insert(authorization(1));
    await backend.repos.evidence.append({
      chainId: authorizationId(1),
      kind: 'DECISION',
      recordedAt: T1,
      body: { a: 1 },
    });
    await expect(
      db.query(`UPDATE evidence_envelopes SET payload = '{"a":2}'::jsonb`),
    ).rejects.toThrow(/append-only/);
  });
});
