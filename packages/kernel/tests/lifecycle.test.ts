/**
 * End-to-end lifecycle and exactly-once scenarios.
 *
 * These are the cases where the interesting failure is not "the wrong verdict"
 * but "the right verdict, twice". They run the real services against real
 * repositories, with only the merchant and the payment provider replaced by
 * doubles that reproduce the semantics of the systems they stand in for.
 */

import { describe, it, expect } from 'vitest';
import { Harness, MERCHANT, SKU, inr } from './harness.js';

describe('the full happy path', () => {
  it('carries a transaction from intent to settlement', async () => {
    const h = new Harness();
    const { releaseId } = await h.openOrder();

    const paymentId = await h.authorizePayment(releaseId);
    const capture = await h.releaseService.requestCapture({
      releaseId: releaseId as never,
      idempotencyKey: h.key('cap1'),
      principal: h.principal(),
    });

    expect(capture.verdict).toBe('ALLOW');
    expect(capture.state).toBe('CAPTURED');
    expect(capture.moneyMoved).toBe(true);
    expect(h.provider.capturedCount()).toBe(1);
    expect((await h.provider.getPayment(paymentId))?.status).toBe('captured');
  });

  it('marks the authorization consumed so it cannot fund a second purchase', async () => {
    const h = new Harness();
    const { releaseId, authorizationId } = await h.openOrder();
    await h.authorizePayment(releaseId);

    await h.releaseService.requestCapture({
      releaseId: releaseId as never,
      idempotencyKey: h.key('cap1'),
      principal: h.principal(),
    });

    const authorization = await h.authorizations.findById(authorizationId as never);
    expect(authorization?.state).toBe('CONSUMED');
    expect(authorization?.consumedByReleaseId).toBe(releaseId);
  });

  it('prices the cart from live state rather than from anything the agent said', async () => {
    const h = new Harness();
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);
    const snapshot = await h.snapshots.findById(snapshotId as never);

    // 4,799.00 item + 150.00 shipping, all server-derived.
    expect(snapshot?.itemSubtotal.amountMinor).toBe(479_900);
    expect(snapshot?.feeTotal.amountMinor).toBe(15_000);
    expect(snapshot?.total.amountMinor).toBe(494_900);
    expect(snapshot?.cart.lines[0]?.unitPrice.amountMinor).toBe(479_900);
  });
});

describe('S12: duplicate execution request', () => {
  it('returns the stored answer for a repeated order request without calling the provider', async () => {
    const h = new Harness();
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);
    const request = {
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('same'),
      principal: h.principal(),
    };

    const first = await h.releaseService.requestOrderCreation(request);
    const second = await h.releaseService.requestOrderCreation(request);

    expect(first.verdict).toBe('ALLOW');
    expect(second.replayed).toBe(true);
    expect(second.releaseId).toBe(first.releaseId);
    expect(h.provider.callCount('createOrder')).toBe(1);
    expect(h.provider.orderCount()).toBe(1);
    expect(h.releases.count()).toBe(1);
  });

  it('refuses a second capture on the same release', async () => {
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    await h.authorizePayment(releaseId);
    const request = {
      releaseId: releaseId as never,
      idempotencyKey: h.key('cap1'),
      principal: h.principal(),
    };

    const first = await h.releaseService.requestCapture(request);
    const second = await h.releaseService.requestCapture(request);

    expect(first.state).toBe('CAPTURED');
    expect(second.verdict).not.toBe('ALLOW');
    // The only thing that matters: the money moved exactly once.
    expect(h.provider.capturedCount()).toBe(1);
    expect(h.provider.callCount('capturePayment')).toBe(1);
  });

  it('refuses when an idempotency key returns with a different request', async () => {
    const h = new Harness();
    const authorizationId = await h.setup();
    const snapshotA = await h.quote(authorizationId);

    await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotA as never,
      idempotencyKey: h.key('shared'),
      principal: h.principal(),
    });

    const snapshotB = await h.quote(authorizationId);
    const reused = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotB as never,
      idempotencyKey: h.key('shared'),
      principal: h.principal(),
    });

    expect(reused.verdict).toBe('DENY');
    expect(reused.reasonCodes).toContain('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
    expect(h.provider.orderCount()).toBe(1);
  });
});

