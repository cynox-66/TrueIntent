/**
 * End-to-end scenarios, driven through the real service stack.
 *
 * Distinct from the 24-scenario harness in `scenarios.ts`, which compares a
 * naive agent against TrueIntent over an in-process world. These seven run the
 * *same object graph the API builds* — same services, same guarded executor,
 * same unit of work — optionally against real Postgres. Their job is to show
 * that the lifecycle holds together end to end, including persistence,
 * recovery, and tamper evidence.
 *
 * Every assertion is stated up front so a passing scenario provably tested the
 * thing it names. In particular each one asserts how many times the provider
 * was called: a refusal that reached the provider is not a refusal.
 */

import { evaluate, deserializeContext } from '@capturelock/kernel';
import { computeDecisionHash } from '@capturelock/core';
import {
  Stack,
  SKU_BLACK,
  SKU_WHITE,
  OTHER_MERCHANT,
  STANDARD_FEES,
  REVIEW_POLICY,
} from './e2e-harness.js';

export interface ScenarioReport {
  readonly id: string;
  readonly title: string;
  readonly steps: readonly string[];
  readonly passed: boolean;
  readonly failure: string | null;
  readonly providerCaptures: number;
  readonly moneyMoved: boolean;
  readonly evidenceChainValid: boolean;
}

interface Ctx {
  readonly steps: string[];
  fail(reason: string): never;
  expect(condition: boolean, reason: string): void;
}

type ScenarioFn = (stack: Stack, ctx: Ctx) => Promise<{ moneyMoved: boolean; chainValid: boolean }>;

interface ScenarioDef {
  readonly id: string;
  readonly title: string;
  readonly run: ScenarioFn;
}

const inr = (minor: number): string => `INR ${(minor / 100).toFixed(2)}`;

