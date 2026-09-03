/**
 * Adversarial scenarios against the verification kernel.
 *
 * Each case starts from the fully valid fixture, perturbs exactly one thing an
 * attacker or a confused agent could plausibly change, and asserts both the
 * verdict and the specific reason code. Asserting the code matters: a test that
 * only checks for DENY would still pass if the transaction were refused for an
 * entirely unrelated reason, which would hide the very regression it exists to
 * catch.
 */

import { describe, it, expect } from 'vitest';
import { addSeconds, asTimestamp, type MerchantId, type Sku } from '@capturelock/core';
import { evaluate } from '../src/kernel.js';
import { buildContext, MERCHANT, NOW, SKU_BLACK, attr, inr, USER } from './fixtures.js';
import type { ScenarioOverrides } from './fixtures.js';

function verdictAndCodes(overrides: ScenarioOverrides): {
  verdict: string;
  codes: readonly string[];
} {
  const decision = evaluate(buildContext(overrides));
  return { verdict: decision.verdict, codes: decision.reasonCodes };
}

function expectDeny(overrides: ScenarioOverrides, code: string): void {
  const { verdict, codes } = verdictAndCodes(overrides);
  expect({ verdict, hasCode: codes.includes(code) }).toEqual({ verdict: 'DENY', hasCode: true });
}

describe('S1: agent switches to an unauthorized merchant', () => {
  it('denies when the cart names a merchant outside the authorization', () => {
    expectDeny(
      { cart: c => ({ ...c, merchantId: 'merchant_omega' as MerchantId }) },
      'MERCHANT_NOT_AUTHORIZED',
    );
  });

  it('also reports the operator policy allowlist breach', () => {
    const { codes } = verdictAndCodes({
      cart: c => ({ ...c, merchantId: 'merchant_omega' as MerchantId }),
    });
    expect(codes).toContain('MERCHANT_NOT_IN_ALLOWLIST');
  });
});

describe('S2: transaction exceeds the authorized price', () => {
  it('denies a total over the user ceiling', () => {
    expectDeny(
      {
        liveItems: items => items.map(i => ({ ...i, unitPrice: inr(599_900) })),
      },
      'INTENT_TOTAL_EXCEEDED',
    );
  });

  it('denies one paisa over the ceiling, not just comfortably over', () => {
    // 4,850.01 item + 150.00 shipping = 5,000.01 against a 5,000.00 ceiling.
    expectDeny(
      { liveItems: items => items.map(i => ({ ...i, unitPrice: inr(485_001) })) },
      'INTENT_TOTAL_EXCEEDED',
    );
  });

  it('denies a unit price over the per-item ceiling', () => {
    expectDeny(
      {
        constraints: { maxUnitPrice: inr(400_000) },
      },
      'INTENT_UNIT_PRICE_EXCEEDED',
    );
  });
});

describe('S3: hidden shipping fee pushes the total over the limit', () => {
  const bigShipping = [
    { type: 'SHIPPING' as const, label: 'Standard delivery', amount: inr(90_000) },
  ];

  it('denies when shipping alone breaches the authorized shipping ceiling', () => {
    expectDeny({ liveFeeAdjustments: bigShipping }, 'INTENT_FEE_EXCEEDED');
  });

  it('also denies on the combined total, so the fee is not merely capped in isolation', () => {
    const { codes } = verdictAndCodes({ liveFeeAdjustments: bigShipping });
    expect(codes).toContain('INTENT_TOTAL_EXCEEDED');
    expect(codes).toContain('FEE_EXCEEDS_LIMIT');
  });

  it('catches fees that are each within their own ceiling but excessive together', () => {
    // No single fee breaches a specific cap, but 100 + 100 + 100 exceeds the
    // 300.00 combined ceiling once the item price is added in.
    expectDeny(
      {
        constraints: {
          fees: {
            ...{
              maxShipping: inr(20_000),
              maxTax: inr(20_000),
              maxTip: inr(20_000),
              maxConvenienceFee: inr(20_000),
              maxTotalFees: inr(30_000),
            },
          },
        },
        liveFeeAdjustments: [
          { type: 'SHIPPING', label: 'Standard delivery', amount: inr(15_000) },
          { type: 'TAX', label: 'GST', amount: inr(15_000) },
          { type: 'CONVENIENCE_FEE', label: 'Handling', amount: inr(15_000) },
        ],
      },
      'INTENT_FEE_EXCEEDED',
    );
  });
});

