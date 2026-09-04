/**
 * The verdict combiner.
 *
 * This is the only place in TrueIntent where the word ALLOW is produced, and
 * it is deliberately small enough to read in one sitting.
 *
 * The rule is default-deny by construction. ALLOW is not the absence of a
 * problem; it is the *presence* of a completed run of every mandatory stage
 * with nothing found. Any of the following yields a refusal:
 *
 *   - a DENY-severity finding from any stage
 *   - a PAUSE-severity finding (which yields PAUSE, not ALLOW)
 *   - a stage that threw
 *   - a stage that could not evaluate because its inputs were missing
 *   - a stage that simply is not in the results at all
 *
 * There is no code path from an exception to ALLOW, and the tests inject a
 * faulting stage into every position to prove it.
 */

import {
  SEVERITY_RANK,
  STAGE_IDS,
  compareFindings,
  finding,
  type Finding,
  type Gate,
  type ReasonCode,
  type Sha256Hex,
  type StageId,
  type StageReport,
  type Timestamp,
  type VerificationDecision,
  type Verdict,
} from '@capturelock/core';
import type { StageExecution } from './pipeline.js';
import type { ApprovedReview } from './context.js';

/**
 * Stages that must complete before any transaction may be approved.
 *
 * Every stage is mandatory. The list exists as data rather than as an implicit
 * "all of them" so that adding a stage without deciding whether it gates money
 * is impossible.
 */
export const MANDATORY_STAGES: readonly StageId[] = STAGE_IDS;

export interface CombineOptions {
  /** The operator approval on file for this release, if any. */
  readonly approval: ApprovedReview | null;
  /** The fingerprint of the request being verified right now. */
  readonly requestFingerprint: Sha256Hex | null;
}

export function combine(
  executions: readonly StageExecution[],
  gate: Gate,
  evaluatedAt: Timestamp,
  options: CombineOptions = { approval: null, requestFingerprint: null },
): VerificationDecision {
  const findings: Finding[] = executions.flatMap(execution => [...execution.findings]);

  // A mandatory stage that is absent from the results is as serious as one that
  // threw: in both cases a check that should have run did not.
  const seen = new Set(executions.map(execution => execution.stage));
  for (const stage of MANDATORY_STAGES) {
    if (!seen.has(stage)) {
      findings.push(
        finding(stage, 'STAGE_DID_NOT_COMPLETE', `Mandatory stage ${stage} did not run.`, {
          stage,
          status: 'ABSENT',
        }),
      );
    }
  }

  for (const execution of executions) {
    if (execution.status === 'COMPLETED') continue;
    if (!MANDATORY_STAGES.includes(execution.stage)) continue;
    // An ERRORED stage already contributed KERNEL_STAGE_ERROR from the runner;
    // this records the orthogonal fact that a required check is missing.
    findings.push(
      finding(
        execution.stage,
        'STAGE_DID_NOT_COMPLETE',
        `Mandatory stage ${execution.stage} did not complete (${execution.status}).`,
        { stage: execution.stage, status: execution.status },
      ),
    );
  }

  const ordered = [...findings].sort(compareFindings);

  const highest = ordered.reduce(
    (rank, item) => Math.max(rank, SEVERITY_RANK[item.severity]),
    SEVERITY_RANK.INFO,
  );

  let verdict: Verdict;
  if (highest === SEVERITY_RANK.DENY) verdict = 'DENY';
  else if (highest === SEVERITY_RANK.PAUSE) verdict = 'PAUSE';
  else verdict = 'ALLOW';

  // A human already looked at this and said yes. Consuming that is the only
  // thing that makes PAUSE different from DENY.
  const approvalApplies = verdict === 'PAUSE' && approvalCovers(ordered, options);
  if (approvalApplies) verdict = 'ALLOW';

  const withApproval = approvalApplies
    ? [
        ...ordered,
        finding(
          'EXECUTION',
          'REVIEW_APPROVAL_APPLIED',
          `Operator ${options.approval!.resolvedBy} approved this exact cart, covering every pause finding.`,
          {
            reviewId: options.approval!.reviewId,
            boundTo: options.approval!.boundTo,
            approvedReasonCodes: options.approval!.reasonCodes.join(','),
            resolvedAt: options.approval!.resolvedAt,
          },
        ),
      ]
    : ordered;

  const reasonCodes = dedupeCodes(withApproval);

  // Record an explicit positive statement when nothing was found, so an
  // envelope never reads as "approved, no reasons given".
  const finalFindings =
    verdict === 'ALLOW'
      ? [
          ...withApproval,
          finding(
            'EXECUTION',
            'VERIFIED_MATCH',
            'All mandatory stages completed with no findings.',
          ),
        ]
      : ordered;

  const stages: StageReport[] = executions.map(execution => ({
    stage: execution.stage,
    status: execution.status,
    findingCount: execution.findings.length,
  }));

  return Object.freeze({
    verdict,
    gate,
    evaluatedAt,
    findings: Object.freeze(finalFindings),
    reasonCodes: Object.freeze(
      verdict === 'ALLOW' ? ([...reasonCodes, 'VERIFIED_MATCH'] as ReasonCode[]) : reasonCodes,
    ),
    stages: Object.freeze(stages),
  });
}

/**
 * Whether an approval covers everything that is currently pausing this release.
 *
 * Deliberately narrow, because this is the one place a refusal becomes an
 * approval. Four conditions, and all of them must hold:
 *
 *  - **There is an approval.** Absent one, nothing is downgraded.
 *  - **The request is the same.** The approval carries the fingerprint of what
 *    the reviewer saw — authorization, snapshot and gate. A re-quote changes it,
 *    and so does moving to the other gate, so an approval never travels to a
 *    cart or a gate the human was not shown.
 *  - **Every pause finding was one the reviewer saw.** A pause the human was
 *    never shown — a price that moved while they deliberated, a new velocity
 *    trip — still pauses. An approval is consent to specific findings, not a
 *    blanket waiver.
 *  - **Nothing DENY-severity is present.** This function is only ever reached
 *    when the verdict is already PAUSE, so a DENY cannot be here; the filter
 *    below is explicit anyway, because relying on a caller's precondition for a
 *    security property is how that property gets lost.
 *
 * Note what is NOT checked: whether the operator "should" have approved. That
 * is their judgement, and the system's job is to bind it to a specific cart and
 * a specific set of reasons rather than to second-guess it.
 */
function approvalCovers(findings: readonly Finding[], options: CombineOptions): boolean {
  const approval = options.approval;
  if (approval === null || approval === undefined) return false;
  if (options.requestFingerprint === null || options.requestFingerprint !== approval.boundTo) {
    return false;
  }
  if (findings.some(item => item.severity === 'DENY')) return false;

  const approved = new Set(approval.reasonCodes);
  const pausing = findings.filter(item => item.severity === 'PAUSE');
  if (pausing.length === 0) return false;
  return pausing.every(item => approved.has(item.code));
}

function dedupeCodes(findings: readonly Finding[]): ReasonCode[] {
  const seen = new Set<ReasonCode>();
  const out: ReasonCode[] = [];
  for (const item of findings) {
    if (seen.has(item.code)) continue;
    seen.add(item.code);
    out.push(item.code);
  }
  return out;
}
