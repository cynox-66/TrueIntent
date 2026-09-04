/**
 * Regressions from the pre-demo hardening pass.
 *
 * Each block corresponds to a defect that was reachable in the committed system
 * and is now closed. The comments say what the failure actually was, because a
 * test whose motivation is lost gets deleted the next time it is inconvenient.
 */

import { describe, it, expect } from 'vitest';
import { STAGE_IDS, asTimestamp, money, type Timestamp } from '@capturelock/core';
import { combine } from '../src/combine.js';
import { GuardedPaymentExecutor, GrantRejectedError } from '../src/payment-executor.js';
import { mintGrant } from '../src/grant.js';
import { nextState } from '../src/release-fsm.js';
import { Harness, SKU } from './harness.js';
import type { PolicyDocument } from '@capturelock/policy';

// ---------------------------------------------------------------- webhooks --

describe('a signed webhook must still belong to the release it addresses', () => {
  /**
   * The signature proves the sender holds the webhook secret. It does not prove
   * the entity inside belongs to this release.
   *
   * Before the fix the release adopted whatever `payment_id` the event carried.
   * The capture gate would then present that id to the provider with THIS
   * release's amount — capturing a payment we never created an order for, or
   * being terminally rejected on an amount mismatch for a payment that was
   * perfectly fine.
   */
  it('refuses an event whose amount is not the release amount', async () => {
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    const release = await h.releases.findById(releaseId as never);

    const result = await h.webhookService.ingest({
      providerEventId: 'evt_wrong_amount',
      eventType: 'payment.authorized',
      signatureValid: true,
      payload: {},
      providerEventAt: h.clock.now(),
      paymentId: 'pay_from_another_order',
      orderId: release!.providerOrderId,
      amountMinor: release!.amount.amountMinor + 1,
      currency: release!.amount.currency,
    });

    expect(result).toMatchObject({
      kind: 'ENTITY_MISMATCH_IGNORED',
      reasonCode: 'WEBHOOK_ENTITY_MISMATCH',
    });

    // The critical assertion: the payment was NOT bound to the release.
    const after = await h.releases.findById(releaseId as never);
    expect(after?.providerPaymentId).toBeNull();
    expect(after?.state).toBe('ORDER_CREATED');
  });

  it('refuses an event carrying a different currency', async () => {
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    const release = await h.releases.findById(releaseId as never);

    const result = await h.webhookService.ingest({
      providerEventId: 'evt_wrong_currency',
      eventType: 'payment.authorized',
      signatureValid: true,
      payload: {},
      providerEventAt: h.clock.now(),
      paymentId: 'pay_x',
      orderId: release!.providerOrderId,
      amountMinor: release!.amount.amountMinor,
      currency: 'USD',
    });

    expect(result.kind).toBe('ENTITY_MISMATCH_IGNORED');
    expect((await h.releases.findById(releaseId as never))?.providerPaymentId).toBeNull();
  });

  it('refuses an event naming an order that is not this release’s order', async () => {
    // Reachable when a payment id happens to correlate to one release while the
    // event's order belongs to another — the case that would previously have
    // silently rewritten `providerOrderId`.
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    const release = await h.releases.findById(releaseId as never);

    const authorized = await h.webhookService.ingest({
      providerEventId: 'evt_ok',
      eventType: 'payment.authorized',
      signatureValid: true,
      payload: {},
      providerEventAt: h.clock.now(),
      paymentId: 'pay_bound',
      orderId: release!.providerOrderId,
      amountMinor: release!.amount.amountMinor,
      currency: release!.amount.currency,
    });
    expect(authorized.kind).toBe('APPLIED');

    const contradictory = await h.webhookService.ingest({
      providerEventId: 'evt_contradictory',
      eventType: 'payment.captured',
      signatureValid: true,
      payload: {},
      providerEventAt: h.clock.now(),
      paymentId: 'pay_bound',
      orderId: 'order_belonging_to_someone_else',
      amountMinor: release!.amount.amountMinor,
      currency: release!.amount.currency,
    });

    expect(contradictory.kind).toBe('ENTITY_MISMATCH_IGNORED');
    const after = await h.releases.findById(releaseId as never);
    // The recorded order id is ours, not the one the event asserted.
    expect(after?.providerOrderId).toBe(release!.providerOrderId);
  });

  it('still applies an event that agrees with the release', async () => {
    // The check must not be so strict that it refuses legitimate traffic.
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    const release = await h.releases.findById(releaseId as never);

    const result = await h.webhookService.ingest({
      providerEventId: 'evt_matching',
      eventType: 'payment.authorized',
      signatureValid: true,
      payload: {},
      providerEventAt: h.clock.now(),
      paymentId: 'pay_correct',
      orderId: release!.providerOrderId,
      amountMinor: release!.amount.amountMinor,
      currency: release!.amount.currency,
    });

    expect(result).toMatchObject({ kind: 'APPLIED', state: 'PAYMENT_AUTHORIZED' });
    expect((await h.releases.findById(releaseId as never))?.providerPaymentId).toBe('pay_correct');
  });

  it('applies an event that omits the amount rather than inventing a mismatch', async () => {
    // A field the provider did not send is not evidence of anything.
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    const release = await h.releases.findById(releaseId as never);

    const result = await h.webhookService.ingest({
      providerEventId: 'evt_no_amount',
      eventType: 'payment.authorized',
      signatureValid: true,
      payload: {},
      providerEventAt: h.clock.now(),
      paymentId: 'pay_no_amount',
      orderId: release!.providerOrderId,
    });

    expect(result.kind).toBe('APPLIED');
  });
});

