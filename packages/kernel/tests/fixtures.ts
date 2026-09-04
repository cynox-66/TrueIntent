/**
 * Scenario fixtures.
 *
 * `buildContext` produces a fully valid, ALLOW-verdict context modelled on the
 * running example: *"find me the cheapest pair of black running shoes under
 * 5,000 rupees"*. Every test then perturbs exactly one thing and asserts what
 * changes. Keeping the happy path in one place means a test that expects DENY
 * is provably testing the thing it names, rather than passing because the
 * fixture was broken in some unrelated way.
 *
 * Derived values — snapshot hash, intent hash, policy hash, row hashes — are
 * always recomputed *after* the overrides are applied, so an override produces
 * a genuinely consistent world rather than one that fails an integrity check by
 * accident. Tests that want an inconsistent world corrupt it explicitly through
 * `corrupt`.
 */

import {
  asTimestamp,
  computeCartTotals,
  computeSnapshotHash,
  hash,
  intentHashInput,
  liveItemRowHash,
  money,
  newAuthorizationId,
  newReleaseId,
  newRequestId,
  newSnapshotId,
  addSeconds,
  deriveReceipt,
  type Attribute,
  type AuthorizationRecord,
  type CartAdjustment,
  type Gate,
  type IntentConstraints,
  type LiveFeeQuote,
  type LiveItemState,
  type LiveStateResult,
  type MerchantId,
  type ProposedCart,
  type ReleaseRecord,
  type Sha256Hex,
  type Sku,
  type Timestamp,
  type UserId,
  type VerifiedSnapshot,
} from '@capturelock/core';
import { computePolicyHash, type PolicyDocument } from '@capturelock/policy';
import type { ExecutionContext, VerificationContext } from '../src/context.js';
import { deepFreeze } from '../src/context.js';

export const NOW = asTimestamp('2026-09-03T10:00:00.000Z');
export const SNAPSHOT_AT = asTimestamp('2026-09-03T09:59:50.000Z');

export const MERCHANT = 'merchant_alpha' as MerchantId;
export const SKU_BLACK = 'SKU-BLK-RUN-42' as Sku;
export const USER = 'user_priya' as UserId;
export const SESSION = 'sess_01';

export const inr = (minor: number) => money('INR', minor);
export const attr = (name: string, value: string): Attribute => ({ name, value });

/** ~4,799 rupees. The shoe the agent found. */
export const LIST_PRICE_MINOR = 479_900;
export const SHIPPING_MINOR = 15_000;

export function defaultConstraints(): IntentConstraints {
  return {
    currency: 'INR',
    maxTotal: inr(500_000),
    maxUnitPrice: inr(500_000),
    quantity: { min: 1, max: 1 },
    allowedCategories: ['footwear'],
    forbiddenCategories: [],
    requiredAttributes: [{ name: 'colour', anyOf: ['black'] }],
    forbiddenAttributes: [{ name: 'colour', anyOf: ['white'] }],
    merchants: { mode: 'ALLOWLIST', merchantIds: [MERCHANT] },
    fees: {
      maxShipping: inr(20_000),
      maxTax: null,
      maxTip: inr(10_000),
      maxConvenienceFee: null,
      maxTotalFees: inr(30_000),
    },
    recurrence: 'ONE_TIME_ONLY',
    geography: { allowedCountries: ['IN'], allowedRegions: null },
    maxSnapshotAgeSeconds: 30,
    notBefore: asTimestamp('2026-09-03T09:00:00.000Z'),
    notAfter: asTimestamp('2026-09-03T11:00:00.000Z'),
  };
}

export function defaultLiveItem(): LiveItemState {
  return {
    sku: SKU_BLACK,
    merchantId: MERCHANT,
    name: 'Trailblaze Runner',
    category: 'footwear',
    attributes: [attr('colour', 'black'), attr('size', 'UK9')],
    unitPrice: inr(LIST_PRICE_MINOR),
    available: true,
    availableStock: 12,
    subscriptionOnly: false,
    updatedAt: asTimestamp('2026-09-03T09:55:00.000Z'),
  };
}

