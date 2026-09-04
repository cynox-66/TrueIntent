/**
 * Webhook handling, evidence tamper-evidence, and the paused-review path.
 */

import { describe, it, expect } from 'vitest';
import { verifyChain } from '@capturelock/evidence';
import { createVerifier } from '@capturelock/evidence';
import { evaluate } from '../src/kernel.js';
import { deserializeContext } from '../src/serialize.js';
import { computeDecisionHash } from '@capturelock/core';
import { Harness, SKU, inr } from './harness.js';

async function capturedRelease(): Promise<{ h: Harness; releaseId: string; paymentId: string }> {
  const h = new Harness();
  const { releaseId } = await h.openOrder();
  const paymentId = await h.authorizePayment(releaseId);
  await h.releaseService.requestCapture({
    releaseId: releaseId as never,
    idempotencyKey: h.key('cap1'),
    principal: h.principal(),
  });
  return { h, releaseId, paymentId };
}

describe('S15: duplicate webhook', () => {
  it('applies the first delivery and ignores every repeat', async () => {
    const { h, releaseId, paymentId } = await capturedRelease();
    const event = {
      providerEventId: 'evt_capture_1',
      eventType: 'payment.captured',
      signatureValid: true,
      payload: { event: 'payment.captured' },
      providerEventAt: h.clock.now(),
      paymentId,
      orderId: null,
    };

    const first = await h.webhookService.ingest(event);
    expect(first).toMatchObject({ kind: 'APPLIED', state: 'SETTLED' });

    for (let i = 0; i < 9; i += 1) {
      const repeat = await h.webhookService.ingest(event);
      expect(repeat.kind).toBe('DUPLICATE_IGNORED');
    }

    expect((await h.releases.findById(releaseId as never))?.state).toBe('SETTLED');
    expect(h.webhookInbox.count()).toBe(1);
  });

  it('deduplicates ten simultaneous deliveries of the same event', async () => {
    const { h, paymentId } = await capturedRelease();
    const event = {
      providerEventId: 'evt_capture_1',
      eventType: 'payment.captured',
      signatureValid: true,
      payload: { event: 'payment.captured' },
      providerEventAt: h.clock.now(),
      paymentId,
      orderId: null,
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => h.webhookService.ingest(event)),
    );
    // Exactly one claim wins; the unique constraint on the event id decides it.
    expect(results.filter(r => r.kind === 'APPLIED')).toHaveLength(1);
    expect(results.filter(r => r.kind === 'DUPLICATE_IGNORED')).toHaveLength(9);
    expect(h.webhookInbox.count()).toBe(1);
  });
});

describe('S16: out-of-order webhook', () => {
  it('does not pull a settled release backwards', async () => {
    const { h, releaseId, paymentId } = await capturedRelease();
    await h.webhookService.ingest({
      providerEventId: 'evt_captured',
      eventType: 'payment.captured',
      signatureValid: true,
      payload: {},
      providerEventAt: h.clock.now(),
      paymentId,
      orderId: null,
    });
    expect((await h.releases.findById(releaseId as never))?.state).toBe('SETTLED');

    // A late `payment.authorized` for the same payment arrives after settlement.
    const late = await h.webhookService.ingest({
      providerEventId: 'evt_authorized_late',
      eventType: 'payment.authorized',
      signatureValid: true,
      payload: {},
      providerEventAt: h.clock.now(),
      paymentId,
      orderId: null,
    });

    expect(late.kind).toBe('OUT_OF_ORDER_IGNORED');
    expect((await h.releases.findById(releaseId as never))?.state).toBe('SETTLED');
  });

  it('records the ignored event rather than dropping it silently', async () => {
    const { h, paymentId } = await capturedRelease();
    await h.webhookService.ingest({
      providerEventId: 'evt_captured',
      eventType: 'payment.captured',
      signatureValid: true,
      payload: {},
      providerEventAt: h.clock.now(),
      paymentId,
      orderId: null,
    });
    await h.webhookService.ingest({
      providerEventId: 'evt_failed_late',
      eventType: 'payment.failed',
      signatureValid: true,
      payload: {},
      providerEventAt: h.clock.now(),
      paymentId,
      orderId: null,
    });
    expect(await h.webhookInbox.findByEventId('evt_failed_late')).not.toBeNull();
  });
});

