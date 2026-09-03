/**
 * The verification kernel.
 *
 * `evaluate` is a pure, synchronous, total function. It performs no I/O, reads
 * no clock, and consumes no randomness. Everything it needs is in the context
 * it is handed, and everything it produces is in the decision it returns.
 *
 * That constraint is not stylistic. It is what allows the same function to be
 * re-run months later against a stored context and produce the identical
 * decision hash — which is the difference between an audit log and a proof.
 *
 * The pipeline is fixed. Stages are not injected from outside and cannot be
 * reordered or removed by a caller, so there is no configuration under which a
 * check silently stops running.
 */

import {
  computeDecisionHash,
  type Gate,
  type Sha256Hex,
  type VerificationDecision,
} from '@capturelock/core';
import { combine } from './combine.js';
import { runStages, type VerificationStage } from './pipeline.js';
import { computeContextHash } from './serialize.js';
import type { VerificationContext } from './context.js';
import { structuralStage } from './stages/structural.js';
import { authorityStage } from './stages/authority.js';
import { snapshotStage } from './stages/snapshot.js';
import { intentAlignmentStage } from './stages/intent.js';
import { policyStage } from './stages/policy.js';
import { freshnessStage } from './stages/freshness.js';
import { executionStage } from './stages/execution.js';

/**
 * The pipeline, in order.
 *
 * The order affects only the readability of the evidence, not the verdict: the
 * combiner takes the maximum severity over all findings, so no stage can be
 * "reached first" and short-circuit another. Ordering runs cheap structural
 * checks before expensive alignment ones purely so a human reading a refusal
 * sees the most fundamental problem at the top.
 */
export const PIPELINE: readonly VerificationStage[] = Object.freeze([
  structuralStage,
  authorityStage,
  snapshotStage,
  intentAlignmentStage,
  policyStage,
  freshnessStage,
  executionStage,
]);

export interface KernelResult {
  readonly decision: VerificationDecision;
  readonly decisionHash: Sha256Hex;
  readonly contextHash: Sha256Hex;
}

/** Runs the pipeline and combines the findings into a single verdict. */
export function evaluate(context: VerificationContext): VerificationDecision {
  const executions = runStages(PIPELINE, context);
  return combine(executions, context.gate, context.evaluatedAt);
}

/** `evaluate` plus the two hashes that go into the evidence envelope. */
export function evaluateWithHashes(context: VerificationContext): KernelResult {
  const decision = evaluate(context);
  return {
    decision,
    decisionHash: computeDecisionHash(decision),
    contextHash: computeContextHash(context),
  };
}

export type { Gate };