export function defaultFeeQuote(adjustments?: CartAdjustment[]): LiveFeeQuote {
  return {
    merchantId: MERCHANT,
    currency: 'INR',
    adjustments: adjustments ?? [
      { type: 'SHIPPING', label: 'Standard delivery', amount: inr(SHIPPING_MINOR) },
    ],
    quotedAt: SNAPSHOT_AT,
  };
}

export function defaultPolicy(): PolicyDocument {
  return {
    policyId: 'household_default',
    version: '1.0.0',
    name: 'Household default policy',
    createdAt: asTimestamp('2026-09-01T00:00:00.000Z'),
    rules: [
      {
        ruleId: 'max_total',
        kind: 'MAX_TOTAL',
        description: 'Operator spend ceiling',
        severity: 'DENY',
        max: inr(500_000),
      },
      {
        ruleId: 'merchant_allowlist',
        kind: 'MERCHANT_ALLOWLIST',
        description: 'Approved merchants only',
        severity: 'DENY',
        merchantIds: [MERCHANT],
      },
      {
        ruleId: 'max_qty',
        kind: 'MAX_QUANTITY_PER_ITEM',
        description: 'At most two of any item',
        severity: 'DENY',
        max: 2,
      },
      {
        ruleId: 'max_shipping',
        kind: 'MAX_FEE',
        description: 'Shipping ceiling',
        severity: 'DENY',
        adjustmentType: 'SHIPPING',
        max: inr(20_000),
      },
      {
        ruleId: 'no_subscriptions',
        kind: 'FORBID_SUBSCRIPTION',
        description: 'One-time purchases only',
        severity: 'DENY',
      },
      {
        ruleId: 'currencies',
        kind: 'ALLOWED_CURRENCIES',
        description: 'INR only',
        severity: 'DENY',
        currencies: ['INR'],
      },
    ],
  };
}

export interface ScenarioOverrides {
  gate?: Gate;
  now?: Timestamp;
  constraints?: Partial<IntentConstraints>;
  /** Mutate the live catalogue. Runs BEFORE the cart is priced, so cart and live agree. */
  liveItems?: (items: LiveItemState[]) => LiveItemState[];
  /**
   * Mutate live state AFTER the cart and snapshot are built.
   *
   * This is how a TOCTOU scenario is expressed: the snapshot records the world
   * as it was at quote time, and the world then moves before capture. Using
   * `liveItems` instead would move both sides together and prove nothing.
   */
  liveDrift?: (items: LiveItemState[]) => LiveItemState[];
  /** Live fee quote AFTER the snapshot is built, for fee drift. */
  liveFeeDrift?: CartAdjustment[];
  /**
   * Replace the cart being charged AFTER the snapshot is sealed, modelling an
   * agent that points at a legitimate quote but submits a different cart.
   */
  proposalDrift?: (cart: ProposedCart) => ProposedCart;
  liveFeeAdjustments?: CartAdjustment[];
  /** Make the live read fail entirely. */
  liveUnavailable?: string;
  /** Mutate the cart after it is priced from live state. */
  cart?: (cart: ProposedCart) => ProposedCart;
  /** Mutate the snapshot after it is built and hashed, to model tampering. */
  corruptSnapshot?: (snapshot: VerifiedSnapshot) => VerifiedSnapshot;
  authorization?: (record: AuthorizationRecord) => AuthorizationRecord;
  policy?: (document: PolicyDocument) => PolicyDocument;
  /** Replace the policy AFTER the authorization bound its hash, to model substitution. */
  substitutePolicy?: PolicyDocument;
  execution?: Partial<ExecutionContext>;
  principal?: { userId: UserId; sessionId: string };
  omitSnapshot?: boolean;
  omitAuthorization?: boolean;
  omitPolicy?: boolean;
}

export interface Scenario {
  readonly context: VerificationContext;
  readonly authorization: AuthorizationRecord;
  readonly snapshot: VerifiedSnapshot;
  readonly policy: PolicyDocument;
  readonly liveItems: readonly LiveItemState[];
}

