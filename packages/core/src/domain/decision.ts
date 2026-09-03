/**
 * The output of the verification kernel.
 *
 * A decision is a value, not an action. It carries every finding that produced
 * it, which stage produced each one, and whether every mandatory stage actually
 * ran. That last part matters: a verdict of ALLOW is only meaningful if we can
 * show that nothing was skipped.
 */

import {
  REASON_CODE_DEFINITIONS,
  SEVERITY_RANK,
  type ReasonCode,
  type Severity,
} from '../reason-codes.js';
import { hash, type Sha256Hex } from '../canonical.js';
import type { Timestamp } from '../time.js';

export type Verdict = 'ALLOW' | 'PAUSE' | 'DENY';

/**
 * Which money-movement boundary is being verified.
 *
 * ORDER_CREATION binds the terms the customer will be asked to pay; no money
 * moves. CAPTURE is where funds actually leave the payer, and is the gate the
 * product is named after.
 */
export type Gate = 'ORDER_CREATION' | 'CAPTURE';

export const STAGE_IDS = [
  'STRUCTURAL',
  'AUTHORITY',
  'SNAPSHOT',
  'INTENT',
  'POLICY',
  'FRESHNESS',
  'EXECUTION',
] as const;

export type StageId = (typeof STAGE_IDS)[number];

/** Finding details are restricted to canonicalizable scalars so a decision always hashes. */
export type FindingDetailValue = string | number | boolean | null;
export type FindingDetail = Readonly<Record<string, FindingDetailValue>>;

export interface Finding {
  readonly code: ReasonCode;
  readonly severity: Severity;
  readonly stage: StageId;
  /** Operator-facing explanation. Never contains secrets or raw provider bodies. */
  readonly message: string;
  readonly detail: FindingDetail;
}

/**
 * Why a stage did or did not produce a result.
 *
 * `ERRORED` exists so that a stage throwing is a first-class, recorded outcome
 * rather than an exception that unwinds past the decision. `SKIPPED_BLOCKED`
 * records that a prerequisite failed, so we do not report a clean pass for a
 * check that never ran.
 */
export type StageStatus = 'COMPLETED' | 'SKIPPED_BLOCKED' | 'ERRORED';

export interface StageReport {
  readonly stage: StageId;
  readonly status: StageStatus;
  readonly findingCount: number;
}

export interface VerificationDecision {
  readonly verdict: Verdict;
  readonly gate: Gate;
  readonly evaluatedAt: Timestamp;
  /** Ordered deterministically: by stage, then severity, then code, then detail. */
  readonly findings: readonly Finding[];
  /** Distinct codes in the same deterministic order, for compact reporting. */
  readonly reasonCodes: readonly ReasonCode[];
  readonly stages: readonly StageReport[];
}

/** Builds a finding, defaulting severity to the code's declared severity. */
export function finding(
  stage: StageId,
  code: ReasonCode,
  message: string,
  detail: FindingDetail = {},
  severity?: Severity,
): Finding {
  return Object.freeze({
    code,
    severity: severity ?? REASON_CODE_DEFINITIONS[code].severity,
    stage,
    message,
    detail: Object.freeze({ ...detail }),
  });
}

const STAGE_ORDER: Readonly<Record<StageId, number>> = Object.freeze({
  STRUCTURAL: 0,
  AUTHORITY: 1,
  SNAPSHOT: 2,
  INTENT: 3,
  POLICY: 4,
  FRESHNESS: 5,
  EXECUTION: 6,
});

/**
 * Total order over findings.
 *
 * Two evaluations of the same context must produce byte-identical output, so
 * the ordering cannot depend on which stage happened to run first or on
 * `Array.prototype.sort` stability. Every tiebreaker is explicit, ending with
 * the serialized detail so no two distinct findings compare equal.
 */
export function compareFindings(a: Finding, b: Finding): number {
  if (a.stage !== b.stage) return STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
  if (a.severity !== b.severity) return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  if (a.message !== b.message) return a.message < b.message ? -1 : 1;
  const detailA = stableDetail(a.detail);
  const detailB = stableDetail(b.detail);
  if (detailA !== detailB) return detailA < detailB ? -1 : 1;
  return 0;
}

function stableDetail(detail: FindingDetail): string {
  return Object.keys(detail)
    .sort()
    .map(key => `${key}=${String(detail[key])}`)
    .join('&');
}

/** Canonical projection of a decision, for the decision hash recorded in evidence. */
export function decisionHashInput(decision: VerificationDecision): Record<string, unknown> {
  return {
    verdict: decision.verdict,
    gate: decision.gate,
    evaluatedAt: decision.evaluatedAt,
    reasonCodes: [...decision.reasonCodes],
    findings: decision.findings.map(f => ({
      code: f.code,
      severity: f.severity,
      stage: f.stage,
      message: f.message,
      detail: Object.keys(f.detail)
        .sort()
        .map(key => ({ key, value: f.detail[key] ?? null })),
    })),
    stages: [...decision.stages]
      .map(s => ({ stage: s.stage, status: s.status, findingCount: s.findingCount }))
      .sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage]),
  };
}

export function computeDecisionHash(decision: VerificationDecision): Sha256Hex {
  return hash('capturelock.v1.decision', decisionHashInput(decision));
}