// ------------------------------------------------------------ review paths --

describe('approving a pause returns the release to the gate that paused it', () => {
  /**
   * `REVIEW_APPROVED` used to send every paused release to `CAPTURE_VERIFYING`.
   *
   * For a release paused at gate 1 that is a dead end: no order exists, so no
   * payment exists, so the capture gate refuses with
   * `INVALID_RELEASE_STATE_FOR_GATE` and the release is DENIED. The operator's
   * approval produced a permanent denial and the order was never created.
   */
  it('sends a gate-1 pause back to the order gate, not to the capture gate', () => {
    expect(nextState('PAUSED', 'REVIEW_APPROVED_AT_ORDER_GATE')).toBe('VERIFYING');
    expect(nextState('PAUSED', 'REVIEW_APPROVED')).toBe('CAPTURE_VERIFYING');
  });

  it('does not resurrect a terminal release through either edge', () => {
    for (const trigger of ['REVIEW_APPROVED', 'REVIEW_APPROVED_AT_ORDER_GATE'] as const) {
      expect(nextState('DENIED', trigger)).toBeNull();
      expect(nextState('SETTLED', trigger)).toBeNull();
      expect(nextState('ABORTED', trigger)).toBeNull();
    }
  });
});

// ------------------------------------------------------------------ grants --