describe('webhook safety', () => {
  it('refuses to act on an unverified signature', async () => {
    const { h, releaseId, paymentId } = await capturedRelease();
    const result = await h.webhookService.ingest({
      providerEventId: 'evt_forged',
      eventType: 'payment.failed',
      signatureValid: false,
      payload: {},
      providerEventAt: h.clock.now(),
      paymentId,
      orderId: null,
    });
    expect(result.kind).toBe('SIGNATURE_INVALID');
    expect((await h.releases.findById(releaseId as never))?.state).toBe('CAPTURED');
    // A forged event must not even occupy an inbox row a genuine one may need.
    expect(h.webhookInbox.count()).toBe(0);
  });

  it('records an unknown event type without applying it', async () => {
    const { h, releaseId, paymentId } = await capturedRelease();
    const result = await h.webhookService.ingest({
      providerEventId: 'evt_unknown',
      eventType: 'refund.speculative',
      signatureValid: true,
      payload: {},
      providerEventAt: h.clock.now(),
      paymentId,
      orderId: null,
    });
    expect(result.kind).toBe('UNKNOWN_EVENT_RECORDED');
    expect((await h.releases.findById(releaseId as never))?.state).toBe('CAPTURED');
    expect((await h.webhookInbox.findByEventId('evt_unknown'))?.status).toBe('IGNORED_UNKNOWN');
  });

  it('cannot create a release for a payment CaptureLock never made', async () => {
    const h = new Harness();
    const result = await h.webhookService.ingest({
      providerEventId: 'evt_ghost',
      eventType: 'payment.captured',
      signatureValid: true,
      payload: {},
      providerEventAt: h.clock.now(),
      paymentId: 'pay_never_seen',
      orderId: null,
    });
    expect(result.kind).toBe('NO_MATCHING_RELEASE');
    expect(h.releases.count()).toBe(0);
  });
});

describe('S19: evidence tampering', () => {
  it('produces a chain that verifies for an honest run', async () => {
    const { h, releaseId } = await capturedRelease();
    const authorizationId = (await h.releases.findById(releaseId as never))!.authorizationId;
    const result = await h.evidence.verifyChain(authorizationId);
    expect(result.valid).toBe(true);
    expect(result.verifiedCount).toBeGreaterThanOrEqual(2);
  });

  it('detects a verdict edited from DENY to ALLOW after the fact', async () => {
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

    h.evidence.tamper(outcome.evidenceEnvelopeId!, envelope => ({
      ...envelope,
      body: { ...(envelope.body as Record<string, unknown>), verdict: 'ALLOW' },
    }));

    const result = await h.evidence.verifyChain(authorizationId);
    expect(result.valid).toBe(false);
    expect(result.defects.map(d => d.kind)).toContain('PAYLOAD_MODIFIED');
  });

  it('detects a deleted envelope', async () => {
    const { h, releaseId } = await capturedRelease();
    const authorizationId = (await h.releases.findById(releaseId as never))!.authorizationId;
    const chain = await h.evidence.listByChain(authorizationId);
    const withoutOne = chain.filter((_, index) => index !== 1);
    const result = verifyChain(withoutOne, createVerifier(h.keys.publicKeySpkiBase64));
    expect(result.valid).toBe(false);
    expect(result.defects.map(d => d.kind)).toContain('SEQUENCE_GAP');
  });

  it('detects truncation against the head the client was handed', async () => {
    const h = new Harness();
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);
    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('head'),
      principal: h.principal(),
    });

    // The client holds this. An operator who later truncates the ledger cannot
    // change it.
    const witness = outcome.evidenceChainHead!;
    const chain = await h.evidence.listByChain(authorizationId);
    const truncated = chain.slice(0, 1);

    const result = verifyChain(truncated, createVerifier(h.keys.publicKeySpkiBase64), witness);
    expect(result.valid).toBe(false);
    expect(result.defects.map(d => d.kind)).toContain('HEAD_MISMATCH');
  });
});