describe('S4: tip exceeds the allowed amount', () => {
  it('denies a tip over the authorized ceiling', () => {
    expectDeny(
      {
        liveFeeAdjustments: [
          { type: 'SHIPPING', label: 'Standard delivery', amount: inr(15_000) },
          { type: 'TIP', label: 'Courier tip', amount: inr(25_000) },
        ],
      },
      'INTENT_FEE_EXCEEDED',
    );
  });
});

describe('S5: product attribute differs from what was authorized', () => {
  it('denies a white shoe when black was required', () => {
    expectDeny(
      {
        liveItems: items =>
          items.map(i => ({ ...i, attributes: [attr('colour', 'white'), attr('size', 'UK9')] })),
        cart: c => ({
          ...c,
          lines: c.lines.map(l => ({
            ...l,
            asserted: { ...l.asserted, attributes: [attr('colour', 'white'), attr('size', 'UK9')] },
          })),
        }),
      },
      'INTENT_ATTRIBUTE_MISSING',
    );
  });

  it('denies an explicitly excluded attribute value', () => {
    const { codes } = verdictAndCodes({
      liveItems: items =>
        items.map(i => ({ ...i, attributes: [attr('colour', 'white'), attr('size', 'UK9')] })),
      cart: c => ({
        ...c,
        lines: c.lines.map(l => ({
          ...l,
          asserted: { ...l.asserted, attributes: [attr('colour', 'white'), attr('size', 'UK9')] },
        })),
      }),
    });
    expect(codes).toContain('INTENT_ATTRIBUTE_FORBIDDEN');
  });

  it('denies a category outside the authorized set', () => {
    expectDeny(
      {
        liveItems: items => items.map(i => ({ ...i, category: 'electronics' })),
        cart: c => ({
          ...c,
          lines: c.lines.map(l => ({ ...l, asserted: { ...l.asserted, category: 'electronics' } })),
        }),
      },
      'INTENT_CATEGORY_MISMATCH',
    );
  });
});

describe('S5b: the agent lies about the item', () => {
  it('denies when the agent asserts an attribute the merchant record contradicts', () => {
    // The live shoe is white; the agent claims it is black to satisfy the
    // constraint. Checking against live truth catches this.
    expectDeny(
      {
        liveItems: items => items.map(i => ({ ...i, attributes: [attr('colour', 'white')] })),
        cart: c => ({
          ...c,
          lines: c.lines.map(l => ({
            ...l,
            asserted: { ...l.asserted, attributes: [attr('colour', 'black')] },
          })),
        }),
      },
      'AGENT_MISREPRESENTED_ITEM',
    );
  });

  it('still denies on the underlying constraint, not only on the lie', () => {
    const { codes } = verdictAndCodes({
      liveItems: items => items.map(i => ({ ...i, attributes: [attr('colour', 'white')] })),
      cart: c => ({
        ...c,
        lines: c.lines.map(l => ({
          ...l,
          asserted: { ...l.asserted, attributes: [attr('colour', 'black')] },
        })),
      }),
    });
    expect(codes).toContain('INTENT_ATTRIBUTE_MISSING');
  });

  it('denies when the agent asserts a category the merchant record contradicts', () => {
    expectDeny(
      {
        cart: c => ({
          ...c,
          lines: c.lines.map(l => ({ ...l, asserted: { ...l.asserted, category: 'groceries' } })),
        }),
      },
      'AGENT_MISREPRESENTED_ITEM',
    );
  });
});

