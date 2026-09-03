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
import { computeMetrics, renderMarkdown } from './report.js';

async function main(): Promise<void> {
  const results = await runAll();
  const metrics = computeMetrics(results);
  const markdown = renderMarkdown(results, metrics);

  const outputDir = join(process.cwd(), '..', '..', 'reports');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'evaluation.md'), markdown, 'utf8');
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

  const failures = results.filter(r => !r.asExpected);
  if (metrics.gatedUnsafeCharges > 0) {
    console.error(`\nFAIL: CaptureLock allowed ${metrics.gatedUnsafeCharges} unsafe charge(s).`);
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