describe('replay of a recorded decision', () => {
  it('reproduces the exact verdict from the stored context alone', async () => {
    const h = new Harness();
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);
    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('replay'),
      principal: h.principal(),
    });

    const envelope = await h.evidence.findById(outcome.evidenceEnvelopeId!);
    const body = envelope!.body as { context: unknown; decisionHash: string; verdict: string };

    // An auditor with only the envelope re-runs the kernel and gets the same
    // answer. This is the difference between an audit log and a proof.
    const replayed = evaluate(deserializeContext(body.context));
    expect(computeDecisionHash(replayed)).toBe(body.decisionHash);
    expect(replayed.verdict).toBe(body.verdict);
    expect(replayed.verdict).toBe(outcome.verdict);
  });

  it('reproduces a refusal just as exactly as an approval', async () => {
    const h = new Harness();
    const authorizationId = await h.setup();
    h.catalog.apply({ kind: 'SET_PRICE', sku: SKU, unitPriceMinor: 999_900 });
    const snapshotId = await h.quote(authorizationId);
    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('replay2'),
      principal: h.principal(),
    });
    expect(outcome.verdict).toBe('DENY');

    const envelope = await h.evidence.findById(outcome.evidenceEnvelopeId!);
    const body = envelope!.body as { context: unknown; decisionHash: string };
    expect(computeDecisionHash(evaluate(deserializeContext(body.context)))).toBe(body.decisionHash);
  });
});

describe('the paused review path', () => {
  it('pauses on a retry storm and opens a review bound to the request', async () => {
    const h = new Harness({ maxAttemptsInWindow: 0 });
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);

    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('storm'),
      principal: h.principal(),
    });

    expect(outcome.verdict).toBe('PAUSE');
    expect(outcome.reasonCodes).toContain('RETRY_VELOCITY_EXCEEDED');
    expect(outcome.state).toBe('PAUSED');
    expect(h.provider.calls).toHaveLength(0);

    const review = await h.reviews.findOpenByRelease(outcome.releaseId as never);
    expect(review).not.toBeNull();
  });

  it('sends an approved order-gate pause back to the ORDER gate, not the capture gate', async () => {
    const h = new Harness({ maxAttemptsInWindow: 0 });
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);
    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('storm'),
      principal: h.principal(),
    });

    const review = (await h.reviews.findOpenByRelease(outcome.releaseId as never))!;
    const resolved = await h.reviewService.resolve(review.reviewId, 'APPROVED', 'operator_dev');

    expect(resolved.kind).toBe('RESOLVED');
    // This release paused at gate 1 — `provider.calls` is empty, so no order
    // exists and therefore no payment does either. Sending it to
    // CAPTURE_VERIFYING (which this test previously asserted) was a dead end:
    // the capture gate would find no provider payment and refuse with
    // INVALID_RELEASE_STATE_FOR_GATE, so the operator's approval produced a
    // permanent denial and the order was never created.
    //
    // Approval re-enters the gate that paused. It does not authorize a payment.
    expect((resolved as { state: string }).state).toBe('VERIFYING');
    expect(h.provider.calls).toHaveLength(0);
  });

  it('cannot be resolved twice', async () => {
    const h = new Harness({ maxAttemptsInWindow: 0 });
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);
    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('storm'),
      principal: h.principal(),
    });
    const review = (await h.reviews.findOpenByRelease(outcome.releaseId as never))!;

    await h.reviewService.resolve(review.reviewId, 'REJECTED', 'operator_a');
    const second = await h.reviewService.resolve(review.reviewId, 'APPROVED', 'operator_b');
    expect(second.kind).toBe('ALREADY_RESOLVED');
  });

  it('records the resolution in the evidence chain', async () => {
    const h = new Harness({ maxAttemptsInWindow: 0 });
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);
    const outcome = await h.releaseService.requestOrderCreation({
      authorizationId: authorizationId as never,
      snapshotId: snapshotId as never,
      idempotencyKey: h.key('storm'),
      principal: h.principal(),
    });
    const review = (await h.reviews.findOpenByRelease(outcome.releaseId as never))!;
    await h.reviewService.resolve(review.reviewId, 'APPROVED', 'operator_dev');

    const chain = await h.evidence.listByChain(authorizationId);
    expect(chain.some(e => e.kind === 'REVIEW_RESOLUTION')).toBe(true);
    expect((await h.evidence.verifyChain(authorizationId)).valid).toBe(true);
  });
});

describe('sanity of the fixture itself', () => {
  it('quotes the expected total, so refusals are not passing by accident', async () => {
    const h = new Harness();
    const authorizationId = await h.setup();
    const snapshotId = await h.quote(authorizationId);
    const snapshot = await h.snapshots.findById(snapshotId as never);
    expect(snapshot?.total).toEqual(inr(494_900));
  });
});