describe('S6: quantity increases beyond the authorized band', () => {
  it('denies a quantity above the authorized maximum', () => {
    expectDeny(
      { cart: c => ({ ...c, lines: c.lines.map(l => ({ ...l, quantity: 3 })) }) },
      'INTENT_QUANTITY_OUT_OF_BAND',
    );
  });

  it('also trips the operator quantity ceiling once it is exceeded', () => {
    const { codes } = verdictAndCodes({
      constraints: { quantity: { min: 1, max: 10 } },
      cart: c => ({ ...c, lines: c.lines.map(l => ({ ...l, quantity: 5 })) }),
    });
    expect(codes).toContain('QUANTITY_EXCEEDS_LIMIT');
  });
});

describe('S7: a subscription is introduced', () => {
  it('denies when the cart establishes a recurring charge', () => {
    expectDeny({ cart: c => ({ ...c, recurring: true }) }, 'SUBSCRIPTION_NOT_AUTHORIZED');
  });

  it('denies when the merchant only sells the item on a recurring plan', () => {
    expectDeny(
      { liveItems: items => items.map(i => ({ ...i, subscriptionOnly: true })) },
      'SUBSCRIPTION_NOT_AUTHORIZED',
    );
  });

  it('reports the operator policy breach as well', () => {
    const { codes } = verdictAndCodes({ cart: c => ({ ...c, recurring: true }) });
    expect(codes).toContain('SUBSCRIPTION_PROHIBITED');
  });
});

describe('S8: currency changes', () => {
  it('denies a cart denominated in a currency the user did not authorize', () => {
    expectDeny(
      {
        cart: c => ({
          ...c,
          currency: 'USD',
          lines: c.lines.map(l => ({ ...l, unitPrice: { currency: 'USD', amountMinor: 5_000 } })),
          adjustments: c.adjustments.map(a => ({
            ...a,
            amount: { currency: 'USD', amountMinor: 200 },
          })),
          declaredTotal: { currency: 'USD', amountMinor: 5_200 },
        }),
      },
      'INTENT_CURRENCY_MISMATCH',
    );
  });

  it('reports the live listing currency divergence too', () => {
    const { codes } = verdictAndCodes({
      cart: c => ({
        ...c,
        currency: 'USD',
        lines: c.lines.map(l => ({ ...l, unitPrice: { currency: 'USD', amountMinor: 5_000 } })),
        adjustments: c.adjustments.map(a => ({
          ...a,
          amount: { currency: 'USD', amountMinor: 200 },
        })),
        declaredTotal: { currency: 'USD', amountMinor: 5_200 },
      }),
    });
    expect(codes).toContain('LIVE_CURRENCY_DIVERGED');
    expect(codes).toContain('CURRENCY_NOT_ALLOWED');
  });
});

describe('S9: the snapshot expires before execution', () => {
  it('denies once the freshness window has passed', () => {
    // The snapshot was observed at 09:59:50 with a 30s window.
    expectDeny({ now: asTimestamp('2026-09-03T10:00:45.000Z') }, 'SNAPSHOT_EXPIRED');
  });

  it('allows right up to the edge of the window', () => {
    expect(evaluate(buildContext({ now: addSeconds(NOW, 19) })).verdict).toBe('ALLOW');
  });

  it('denies one second past the window', () => {
    expectDeny({ now: addSeconds(NOW, 21) }, 'SNAPSHOT_EXPIRED');
  });
});

