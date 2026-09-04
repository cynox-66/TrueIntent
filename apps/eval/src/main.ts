/**
 * Entry point: `pnpm eval`.
 *
 * Writes a markdown report and a machine-readable JSON summary to `reports/`,
 * and exits non-zero if any scenario failed to behave as declared — so this can
 * gate a build rather than merely informing one.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAll } from './runner.js';
import { runAllAgentScenarios } from './agent-runner.js';
import {
  computeAgentMetrics,
  computeMetrics,
  renderAgentMarkdown,
  renderMarkdown,
} from './report.js';

async function main(): Promise<void> {
  const results = await runAll();
  const agentResults = await runAllAgentScenarios();
  const agentMetrics = computeAgentMetrics(agentResults);
  const agentMarkdown = renderAgentMarkdown(agentResults, agentMetrics);
  const metrics = computeMetrics(results);
  const markdown = renderMarkdown(results, metrics);

  const outputDir = join(process.cwd(), '..', '..', 'reports');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'evaluation.md'), markdown, 'utf8');
  writeFileSync(join(outputDir, 'evaluation-agent.md'), agentMarkdown, 'utf8');
  writeFileSync(
    join(outputDir, 'evaluation-agent.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        metrics: agentMetrics,
        results: agentResults.map(r => ({
          id: r.scenario.id,
          title: r.scenario.title,
          family: r.scenario.family,
          kind: r.scenario.kind,
          outcome: r.outcome,
          asExpected: r.asExpected,
          mismatch: r.mismatch,
        })),
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    join(outputDir, 'evaluation.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        metrics,
        results: results.map(r => ({
          id: r.scenario.id,
          title: r.scenario.title,
          family: r.scenario.family,
          kind: r.scenario.kind,
          baseline: r.baseline,
          capturelock: r.capturelock,
          asExpected: r.asExpected,
          mismatch: r.mismatch,
        })),
      },
      null,
      2,
    ),
    'utf8',
  );

  console.info(markdown);
  console.info(`\n${agentMarkdown}`);

  const agentFailures = agentResults.filter(r => !r.asExpected);
  if (agentMetrics.unsafeCharges > 0) {
    console.error(
      `\nFAIL: the agentic suite charged on ${String(agentMetrics.unsafeCharges)} scenario(s) that declared no money may move.`,
    );
    process.exit(1);
  }
  if (agentMetrics.duplicateProviderCaptures > 0 || agentMetrics.duplicateReleases > 0) {
    console.error('\nFAIL: a retried or concurrent request produced duplicate execution.');
    process.exit(1);
  }
  if (agentFailures.length > 0) {
    console.error(
      `\nFAIL: ${String(agentFailures.length)} agentic scenario(s) did not match their declared expectation.`,
    );
    for (const failure of agentFailures) {
      console.error(`  ${failure.scenario.id}: ${String(failure.mismatch)}`);
    }
    process.exit(1);
  }

  const failures = results.filter(r => !r.asExpected);
  if (metrics.gatedUnsafeCharges > 0) {
    console.error(`\nFAIL: TrueIntent allowed ${metrics.gatedUnsafeCharges} unsafe charge(s).`);
    process.exit(1);
  }
  if (failures.length > 0) {
    console.error(
      `\nFAIL: ${failures.length} scenario(s) did not match their declared expectation.`,
    );
    process.exit(1);
  }
  console.info('\nAll scenarios behaved as declared.');
}

void main();