describe('S13: concurrent execution requests', () => {
  it('creates exactly one order when five requests race with distinct keys', async () => {
    const h = new Harness();
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(n =>
        h.releaseService.requestOrderCreation({
          authorizationId: authorizationId as never,
          snapshotId: snapshotId as never,
          idempotencyKey: h.key(`race${n}`),
          principal: h.principal(),
        }),
      ),
    );

    // The partial unique index on (authorization_id) for non-terminal releases
    // is what enforces this, not application logic.
    const allowed = results.filter(r => r.verdict === 'ALLOW');
    expect(allowed).toHaveLength(1);
    expect(h.provider.orderCount()).toBe(1);
    expect(h.releases.count()).toBe(1);

    const refused = results.filter(r => r.verdict !== 'ALLOW');
    expect(refused.every(r => r.reasonCodes.includes('AUTHORIZATION_HAS_ACTIVE_RELEASE'))).toBe(
      true,
    );
  });

  it('captures exactly once when five capture requests race', async () => {
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    await h.authorizePayment(releaseId);

    await Promise.all(
      [1, 2, 3, 4, 5].map(n =>
        h.releaseService.requestCapture({
          releaseId: releaseId as never,
          idempotencyKey: h.key(`cap${n}`),
          principal: h.principal(),
        }),
      ),
    );

    expect(h.provider.capturedCount()).toBe(1);
    expect(h.provider.callCount('capturePayment')).toBe(1);
  });

  it('never lets the same snapshot be redeemed by two releases', async () => {
    const h = new Harness();
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);

    await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('first'),
      principal: h.principal(),
    });

    const snapshot = await h.snapshots.findById(snapshotId as never);
    expect(snapshot?.state).toBe('REDEEMED');
    expect(await h.snapshots.claimForRelease(snapshotId as never, 'rel_other' as never)).toBeNull();
  });
});