describe('the executor bounds what it remembers without widening replay', () => {
  const clockAt = (t: Timestamp) => ({ now: () => t });

  function grantAt(expiresAt: Timestamp, nonce: string) {
    return mintGrant(
      {
        verdict: 'ALLOW',
        reasonCodes: [],
        findings: [],
        evaluatedAt: asTimestamp('2026-09-04T10:00:00.000Z'),
        stages: [],
      } as never,
      'a'.repeat(64) as never,
      {
        releaseId: 'rel_1' as never,
        authorizationId: 'auth_1' as never,
        snapshotId: 'snap_1' as never,
        snapshotHash: 'b'.repeat(64) as never,
        receipt: 'cl_r' as never,
        amount: money('INR', 1000),
      },
      { nonce, expiresAt },
    )!;
  }

  it('still refuses a second use of a live grant', async () => {
    // The property that must not regress.
    const provider = { name: 'fake', createOrder: async () => ({ kind: 'INDETERMINATE' }) };
    const executor = new GuardedPaymentExecutor(
      provider as never,
      clockAt(asTimestamp('2026-09-04T10:00:00.000Z')),
    );
    const grant = grantAt(asTimestamp('2026-09-04T10:00:30.000Z'), 'nonce-live');

    await executor.createOrder(grant, {
      receipt: 'cl_r' as never,
      amount: money('INR', 1000),
      notes: {},
    });
    await expect(
      executor.createOrder(grant, {
        receipt: 'cl_r' as never,
        amount: money('INR', 1000),
        notes: {},
      }),
    ).rejects.toBeInstanceOf(GrantRejectedError);
  });

  it('forgets a nonce only once its grant could no longer be presented', async () => {
    // Retaining every nonce for the life of the process is an unbounded leak;
    // dropping one early would widen the replay window. Neither is acceptable,
    // so eviction is tied to the same expiry the guard already enforces.
    const provider = { name: 'fake', createOrder: async () => ({ kind: 'INDETERMINATE' }) };
    let now = asTimestamp('2026-09-04T10:00:00.000Z');
    const executor = new GuardedPaymentExecutor(provider as never, { now: () => now });

    const expired = grantAt(asTimestamp('2026-09-04T10:00:10.000Z'), 'nonce-old');
    await executor.createOrder(expired, {
      receipt: 'cl_r' as never,
      amount: money('INR', 1000),
      notes: {},
    });
    expect(executor.consumedCount()).toBe(1);

    // Well past the first grant's expiry. Burning a second grant sweeps it.
    now = asTimestamp('2026-09-04T10:05:00.000Z');
    const fresh = grantAt(asTimestamp('2026-09-04T10:05:30.000Z'), 'nonce-new');
    await executor.createOrder(fresh, {
      receipt: 'cl_r' as never,
      amount: money('INR', 1000),
      notes: {},
    });
    expect(executor.consumedCount()).toBe(1);

    // And the forgotten nonce is still unusable — expiry is checked first.
    await expect(
      executor.createOrder(expired, {
        receipt: 'cl_r' as never,
        amount: money('INR', 1000),
        notes: {},
      }),
    ).rejects.toMatchObject({ reason: 'EXPIRED' });
  });
});

// -------------------------------------------------------- approval breadth --

describe('an operator approval is bound, not a blanket waiver', () => {
  /**
   * This is the one place in CaptureLock where a refusal becomes an approval,
   * so the boundaries matter more than the happy path.
   */
  const APPROVAL = {
    reviewId: 'rev_1',
    boundTo: 'f'.repeat(64) as never,
    reasonCodes: ['TOTAL_EXCEEDS_LIMIT'],
    resolvedBy: 'operator_dev',
    resolvedAt: asTimestamp('2026-09-04T10:00:00.000Z'),
  };

  function pauseFinding(code: string) {
    return {
      code,
      severity: 'PAUSE' as const,
      stage: 'POLICY' as const,
      message: code,
      detail: {},
    };
  }

  function run(
    findings: readonly unknown[],
    options: { approval?: unknown; fingerprint?: string } = {},
  ) {
    return combine(
      [
        ...STAGE_IDS.map(stage => ({
          stage,
          status: 'COMPLETED' as const,
          findings: stage === 'POLICY' ? findings : [],
        })),
      ] as never,
      'ORDER_CREATION',
      asTimestamp('2026-09-04T10:00:05.000Z'),
      {
        approval: (options.approval === undefined ? APPROVAL : options.approval) as never,
        requestFingerprint: (options.fingerprint ?? 'f'.repeat(64)) as never,
      },
    );
  }

  it('clears a pause the reviewer actually saw', () => {
    const decision = run([pauseFinding('TOTAL_EXCEEDS_LIMIT')]);
    expect(decision.verdict).toBe('ALLOW');
    expect(decision.reasonCodes).toContain('REVIEW_APPROVAL_APPLIED');
  });

  it('does not clear a pause the reviewer was never shown', () => {
    // A price that moved while the human deliberated is a new fact. Consent to
    // one finding is not consent to another.
    const decision = run([pauseFinding('TOTAL_EXCEEDS_LIMIT'), pauseFinding('VELOCITY_EXCEEDED')]);
    expect(decision.verdict).toBe('PAUSE');
  });

  it('does not apply to a different cart or a different gate', () => {
    // The binding is the request fingerprint: authorization, snapshot and gate.
    const decision = run([pauseFinding('TOTAL_EXCEEDS_LIMIT')], { fingerprint: 'a'.repeat(64) });
    expect(decision.verdict).toBe('PAUSE');
  });

  it('never downgrades a DENY', () => {
    // The property that must hold even if every other check were wrong.
    const decision = run([
      {
        code: 'INTENT_TOTAL_EXCEEDED',
        severity: 'DENY',
        stage: 'INTENT',
        message: 'x',
        detail: {},
      },
      pauseFinding('TOTAL_EXCEEDS_LIMIT'),
    ]);
    expect(decision.verdict).toBe('DENY');
    expect(decision.reasonCodes).not.toContain('REVIEW_APPROVAL_APPLIED');
  });

  it('changes nothing when there is no approval', () => {
    expect(run([pauseFinding('TOTAL_EXCEEDS_LIMIT')], { approval: null }).verdict).toBe('PAUSE');
  });

  it('cannot manufacture an ALLOW out of a clean run it did not affect', () => {
    // With no findings the verdict is already ALLOW, and the approval must not
    // add its marker to a decision it played no part in.
    const decision = run([]);
    expect(decision.verdict).toBe('ALLOW');
    expect(decision.reasonCodes).not.toContain('REVIEW_APPROVAL_APPLIED');
  });
});

