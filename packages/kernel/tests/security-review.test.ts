/**
 * Findings from the hostile self-review, encoded as tests.
 *
 * Written by deliberately reading the implementation as an attacker rather than
 * as its author. Each case below is a specific bypass that was considered; two
 * of them were real and were fixed (a provider-state transition that accepted
 * too wide a source list, and a refusal that lost its reason codes when its
 * declared transition did not apply). The rest were already closed, and are
 * kept here so they stay closed.
 */

import { describe, it, expect } from 'vitest';
import { canonicalize, computeCartTotals, money } from '@capturelock/core';
import { evaluate } from '../src/kernel.js';
import { mintGrant } from '../src/grant.js';
import { nextState } from '../src/release-fsm.js';
import { buildContext, NOW } from './fixtures.js';

/** mintGrant now demands a nonce and an expiry; see ADR-012. */
const GRANT_OPTIONS = { nonce: 'test-nonce', expiresAt: NOW } as const;
import { Harness, SKU } from './harness.js';

describe('the execution grant cannot be obtained without an ALLOW', () => {
  it('returns null for a DENY', () => {
    const decision = evaluate(buildContext({ omitAuthorization: true }));
    expect(decision.verdict).toBe('DENY');
    expect(
      mintGrant(
        decision,
        'a'.repeat(64) as never,
        {
          releaseId: 'rel_x' as never,
          authorizationId: 'auth_x' as never,
          snapshotId: 'snap_x' as never,
          snapshotHash: 'b'.repeat(64) as never,
          receipt: 'cl_x' as never,
          amount: money('INR', 1),
        },
        GRANT_OPTIONS,
      ),
    ).toBeNull();
  });

  it('returns null for a PAUSE', () => {
    const decision = evaluate(
      buildContext({ execution: { attemptsInWindow: 99, maxAttemptsInWindow: 1 } }),
    );
    expect(decision.verdict).toBe('PAUSE');
    expect(
      mintGrant(
        decision,
        'a'.repeat(64) as never,
        {
          releaseId: 'rel_x' as never,
          authorizationId: 'auth_x' as never,
          snapshotId: 'snap_x' as never,
          snapshotHash: 'b'.repeat(64) as never,
          receipt: 'cl_x' as never,
          amount: money('INR', 1),
        },
        GRANT_OPTIONS,
      ),
    ).toBeNull();
  });

  it('produces a frozen grant that pins the exact amount and cart', () => {
    const decision = evaluate(buildContext());
    const grant = mintGrant(
      decision,
      'a'.repeat(64) as never,
      {
        releaseId: 'rel_x' as never,
        authorizationId: 'auth_x' as never,
        snapshotId: 'snap_x' as never,
        snapshotHash: 'b'.repeat(64) as never,
        receipt: 'cl_x' as never,
        amount: money('INR', 494_900),
      },
      GRANT_OPTIONS,
    );
    expect(grant).not.toBeNull();
    expect(Object.isFrozen(grant)).toBe(true);
    expect(() => {
      (grant as unknown as { amount: unknown }).amount = money('INR', 1);
    }).toThrow(TypeError);
  });
});

describe('the state machine cannot be walked around', () => {
  it('offers no path to a capture call that skips the capture gate', () => {
    for (const from of [
      'DRAFT',
      'VERIFYING',
      'VERIFIED',
      'ORDER_CREATED',
      'PAYMENT_AUTHORIZED',
      'CAPTURE_VERIFYING',
      'PAUSED',
    ] as const) {
      expect(nextState(from, 'CAPTURE_CALL_STARTED')).toBeNull();
    }
    // The one legal entry.
    expect(nextState('CAPTURE_APPROVED', 'CAPTURE_CALL_STARTED')).toBe('CAPTURE_IN_FLIGHT');
  });

  it('offers no path that marks a release captured without a provider call', () => {
    for (const from of [
      'VERIFIED',
      'ORDER_CREATED',
      'PAYMENT_AUTHORIZED',
      'CAPTURE_APPROVED',
    ] as const) {
      expect(nextState(from, 'CAPTURE_SUCCEEDED')).toBeNull();
    }
  });

  it('offers no path out of a settled release', () => {
    expect(nextState('SETTLED', 'CAPTURE_REQUESTED')).toBeNull();
    expect(nextState('SETTLED', 'REVIEW_APPROVED')).toBeNull();
  });
});

describe('agent-supplied values cannot reach a decision', () => {
  it('ignores the cart total the agent declared, using its own recomputation', () => {
    // The agent claims a total of 1 paisa on a cart worth 4,949 rupees. The
    // arithmetic check catches the mismatch, and nothing downstream uses the
    // declared figure.
    const decision = evaluate(
      buildContext({ cart: c => ({ ...c, declaredTotal: money('INR', 1) }) }),
    );
    expect(decision.verdict).toBe('DENY');
    const finding = decision.findings.find(f => f.code === 'CART_ARITHMETIC_MISMATCH');
    expect(finding?.detail['recomputedMinor']).toBe(494_900);
    expect(finding?.detail['declaredMinor']).toBe(1);
  });

  it('checks attributes against live state, not against the agent assertion', () => {
    const decision = evaluate(
      buildContext({
        liveItems: items =>
          items.map(i => ({ ...i, attributes: [{ name: 'colour', value: 'white' }] })),
        cart: c => ({
          ...c,
          lines: c.lines.map(l => ({
            ...l,
            asserted: { ...l.asserted, attributes: [{ name: 'colour', value: 'black' }] },
          })),
        }),
      }),
    );
    // If the check read the assertion, this would have passed.
    expect(decision.reasonCodes).toContain('INTENT_ATTRIBUTE_MISSING');
    expect(decision.reasonCodes).toContain('AGENT_MISREPRESENTED_ITEM');
  });
});