export const E2E_SCENARIOS: readonly ScenarioDef[] = [
  {
    id: '1-normal-purchase',
    title: 'Normal purchase: verified at both gates, captured in test mode',
    async run(stack, ctx) {
      const auth = await stack.setup();
      const snapshot = await stack.quote(auth);
      if (typeof snapshot !== 'string') ctx.fail(`quote failed: ${snapshot.failed}`);
      ctx.steps.push(`quote issued, server-priced at ${inr(479_900 + 15_000)}`);

      const order = await stack.releases.requestOrderCreation({
        authorizationId: auth as never,
        snapshotId: snapshot as never,
        idempotencyKey: stack.key('s1-order'),
        principal: stack.principal(),
      });
      ctx.expect(order.verdict === 'ALLOW', `gate 1 refused: ${order.reasonCodes.join(',')}`);
      ctx.steps.push(`gate 1 ALLOW, order ${String(order.providerOrderId)}`);

      await stack.simulatePayerAuthorization(order.releaseId!);
      ctx.steps.push('payer authorized (real signed webhook)');

      const capture = await stack.releases.requestCapture({
        releaseId: order.releaseId as never,
        idempotencyKey: stack.key('s1-capture'),
        principal: stack.principal(),
      });
      ctx.expect(capture.verdict === 'ALLOW', `gate 2 refused: ${capture.reasonCodes.join(',')}`);
      ctx.expect(capture.state === 'CAPTURED', `expected CAPTURED, got ${String(capture.state)}`);
      ctx.expect(capture.moneyMoved, 'money did not move');
      ctx.steps.push(`gate 2 ALLOW, state ${String(capture.state)}`);

      const authorization = await stack.deps.authorizations.findById(auth as never);
      ctx.expect(authorization?.state === 'CONSUMED', 'authorization was not marked consumed');
      ctx.steps.push('authorization marked CONSUMED, so the mandate cannot be replayed');

      return { moneyMoved: true, chainValid: await stack.chainValid(auth) };
    },
  },

  {
    id: '2-price-drift',
    title: 'Price drift between gates: gate 1 allows, gate 2 refuses, capture never called',
    async run(stack, ctx) {
      const auth = await stack.setup();
      const snapshot = await stack.quote(auth);
      if (typeof snapshot !== 'string') ctx.fail(`quote failed: ${snapshot.failed}`);

      const order = await stack.releases.requestOrderCreation({
        authorizationId: auth as never,
        snapshotId: snapshot as never,
        idempotencyKey: stack.key('s2-order'),
        principal: stack.principal(),
      });
      ctx.expect(
        order.verdict === 'ALLOW',
        `gate 1 should have allowed: ${order.reasonCodes.join(',')}`,
      );
      ctx.steps.push(`gate 1 ALLOW at ${inr(479_900)}`);

      await stack.simulatePayerAuthorization(order.releaseId!);

      // The merchant's world moves. TrueIntent is told nothing; it finds out
      // on its next live read, which is the whole point.
      stack.drift({ kind: 'SET_PRICE', sku: SKU_BLACK, unitPriceMinor: 549_900 });
      ctx.steps.push(`merchant raised the price to ${inr(549_900)}`);

      const before = stack.provider.callCount('capturePayment');
      const capture = await stack.releases.requestCapture({
        releaseId: order.releaseId as never,
        idempotencyKey: stack.key('s2-capture'),
        principal: stack.principal(),
      });

      ctx.expect(capture.verdict === 'DENY', `gate 2 should have refused, got ${capture.verdict}`);
      ctx.expect(
        capture.reasonCodes.includes('LIVE_PRICE_DIVERGED'),
        `expected LIVE_PRICE_DIVERGED, got ${capture.reasonCodes.join(',')}`,
      );
      ctx.expect(!capture.moneyMoved, 'money moved on a refused capture');
      // The assertion that matters most: the provider was never reached.
      ctx.expect(
        stack.provider.callCount('capturePayment') === before,
        'the provider was called despite the capture gate refusing',
      );
      ctx.steps.push('gate 2 DENY (LIVE_PRICE_DIVERGED); provider capture never called');

      return { moneyMoved: false, chainValid: await stack.chainValid(auth) };
    },
  },

  {
    id: '3-merchant-switch',
    title: 'Merchant switch: an unauthorized merchant is refused before any order exists',
    async run(stack, ctx) {
      const auth = await stack.setup();
      // The quote itself is for a merchant the authorization does not permit.
      const snapshot = await stack.quote(auth, { merchantId: OTHER_MERCHANT });
      if (typeof snapshot !== 'string') {
        ctx.steps.push(`quote refused outright: ${snapshot.failed}`);
        return { moneyMoved: false, chainValid: true };
      }

      const order = await stack.releases.requestOrderCreation({
        authorizationId: auth as never,
        snapshotId: snapshot as never,
        idempotencyKey: stack.key('s3-order'),
        principal: stack.principal(),
      });
      ctx.expect(order.verdict === 'DENY', `expected DENY, got ${order.verdict}`);
      ctx.expect(
        order.reasonCodes.includes('MERCHANT_NOT_AUTHORIZED'),
        `expected MERCHANT_NOT_AUTHORIZED, got ${order.reasonCodes.join(',')}`,
      );
      ctx.expect(stack.provider.calls.length === 0, 'the provider was called on a refused order');
      ctx.steps.push('gate 1 DENY (MERCHANT_NOT_AUTHORIZED); provider never called');

      return { moneyMoved: false, chainValid: await stack.chainValid(auth) };
    },
  },

  {
    id: '4-hidden-shipping-fee',
    title: 'Hidden shipping fee: item within budget, total over it, refused',
    async run(stack, ctx) {
      const auth = await stack.setup();
      // 4,700 item + 500 shipping = 5,200 against a 5,000 ceiling. Neither
      // figure is agent-supplied: the item price and the fee both come from the
      // live merchant read.
      stack.drift({ kind: 'SET_PRICE', sku: SKU_BLACK, unitPriceMinor: 470_000 });
      stack.drift({
        kind: 'SET_FEES',
        adjustments: [
          {
            type: 'SHIPPING',
            label: 'Standard delivery',
            amount: { currency: 'INR', amountMinor: 50_000 },
          },
        ],
      });

      const snapshot = await stack.quote(auth);
      if (typeof snapshot !== 'string') ctx.fail(`quote failed: ${snapshot.failed}`);

      const order = await stack.releases.requestOrderCreation({
        authorizationId: auth as never,
        snapshotId: snapshot as never,
        idempotencyKey: stack.key('s4-order'),
        principal: stack.principal(),
      });

      ctx.expect(order.verdict === 'DENY', `expected DENY, got ${order.verdict}`);
      ctx.expect(
        order.reasonCodes.includes('INTENT_FEE_EXCEEDED') ||
          order.reasonCodes.includes('INTENT_TOTAL_EXCEEDED'),
        `expected a fee or total breach, got ${order.reasonCodes.join(',')}`,
      );
      ctx.expect(stack.provider.calls.length === 0, 'the provider was called on a refused order');
      ctx.steps.push(
        `${inr(470_000)} item + ${inr(50_000)} shipping = ${inr(520_000)} against a ${inr(500_000)} ceiling: DENY`,
      );

      return { moneyMoved: false, chainValid: await stack.chainValid(auth) };
    },
  },

  {
    id: '5-duplicate-execution',
    title: 'Duplicate execution: two captures race, exactly one crosses the boundary',
    async run(stack, ctx) {
      const auth = await stack.setup();
      const snapshot = await stack.quote(auth);
      if (typeof snapshot !== 'string') ctx.fail(`quote failed: ${snapshot.failed}`);

      const order = await stack.releases.requestOrderCreation({
        authorizationId: auth as never,
        snapshotId: snapshot as never,
        idempotencyKey: stack.key('s5-order'),
        principal: stack.principal(),
      });
      ctx.expect(order.verdict === 'ALLOW', `gate 1 refused: ${order.reasonCodes.join(',')}`);
      await stack.simulatePayerAuthorization(order.releaseId!);

      const attempts = await Promise.all(
        [1, 2].map(n =>
          stack.releases.requestCapture({
            releaseId: order.releaseId as never,
            idempotencyKey: stack.key(`s5-capture-${n}`),
            principal: stack.principal(),
          }),
        ),
      );

      const captured = stack.provider.capturedCount();
      const calls = stack.provider.callCount('capturePayment');
      ctx.expect(captured === 1, `expected exactly one capture, got ${captured}`);
      ctx.expect(calls === 1, `expected exactly one provider call, got ${calls}`);
      ctx.expect(
        attempts.filter(a => a.verdict === 'ALLOW').length === 1,
        'more than one attempt was allowed',
      );
      ctx.steps.push(`two concurrent captures, ${calls} provider call, ${captured} capture`);

      return { moneyMoved: true, chainValid: await stack.chainValid(auth) };
    },
  },

  {
    id: '6-provider-timeout',
    title: 'Provider timeout: CAPTURE_INDETERMINATE, no blind retry, reconciled by lookup',
    async run(stack, ctx) {
      const auth = await stack.setup();
      const snapshot = await stack.quote(auth);
      if (typeof snapshot !== 'string') ctx.fail(`quote failed: ${snapshot.failed}`);

      const order = await stack.releases.requestOrderCreation({
        authorizationId: auth as never,
        snapshotId: snapshot as never,
        idempotencyKey: stack.key('s6-order'),
        principal: stack.principal(),
      });
      ctx.expect(order.verdict === 'ALLOW', `gate 1 refused: ${order.reasonCodes.join(',')}`);
      await stack.simulatePayerAuthorization(order.releaseId!);

      // The capture lands at the provider; the response is lost.
      stack.provider.failNextCaptureWith('TIMEOUT_AFTER_APPLY');

      const capture = await stack.releases.requestCapture({
        releaseId: order.releaseId as never,
        idempotencyKey: stack.key('s6-capture'),
        principal: stack.principal(),
      });
      ctx.expect(
        capture.state === 'CAPTURE_INDETERMINATE',
        `expected CAPTURE_INDETERMINATE, got ${String(capture.state)}`,
      );
      ctx.expect(!capture.moneyMoved, 'reported money moved before reconciliation confirmed it');
      ctx.steps.push('capture response lost: state CAPTURE_INDETERMINATE, outcome unknown to us');

      const reconciled = await stack.reconciliation.reconcileById(order.releaseId as never);
      ctx.expect(
        reconciled?.after === 'CAPTURED',
        `expected CAPTURED, got ${String(reconciled?.after)}`,
      );
      ctx.expect(
        reconciled?.resolvedBy === 'PAYMENT_LOOKUP',
        'was not resolved by asking the provider',
      );
      // The critical assertion: still exactly one capture call, ever.
      const calls = stack.provider.callCount('capturePayment');
      ctx.expect(calls === 1, `expected exactly one capture call, got ${calls} — a retry happened`);
      ctx.steps.push(`reconciled by lookup to CAPTURED; capture called ${calls} time total`);

      return { moneyMoved: true, chainValid: await stack.chainValid(auth) };
    },
  },

  {
    id: '7-evidence-tampering',
    title: 'Evidence tampering: replay reproduces an honest decision, a doctored one fails',
    async run(stack, ctx) {
      const auth = await stack.setup();
      const snapshot = await stack.quote(auth);
      if (typeof snapshot !== 'string') ctx.fail(`quote failed: ${snapshot.failed}`);

      const order = await stack.releases.requestOrderCreation({
        authorizationId: auth as never,
        snapshotId: snapshot as never,
        idempotencyKey: stack.key('s7-order'),
        principal: stack.principal(),
      });

      const envelope = await stack.deps.evidence.findById(order.evidenceEnvelopeId!);
      const body = envelope!.body as { context: unknown; decisionHash: string; verdict: string };

      // An auditor with only the envelope re-runs the kernel and gets the same
      // answer. This is the difference between an audit log and a proof.
      const replayed = evaluate(deserializeContext(body.context));
      ctx.expect(
        computeDecisionHash(replayed) === body.decisionHash,
        'replay did not reproduce the recorded decision',
      );
      ctx.expect(replayed.verdict === body.verdict, 'replayed verdict differs from the record');
      ctx.steps.push(`decision replayed from evidence: ${replayed.verdict}, hashes match`);

      const valid = await stack.chainValid(auth);
      ctx.expect(valid, 'an untampered chain failed verification');
      ctx.steps.push('evidence chain verifies');

      // Doctor the recorded context and show that replay no longer reproduces.
      const doctored = JSON.parse(JSON.stringify(body.context)) as Record<string, unknown>;
      const proposal = doctored['proposal'] as {
        declaredTotalMinor?: number;
        lines: { unitPrice: { amountMinor: number } }[];
      };
      proposal.lines[0]!.unitPrice.amountMinor = 1;
      const replayedTampered = evaluate(deserializeContext(doctored));
      ctx.expect(
        computeDecisionHash(replayedTampered) !== body.decisionHash,
        'a doctored context still produced the recorded decision hash',
      );
      ctx.steps.push(
        'doctored context produces a different decision hash: tampering is detectable',
      );

      return { moneyMoved: false, chainValid: valid };
    },
  },
  {
    id: '8-operator-approval',
    title:
      'Operator review: paused at both gates, approved by a human, and still re-verified before money moves',
    async run(stack, ctx) {
      const auth = await stack.setup();
      const snapshot = await stack.quote(auth);
      if (typeof snapshot !== 'string') ctx.fail(`quote failed: ${snapshot.failed}`);

      // The same request object every time. An operator's approval has to make
      // the agent's *identical* retry succeed; if the agent had to change
      // anything, the approval would not be what unblocked it.
      const orderRequest = {
        authorizationId: auth as never,
        snapshotId: snapshot as never,
        idempotencyKey: stack.key('s8-order'),
        principal: stack.principal(),
      };

      const paused = await stack.releases.requestOrderCreation(orderRequest);
      ctx.expect(paused.verdict === 'PAUSE', `gate 1 should have paused, got ${paused.verdict}`);
      ctx.expect(
        paused.reasonCodes.includes('TOTAL_EXCEEDS_LIMIT'),
        `expected TOTAL_EXCEEDS_LIMIT, got ${paused.reasonCodes.join(',')}`,
      );
      ctx.expect(stack.provider.calls.length === 0, 'the provider was called on a paused order');
      ctx.steps.push(`gate 1 PAUSE (${inr(494_900)} over a ${inr(100_000)} review ceiling)`);

      const releaseId = paused.releaseId!;
      const orderReview = await stack.resolveOpenReview(releaseId, 'APPROVED', 'operator_asha');
      ctx.expect(
        orderReview.state === 'VERIFYING',
        `a gate-1 approval must return to the ORDER gate, got ${orderReview.state}`,
      );
      ctx.steps.push('operator_asha approved; release returned to the ORDER gate');

      const created = await stack.releases.requestOrderCreation(orderRequest);
      ctx.expect(
        created.verdict === 'ALLOW',
        `gate 1 retry refused: ${created.reasonCodes.join(',')}`,
      );
      ctx.expect(
        created.state === 'ORDER_CREATED',
        `expected ORDER_CREATED, got ${String(created.state)}`,
      );
      ctx.expect(
        created.reasonCodes.includes('REVIEW_APPROVAL_APPLIED'),
        'the approval was not recorded as what cleared the pause',
      );
      ctx.expect(!created.moneyMoved, 'money moved at the order gate');
      ctx.steps.push('agent retried the identical request: ALLOW, order created, no money moved');

      await stack.simulatePayerAuthorization(releaseId);
      ctx.steps.push('payer authorized (real signed webhook)');

      // Gate 2 sees the same ceiling. The gate-1 approval must NOT carry over:
      // a fingerprint names the gate, so an approval never travels to one the
      // human was not shown.
      const capturePaused = await stack.releases.requestCapture({
        releaseId: releaseId as never,
        idempotencyKey: stack.key('s8-capture-1'),
        principal: stack.principal(),
      });
      ctx.expect(
        capturePaused.verdict === 'PAUSE',
        `gate 2 should have paused again, got ${capturePaused.verdict}`,
      );
      ctx.expect(!capturePaused.moneyMoved, 'money moved on a paused capture');
      ctx.expect(
        stack.provider.callCount('capturePayment') === 0,
        'the provider was called on a paused capture',
      );
      ctx.steps.push('gate 2 PAUSE: the order-gate approval did not carry across the gate');

      const captureReview = await stack.resolveOpenReview(releaseId, 'APPROVED', 'operator_ben');
      ctx.expect(
        captureReview.reviewId !== orderReview.reviewId,
        'the second pause reused the first review instead of opening its own',
      );
      ctx.expect(
        captureReview.state === 'CAPTURE_VERIFYING',
        `a gate-2 approval must return to the CAPTURE gate, got ${captureReview.state}`,
      );
      ctx.steps.push('operator_ben approved the capture-gate pause; release returned to gate 2');

      const captured = await stack.releases.requestCapture({
        releaseId: releaseId as never,
        idempotencyKey: stack.key('s8-capture-2'),
        principal: stack.principal(),
      });
      ctx.expect(
        captured.verdict === 'ALLOW',
        `gate 2 retry refused: ${captured.reasonCodes.join(',')}`,
      );
      ctx.expect(captured.state === 'CAPTURED', `expected CAPTURED, got ${String(captured.state)}`);
      ctx.expect(captured.moneyMoved, 'the approved capture did not move money');
      const calls = stack.provider.callCount('capturePayment');
      ctx.expect(
        calls === 1,
        `expected exactly one capture call across the whole flow, got ${calls}`,
      );
      ctx.steps.push(`gate 2 ALLOW after approval; capture called ${calls} time`);

      // The approval authorized re-verification, not payment: two humans are
      // attributed in the ledger, and both approvals are still there.
      const envelopes = await stack.deps.evidence.listByChain(auth);
      const resolutions = envelopes.filter(e => e.kind === 'REVIEW_RESOLUTION');
      ctx.expect(
        resolutions.length === 2,
        `expected both approvals in evidence, found ${resolutions.length}`,
      );
      ctx.steps.push('both approvals recorded in evidence, each attributed to its operator');

      return { moneyMoved: true, chainValid: await stack.chainValid(auth) };
    },
  },

  {
    id: '9-operator-approval-does-not-override-reality',
    title:
      'An approval authorizes re-verification, not payment: drift after approval still refuses',
    async run(stack, ctx) {
      const auth = await stack.setup();
      const snapshot = await stack.quote(auth);
      if (typeof snapshot !== 'string') ctx.fail(`quote failed: ${snapshot.failed}`);

      const orderRequest = {
        authorizationId: auth as never,
        snapshotId: snapshot as never,
        idempotencyKey: stack.key('s9-order'),
        principal: stack.principal(),
      };

      const paused = await stack.releases.requestOrderCreation(orderRequest);
      ctx.expect(paused.verdict === 'PAUSE', `gate 1 should have paused, got ${paused.verdict}`);
      await stack.resolveOpenReview(paused.releaseId!, 'APPROVED', 'operator_asha');
      const created = await stack.releases.requestOrderCreation(orderRequest);
      ctx.expect(
        created.verdict === 'ALLOW',
        `gate 1 retry refused: ${created.reasonCodes.join(',')}`,
      );
      await stack.simulatePayerAuthorization(created.releaseId!);
      ctx.steps.push('approved at gate 1, order created, payer authorized');

      const capturePaused = await stack.releases.requestCapture({
        releaseId: created.releaseId as never,
        idempotencyKey: stack.key('s9-capture-1'),
        principal: stack.principal(),
      });
      ctx.expect(
        capturePaused.verdict === 'PAUSE',
        `gate 2 should have paused, got ${capturePaused.verdict}`,
      );
      await stack.resolveOpenReview(created.releaseId!, 'APPROVED', 'operator_ben');
      ctx.steps.push('operator approved the capture-gate pause');

      // The world moves between the approval and the retry — the exact window
      // an approval is most likely to be stale in, because a human took time.
      stack.drift({ kind: 'SET_PRICE', sku: SKU_BLACK, unitPriceMinor: 549_900 });
      ctx.steps.push(`merchant raised the price to ${inr(549_900)} while the operator deliberated`);

      const before = stack.provider.callCount('capturePayment');
      const refused = await stack.releases.requestCapture({
        releaseId: created.releaseId as never,
        idempotencyKey: stack.key('s9-capture-2'),
        principal: stack.principal(),
      });

      ctx.expect(refused.verdict === 'DENY', `expected DENY, got ${refused.verdict}`);
      ctx.expect(
        refused.reasonCodes.includes('LIVE_PRICE_DIVERGED'),
        `expected LIVE_PRICE_DIVERGED, got ${refused.reasonCodes.join(',')}`,
      );
      ctx.expect(!refused.moneyMoved, 'money moved despite the refusal');
      ctx.expect(
        stack.provider.callCount('capturePayment') === before,
        'the provider was called despite the capture gate refusing',
      );
      ctx.steps.push(
        'gate 2 DENY: a human approval does not override live state; capture never called',
      );

      return { moneyMoved: false, chainValid: await stack.chainValid(auth) };
    },
  },
];

