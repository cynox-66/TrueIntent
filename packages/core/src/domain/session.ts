/**
 * Session authority: what the user delegated to an agent, across many purchases.
 *
 * `AuthorizedIntent` already bounds *one* purchase, and it is consumed by the
 * release that spends it (`ACTIVE -> CONSUMED`, one active release per
 * authorization). That is the right shape for a single mandate and the wrong
 * shape for an autonomous agent, which needs to make several purchases against
 * one delegation and must not be able to spend the per-transaction ceiling
 * repeatedly.
 *
 * So this sits *above* the authorization:
 *
 *     SessionAuthority  (aggregate budget, purpose, expiry)
 *         │
 *         ├── AuthorizedIntent #1 ── release ── payment
 *         └── AuthorizedIntent #2 ── release ── payment
 *
 * Three things it deliberately is NOT:
 *
 *  - **Not a payment credential.** It carries no provider reference, no key, no
 *    token. Holding one lets an agent *ask*; it does not let it charge.
 *  - **Not an `ExecutionGrant`.** A grant is minted by the kernel for one
 *    verified cart and consumed milliseconds later. This is a long-lived
 *    statement of scope that every purchase is checked against.
 *  - **Not a second state machine over money.** Release state stays
 *    authoritative for execution. This record tracks scope and budget only,
 *    which is why budget exhaustion is a derived property here rather than a
 *    state: two ways to say "no funds left" is one way to disagree with itself.
 *
 * `bounds` is a deliberate subset of `IntentConstraints`, reusing its own types
 * for merchants, quantity and recurrence, so that deriving a per-purchase intent
 * from a session is mechanical rather than a translation layer that can drift.
 */

import { z } from 'zod';
import {
  MerchantConstraintSchema,
  QuantityBandSchema,
  RecurrenceConstraintSchema,
  type MerchantConstraint,
  type QuantityBand,
  type RecurrenceConstraint,
} from './intent.js';
import { CurrencyCodeSchema, MoneySchema, type CurrencyCode, type Money } from '../money.js';
import { TimestampSchema, type Timestamp } from '../time.js';
import { hash, type Sha256Hex } from '../canonical.js';
import type { SessionId, UserId } from '../ids.js';

/**
 * Lifecycle of a delegation.
 *
 * There is no `EXHAUSTED`: whether budget remains is arithmetic over
 * `totalBudget - reserved - spent`, and duplicating it as a state would create
 * two sources of truth that a partial write could split.
 */
export const SessionAuthorityStateSchema = z.enum(['ACTIVE', 'REVOKED', 'EXPIRED']);
export type SessionAuthorityState = z.infer<typeof SessionAuthorityStateSchema>;

/**
 * The bounds of the delegation.
 *
 * Both ceilings are load-bearing and neither implies the other.
 * `maxPerPurchase` stops one oversized basket; `totalBudget` stops death by a
 * thousand compliant ones — which is precisely the failure mode a per-release
 * check cannot see.
 */
export const SessionBoundsSchema = z
  .object({
    currency: CurrencyCodeSchema,
    /** Ceiling on everything this session may spend, summed across purchases. */
    totalBudget: MoneySchema.refine(m => m.amountMinor > 0, 'Total budget must be positive'),
    /** Ceiling on any single purchase, including its fees. */
    maxPerPurchase: MoneySchema.refine(m => m.amountMinor > 0, 'Per-purchase cap must be positive'),
    merchants: MerchantConstraintSchema,
    /** Categories a purchase may fall in. Empty means "unconstrained by category". */
    allowedCategories: z.array(z.string().min(1).max(64)).max(64),
    forbiddenCategories: z.array(z.string().min(1).max(64)).max(64),
    /** Per-line quantity band any single purchase must sit inside. */
    itemsPerPurchase: QuantityBandSchema,
    recurrence: RecurrenceConstraintSchema,
    expiresAt: TimestampSchema,
  })
  .strict()
  .refine(
    b => b.totalBudget.currency === b.currency,
    'Total budget currency must match the session currency',
  )
  .refine(
    b => b.maxPerPurchase.currency === b.currency,
    'Per-purchase cap currency must match the session currency',
  )
  .refine(
    b => b.maxPerPurchase.amountMinor <= b.totalBudget.amountMinor,
    'Per-purchase cap cannot exceed the total budget',
  );

export type SessionBounds = z.infer<typeof SessionBoundsSchema>;

export interface SessionAuthorityRecord {
  readonly sessionId: SessionId;
  readonly userId: UserId;
  /**
   * The user's own words for what this session is for.
   *
   * Evidence and advisory only, exactly like `AuthorizedIntent.rawText`: no
   * deterministic check reads it. Free text cannot be verified, and treating it
   * as though it could is how "vegetarian dinner" becomes twelve energy drinks.
   */
  readonly purpose: string;
  readonly bounds: SessionBounds;
  readonly boundsHash: Sha256Hex;
  /** The operator policy every purchase derived from this session inherits. */
  readonly policyId: string;
  readonly policyVersion: string;
  readonly state: SessionAuthorityState;
  /** Committed to in-flight purchases, not yet known to have moved. */
  readonly reservedMinor: number;
  /** Confirmed moved at the provider. */
  readonly spentMinor: number;
  readonly createdAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly revokedAt: Timestamp | null;
}

