/**
 * The stage runner.
 *
 * Stages are pure, synchronous functions from a frozen context to a list of
 * findings. They cannot approve anything: a stage's entire vocabulary is
 * "here is what I found wrong, and whether I was able to look at all". The
 * verdict is computed elsewhere, from all stages together.
 *
 * The runner's one job beyond sequencing is to make a throwing stage a
 * *recorded outcome* rather than an exception that escapes the kernel. An
 * exception that unwinds past a verification boundary is the classic way a
 * security check turns into no check at all; here it becomes a DENY.
 */

import { finding, type Finding, type StageId, type StageStatus } from '@capturelock/core';
import type { VerificationContext } from './context.js';

export type StageOutcome =
  | { readonly status: 'COMPLETED'; readonly findings: readonly Finding[] }
  /**
   * The stage could not evaluate because data it depends on was absent — for
   * example the intent stage when no authorization was found. It reports what
   * blocked it instead of reporting a clean pass.
   */
  | {
      readonly status: 'SKIPPED_BLOCKED';
      readonly findings: readonly Finding[];
      readonly blockedBy: string;
    };

export interface VerificationStage {
  readonly id: StageId;
  /** Pure and synchronous. No clock, no I/O, no randomness. */
  run(context: VerificationContext): StageOutcome;
}

export interface StageExecution {
  readonly stage: StageId;
  readonly status: StageStatus;
  readonly findings: readonly Finding[];
}

export function completed(findings: readonly Finding[] = []): StageOutcome {
  return { status: 'COMPLETED', findings };
}

export function blocked(blockedBy: string, findings: readonly Finding[] = []): StageOutcome {
  return { status: 'SKIPPED_BLOCKED', findings, blockedBy };
}

/**
 * Runs every stage, in order, without short-circuiting.
 *
 * Not short-circuiting is deliberate. A DENY from the first stage would be
 * enough to refuse, but an operator investigating a refusal needs to see every
 * problem, not the first one; and the evidence envelope should record the full
 * picture of what was true at decision time.
 */
export function runStages(
  stages: readonly VerificationStage[],
  context: VerificationContext,
): readonly StageExecution[] {
  return stages.map(stage => {
    try {
      const outcome = stage.run(context);
      if (outcome.status === 'SKIPPED_BLOCKED') {
        return {
          stage: stage.id,
          status: 'SKIPPED_BLOCKED' as const,
          findings: outcome.findings,
        };
      }
      return { stage: stage.id, status: 'COMPLETED' as const, findings: outcome.findings };
    } catch (error) {
      return {
        stage: stage.id,
        status: 'ERRORED' as const,
        findings: [
          finding(
            stage.id,
            'KERNEL_STAGE_ERROR',
            `Verification stage ${stage.id} threw; refusing rather than skipping the check.`,
            { stage: stage.id, error: describeError(error) },
          ),
        ],
      };
    }
  });
}

/**
 * Error text safe to place in evidence.
 *
 * Only the error's own message, never a stack trace and never a nested cause,
 * because either could contain values from the request we do not want copied
 * into an audit record.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return 'non-error thrown';
}