// ------------------------------------------- operator approval at gate two --

/**
 * A policy whose only rule pauses above a low ceiling.
 *
 * PAUSE severity is the one thing a policy author may choose, and it is chosen
 * server-side and bound at issuance — an agent cannot select it. It makes the
 * review path reachable without weakening any fixed-severity check.
 */
function pausingPolicy(): PolicyDocument {
  return {
    policyId: 'household_review',
    version: '1.0.0',
    name: 'Pauses above a low ceiling',
    createdAt: asTimestamp('2026-09-01T00:00:00.000Z'),
    rules: [
      {
        ruleId: 'review_above_ceiling',
        kind: 'MAX_TOTAL',
        description: 'Spend above this ceiling needs a human',
        severity: 'PAUSE',
        max: money('INR', 100),
      },
    ],
  };
}

/** Approves whatever review is currently open on a release. */
async function approveOpenReview(h: Harness, releaseId: string, by: string): Promise<string> {
  const review = await h.reviews.findOpenByRelease(releaseId as never);
  expect(review, 'expected an open review to approve').not.toBeNull();
  const resolved = await h.reviewService.resolve(review!.reviewId, 'APPROVED', by);
  expect(resolved.kind).toBe('RESOLVED');
  return review!.reviewId;
}

describe('an operator approval at the CAPTURE gate is actionable', () => {
  /**
   * The defect this pins was the exact mirror of the gate-1 one fixed earlier,
   * and it was reachable end to end.
   *
   * `REVIEW_APPROVED` leaves an approved release in `CAPTURE_VERIFYING`, but
   * `CAPTURE_REQUESTED` was only legal from `PAYMENT_AUTHORIZED`. The agent's
   * retry therefore lost the compare-and-set, was told
   * `CONCURRENT_RELEASE_IN_PROGRESS`, and the release sat in `CAPTURE_VERIFYING`
   * until the liveness sweep aborted it. Money could never move for any release
   * that had once paused at the capture gate — the operator's approval produced
   * nothing at all.
   */
  async function pauseAtCaptureGate(): Promise<{
    h: Harness;
    releaseId: string;
    orderReviewId: string;
  }> {
    const h = new Harness({ policy: pausingPolicy() });
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);

    const request = {
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('gate2approve'),
      principal: h.principal(),
    };

    const paused = await h.releaseService.requestOrderCreation(request);
    expect(paused.verdict).toBe('PAUSE');

    const orderReviewId = await approveOpenReview(h, paused.releaseId!, 'operator_one');

    // The agent retries the identical request; gate 1 re-verifies and allows.
    const allowed = await h.releaseService.requestOrderCreation(request);
    expect(allowed.verdict).toBe('ALLOW');
    expect(allowed.state).toBe('ORDER_CREATED');

    await h.authorizePayment(allowed.releaseId!);

    // Gate 2 sees the same PAUSE rule. The gate-1 approval must NOT carry over:
    // its fingerprint names the order gate, so it covers nothing here.
    const captureAttempt = await h.releaseService.requestCapture({
      releaseId: allowed.releaseId as never,
      idempotencyKey: h.key('gate2cap1'),
      principal: h.principal(),
    });
    expect(captureAttempt.verdict).toBe('PAUSE');
    expect(captureAttempt.state).toBe('PAUSED');
    expect(captureAttempt.moneyMoved).toBe(false);

    return { h, releaseId: allowed.releaseId!, orderReviewId };
  }

  it('captures after the operator approves the capture-gate pause', async () => {
    const { h, releaseId } = await pauseAtCaptureGate();

    await approveOpenReview(h, releaseId, 'operator_two');
    expect((await h.releases.findById(releaseId as never))?.state).toBe('CAPTURE_VERIFYING');

    const captured = await h.releaseService.requestCapture({
      releaseId: releaseId as never,
      idempotencyKey: h.key('gate2cap2'),
      principal: h.principal(),
    });

    expect(captured.verdict).toBe('ALLOW');
    expect(captured.state).toBe('CAPTURED');
    expect(captured.moneyMoved).toBe(true);
    // Once, and only once, across the whole flow.
    expect(h.provider.callCount('capturePayment')).toBe(1);
    expect(h.provider.capturedCount()).toBe(1);
  });

  it('gives the second pause its own review rather than colliding with the first', async () => {
    const { h, releaseId, orderReviewId } = await pauseAtCaptureGate();

    const captureReview = await h.reviews.findOpenByRelease(releaseId as never);
    expect(captureReview).not.toBeNull();
    // Both reviews exist, and the resolved gate-1 one was not overwritten.
    expect(captureReview!.reviewId).not.toBe(orderReviewId);
    const first = await h.reviews.findById(orderReviewId as never);
    expect(first?.state).toBe('APPROVED');
    expect(first?.resolvedBy).toBe('operator_one');
  });

  it('still refuses when reality moved while the operator deliberated', async () => {
    const { h, releaseId } = await pauseAtCaptureGate();
    await approveOpenReview(h, releaseId, 'operator_two');

    // The approval authorizes re-verification, not payment. The merchant's
    // price moves before the agent retries.
    h.catalog.apply({ kind: 'SET_PRICE', sku: SKU, unitPriceMinor: 549_900 });

    const refused = await h.releaseService.requestCapture({
      releaseId: releaseId as never,
      idempotencyKey: h.key('gate2cap3'),
      principal: h.principal(),
    });

    expect(refused.verdict).toBe('DENY');
    expect(refused.reasonCodes).toContain('LIVE_PRICE_DIVERGED');
    expect(refused.moneyMoved).toBe(false);
    expect(h.provider.callCount('capturePayment')).toBe(0);
  });

  it('does not let the capture gate re-enter from anywhere else', () => {
    // The re-entry is confined to the two states the gate legitimately runs
    // from. Nothing that has reached the provider can go back to the gate.
    expect(nextState('CAPTURE_VERIFYING', 'CAPTURE_REQUESTED')).toBe('CAPTURE_VERIFYING');
    expect(nextState('PAYMENT_AUTHORIZED', 'CAPTURE_REQUESTED')).toBe('CAPTURE_VERIFYING');
    for (const from of [
      'CAPTURE_APPROVED',
      'CAPTURE_IN_FLIGHT',
      'CAPTURE_INDETERMINATE',
      'CAPTURED',
      'ORDER_CREATED',
      'PAUSED',
    ] as const) {
      expect(nextState(from, 'CAPTURE_REQUESTED')).toBeNull();
    }
  });
});

