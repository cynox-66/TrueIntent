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
import { Harness } from './harness.js';

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
