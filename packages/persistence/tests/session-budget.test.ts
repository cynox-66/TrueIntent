/**
 * Aggregate budget accounting, against the in-memory store.
 *
 * This is the offline half of a mirrored pair: `parity.db.test.ts` runs the same
 * sequences against both backends and compares the observable result, and
 * `postgres.db.test.ts` proves the concurrency claim against real row
 * contention. This file exists so the *shape* of the logic is checked on every
 * `pnpm test`, without Docker.
 *
 * What it deliberately cannot prove: that two processes cannot both reserve the
 * same remaining budget. A single-threaded event loop makes the in-memory
 * reserve atomic for free, which is precisely why the real claim has to be made
 * against Postgres. See ADR-010.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  asTimestamp,
  computeSessionBoundsHash,
  derivePurchaseRequestId,
  money,
  remainingBudget,
  type SessionAuthorityRecord,
  type SessionBounds,
  type SessionId,
  type SessionPurchaseRecord,
  type Sha256Hex,
  type UserId,
} from '@capturelock/core';
import type { AuthorizationId } from '@capturelock/core';
import { InMemorySessionAuthorityRepository } from '../src/index.js';

const T0 = asTimestamp('2026-09-04T10:00:00.000Z');
const T1 = asTimestamp('2026-09-04T10:01:00.000Z');
const EXPIRES = asTimestamp('2026-09-05T10:00:00.000Z');

const SESSION = 'sess_00000000000000000000000000000001' as SessionId;

function bounds(): SessionBounds {
  return {
    currency: 'INR',
    totalBudget: money('INR', 200_000),
    maxPerPurchase: money('INR', 80_000),
    merchants: { mode: 'ANY' },
    allowedCategories: [],
    forbiddenCategories: [],
    itemsPerPurchase: { min: 1, max: 8 },
    recurrence: 'ONE_TIME_ONLY',
    expiresAt: EXPIRES,
  };
}

function session(overrides: Partial<SessionAuthorityRecord> = {}): SessionAuthorityRecord {
  const b = bounds();
  return {
    sessionId: SESSION,
    userId: 'user_priya' as UserId,
    purpose: 'dinner',
    bounds: b,
    boundsHash: computeSessionBoundsHash(b),
    policyId: 'household',
    policyVersion: '1.0.0',
    state: 'ACTIVE',
    reservedMinor: 0,
    spentMinor: 0,
    createdAt: T0,
    expiresAt: EXPIRES,
    revokedAt: null,
    ...overrides,
  };
}

function authId(n: number): AuthorizationId {
  return `auth_${String(n).padStart(32, '0')}` as AuthorizationId;
}

function purchase(n: number, reservedMinor: number): SessionPurchaseRecord {
  return {
    authorizationId: `auth_${String(n).padStart(32, '0')}`,
    sessionId: SESSION,
    purchaseRequestId: derivePurchaseRequestId(SESSION, `key-${String(n).padStart(16, '0')}`),
    reservedMinor,
    settlementState: 'RESERVED',
    capsuleHash: '0'.repeat(64) as Sha256Hex,
    createdAt: T0,
    settledAt: null,
  };
}

describe('reserving against the session budget', () => {
  let repo: InMemorySessionAuthorityRepository;

  beforeEach(async () => {
    repo = new InMemorySessionAuthorityRepository();
    await repo.insert(session());
  });

  it('permits a purchase inside the remaining budget', async () => {
    const result = await repo.reserve(SESSION, money('INR', 70_000), T0);
    expect(result.kind).toBe('RESERVED');
    const current = await repo.findById(SESSION);
    expect(current?.reservedMinor).toBe(70_000);
  });

  it('refuses the purchase that would cross the aggregate budget', async () => {
    // 700 + 600 leaves 700. An 800 purchase is inside the per-purchase cap and
    // must still be refused — this is the entire reason the aggregate exists.
    await repo.reserve(SESSION, money('INR', 70_000), T0);
    await repo.reserve(SESSION, money('INR', 60_000), T0);

    const third = await repo.reserve(SESSION, money('INR', 80_000), T0);
    expect(third).toEqual({ kind: 'REFUSED', reason: 'BUDGET_EXCEEDED' });

    const current = await repo.findById(SESSION);
    expect(remainingBudget(current!)).toEqual(money('INR', 70_000));
  });

  it('permits a purchase for exactly the remaining budget', async () => {
    await repo.reserve(SESSION, money('INR', 70_000), T0);
    await repo.reserve(SESSION, money('INR', 60_000), T0);
    const exact = await repo.reserve(SESSION, money('INR', 70_000), T0);
    expect(exact.kind).toBe('RESERVED');
    expect(remainingBudget((await repo.findById(SESSION))!)).toEqual(money('INR', 0));
  });

  it('refuses one paisa over, not merely comfortably over', async () => {
    const over = await repo.reserve(SESSION, money('INR', 200_001), T0);
    expect(over).toEqual({ kind: 'REFUSED', reason: 'BUDGET_EXCEEDED' });
  });

  it('refuses an expired session', async () => {
    const after = asTimestamp('2026-09-06T10:00:00.000Z');
    expect(await repo.reserve(SESSION, money('INR', 1_000), after)).toEqual({
      kind: 'REFUSED',
      reason: 'EXPIRED',
    });
  });

  it('refuses a revoked session', async () => {
    await repo.transition(SESSION, ['ACTIVE'], 'REVOKED', { revokedAt: T1 });
    expect(await repo.reserve(SESSION, money('INR', 1_000), T0)).toEqual({
      kind: 'REFUSED',
      reason: 'NOT_ACTIVE',
    });
  });

  it('refuses an unknown session rather than creating one', async () => {
    const other = 'sess_0000000000000000000000000000ffff' as SessionId;
    expect(await repo.reserve(other, money('INR', 1_000), T0)).toEqual({
      kind: 'REFUSED',
      reason: 'NOT_FOUND',
    });
  });
});

describe('settling and releasing a hold', () => {
  let repo: InMemorySessionAuthorityRepository;

  beforeEach(async () => {
    repo = new InMemorySessionAuthorityRepository();
    await repo.insert(session());
    await repo.reserve(SESSION, money('INR', 70_000), T0);
    await repo.recordPurchase(purchase(1, 70_000));
  });

  it('moves a settled hold from reserved into spent', async () => {
    const settled = await repo.settlePurchase(authId(1), T1);
    expect(settled?.settlementState).toBe('SETTLED');

    const current = await repo.findById(SESSION);
    expect({ reserved: current?.reservedMinor, spent: current?.spentMinor }).toEqual({
      reserved: 0,
      spent: 70_000,
    });
  });

  it('counts a settlement once even if it is applied twice', async () => {
    // Exactly-once is the purchase row's compare-and-set. A retried caller, or
    // two sweepers racing, must not double-count money that moved once.
    const id = authId(1);
    await repo.settlePurchase(id, T1);
    expect(await repo.settlePurchase(id, T1)).toBeNull();

    const current = await repo.findById(SESSION);
    expect(current?.spentMinor).toBe(70_000);
  });

  it('frees the budget again when the purchase moved no money', async () => {
    const released = await repo.releasePurchase(authId(1), T1);
    expect(released?.settlementState).toBe('RELEASED');

    const current = await repo.findById(SESSION);
    expect({ reserved: current?.reservedMinor, spent: current?.spentMinor }).toEqual({
      reserved: 0,
      spent: 0,
    });
    expect(remainingBudget(current!)).toEqual(money('INR', 200_000));
  });

  it('refuses to release a hold that already settled', async () => {
    // Money moved. Freeing the hold now would make the budget claim a lie.
    const id = authId(1);
    await repo.settlePurchase(id, T1);
    expect(await repo.releasePurchase(id, T1)).toBeNull();
    expect((await repo.findById(SESSION))?.spentMinor).toBe(70_000);
  });
});

describe('purchase request identity', () => {
  let repo: InMemorySessionAuthorityRepository;

  beforeEach(async () => {
    repo = new InMemorySessionAuthorityRepository();
    await repo.insert(session());
  });

  it('reports a repeated request instead of recording a second purchase', async () => {
    // The retry path. A second mandate against the same session would be a
    // second budget hold for one user intent.
    const first = await repo.recordPurchase(purchase(1, 70_000));
    expect(first.kind).toBe('RECORDED');

    const retry = await repo.recordPurchase({
      ...purchase(2, 70_000),
      purchaseRequestId: purchase(1, 70_000).purchaseRequestId,
    });
    expect(retry.kind).toBe('DUPLICATE_REQUEST');
    if (retry.kind === 'DUPLICATE_REQUEST') {
      expect(retry.existing.authorizationId).toBe(authId(1));
    }
    expect(await repo.listPurchasesBySession(SESSION, 10)).toHaveLength(1);
  });

  it('lists only holds still unresolved past the cutoff', async () => {
    await repo.recordPurchase(purchase(1, 70_000));
    await repo.recordPurchase(purchase(2, 60_000));
    await repo.settlePurchase(authId(1), T1);

    const stranded = await repo.findUnsettledPurchases(T1, 10);
    expect(stranded.map(p => p.authorizationId)).toEqual([authId(2)]);
  });
});
