/**
 * Explaining a reason code.
 *
 * The kernel already ships the closed vocabulary — 79 codes, each with a stage,
 * a default severity and a one-line description — in a dependency-free module.
 * The console imports that table rather than keeping a second glossary, so an
 * explanation shown to an operator is the one the kernel documents and cannot
 * drift from it.
 *
 * A code the table does not know is rendered as itself with an explicit
 * "no description" note. Inventing prose for an unrecognised code would be
 * exactly the fabrication this console exists to make unnecessary, and the raw
 * code is always shown alongside the description regardless.
 */

import {
  REASON_CODE_DEFINITIONS,
  isReasonCode,
  type ReasonStage,
  type Severity,
} from '@capturelock/core/reason-codes';

export interface ExplainedReason {
  readonly code: string;
  /** The kernel's own description, or null when the code is unrecognised. */
  readonly description: string | null;
  readonly stage: ReasonStage | null;
  readonly severity: Severity | null;
  /** True when the code is not in the kernel's vocabulary. */
  readonly unknown: boolean;
}

export function explainReason(code: string): ExplainedReason {
  if (!isReasonCode(code)) {
    return { code, description: null, stage: null, severity: null, unknown: true };
  }
  const definition = REASON_CODE_DEFINITIONS[code];
  return {
    code,
    description: definition.description,
    stage: definition.stage,
    severity: definition.severity,
    unknown: false,
  };
}

export function explainReasons(codes: readonly string[]): readonly ExplainedReason[] {
  return codes.map(explainReason);
}

/**
 * The single code that best explains why something is blocked.
 *
 * Severity order, DENY before PAUSE before everything else, with the original
 * order breaking ties so the choice is deterministic. Used only to pick a
 * headline; the full list is always rendered underneath, because a decision
 * usually has more than one reason and showing one would misrepresent it.
 */
export function primaryReason(codes: readonly string[]): ExplainedReason | null {
  if (codes.length === 0) return null;
  const rank = (severity: Severity | null): number =>
    severity === 'DENY' ? 0 : severity === 'PAUSE' ? 1 : 2;
  return explainReasons(codes).reduce((best, candidate) =>
    rank(candidate.severity) < rank(best.severity) ? candidate : best,
  );
}