describe('the verified context cannot be mutated mid-pipeline', () => {
  it('freezes the live item map and its contents', () => {
    const context = buildContext();
    if (context.live.kind !== 'OK') throw new Error('expected live state');
    const item = context.live.state.items.get(SKU as never);
    expect(Object.isFrozen(item)).toBe(true);
    expect(() => {
      (item as unknown as { availableStock: number }).availableStock = 9_999;
    }).toThrow(TypeError);
  });

  it('freezes the authorization constraints', () => {
    const context = buildContext();
    expect(() => {
      (context.authorization!.intent.constraints as unknown as { maxTotal: unknown }).maxTotal =
        money('INR', 99_999_999);
    }).toThrow(TypeError);
  });

  it('freezes the snapshot totals', () => {
    const context = buildContext();
    expect(() => {
      (context.snapshot as unknown as { total: unknown }).total = money('INR', 1);
    }).toThrow(TypeError);
  });
});

describe('hostile input cannot corrupt a hash', () => {
  it('refuses to canonicalize a prototype-pollution payload', () => {
    const hostile: unknown = JSON.parse('{"__proto__":{"polluted":true},"sku":"X"}');
    expect(() => canonicalize(hostile)).toThrow(/ASCII identifier/);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('refuses a float that would serialize ambiguously', () => {
    expect(() => canonicalize({ amountMinor: 0.1 + 0.2 })).toThrow(/safe integers/);
  });

  it('refuses a cart whose arithmetic would overflow rather than wrapping', () => {
    expect(() =>
      computeCartTotals({
        merchantId: 'm' as never,
        currency: 'INR',
        lines: [
          {
            sku: 'S' as never,
            quantity: 10_000,
            unitPrice: money('INR', 10_000_000_000_000),
            asserted: { name: 'n', category: 'c', attributes: [] },
          },
        ],
        adjustments: [],
        declaredTotal: money('INR', 0),
        recurring: false,
        shipTo: null,
      }),
    ).toThrow();
  });
});

describe('reconciliation cannot be used to force a state', () => {
  it('does nothing to a release that was never mid-call', async () => {
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    const before = (await h.releases.findById(releaseId as never))!.state;

    const result = await h.reconciliationService.reconcileById(releaseId as never);

    expect(result?.resolvedBy).toBe('NOT_RESOLVED');
    expect(result?.after).toBe(before);
    expect(h.provider.capturedCount()).toBe(0);
  });

  it('never captures anything itself', async () => {
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    await h.authorizePayment(releaseId);
    await h.reconciliationService.reconcileById(releaseId as never);
    // Reconciliation only ever reads from the provider.
    expect(h.provider.callCount('capturePayment')).toBe(0);
    expect(h.provider.capturedCount()).toBe(0);
  });
});

describe('a refusal is always recorded, even when it cannot change the state', () => {
  it('persists reason codes when the declared transition does not apply', async () => {
    // A capture refused while the release sits in PAYMENT_AUTHORIZED cannot use
    // the VERIFICATION_DENIED edge, which starts from CAPTURE_VERIFYING. The
    // release must keep its state and still record why it was refused.
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    await h.authorizePayment(releaseId);
    h.catalog.apply({ kind: 'SET_PRICE', sku: SKU, unitPriceMinor: 489_900 });

    const outcome = await h.releaseService.requestCapture({
      releaseId: releaseId as never,
      idempotencyKey: h.key('denied'),
      principal: h.principal(),
    });
    expect(outcome.verdict).toBe('DENY');

    const release = await h.releases.findById(releaseId as never);
    expect(release?.lastReasonCodes).toContain('LIVE_PRICE_DIVERGED');
    expect(h.provider.capturedCount()).toBe(0);
  });
});

describe('a denied transaction leaves no provider trace', () => {
  it('never calls the provider on any refusal path', async () => {
    for (const overrides of [
      {
        items: [
          {
            ...{
              sku: SKU,
              name: 'n',
              category: 'electronics',
              attributes: [{ name: 'colour', value: 'black' }],
              unitPriceMinor: 479_900,
              availableStock: 12,
            },
          },
        ],
      },
      {
        items: [
          {
            sku: SKU,
            name: 'n',
            category: 'footwear',
            attributes: [{ name: 'colour', value: 'white' }],
            unitPriceMinor: 479_900,
            availableStock: 12,
          },
        ],
      },
      {
        items: [
          {
            sku: SKU,
            name: 'n',
            category: 'footwear',
            attributes: [{ name: 'colour', value: 'black' }],
            unitPriceMinor: 999_900,
            availableStock: 12,
          },
        ],
      },
    ]) {
      const h = new Harness(overrides);
      const authorizationId = await h.setup();
      const snapshotId = await h.quote(authorizationId);
      const outcome = await h.releaseService.requestOrderCreation({
        authorizationId: authorizationId as never,
        snapshotId: snapshotId as never,
        idempotencyKey: h.key('refused'),
        principal: h.principal(),
      });
      expect(outcome.verdict).toBe('DENY');
      expect(h.provider.calls).toHaveLength(0);
    }
  });
});
