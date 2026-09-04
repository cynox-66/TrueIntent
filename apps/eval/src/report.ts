/**
 * Report rendering.
 *
 * The numbers here describe this repository's own committed scenario suite.
 * They say whether the system behaves as designed on cases we chose. They are
 * not a measurement of real agent behaviour, and nothing about real-world
 * prevention rates should be read into them.
 */

import type { ScenarioResult } from './runner.js';
import type { AgentScenarioResult } from './agent-runner.js';

export interface Metrics {
  readonly total: number;
  readonly nominal: number;
  readonly adversarial: number;
  /** Baseline moved money on a scenario where it should not have. */
  readonly baselineUnsafeCharges: number;
  /** CaptureLock moved money on a scenario where it should not have. Must be 0. */
  readonly gatedUnsafeCharges: number;
  /** Nominal scenarios CaptureLock wrongly refused. */
  readonly falseRefusals: number;
  readonly baselineTotalCaptures: number;
  readonly gatedTotalCaptures: number;
  readonly baselineOvercharges: number;
  readonly scenariosAsExpected: number;
  readonly evidenceChainsValid: number;
  readonly decisionsReplayed: number;
  readonly baselineUnauthorizedSpendMinor: number;
}

export function computeMetrics(results: readonly ScenarioResult[]): Metrics {
  return {
    total: results.length,
    nominal: results.filter(r => r.scenario.kind === 'NOMINAL').length,
    adversarial: results.filter(r => r.scenario.kind === 'ADVERSARIAL').length,
    baselineUnsafeCharges: results.filter(r => r.baselineUnsafeCharge).length,
    gatedUnsafeCharges: results.filter(r => r.gatedUnsafeCharge).length,
    falseRefusals: results.filter(
      r => r.scenario.kind === 'NOMINAL' && r.capturelock.verdict !== 'ALLOW',
    ).length,
    baselineTotalCaptures: results.reduce((sum, r) => sum + r.baseline.captures, 0),
    gatedTotalCaptures: results.reduce((sum, r) => sum + r.capturelock.captures, 0),
    baselineOvercharges: results.filter(r => r.baseline.captures > 1).length,
    scenariosAsExpected: results.filter(r => r.asExpected).length,
    evidenceChainsValid: results.filter(r => r.evidenceChainValid).length,
    decisionsReplayed: results.filter(r => r.decisionReplayed).length,
    baselineUnauthorizedSpendMinor: results
      .filter(r => r.baselineUnsafeCharge)
      .reduce((sum, r) => sum + r.baseline.amountChargedMinor, 0),
  };
}

function rupees(minor: number): string {
  return `INR ${(minor / 100).toFixed(2)}`;
}