/** Scenarios that need the PAUSE path, and therefore the review policy. */
const NEEDS_REVIEW_POLICY = new Set([
  '8-operator-approval',
  '9-operator-approval-does-not-override-reality',
]);

export async function runE2EScenario(
  def: ScenarioDef,
  databaseUrl: string | undefined,
): Promise<ScenarioReport> {
  const stack = await Stack.create({
    databaseUrl,
    fees: [...STANDARD_FEES],
    policy: NEEDS_REVIEW_POLICY.has(def.id) ? REVIEW_POLICY : undefined,
  });
  const steps: string[] = [];
  let failure: string | null = null;

  const ctx: Ctx = {
    steps,
    fail(reason: string): never {
      throw new Error(reason);
    },
    expect(condition: boolean, reason: string): void {
      if (!condition) throw new Error(reason);
    },
  };

  let moneyMoved = false;
  let chainValid = false;
  try {
    const result = await def.run(stack, ctx);
    moneyMoved = result.moneyMoved;
    chainValid = result.chainValid;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  const report: ScenarioReport = {
    id: def.id,
    title: def.title,
    steps,
    passed: failure === null,
    failure,
    providerCaptures: stack.provider.capturedCount(),
    moneyMoved,
    evidenceChainValid: chainValid,
  };

  await stack.close();
  return report;
}

export { SKU_BLACK, SKU_WHITE };