// ------------------------------------------ what a refused duplicate says --

describe('a duplicate capture is refused definitively, not left open', () => {
  /**
   * The refusal override may lower a verdict, never raise one — and it must not
   * soften one either.
   *
   * Applying it unconditionally rewrote the kernel's DENY into a PAUSE, so a
   * second capture of an already-captured release answered `202 Accepted` with
   * `PAUSE`. To a client that reads status codes, "accepted, pending" is an
   * invitation to poll or retry the one operation the state machine had just
   * established must never happen twice.
   */
  it('reports DENY, not PAUSE, for a capture the state machine refuses outright', async () => {
    const h = new Harness();
    const { releaseId } = await h.openOrder();
    await h.authorizePayment(releaseId);

    const first = await h.releaseService.requestCapture({
      releaseId: releaseId as never,
      idempotencyKey: h.key('dup1'),
      principal: h.principal(),
    });
    expect(first.verdict).toBe('ALLOW');
    expect(first.state).toBe('CAPTURED');

    const second = await h.releaseService.requestCapture({
      releaseId: releaseId as never,
      idempotencyKey: h.key('dup2'),
      principal: h.principal(),
    });

    expect(second.verdict).toBe('DENY');
    expect(second.reasonCodes).toContain('INVALID_RELEASE_STATE_FOR_GATE');
    expect(second.reasonCodes).toContain('AUTHORIZATION_ALREADY_CONSUMED');
    // The release is untouched, and the provider was asked exactly once.
    expect(second.state).toBe('CAPTURED');
    expect(h.provider.callCount('capturePayment')).toBe(1);
    expect(h.provider.capturedCount()).toBe(1);
    // `moneyMoved` describes the release, which really was captured — by the
    // first request. The verdict is what tells this caller it was not them.
    expect(second.moneyMoved).toBe(true);
  });
});