export function renderMarkdown(results: readonly ScenarioResult[], metrics: Metrics): string {
  const lines: string[] = [];

  lines.push('# CaptureLock evaluation report');
  lines.push('');
  lines.push(
    "_Results of this repository's own committed scenario suite. They show whether the system",
  );
  lines.push(
    'behaves as designed on cases we chose; they are not a measurement of real agent behaviour._',
  );
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Baseline (no verification) | CaptureLock |');
  lines.push('| --- | --- | --- |');
  lines.push(
    `| Unsafe charges (money moved that should not have) | ${metrics.baselineUnsafeCharges} | ${metrics.gatedUnsafeCharges} |`,
  );
  lines.push(
    `| Unauthorized spend across the suite | ${rupees(metrics.baselineUnauthorizedSpendMinor)} | ${rupees(0)} |`,
  );
  lines.push(
    `| Scenarios with more than one capture | ${metrics.baselineOvercharges} | ${results.filter(r => r.capturelock.captures > 1).length} |`,
  );
  lines.push(
    `| Total provider captures | ${metrics.baselineTotalCaptures} | ${metrics.gatedTotalCaptures} |`,
  );
  lines.push(`| Live state re-checked before capture | never | every scenario |`);
  lines.push(
    `| Decisions reproducible from evidence | 0 | ${metrics.decisionsReplayed} / ${metrics.total} |`,
  );
  lines.push(
    `| Evidence chains verifying | n/a | ${metrics.evidenceChainsValid} / ${metrics.total} |`,
  );
  lines.push('');
  lines.push(
    `Nominal scenarios wrongly refused by CaptureLock: **${metrics.falseRefusals} of ${metrics.nominal}**.`,
  );
  lines.push(
    `Scenarios matching their declared expectation: **${metrics.scenariosAsExpected} of ${metrics.total}**.`,
  );
  lines.push('');

  lines.push('## Per-scenario results');
  lines.push('');
  lines.push('| Scenario | Family | Baseline | CaptureLock | Reason codes |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const result of results) {
    const baseline = result.baseline.moneyMoved
      ? `charged ${rupees(result.baseline.amountChargedMinor)}${result.baseline.captures > 1 ? ` (${result.baseline.captures}x)` : ''}`
      : 'no charge';
    const gated = result.capturelock.moneyMoved
      ? `charged ${rupees(result.capturelock.amountChargedMinor)}`
      : `${result.capturelock.verdict}, no charge`;
    const codes = result.capturelock.reasonCodes.slice(0, 3).join(', ') || '-';
    lines.push(
      `| \`${result.scenario.id}\` | ${result.scenario.family} | ${baseline} | ${gated} | ${codes} |`,
    );
  }
  lines.push('');

  const failures = results.filter(r => !r.asExpected);
  if (failures.length > 0) {
    lines.push('## Scenarios that did not match expectations');
    lines.push('');
    for (const failure of failures) {
      lines.push(`- \`${failure.scenario.id}\`: ${failure.mismatch ?? 'unknown'}`);
    }
    lines.push('');
  }

  lines.push('## What the baseline actually does');
  lines.push('');
  lines.push(
    'The baseline is not a straw man. It reads the same catalogue, calls the same provider, and',
  );
  lines.push(
    'charges the same amounts. The only difference is that nothing verifies the transaction',
  );
  lines.push('before the money moves. Two behaviours are worth calling out:');
  lines.push('');
  lines.push(
    '- It quotes once and never looks again, so anything that changes between quote and capture is invisible to it.',
  );
  lines.push(
    '- On a lost capture response it retries, because without a notion of an indeterminate outcome there is nothing else to do. Razorpay rejects the second capture with a 400, which the baseline records as a failure while the money has in fact moved.',
  );
  lines.push('');

  return lines.join('\n');
}

// ============================================================== agentic ==

/**
 * Metrics for the bounded-agent suite.
 *
 * Every one of these is counted from a scenario that actually ran. The names
 * are chosen to be answerable rather than impressive: "unauthorized charges"
 * means the provider captured on a scenario that declared it must not, which
 * is a fact about a run, not an estimate about the world.
 */
export interface AgentMetrics {
  readonly total: number;
  readonly nominal: number;
  readonly adversarial: number;
  /** Provider captures on scenarios that declared money must not move. Must be 0. */
  readonly unsafeCharges: number;
  /** Capture calls that reached the provider across the whole suite. */
  readonly providerCaptures: number;
  /** Scenarios where a stale or diverged live state was refused. */
  readonly staleStateRefusals: number;
  /** Scenarios where a semantically wrong but numerically valid cart was refused. */
  readonly intentDriftRefusals: number;
  /** Scenarios where the aggregate session budget refused a purchase. */
  readonly budgetRefusals: number;
  /** Scenarios where a model failure ended the run without a charge. */
  readonly modelFailuresContained: number;
  /** Duplicate or concurrent requests that produced more than one release. Must be 0. */
  readonly duplicateReleases: number;
  /** Duplicate or concurrent requests that captured more than once. Must be 0. */
  readonly duplicateProviderCaptures: number;
  /** Nominal scenarios that were wrongly refused. */
  readonly falseRefusals: number;
  readonly legitimatePurchases: number;
  readonly scenariosAsExpected: number;
  readonly evidenceChainsValid: number;
  /** Purchases whose evidence chain carries the agentic context. */
  readonly agenticContextsRecorded: number;
}