/**
 * What a purchase attempt holds against the session budget.
 *
 * A reservation exists so that budget safety does not depend on the money path
 * cooperating. It is taken *before* a release exists and converted only once the
 * release reaches a terminal state, so the crash window leaves budget
 * conservatively withheld rather than double-spendable.
 */
export const PurchaseSettlementStateSchema = z.enum(['RESERVED', 'SETTLED', 'RELEASED']);
export type PurchaseSettlementState = z.infer<typeof PurchaseSettlementStateSchema>;

export interface SessionPurchaseRecord {
  readonly authorizationId: string;
  readonly sessionId: SessionId;
  /**
   * Deterministic over (sessionId, idempotencyKey).
   *
   * Unique per session, so a retried purchase request finds this row instead of
   * minting a second mandate. The agent chooses the idempotency key, so this
   * cannot bound money on its own — the release's receipt does that — but it is
   * what stops a retry from creating a parallel authorization.
   */
  readonly purchaseRequestId: Sha256Hex;
  readonly reservedMinor: number;
  readonly settlementState: PurchaseSettlementState;
  readonly capsuleHash: Sha256Hex;
  readonly createdAt: Timestamp;
  readonly settledAt: Timestamp | null;
}

/** Budget still committable: total, less what is reserved and what is spent. */
export function remainingBudget(session: SessionAuthorityRecord): Money {
  return {
    currency: session.bounds.currency,
    amountMinor:
      session.bounds.totalBudget.amountMinor - session.reservedMinor - session.spentMinor,
  };
}

/**
 * The ceiling a single purchase derived from this session may carry.
 *
 * The smaller of the per-purchase cap and what is actually left. Handing this to
 * the derived `AuthorizedIntent.maxTotal` means the *existing* deterministic
 * `INTENT_TOTAL_EXCEEDED` check enforces the aggregate budget at both gates —
 * independently of the reservation, and inside the pure kernel where it is
 * replayable.
 */
export function purchaseCeiling(session: SessionAuthorityRecord): Money {
  const remaining = remainingBudget(session);
  const cap = session.bounds.maxPerPurchase;
  return remaining.amountMinor < cap.amountMinor ? remaining : cap;
}

/** Projects the bounds into the exact shape that gets hashed. */
export function sessionBoundsHashInput(bounds: SessionBounds): Record<string, unknown> {
  return {
    currency: bounds.currency,
    totalBudget: moneyForHash(bounds.totalBudget),
    maxPerPurchase: moneyForHash(bounds.maxPerPurchase),
    merchants:
      bounds.merchants.mode === 'ANY'
        ? { mode: 'ANY', merchantIds: null }
        : { mode: 'ALLOWLIST', merchantIds: [...bounds.merchants.merchantIds].sort() },
    allowedCategories: [...bounds.allowedCategories].sort(),
    forbiddenCategories: [...bounds.forbiddenCategories].sort(),
    itemsPerPurchaseMin: bounds.itemsPerPurchase.min,
    itemsPerPurchaseMax: bounds.itemsPerPurchase.max,
    recurrence: bounds.recurrence,
    expiresAt: bounds.expiresAt,
  };
}

export function computeSessionBoundsHash(bounds: SessionBounds): Sha256Hex {
  return hash('capturelock.v1.session_bounds', sessionBoundsHashInput(bounds));
}

/**
 * Recomputes the bounds hash and reports whether the stored value still holds.
 *
 * This is what makes raising a session budget directly in the database a
 * *detected* edit rather than an enforced one — the same property
 * `intentHash` gives a single authorization.
 */
export function verifySessionBoundsIntegrity(session: SessionAuthorityRecord): {
  readonly valid: boolean;
  readonly recomputed: Sha256Hex;
} {
  const recomputed = computeSessionBoundsHash(session.bounds);
  return { valid: recomputed === session.boundsHash, recomputed };
}

/**
 * Deterministic identity of a purchase attempt within a session.
 *
 * Derived server-side from the session and the agent's idempotency key, so a
 * retry maps to the same row. Hashed rather than concatenated so the value is
 * fixed-width and cannot be made to collide by choosing a key containing the
 * separator.
 */
export function derivePurchaseRequestId(sessionId: SessionId, idempotencyKey: string): Sha256Hex {
  return hash('capturelock.v1.purchase_request', { sessionId, idempotencyKey });
}

function moneyForHash(amount: Money): Record<string, unknown> {
  return { currency: amount.currency, amountMinor: amount.amountMinor };
}

export type { CurrencyCode, MerchantConstraint, QuantityBand, RecurrenceConstraint };
