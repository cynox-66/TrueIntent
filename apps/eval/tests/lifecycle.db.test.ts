/**
 * The persistent lifecycle, against real Postgres.
 *
 * These are the tests the in-memory doubles cannot honestly stand in for. They
 * exercise the *application* against real database constraints — the partial
 * unique index, compare-and-set under genuine contention, transaction rollback,
 * and recovery from a crash mid-sequence.
 *
 * Opt in with:  pnpm db:up && pnpm test:db
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Database, runMigrations } from '@capturelock/persistence';
import { Stack, SKU_BLACK } from '../src/e2e-harness.js';

const CONNECTION =
  process.env['DATABASE_URL'] ??
  'postgresql://capturelock:capturelock@localhost:5432/capturelock_dev';

const MIGRATIONS = new URL('../../../packages/persistence/src/postgres/migrations', import.meta.url)
  .pathname;

let admin: Database;

beforeAll(async () => {
  admin = new Database({ connectionString: CONNECTION });
  await admin.reset();
  await runMigrations(admin, MIGRATIONS);
}, 60_000);

afterAll(async () => {
  await admin.close();
});

beforeEach(async () => {
  await admin.query(
    `TRUNCATE idempotency_records, review_requests, webhook_inbox, evidence_envelopes,
     evaluations, releases, verified_snapshots, authorizations, policies CASCADE`,
  );
});

async function stack(): Promise<Stack> {
  return Stack.create({ databaseUrl: CONNECTION });
}

async function openOrder(s: Stack): Promise<{ auth: string; releaseId: string }> {
  const auth = await s.setup();
  const snapshot = await s.quote(auth);
  if (typeof snapshot !== 'string') throw new Error(`quote failed: ${snapshot.failed}`);
  const order = await s.releases.requestOrderCreation({
    authorizationId: auth as never,
    snapshotId: snapshot as never,
    idempotencyKey: s.key('order'),
    principal: s.principal(),
  });
  if (order.verdict !== 'ALLOW') throw new Error(`gate 1 refused: ${order.reasonCodes.join(',')}`);
  return { auth, releaseId: order.releaseId! };
}

describe('the full lifecycle persists', () => {
  it('carries a purchase from authorization to capture, all of it durable', async () => {
    const s = await stack();
    try {
      const { auth, releaseId } = await openOrder(s);
      await s.simulatePayerAuthorization(releaseId);

      const capture = await s.releases.requestCapture({
        releaseId: releaseId as never,
        idempotencyKey: s.key('cap'),
        principal: s.principal(),
      });
      expect(capture.verdict).toBe('ALLOW');
      expect(capture.state).toBe('CAPTURED');

      // Read it back through a fresh connection: this is what "persistent" means.
      const rows = await admin.query<{ state: string; provider_payment_id: string | null }>(
        'SELECT state, provider_payment_id FROM releases WHERE release_id = $1',
        [releaseId],
      );
      expect(rows[0]?.state).toBe('CAPTURED');
      expect(rows[0]?.provider_payment_id).not.toBeNull();

      const authRows = await admin.query<{ state: string }>(
        'SELECT state FROM authorizations WHERE authorization_id = $1',
        [auth],
      );
      expect(authRows[0]?.state).toBe('CONSUMED');
    } finally {
      await s.close();
    }
  });

  it('records an evaluation and evidence for every gate', async () => {
    const s = await stack();
    try {
      const { auth, releaseId } = await openOrder(s);
      await s.simulatePayerAuthorization(releaseId);
      await s.releases.requestCapture({
        releaseId: releaseId as never,
        idempotencyKey: s.key('cap'),
        principal: s.principal(),
      });

      const evals = await admin.query<{ gate: string; verdict: string }>(
        'SELECT gate, verdict FROM evaluations WHERE release_id = $1 ORDER BY evaluated_at',
        [releaseId],
      );
      expect(evals.map(e => e.gate)).toEqual(['ORDER_CREATION', 'CAPTURE']);
      expect(evals.every(e => e.verdict === 'ALLOW')).toBe(true);

      const envelopes = await admin.query<{ kind: string }>(
        'SELECT kind FROM evidence_envelopes WHERE chain_id = $1 ORDER BY sequence',
        [auth],
      );
      // Two decisions and two provider outcomes, plus the webhook.
      expect(envelopes.filter(e => e.kind === 'DECISION')).toHaveLength(2);
      expect(envelopes.filter(e => e.kind === 'PROVIDER_OUTCOME')).toHaveLength(2);
      expect(await s.chainValid(auth)).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe('the price-drift refusal never reaches the provider', () => {
  it('refuses at the capture gate and leaves no provider capture call', async () => {
    const s = await stack();
    try {
      const { auth, releaseId } = await openOrder(s);
      await s.simulatePayerAuthorization(releaseId);
      s.drift({ kind: 'SET_PRICE', sku: SKU_BLACK, unitPriceMinor: 549_900 });

      const capture = await s.releases.requestCapture({
        releaseId: releaseId as never,
        idempotencyKey: s.key('cap'),
        principal: s.principal(),
      });

      expect(capture.verdict).toBe('DENY');
      expect(capture.reasonCodes).toContain('LIVE_PRICE_DIVERGED');
      expect(s.provider.callCount('capturePayment')).toBe(0);
      expect(s.provider.capturedCount()).toBe(0);

      // The refusal is durable and explained.
      const rows = await admin.query<{ state: string; last_reason_codes: string[] }>(
        'SELECT state, last_reason_codes FROM releases WHERE release_id = $1',
        [releaseId],
      );
      expect(rows[0]?.state).toBe('DENIED');
      expect(rows[0]?.last_reason_codes).toContain('LIVE_PRICE_DIVERGED');

      // And the refusal itself is recorded as evidence.
      const evals = await admin.query<{ verdict: string }>(
        `SELECT verdict FROM evaluations WHERE release_id = $1 AND gate = 'CAPTURE'`,
        [releaseId],
      );
      expect(evals[0]?.verdict).toBe('DENY');
      expect(await s.chainValid(auth)).toBe(true);
    } finally {
      await s.close();
    }
  });
});

describe('concurrency, enforced by the database', () => {
  it('permits exactly one active release when ten requests race', async () => {
    const s = await stack();
    try {
      const auth = await s.setup();
      const snapshot = await s.quote(auth);
      if (typeof snapshot !== 'string') throw new Error('quote failed');

      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          s.releases.requestOrderCreation({
            authorizationId: auth as never,
            snapshotId: snapshot as never,
            idempotencyKey: s.key('race'),
            principal: s.principal(),
          }),
        ),
      );

      // The partial unique index decides this, not application logic.
      expect(results.filter(r => r.verdict === 'ALLOW')).toHaveLength(1);
      expect(s.provider.orderCount()).toBe(1);

      const count = await admin.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM releases
         WHERE authorization_id = $1
           AND state NOT IN ('SETTLED','DENIED','CAPTURE_REJECTED','FAILED','ABORTED')`,
        [auth],
      );
      expect(count[0]?.n).toBe('1');
    } finally {
      await s.close();
    }
  });

  it('lets exactly one of two concurrent captures cross the boundary', async () => {
    const s = await stack();
    try {
      const { releaseId } = await openOrder(s);
      await s.simulatePayerAuthorization(releaseId);

      const attempts = await Promise.all(
        [1, 2].map(() =>
          s.releases.requestCapture({
            releaseId: releaseId as never,
            idempotencyKey: s.key('cap'),
            principal: s.principal(),
          }),
        ),
      );

      expect(s.provider.callCount('capturePayment')).toBe(1);
      expect(s.provider.capturedCount()).toBe(1);
      expect(attempts.filter(a => a.verdict === 'ALLOW')).toHaveLength(1);

      // The loser is told it did not capture. Note what it is NOT told: that no
      // money moved. Money did move — the winner moved it — and `moneyMoved`
      // describes the release, not the caller. Reporting false here would be a
      // lie about a captured release; reporting ALLOW would be a lie about who
      // captured it. PAUSE with a concurrency reason code is the honest answer.
      const loser = attempts.find(a => a.verdict !== 'ALLOW');
      expect(loser?.verdict).toBe('PAUSE');
      expect(loser?.reasonCodes).toContain('CONCURRENT_RELEASE_IN_PROGRESS');
    } finally {
      await s.close();
    }
  });
});

describe('transaction boundaries', () => {
  it('rolls back evidence when the enclosing transaction fails', async () => {
    const s = await stack();
    try {
      const auth = await s.setup();
      const before = await admin.query<{ n: string }>(
        'SELECT COUNT(*)::text AS n FROM evidence_envelopes',
      );

      await expect(
        s.deps.unitOfWork.withTransaction(async repos => {
          await repos.evidence.append({
            chainId: auth,
            kind: 'DECISION',
            recordedAt: s.deps.clock.now(),
            body: { doomed: true },
          });
          throw new Error('deliberate failure after the append');
        }),
      ).rejects.toThrow('deliberate failure');

      const after = await admin.query<{ n: string }>(
        'SELECT COUNT(*)::text AS n FROM evidence_envelopes',
      );
      // A half-written decision is worse than none: it would claim the system
      // knew something it never acted on.
      expect(after[0]?.n).toBe(before[0]?.n);
    } finally {
      await s.close();
    }
  });

  it('commits the write-ahead before the provider call, so a crash is recoverable', async () => {
    const s = await stack();
    try {
      const { releaseId } = await openOrder(s);
      await s.simulatePayerAuthorization(releaseId);

      // The capture lands at the provider; the response is lost — the exact
      // shape of a crash between the write-ahead and the outcome.
      s.provider.failNextCaptureWith('TIMEOUT_AFTER_APPLY');
      await s.releases.requestCapture({
        releaseId: releaseId as never,
        idempotencyKey: s.key('cap'),
        principal: s.principal(),
      });

      const rows = await admin.query<{ state: string; in_flight_since: Date | null }>(
        'SELECT state, in_flight_since FROM releases WHERE release_id = $1',
        [releaseId],
      );
      expect(rows[0]?.state).toBe('CAPTURE_INDETERMINATE');
      // Still marked in flight, which is how the sweep finds it.
      expect(rows[0]?.in_flight_since).not.toBeNull();
    } finally {
      await s.close();
    }
  });
});

describe('recovery after a crash', () => {
  it('reconciles an indeterminate capture by asking the provider, never by retrying', async () => {
    const s = await stack();
    try {
      const { releaseId } = await openOrder(s);
      await s.simulatePayerAuthorization(releaseId);
      s.provider.failNextCaptureWith('TIMEOUT_AFTER_APPLY');
      await s.releases.requestCapture({
        releaseId: releaseId as never,
        idempotencyKey: s.key('cap'),
        principal: s.principal(),
      });

      const outcome = await s.reconciliation.reconcileById(releaseId as never);
      expect(outcome?.after).toBe('CAPTURED');
      expect(outcome?.resolvedBy).toBe('PAYMENT_LOOKUP');
      expect(s.provider.callCount('capturePayment')).toBe(1);
    } finally {
      await s.close();
    }
  });

  it('frees an authorization stranded by a crash mid-verification', async () => {
    // This is the liveness hazard the one-active-release index creates: a
    // release abandoned in a transient state would otherwise hold the mandate
    // forever. See ADR-011.
    const s = await stack();
    try {
      const { auth, releaseId } = await openOrder(s);

      // Simulate a process that died between tx A and tx B.
      await admin.query(
        `UPDATE releases SET state = 'CAPTURE_VERIFYING', updated_at = NOW() - INTERVAL '1 hour'
         WHERE release_id = $1`,
        [releaseId],
      );

      const before = await admin.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM releases
         WHERE authorization_id = $1
           AND state NOT IN ('SETTLED','DENIED','CAPTURE_REJECTED','FAILED','ABORTED')`,
        [auth],
      );
      expect(before[0]?.n).toBe('1');

      const swept = await s.reconciliation.sweepAbandoned();
      expect(swept.map(o => o.after)).toContain('ABORTED');
      // No provider call was ever made from a transient state, so aborting is safe.
      expect(s.provider.callCount('capturePayment')).toBe(0);

      const after = await admin.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM releases
         WHERE authorization_id = $1
           AND state NOT IN ('SETTLED','DENIED','CAPTURE_REJECTED','FAILED','ABORTED')`,
        [auth],
      );
      // The mandate is spendable again.
      expect(after[0]?.n).toBe('0');
    } finally {
      await s.close();
    }
  });

  it('does not sweep a release whose provider call only just started', async () => {
    // The Phase 1 sweep passed `now` as the cutoff, so a call a millisecond old
    // was eligible and a background sweeper would have raced live captures.
    const s = await stack();
    try {
      const { releaseId } = await openOrder(s);
      await s.simulatePayerAuthorization(releaseId);
      s.provider.failNextCaptureWith('TIMEOUT_AFTER_APPLY');
      await s.releases.requestCapture({
        releaseId: releaseId as never,
        idempotencyKey: s.key('cap'),
        principal: s.principal(),
      });

      const swept = await s.reconciliation.sweep();
      expect(swept.map(o => o.releaseId)).not.toContain(releaseId);
    } finally {
      await s.close();
    }
  });
});