describe('S10: the price changes after the snapshot (TOCTOU)', () => {
  it('denies when the live price rose between quote and capture', () => {
    // The snapshot vouched for 4,799.00; the merchant now wants 4,899.00.
    // Kept under the 5,000.00 ceiling on purpose, so the refusal can only come
    // from the freshness check and not from a budget breach.
    expectDeny(
      { liveDrift: items => items.map(i => ({ ...i, unitPrice: inr(489_900) })) },
      'LIVE_PRICE_DIVERGED',
    );
  });

  it('denies when the live price FELL, because the user would be overcharged', () => {
    const { verdict, codes } = verdictAndCodes({
      liveDrift: items => items.map(i => ({ ...i, unitPrice: inr(399_900) })),
    });
    expect(verdict).toBe('DENY');
    expect(codes).toContain('LIVE_PRICE_DIVERGED');
    const decision = evaluate(
      buildContext({ liveDrift: items => items.map(i => ({ ...i, unitPrice: inr(399_900) })) }),
    );
    const priceFinding = decision.findings.find(f => f.code === 'LIVE_PRICE_DIVERGED');
    expect(priceFinding?.detail['direction']).toBe('DECREASED');
  });

  it('denies when the merchant now quotes a different shipping fee', () => {
    expectDeny(
      {
        liveFeeAdjustments: [{ type: 'SHIPPING', label: 'Standard delivery', amount: inr(17_500) }],
        cart: c => ({
          ...c,
          adjustments: [{ type: 'SHIPPING', label: 'Standard delivery', amount: inr(15_000) }],
          declaredTotal: inr(494_900),
        }),
      },
      'LIVE_FEE_DIVERGED',
    );
  });

  it('denies a fee the merchant does not quote at all', () => {
    expectDeny(
      {
        liveFeeAdjustments: [{ type: 'SHIPPING', label: 'Standard delivery', amount: inr(15_000) }],
        cart: c => ({
          ...c,
          adjustments: [
            { type: 'SHIPPING', label: 'Standard delivery', amount: inr(15_000) },
            { type: 'CONVENIENCE_FEE', label: 'Invented', amount: inr(5_000) },
          ],
          declaredTotal: inr(499_900),
        }),
      },
      'LIVE_FEE_DIVERGED',
    );
  });
});

describe('S11: inventory changes after the snapshot', () => {
  it('denies when live stock falls below the requested quantity', () => {
    expectDeny(
      { liveItems: items => items.map(i => ({ ...i, availableStock: 0 })) },
      'LIVE_INSUFFICIENT_STOCK',
    );
  });

  it('denies when the item is flagged unavailable', () => {
    expectDeny(
      { liveItems: items => items.map(i => ({ ...i, available: false })) },
      'LIVE_ITEM_UNAVAILABLE',
    );
  });

  it('denies when the SKU vanished from the catalogue', () => {
    expectDeny({ liveItems: () => [] }, 'LIVE_ITEM_NOT_FOUND');
  });
});

describe('S18: the snapshot is modified after issuance', () => {
  it('denies when the stored hash no longer matches the snapshot body', () => {
    expectDeny(
      {
        corruptSnapshot: s => ({
          ...s,
          total: inr(1),
          cart: { ...s.cart, declaredTotal: inr(1) },
        }),
      },
      'SNAPSHOT_HASH_MISMATCH',
    );
  });

  it('denies when a price inside the snapshot cart was edited', () => {
    expectDeny(
      {
        corruptSnapshot: s => ({
          ...s,
          cart: {
            ...s.cart,
            lines: s.cart.lines.map(l => ({ ...l, unitPrice: inr(100) })),
          },
        }),
      },
      'SNAPSHOT_HASH_MISMATCH',
    );
  });

  it('denies when the totals disagree with the lines even if the hash was recomputed', () => {
    // Models an attacker who can write the database and recompute hashes, but
    // must still keep the arithmetic self-consistent.
    const { codes } = verdictAndCodes({
      corruptSnapshot: s => {
        const doctored = { ...s, total: inr(1) };
        return { ...doctored, snapshotHash: s.snapshotHash };
      },
    });
    expect(codes).toContain('SNAPSHOT_TOTALS_INCONSISTENT');
  });

  it('denies when the snapshot belongs to a different authorization', () => {
    expectDeny(
      { corruptSnapshot: s => ({ ...s, authorizationId: 'auth_' + 'f'.repeat(32) }) },
      'SNAPSHOT_NOT_BOUND_TO_AUTHORIZATION',
    );
  });

  it('denies when the snapshot was already redeemed by another release', () => {
    expectDeny(
      { corruptSnapshot: s => ({ ...s, redeemedByReleaseId: 'rel_' + 'a'.repeat(32) }) },
      'SNAPSHOT_ALREADY_REDEEMED',
    );
  });

  it('denies when the cart being charged is not the cart the snapshot vouched for', () => {
    // The agent points at a legitimate quote but submits a different cart.
    expectDeny(
      {
        proposalDrift: c => ({
          ...c,
          lines: c.lines.map(l => ({ ...l, sku: 'SKU-SWAPPED' as Sku })),
        }),
      },
      'PROPOSAL_DIVERGES_FROM_SNAPSHOT',
    );
  });

  it('denies when the agent quietly raises the quantity after the quote', () => {
    expectDeny(
      {
        proposalDrift: c => ({
          ...c,
          lines: c.lines.map(l => ({ ...l, quantity: 2 })),
          declaredTotal: inr(974_800),
        }),
      },
      'PROPOSAL_DIVERGES_FROM_SNAPSHOT',
    );
  });
});