export function buildScenario(overrides: ScenarioOverrides = {}): Scenario {
  const now = overrides.now ?? NOW;
  const gate = overrides.gate ?? 'CAPTURE';

  // ---- live state ---------------------------------------------------------
  const baseItems = [defaultLiveItem()];
  const liveItems = overrides.liveItems ? overrides.liveItems(baseItems) : baseItems;
  const feeQuote = defaultFeeQuote(overrides.liveFeeAdjustments);

  // ---- cart, priced from live state ---------------------------------------
  const priced = liveItems[0] ?? defaultLiveItem();
  const baseCart: ProposedCart = {
    merchantId: MERCHANT,
    currency: 'INR',
    lines: [
      {
        sku: priced.sku,
        quantity: 1,
        unitPrice: priced.unitPrice,
        asserted: {
          name: priced.name,
          category: priced.category,
          attributes: [...priced.attributes],
        },
      },
    ],
    adjustments: [...feeQuote.adjustments],
    declaredTotal: inr(0),
    recurring: false,
    shipTo: { country: 'IN', region: null },
  };
  const withTotal: ProposedCart = {
    ...baseCart,
    declaredTotal: computeCartTotals(baseCart).computedTotal,
  };
  const cartBeforeTotal = overrides.cart ? overrides.cart(withTotal) : withTotal;

  // Re-derive the declared total unless the override deliberately set one that
  // disagrees, so an override that changes a price does not accidentally also
  // trip the arithmetic check.
  const cart: ProposedCart =
    overrides.cart &&
    cartBeforeTotal.declaredTotal.amountMinor !== withTotal.declaredTotal.amountMinor
      ? cartBeforeTotal
      : { ...cartBeforeTotal, declaredTotal: computeCartTotals(cartBeforeTotal).computedTotal };

  const totals = computeCartTotals(cart);

  // ---- snapshot -----------------------------------------------------------
  const snapshotId = newSnapshotId();
  const authorizationId = newAuthorizationId();

  const rowHashes = new Map<Sku, Sha256Hex>(
    liveItems.map(item => [item.sku, liveItemRowHash(item)]),
  );

  const unsealed = {
    snapshotId,
    authorizationId,
    merchantId: MERCHANT,
    currency: 'INR' as const,
    cart,
    itemSubtotal: totals.itemSubtotal,
    feeTotal: totals.feeTotal,
    discountTotal: totals.discountTotal,
    total: totals.computedTotal,
    rowHashes,
    liveStateDigest: hash('capturelock.v1.live_state', { merchantId: MERCHANT, at: SNAPSHOT_AT }),
    observedAt: SNAPSHOT_AT,
    expiresAt: addSeconds(SNAPSHOT_AT, 30),
  };

  const baseSnapshot: VerifiedSnapshot = {
    ...unsealed,
    snapshotHash: computeSnapshotHash(unsealed),
    state: 'ISSUED',
    redeemedByReleaseId: null,
  };
  const snapshot = overrides.corruptSnapshot
    ? overrides.corruptSnapshot(baseSnapshot)
    : baseSnapshot;

  // ---- post-snapshot drift (TOCTOU) ---------------------------------------
  // The snapshot above froze the world at quote time. Anything applied here
  // happens between quote and capture, which is exactly the window the
  // freshness stage exists to police.
  const driftedItems = overrides.liveDrift ? overrides.liveDrift([...liveItems]) : liveItems;
  const driftedFeeQuote =
    overrides.liveFeeDrift === undefined ? feeQuote : defaultFeeQuote(overrides.liveFeeDrift);
  const driftedLive: LiveStateResult =
    overrides.liveUnavailable !== undefined
      ? { kind: 'UNAVAILABLE', reason: overrides.liveUnavailable }
      : {
          kind: 'OK',
          state: {
            merchantId: MERCHANT,
            items: new Map<Sku, LiveItemState>(driftedItems.map(item => [item.sku, item])),
            feeQuote: driftedFeeQuote,
            fetchedAt: now,
          },
        };

  const proposal = overrides.proposalDrift ? overrides.proposalDrift(cart) : cart;

  // ---- policy and authorization -------------------------------------------
  const basePolicy = overrides.policy ? overrides.policy(defaultPolicy()) : defaultPolicy();
  const boundPolicyHash = computePolicyHash(basePolicy);
  const policy = overrides.substitutePolicy ?? basePolicy;

  const constraints: IntentConstraints = { ...defaultConstraints(), ...overrides.constraints };
  const intent = {
    rawText: 'Find me the cheapest pair of black running shoes under 5,000 rupees.',
    constraints,
    normalization: {
      method: 'LLM_ASSISTED' as const,
      modelId: 'test-normalizer',
      confirmedByUser: true,
    },
  };

  const baseAuthorization: AuthorizationRecord = {
    authorizationId,
    userId: USER,
    sessionId: SESSION,
    intent,
    intentHash: hash('capturelock.v1.intent', intentHashInput(intent)),
    policyId: basePolicy.policyId,
    policyVersion: basePolicy.version,
    policyHash: boundPolicyHash,
    state: 'ACTIVE',
    createdAt: asTimestamp('2026-09-03T09:30:00.000Z'),
    revokedAt: null,
    consumedByReleaseId: null,
  };
  const authorization = overrides.authorization
    ? overrides.authorization(baseAuthorization)
    : baseAuthorization;

  // ---- execution ----------------------------------------------------------
  const releaseId = newReleaseId();
  const receipt = deriveReceipt(authorizationId, snapshot.snapshotHash);
  const requestFingerprint = hash('capturelock.v1.request_fingerprint', {
    authorizationId,
    snapshotId,
    gate,
  });

  const release: ReleaseRecord = {
    releaseId,
    authorizationId,
    snapshotId,
    state: gate === 'CAPTURE' ? 'PAYMENT_AUTHORIZED' : 'VERIFYING',
    clientIdempotencyKey: 'idem-0123456789abcdef' as ReleaseRecord['clientIdempotencyKey'],
    requestFingerprint,
    receipt,
    amount: totals.computedTotal,
    currency: 'INR',
    providerOrderId: gate === 'CAPTURE' ? 'order_test_1' : null,
    providerPaymentId: gate === 'CAPTURE' ? 'pay_test_1' : null,
    attemptCount: 1,
    inFlightSince: null,
    createdAt: asTimestamp('2026-09-03T09:59:55.000Z'),
    updatedAt: asTimestamp('2026-09-03T09:59:55.000Z'),
    lastReasonCodes: [],
  };

  // Release-shaped overrides are merged onto the complete base record rather
  // than replacing it. A test that only cares about `state` should not have to
  // restate every field, and a partial stub reaching a stage would fail for the
  // wrong reason.
  const mergeRelease = (patch: unknown): ReleaseRecord | null => {
    if (patch === null || patch === undefined) return null;
    return { ...release, ...(patch as Partial<ReleaseRecord>) };
  };

  const executionOverrides = overrides.execution ?? {};
  const execution: ExecutionContext = {
    requestFingerprint,
    // No operator approval unless a test asks for one. A fixture that defaulted
    // to an approval would quietly weaken every refusal test in the suite.
    approvedReview: null,
    attemptsInWindow: 1,
    velocityWindowSeconds: 60,
    maxAttemptsInWindow: 3,
    ...executionOverrides,
    release: 'release' in executionOverrides ? mergeRelease(executionOverrides.release) : release,
    releaseForIdempotencyKey:
      'releaseForIdempotencyKey' in executionOverrides
        ? mergeRelease(executionOverrides.releaseForIdempotencyKey)
        : release,
    otherActiveRelease:
      'otherActiveRelease' in executionOverrides
        ? mergeRelease(executionOverrides.otherActiveRelease)
        : null,
  };

  const context: VerificationContext = deepFreeze({
    gate,
    requestId: newRequestId(),
    evaluatedAt: now,
    principal: overrides.principal ?? { userId: USER, sessionId: SESSION },
    authorization: overrides.omitAuthorization ? null : authorization,
    policy: overrides.omitPolicy ? null : policy,
    snapshot: overrides.omitSnapshot ? null : snapshot,
    proposal,
    live: driftedLive,
    execution,
  });

  return { context, authorization, snapshot, policy: basePolicy, liveItems };
}

export function buildContext(overrides: ScenarioOverrides = {}): VerificationContext {
  return buildScenario(overrides).context;
}