describe('S14: provider timeout followed by retry', () => {
  it('records ORDER_INDETERMINATE and recovers the order by receipt lookup', async () => {
    const h = new Harness();
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);
    h.provider.failNextOrderWith('TIMEOUT_AFTER_APPLY');

    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('timeout'),
      principal: h.principal(),
    });
    expect(outcome.state).toBe('ORDER_INDETERMINATE');
    // The order exists at the provider even though we never saw the response.
    expect(h.provider.orderCount()).toBe(1);

    const reconciled = await h.reconciliationService.reconcileById(outcome.releaseId as never);
    expect(reconciled?.after).toBe('ORDER_CREATED');
    expect(reconciled?.resolvedBy).toBe('ORDER_LOOKUP');
    // Reconciliation never re-creates: still exactly one order.
    expect(h.provider.orderCount()).toBe(1);
    expect(h.provider.callCount('createOrder')).toBe(1);
  });

  it('stays indeterminate on an empty lookup until the provider lag window has passed', async () => {
    // An empty receipt lookup is NOT proof the order was never created:
    // Razorpay's receipt search is eventually consistent. Concluding FAILED
    // immediately would strand a real order. See ADR-015.
    const h = new Harness();
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);
    h.provider.failNextOrderWith('TIMEOUT_BEFORE_APPLY');

    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('nothing'),
      principal: h.principal(),
    });
    expect(outcome.state).toBe('ORDER_INDETERMINATE');

    const early = await h.reconciliationService.reconcileById(outcome.releaseId as never);
    expect(early?.after).toBe('ORDER_INDETERMINATE');
    expect(early?.resolvedBy).toBe('NOT_RESOLVED');
  });

  it('concludes FAILED once the lag window has passed and the order still is not there', async () => {
    const h = new Harness();
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);
    h.provider.failNextOrderWith('TIMEOUT_BEFORE_APPLY');

    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('nothing'),
      principal: h.principal(),
    });

    // Past the point where "not indexed yet" is a plausible explanation.
    h.clock.advanceBySeconds(120);

    const reconciled = await h.reconciliationService.reconcileById(outcome.releaseId as never);
    expect(reconciled?.after).toBe('FAILED');
    expect(h.provider.orderCount()).toBe(0);
  });

  it('does NOT re-capture after a lost capture response: it asks the provider', async () => {
    // The scenario that breaks naive systems. The capture succeeded; the
    // response was lost. A retry would either double-charge or be misread as a
    // failure while the money has already gone.
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    await h.authorizePayment(releaseId);
    h.provider.failNextCaptureWith('TIMEOUT_AFTER_APPLY');

    const outcome = await h.releaseService.requestCapture({
      releaseId: releaseId as never,
      idempotencyKey: h.key('cap1'),
      principal: h.principal(),
    });
    expect(outcome.state).toBe('CAPTURE_INDETERMINATE');
    expect(outcome.moneyMoved).toBe(false); // we do not yet know
    expect(h.provider.capturedCount()).toBe(1); // but it did

    const reconciled = await h.reconciliationService.reconcileById(releaseId as never);
    expect(reconciled?.after).toBe('CAPTURED');
    expect(reconciled?.moneyMoved).toBe(true);
    expect(reconciled?.resolvedBy).toBe('PAYMENT_LOOKUP');
    // The critical assertion: still exactly one capture call, ever.
    expect(h.provider.callCount('capturePayment')).toBe(1);
    expect(h.provider.capturedCount()).toBe(1);
  });

  it('resolves to CAPTURE_REJECTED when the capture truly never happened', async () => {
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    await h.authorizePayment(releaseId);
    h.provider.failNextCaptureWith('TIMEOUT_BEFORE_APPLY');

    await h.releaseService.requestCapture({
      releaseId: releaseId as never,
      idempotencyKey: h.key('cap1'),
      principal: h.principal(),
    });

    const reconciled = await h.reconciliationService.reconcileById(releaseId as never);
    expect(reconciled?.after).toBe('CAPTURE_REJECTED');
    expect(reconciled?.moneyMoved).toBe(false);
    expect(h.provider.capturedCount()).toBe(0);
  });

  it('stays stuck rather than guessing when the provider cannot be reached at all', async () => {
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    await h.authorizePayment(releaseId);
    h.provider.failNextCaptureWith('TIMEOUT_AFTER_APPLY');
    await h.releaseService.requestCapture({
      releaseId: releaseId as never,
      idempotencyKey: h.key('cap1'),
      principal: h.principal(),
    });

    // Wipe the provider's knowledge of the payment to model an unreachable API.
    const stuck = (await h.releases.findById(releaseId as never))!;
    await h.releases.transition(
      releaseId as never,
      [stuck.state],
      'CAPTURE_INDETERMINATE',
      { providerPaymentId: 'pay_unknown' },
      h.clock.now(),
    );

    const reconciled = await h.reconciliationService.reconcileById(releaseId as never);
    expect(reconciled?.resolvedBy).toBe('NOT_RESOLVED');
    expect(reconciled?.after).toBe('CAPTURE_INDETERMINATE');
  });

  it('finds stuck releases through the sweep', async () => {
    const h = new Harness();
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);
    h.provider.failNextOrderWith('TIMEOUT_AFTER_APPLY');
    await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('sweep'),
      principal: h.principal(),
    });

    h.clock.advanceBySeconds(120);
    const swept = await h.reconciliationService.sweep();
    expect(swept).toHaveLength(1);
    expect(swept[0]?.after).toBe('ORDER_CREATED');
  });
});

describe('capture-time re-verification', () => {
  it('refuses at capture when the price moved after the order was created', async () => {
    // The heart of the product: the order was approved, then the world changed.
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    await h.authorizePayment(releaseId);

    h.catalog.apply({ kind: 'SET_PRICE', sku: SKU, unitPriceMinor: 489_900 });

    const capture = await h.releaseService.requestCapture({
      releaseId: releaseId as never,
      idempotencyKey: h.key('cap1'),
      principal: h.principal(),
    });

    expect(capture.verdict).toBe('DENY');
    expect(capture.reasonCodes).toContain('LIVE_PRICE_DIVERGED');
    expect(h.provider.capturedCount()).toBe(0);
    expect(h.provider.callCount('capturePayment')).toBe(0);
  });

  it('refuses at capture when stock ran out after the order was created', async () => {
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    await h.authorizePayment(releaseId);

    h.catalog.apply({ kind: 'SET_STOCK', sku: SKU, availableStock: 0 });

    const capture = await h.releaseService.requestCapture({
      releaseId: releaseId as never,
      idempotencyKey: h.key('cap1'),
      principal: h.principal(),
    });
    expect(capture.reasonCodes).toContain('LIVE_INSUFFICIENT_STOCK');
    expect(h.provider.capturedCount()).toBe(0);
  });

  it('refuses at capture when the merchant becomes unreachable', async () => {
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    await h.authorizePayment(releaseId);

    h.catalog.apply({ kind: 'GO_OFFLINE', reason: 'merchant probe timed out' });

    const capture = await h.releaseService.requestCapture({
      releaseId: releaseId as never,
      idempotencyKey: h.key('cap1'),
      principal: h.principal(),
    });
    expect(capture.verdict).toBe('DENY');
    expect(capture.reasonCodes).toContain('LIVE_STATE_UNAVAILABLE');
    expect(h.provider.capturedCount()).toBe(0);
  });

  it('refuses at capture once the snapshot has expired', async () => {
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    await h.authorizePayment(releaseId);

    h.clock.advanceBySeconds(120);

    const capture = await h.releaseService.requestCapture({
      releaseId: releaseId as never,
      idempotencyKey: h.key('cap1'),
      principal: h.principal(),
    });
    expect(capture.reasonCodes).toContain('SNAPSHOT_EXPIRED');
    expect(h.provider.capturedCount()).toBe(0);
  });
});