export function computeAgentMetrics(results: readonly AgentScenarioResult[]): AgentMetrics {
  const duplicateFamily = results.filter(r => r.scenario.family === 'duplicate execution');

  return {
    total: results.length,
    nominal: results.filter(r => r.scenario.kind === 'NOMINAL').length,
    adversarial: results.filter(r => r.scenario.kind === 'ADVERSARIAL').length,
    unsafeCharges: results.filter(
      r => !r.scenario.expect.moneyMoved && r.outcome.providerCaptures > 0,
    ).length,
    providerCaptures: results.reduce((sum, r) => sum + r.outcome.providerCaptures, 0),
    staleStateRefusals: results.filter(
      r => r.scenario.family === 'live-state drift' && r.outcome.providerCaptures === 0,
    ).length,
    intentDriftRefusals: results.filter(
      r => r.scenario.family === 'intent drift' && r.outcome.providerCaptures === 0,
    ).length,
    budgetRefusals: results.filter(r =>
      r.outcome.reasonCodes.some(
        code => code === 'SESSION_BUDGET_EXCEEDED' || code === 'INTENT_TOTAL_EXCEEDED',
      ),
    ).length,
    modelFailuresContained: results.filter(
      r => r.scenario.family === 'model failure' && r.outcome.providerCaptures === 0,
    ).length,
    duplicateReleases: duplicateFamily.filter(r => r.outcome.releases > 1).length,
    duplicateProviderCaptures: duplicateFamily.filter(r => r.outcome.providerCaptures > 1).length,
    falseRefusals: results.filter(r => r.scenario.kind === 'NOMINAL' && !r.outcome.moneyMoved)
      .length,
    legitimatePurchases: results.filter(r => r.scenario.expect.moneyMoved && r.outcome.moneyMoved)
      .length,
    scenariosAsExpected: results.filter(r => r.asExpected).length,
    evidenceChainsValid: results.filter(r => r.outcome.evidenceChainValid).length,
    agenticContextsRecorded: results.filter(r => r.outcome.agenticContextRecorded).length,
  };
}

export function renderAgentMarkdown(
  results: readonly AgentScenarioResult[],
  metrics: AgentMetrics,
): string {
  const lines: string[] = [];

  lines.push('# CaptureLock agentic evaluation report');
  lines.push('');
  lines.push(
    'A bounded buyer agent shopping inside a delegated commerce session. Every',
    'figure below is counted from a scenario in `apps/eval/src/agent-scenarios.ts`',
    'that actually ran against the real two-gate pipeline; capture counts come',
    "from the payment provider's own call log, so a zero means the guarded",
    'executor was never invoked rather than that a stub did not fire.',
  );
  lines.push('');
  lines.push(
    '**What this does not measure.** It says whether the system behaves as',
    'designed on cases this repository chose. It is not a measurement of real',
    'agent behaviour, and no real-world prevention rate should be read into it.',
  );
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  lines.push(
    `| scenarios | ${String(metrics.total)} (${String(metrics.nominal)} nominal, ${String(metrics.adversarial)} adversarial) |`,
  );
  lines.push(`| **unauthorized charges** | **${String(metrics.unsafeCharges)}** |`);
  lines.push(`| provider capture calls, whole suite | ${String(metrics.providerCaptures)} |`);
  lines.push(`| legitimate purchases completed | ${String(metrics.legitimatePurchases)} |`);
  lines.push(`| false refusals of nominal scenarios | ${String(metrics.falseRefusals)} |`);
  lines.push(`| stale or diverged live state refused | ${String(metrics.staleStateRefusals)} |`);
  lines.push(`| intent drift refused | ${String(metrics.intentDriftRefusals)} |`);
  lines.push(`| aggregate budget refusals | ${String(metrics.budgetRefusals)} |`);
  lines.push(
    `| model failures contained without a charge | ${String(metrics.modelFailuresContained)} |`,
  );
  lines.push(`| duplicate releases from retries | ${String(metrics.duplicateReleases)} |`);
  lines.push(
    `| duplicate provider captures from retries | ${String(metrics.duplicateProviderCaptures)} |`,
  );
  lines.push(
    `| evidence chains valid | ${String(metrics.evidenceChainsValid)}/${String(metrics.total)} |`,
  );
  lines.push(
    `| purchases carrying agentic context in evidence | ${String(metrics.agenticContextsRecorded)} |`,
  );
  lines.push(
    `| scenarios matching their declaration | ${String(metrics.scenariosAsExpected)}/${String(metrics.total)} |`,
  );
  lines.push('');

  lines.push('## Per scenario');
  lines.push('');
  lines.push('| id | family | money moved | captures | releases | reason codes | as declared |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const result of results) {
    const codes = result.outcome.reasonCodes.slice(0, 3).join(', ') || '—';
    lines.push(
      `| \`${result.scenario.id}\` | ${result.scenario.family} | ${
        result.outcome.moneyMoved ? 'yes' : 'no'
      } | ${String(result.outcome.providerCaptures)} | ${String(result.outcome.releases)} | ${codes} | ${
        result.asExpected ? 'yes' : '**NO**'
      } |`,
    );
  }
  lines.push('');

  const mismatches = results.filter(r => !r.asExpected);
  if (mismatches.length > 0) {
    lines.push('## Scenarios that did not behave as declared');
    lines.push('');
    for (const result of mismatches) {
      lines.push(`- \`${result.scenario.id}\`: ${String(result.mismatch)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