describe('S21/S22/S23/S24/S25: authorization attacks', () => {
  it('denies execution with no authorization at all', () => {
    expectDeny({ omitAuthorization: true }, 'AUTHORIZATION_NOT_FOUND');
  });

  it('denies an expired authorization', () => {
    expectDeny(
      { constraints: { notAfter: asTimestamp('2026-09-03T09:45:00.000Z') } },
      'AUTHORIZATION_EXPIRED',
    );
  });

  it('denies an authorization whose window has not opened', () => {
    expectDeny(
      { constraints: { notBefore: asTimestamp('2026-09-03T10:30:00.000Z') } },
      'AUTHORIZATION_NOT_YET_VALID',
    );
  });

  it('denies a revoked authorization', () => {
    expectDeny(
      { authorization: a => ({ ...a, state: 'REVOKED', revokedAt: NOW }) },
      'AUTHORIZATION_REVOKED',
    );
  });

  it('denies replay of an authorization already spent by a settled release', () => {
    expectDeny(
      {
        authorization: a => ({
          ...a,
          state: 'CONSUMED',
          consumedByReleaseId: 'rel_' + 'b'.repeat(32),
        }),
      },
      'AUTHORIZATION_ALREADY_CONSUMED',
    );
  });

  it('denies a request from a different session', () => {
    expectDeny({ principal: { userId: USER, sessionId: 'sess_attacker' } }, 'SESSION_MISMATCH');
  });

  it('denies a request from a different user', () => {
    expectDeny(
      { principal: { userId: 'user_mallory' as typeof USER, sessionId: 'sess_01' } },
      'USER_MISMATCH',
    );
  });

  it('denies when the stored constraints were edited after issuance', () => {
    // An attacker with database access raises the budget from 5,000 to 50,000.
    // The recorded intent hash no longer matches, so the raised ceiling is
    // never enforced.
    expectDeny(
      {
        authorization: a => ({
          ...a,
          intent: {
            ...a.intent,
            constraints: { ...a.intent.constraints, maxTotal: inr(5_000_000) },
          },
        }),
      },
      'INTENT_HASH_MISMATCH',
    );
  });
});

describe('policy substitution', () => {
  it('denies when a different policy is served than the one bound at issuance', () => {
    expectDeny(
      {
        substitutePolicy: {
          policyId: 'household_default',
          version: '1.0.0',
          name: 'Permissive replacement',
          createdAt: asTimestamp('2026-09-01T00:00:00.000Z'),
          rules: [],
        },
      },
      'POLICY_HASH_MISMATCH',
    );
  });

  it('denies when no policy is bound at all', () => {
    expectDeny({ omitPolicy: true }, 'POLICY_NOT_FOUND');
  });

  it('denies on a policy rule this build cannot interpret', () => {
    expectDeny(
      {
        policy: p => ({
          ...p,
          rules: [
            ...p.rules,
            {
              ruleId: 'future_rule',
              kind: 'MAX_CARBON_FOOTPRINT',
              description: 'From a newer deployment',
              severity: 'DENY',
              grams: 100,
            },
          ],
        }),
      },
      'POLICY_RULE_UNKNOWN',
    );
  });
});

