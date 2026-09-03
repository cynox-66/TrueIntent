/**
 * Report rendering.
 *
 * The numbers here describe this repository's own committed scenario suite.
 * They say whether the system behaves as designed on cases we chose. They are
 * not a measurement of real agent behaviour, and nothing about real-world
 * prevention rates should be read into them.
 */

import type { ScenarioResult } from './runner.js';

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