// ------------------------------------------ one release per provider payment --

describe('a provider payment belongs to exactly one release', () => {
  /**
   * The database backstop behind the webhook service's entity check.
   *
   * `releases.provider_payment_id` is UNIQUE, and that constraint is what makes
   * "one release per payment" true rather than merely intended: the capture
   * gate presents `release.providerPaymentId` to the provider together with
   * *this* release's amount, so a payment bound to two releases is a payment
   * that could be captured for the wrong figure.
   *
   * This assertion was not writable offline until recently. The in-memory store
   * did not model the constraint, so a test like this passed for a reason that
   * did not hold in production — the exact inversion the parity suite now
   * prevents. `parity.db.test.ts` proves the two stores agree here.
   */
  it('lets a release re-assert its own payment id, which redelivery does', async () => {
    // The constraint must not punish the normal case: a webhook is delivered
    // at least once, so the same payment id arrives again for the release that
    // already holds it. Postgres does not consider a row in conflict with
    // itself, and neither may the fake.
    const h = new Harness();
    const { releaseId } = await h.openOrder('redelivery');
    const paymentId = await h.authorizePayment(releaseId);

    const again = await h.releases.transition(
      releaseId as never,
      ['PAYMENT_AUTHORIZED'],
      'PAYMENT_AUTHORIZED',
      { providerPaymentId: paymentId },
      h.clock.now(),
    );
    expect(again?.providerPaymentId).toBe(paymentId);
  });

  it('refuses a second release in the same store claiming one payment', async () => {
    const h = new Harness();
    const first = await h.openOrder('claim-one');
    const paymentId = await h.authorizePayment(first.releaseId);

    // Drive the first release terminal so the authorization frees its slot,
    // then build a second release in the SAME store.
    await h.releases.transition(
      first.releaseId as never,
      ['PAYMENT_AUTHORIZED'],
      'ABORTED',
      {},
      h.clock.now(),
    );
    const second = await h.openOrder('claim-two');

    await expect(
      h.releases.transition(
        second.releaseId as never,
        ['ORDER_CREATED'],
        'PAYMENT_AUTHORIZED',
        { providerPaymentId: paymentId },
        h.clock.now(),
      ),
    ).rejects.toThrow(/releases_provider_payment_id_key/);

    // The refused transition left the release exactly as it was.
    const after = await h.releases.findById(second.releaseId as never);
    expect(after?.state).toBe('ORDER_CREATED');
    expect(after?.providerPaymentId).toBeNull();
  });
});
