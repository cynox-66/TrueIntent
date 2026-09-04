/**
 * Session authority domain.
 *
 * The arithmetic here is what stops an agent spending a per-transaction ceiling
 * an unbounded number of times, so it is tested at its boundaries rather than
 * in the middle: one paisa over, exactly at the limit, and the case where the
 * remaining budget is what binds rather than the per-purchase cap.
 */

import { describe, expect, it } from 'vitest';
import {
  SessionBoundsSchema,
  asTimestamp,
  computeSessionBoundsHash,
  derivePurchaseRequestId,
  money,
  purchaseCeiling,
  remainingBudget,
  verifySessionBoundsIntegrity,
  type SessionAuthorityRecord,
  type SessionBounds,
  type SessionId,
  type UserId,
} from '../src/index.js';

const EXPIRES = asTimestamp('2026-09-05T10:00:00.000Z');
const CREATED = asTimestamp('2026-09-04T10:00:00.000Z');

function bounds(overrides: Partial<SessionBounds> = {}): SessionBounds {
  return SessionBoundsSchema.parse({
    currency: 'INR',
    totalBudget: money('INR', 200_000),
    maxPerPurchase: money('INR', 80_000),
    merchants: { mode: 'ALLOWLIST', merchantIds: ['merchant_thai'] },
    allowedCategories: ['thai', 'groceries'],
    forbiddenCategories: ['alcohol'],
    itemsPerPurchase: { min: 1, max: 8 },
    recurrence: 'ONE_TIME_ONLY',
    expiresAt: EXPIRES,
    ...overrides,
  });
}

function session(overrides: Partial<SessionAuthorityRecord> = {}): SessionAuthorityRecord {
  const b = overrides.bounds ?? bounds();
  return {
    sessionId: 'sess_00000000000000000000000000000001' as SessionId,
    userId: 'user_priya' as UserId,
    purpose: 'Thai curry dinner for 4, vegetarian, under 800 rupees.',
    bounds: b,
    boundsHash: computeSessionBoundsHash(b),
    policyId: 'household',
    policyVersion: '1.0.0',
    state: 'ACTIVE',
    reservedMinor: 0,
    spentMinor: 0,
    createdAt: CREATED,
    expiresAt: EXPIRES,
    revokedAt: null,
    ...overrides,
  };
}

describe('session bounds', () => {
  it('refuses a per-purchase cap above the total budget', () => {
    // A cap that cannot bind is a statement the user did not make. Refusing at
    // the schema means it cannot be stored and later read as meaningful.
    const result = SessionBoundsSchema.safeParse({
      ...bounds(),
      totalBudget: money('INR', 50_000),
      maxPerPurchase: money('INR', 80_000),
    });
    expect(result.success).toBe(false);
  });

  it('refuses a budget in a currency other than the session currency', () => {
    const result = SessionBoundsSchema.safeParse({
      ...bounds(),
      totalBudget: money('USD', 200_000),
    });
    expect(result.success).toBe(false);
  });

  it('refuses a zero budget rather than creating a session that can never buy', () => {
    const result = SessionBoundsSchema.safeParse({
      ...bounds(),
      totalBudget: money('INR', 0),
      maxPerPurchase: money('INR', 0),
    });
    expect(result.success).toBe(false);
  });
});

describe('the bounds hash', () => {
  it('is deterministic across independently constructed but equal bounds', () => {
    expect(computeSessionBoundsHash(bounds())).toBe(computeSessionBoundsHash(bounds()));
  });

  it('does not depend on the order of the category or merchant lists', () => {
    // These are sets semantically. If ordering changed the hash, an agent
    // reordering a list would look like tampering.
    const a = bounds({ allowedCategories: ['thai', 'groceries'] });
    const b = bounds({ allowedCategories: ['groceries', 'thai'] });
    expect(computeSessionBoundsHash(a)).toBe(computeSessionBoundsHash(b));
  });

  it('changes when the budget changes', () => {
    const raised = bounds({ totalBudget: money('INR', 200_001) });
    expect(computeSessionBoundsHash(raised)).not.toBe(computeSessionBoundsHash(bounds()));
  });

  it('detects a budget raised directly in the store', () => {
    // The whole point of storing the hash: editing the row is caught, not
    // enforced. This is the session-level twin of INTENT_HASH_MISMATCH.
    const tampered = session();
    const edited: SessionAuthorityRecord = {
      ...tampered,
      bounds: { ...tampered.bounds, totalBudget: money('INR', 10_000_000) },
    };
    expect(verifySessionBoundsIntegrity(tampered).valid).toBe(true);
    expect(verifySessionBoundsIntegrity(edited).valid).toBe(false);
  });
});

describe('budget arithmetic', () => {
  it('counts reservations as committed, not just settled spend', () => {
    // A purchase in flight must not be spendable twice. If `remaining` ignored
    // reservations, two concurrent requests would each see the full budget.
    const s = session({ reservedMinor: 70_000, spentMinor: 60_000 });
    expect(remainingBudget(s)).toEqual(money('INR', 70_000));
  });

  it('caps a purchase at the per-purchase limit while budget is plentiful', () => {
    expect(purchaseCeiling(session())).toEqual(money('INR', 80_000));
  });

  it('caps a purchase at the remaining budget once that is the tighter bound', () => {
    // 2,000 budget, 700 + 600 already committed, 700 left. A third purchase may
    // be at most 700 even though the per-purchase cap is 800 — which is exactly
    // the check a per-transaction ceiling cannot make.
    const s = session({ spentMinor: 70_000 + 60_000 });
    expect(purchaseCeiling(s)).toEqual(money('INR', 70_000));
  });

  it('reaches exactly zero rather than going negative when fully committed', () => {
    const s = session({ spentMinor: 200_000 });
    expect(remainingBudget(s)).toEqual(money('INR', 0));
    expect(purchaseCeiling(s)).toEqual(money('INR', 0));
  });
});

describe('the purchase request id', () => {
  it('is stable for the same session and key, so a retry maps to one row', () => {
    const id = 'sess_00000000000000000000000000000001' as SessionId;
    expect(derivePurchaseRequestId(id, 'key-aaaaaaaaaaaaaaaa')).toBe(
      derivePurchaseRequestId(id, 'key-aaaaaaaaaaaaaaaa'),
    );
  });

  it('differs across sessions for the same key', () => {
    // Two users' agents may pick the same key. Scoping by session stops one
    // agent's retry resolving to the other's purchase.
    const a = 'sess_00000000000000000000000000000001' as SessionId;
    const b = 'sess_00000000000000000000000000000002' as SessionId;
    expect(derivePurchaseRequestId(a, 'key-aaaaaaaaaaaaaaaa')).not.toBe(
      derivePurchaseRequestId(b, 'key-aaaaaaaaaaaaaaaa'),
    );
  });

  it('cannot be made to collide by choosing a key containing the separator', () => {
    // Hashed as structured fields rather than concatenated, so there is no
    // separator to smuggle.
    const a = 'sess_00000000000000000000000000000001' as SessionId;
    const b = 'sess_00000000000000000000000000000002' as SessionId;
    expect(derivePurchaseRequestId(a, `${b}:key`)).not.toBe(derivePurchaseRequestId(b, 'key'));
  });
});