describe('fail-closed behaviour', () => {
  it('denies when live merchant state cannot be read', () => {
    expectDeny({ liveUnavailable: 'merchant probe timed out' }, 'LIVE_STATE_UNAVAILABLE');
  });

  it('records the blocked stages rather than reporting a clean pass', () => {
    const decision = evaluate(buildContext({ liveUnavailable: 'merchant probe timed out' }));
    const blockedStages = decision.stages.filter(s => s.status === 'SKIPPED_BLOCKED');
    expect(blockedStages.map(s => s.stage).sort()).toEqual(['FRESHNESS', 'INTENT', 'POLICY']);
    expect(decision.reasonCodes).toContain('STAGE_DID_NOT_COMPLETE');
  });

  it('never returns ALLOW when any stage was blocked', () => {
    const decision = evaluate(buildContext({ omitSnapshot: true }));
    expect(decision.verdict).toBe('DENY');
    expect(decision.reasonCodes).toContain('SNAPSHOT_NOT_FOUND');
  });

  it('denies a cart whose declared total disagrees with its own line items', () => {
    expectDeny({ cart: c => ({ ...c, declaredTotal: inr(1) }) }, 'CART_ARITHMETIC_MISMATCH');
  });

  it('denies a cart with the same SKU on two lines', () => {
    expectDeny(
      {
        cart: c => ({
          ...c,
          lines: [c.lines[0]!, { ...c.lines[0]!, sku: SKU_BLACK }],
        }),
      },
      'DUPLICATE_LINE_ITEM',
    );
  });
});

describe('execution-state attacks', () => {
  it('denies when an idempotency key returns with a different payload', () => {
    expectDeny(
      {
        execution: {
          releaseForIdempotencyKey: {
            requestFingerprint: 'f'.repeat(64),
          } as never,
        },
      },
      'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
    );
  });

  it('denies acting on a release that already reached a terminal state', () => {
    expectDeny(
      { execution: { release: { state: 'SETTLED' } as never } },
      'RELEASE_ALREADY_TERMINAL',
    );
  });

  it('denies capturing from a state the machine does not permit', () => {
    expectDeny(
      { execution: { release: { state: 'DRAFT' } as never } },
      'INVALID_RELEASE_STATE_FOR_GATE',
    );
  });

  it('denies a second live release against the same authorization', () => {
    expectDeny(
      {
        execution: {
          otherActiveRelease: {
            releaseId: ('rel_' + 'e'.repeat(32)) as never,
            state: 'CAPTURE_IN_FLIGHT',
          } as never,
        },
      },
      'AUTHORIZATION_HAS_ACTIVE_RELEASE',
    );
  });

  it('pauses rather than denying on a retry storm, since the transaction may be valid', () => {
    const decision = evaluate(
      buildContext({ execution: { attemptsInWindow: 9, maxAttemptsInWindow: 3 } }),
    );
    expect(decision.verdict).toBe('PAUSE');
    expect(decision.reasonCodes).toContain('RETRY_VELOCITY_EXCEEDED');
  });
});

describe('merchant identity', () => {
  it('denies when live state was read from a different merchant than the cart names', () => {
    expectDeny(
      {
        cart: c => ({ ...c, merchantId: 'merchant_omega' as MerchantId }),
        constraints: { merchants: { mode: 'ANY' } },
        policy: p => ({
          ...p,
          rules: p.rules.filter(r => (r as { ruleId: string }).ruleId !== 'merchant_allowlist'),
        }),
      },
      'LIVE_MERCHANT_DIVERGED',
    );
  });

  it('confirms the fixture merchant is the authorized one', () => {
    expect(MERCHANT).toBe('merchant_alpha');
  });
});
