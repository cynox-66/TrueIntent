/**
 * Stage 6: operator policy.
 *
 * Intent is what the *user* agreed to; policy is what the *operator* permits.
 * Both are enforced, and neither can relax the other — a permissive policy
 * cannot raise a user's budget, and a generous user cannot escape a merchant
 * denylist.
 *
 * The policy document is loaded server-side by the id and version bound to the
 * authorization at issuance, and this stage re-checks that the loaded document
 * still hashes to the value recorded then. Without that check, swapping in a
 * permissive policy row would silently widen every authorization that
 * references it.
 */

import {
  finding,
  millisBetween,
  zero,
  type Attribute,
  type Finding,
  type LiveItemState,
  type Money,
  type ReasonCode,
} from '@capturelock/core';
import { computeCartTotals } from '@capturelock/core';
import {
  computePolicyHash,
  evaluatePolicy,
  type PolicySubject,
  type PolicySubjectLine,
} from '@capturelock/policy';
import type { VerificationContext } from '../context.js';
import { blocked, completed, type StageOutcome, type VerificationStage } from '../pipeline.js';

const STAGE = 'POLICY' as const;

export const policyStage: VerificationStage = {
  id: STAGE,
  run(context: VerificationContext): StageOutcome {
    const document = context.policy;

    if (document === null) {
      return blocked('policy', [
        finding(
          STAGE,
          'POLICY_NOT_FOUND',
          'No policy document is bound to this authorization, so no operator constraints can be enforced.',
        ),
      ]);
    }

    const findings: Finding[] = [];

    if (context.authorization !== null) {
      const recomputed = computePolicyHash(document);
      if (recomputed !== context.authorization.policyHash) {
        findings.push(
          finding(
            STAGE,
            'POLICY_HASH_MISMATCH',
            'The loaded policy is not the one this authorization was issued under.',
            { boundHash: context.authorization.policyHash, loadedHash: recomputed },
          ),
        );
        // Enforcing rules from a document we cannot vouch for would be worse
        // than enforcing none: it would look like a policy check happened.
        return completed(findings);
      }
    }

    if (context.live.kind !== 'OK') {
      // Category and attribute rules must read live truth, exactly as intent
      // alignment does. Evaluating them against agent claims would turn a
      // policy check into a formality.
      return blocked('live-state', findings);
    }

    const subject = buildSubject(context, context.live.state.items);
    const evaluation = evaluatePolicy(document, subject);

    for (const violation of evaluation.violations) {
      findings.push(
        finding(
          STAGE,
          violation.code as ReasonCode,
          violation.message,
          { ...violation.detail, ruleId: violation.ruleId, ruleKind: violation.ruleKind },
          violation.severity,
        ),
      );
    }

    return completed(findings);
  },
};

function buildSubject(
  context: VerificationContext,
  items: ReadonlyMap<string, LiveItemState>,
): PolicySubject {
  const cart = context.proposal;
  const totals = computeCartTotals(cart);

  const lines: PolicySubjectLine[] = cart.lines.map(line => {
    const item = items.get(line.sku);
    return {
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: multiplyMinor(line.unitPrice, line.quantity),
      // Live truth where available. A missing live item is already a DENY from
      // the freshness stage; the sentinel keeps category rules from silently
      // matching the agent's claim in the meantime.
      category: item?.category ?? '<unknown>',
      attributes: (item?.attributes ?? []) as readonly Attribute[],
    };
  });

  // Both instants come from the context, never from the clock: the age is a
  // property of the recorded world, which is what makes it replayable.
  const snapshotAgeSeconds =
    context.snapshot === null
      ? 0
      : Math.max(
          0,
          Math.floor(millisBetween(context.snapshot.observedAt, context.evaluatedAt) / 1000),
        );

  return {
    merchantId: cart.merchantId,
    currency: cart.currency,
    lines,
    totals,
    feeByType: totals.byAdjustmentType,
    recurring: cart.recurring,
    snapshotAgeSeconds,
  };
}

function multiplyMinor(unitPrice: Money, quantity: number): Money {
  return { currency: unitPrice.currency, amountMinor: unitPrice.amountMinor * quantity };
}

export const __testing = { buildSubject, zero };