describe('quote issuance', () => {
  it('refuses to issue a quote from a merchant it cannot read', async () => {
    const h = new Harness();
    const authorizationId = await h.setup();
    h.catalog.apply({ kind: 'GO_OFFLINE', reason: 'catalogue unavailable' });

    const result = await h.quoteService.issue({
      authorizationId: authorizationId as never,
      merchantId: MERCHANT,
      lines: [{ sku: SKU, quantity: 1 }],
      shipTo: { country: 'IN', region: null },
      recurring: false,
    });
    expect(result.kind).toBe('LIVE_STATE_UNAVAILABLE');
  });

  it('refuses to quote an unknown SKU', async () => {
    const h = new Harness();
    const authorizationId = await h.setup();
    const result = await h.quoteService.issue({
      authorizationId: authorizationId as never,
      merchantId: MERCHANT,
      lines: [{ sku: 'SKU-NOPE' as never, quantity: 1 }],
      shipTo: { country: 'IN', region: null },
      recurring: false,
    });
    expect(result.kind).toBe('ITEM_NOT_FOUND');
  });

  it('refuses to quote against an authorization that does not exist', async () => {
    const h = new Harness();
    const result = await h.quoteService.issue({
      authorizationId: ('auth_' + 'f'.repeat(32)) as never,
      merchantId: MERCHANT,
      lines: [{ sku: SKU, quantity: 1 }],
      shipTo: null,
      recurring: false,
    });
    expect(result.kind).toBe('AUTHORIZATION_NOT_FOUND');
  });
});

describe('policy refusals reach the provider boundary, not past it', () => {
  it('never calls the provider when the kernel refuses', async () => {
    const h = new Harness({
      items: [
        {
          sku: SKU,
          name: 'Trailblaze Runner',
          category: 'footwear',
          attributes: [{ name: 'colour', value: 'white' }],
          unitPriceMinor: 479_900,
          availableStock: 12,
        },
      ],
    });
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);

    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('white'),
      principal: h.principal(),
    });

    expect(outcome.verdict).toBe('DENY');
    expect(outcome.reasonCodes).toContain('INTENT_ATTRIBUTE_MISSING');
    expect(h.provider.calls).toHaveLength(0);
  });

  it('never calls the provider when the total exceeds the ceiling', async () => {
    const h = new Harness({
      items: [
        {
          ...{
            sku: SKU,
            name: 'Trailblaze Runner',
            category: 'footwear',
            attributes: [{ name: 'colour', value: 'black' }],
            availableStock: 12,
          },
          unitPriceMinor: 599_900,
        },
      ],
    });
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);

    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('expensive'),
      principal: h.principal(),
    });

    expect(outcome.verdict).toBe('DENY');
    expect(outcome.reasonCodes).toContain('INTENT_TOTAL_EXCEEDED');
    expect(h.provider.calls).toHaveLength(0);
  });

  it('refuses a hidden fee added by the merchant between quotes', async () => {
    const h = new Harness();
    const authorizationId = await h.setup();
    h.catalog.apply({
      kind: 'SET_FEES',
      adjustments: [
        { type: 'SHIPPING', label: 'Standard delivery', amount: inr(15_000) },
        { type: 'CONVENIENCE_FEE', label: 'Handling', amount: inr(90_000) },
      ],
    });
    const snapshotId = await h.quote(authorizationId);

    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('fees'),
      principal: h.principal(),
    });
    expect(outcome.verdict).toBe('DENY');
    expect(outcome.reasonCodes).toContain('INTENT_FEE_EXCEEDED');
    expect(h.provider.calls).toHaveLength(0);
  });
});
