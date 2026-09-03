/**
 * `pnpm scenario [id]`
 *
 * Runs the end-to-end scenarios against the real service stack. With
 * `DATABASE_URL` set it uses Postgres, which is what makes these a test of the
 * *persistent* lifecycle rather than of in-process bookkeeping.
 *
 * Exits non-zero on any failure, so it gates a build rather than merely
 * informing one.
 */

import 'dotenv/config';
import { E2E_SCENARIOS, runE2EScenario } from './scenarios-e2e.js';

async function main(): Promise<void> {
  const wanted = process.argv[2];
  const scenarios =
    wanted === undefined ? E2E_SCENARIOS : E2E_SCENARIOS.filter(s => s.id.includes(wanted));

  if (scenarios.length === 0) {
    console.error(`No scenario matches "${String(wanted)}".`);
    console.error(`Available: ${E2E_SCENARIOS.map(s => s.id).join(', ')}`);
    process.exit(1);
  }

  const databaseUrl = process.env['DATABASE_URL'];
  console.info(
    `CaptureLock end-to-end scenarios  (persistence: ${databaseUrl === undefined ? 'in-memory' : 'postgres'})\n`,
  );

  let failed = 0;
  for (const scenario of scenarios) {
    const report = await runE2EScenario(scenario, databaseUrl);
    console.info(`${report.passed ? 'PASS' : 'FAIL'}  ${report.id}`);
    console.info(`      ${report.title}`);
    for (const step of report.steps) console.info(`        · ${step}`);
    console.info(
      `        provider captures: ${report.providerCaptures}   money moved: ${String(report.moneyMoved)}   evidence chain: ${report.evidenceChainValid ? 'valid' : 'INVALID'}`,
    );
    if (!report.passed) {
      failed += 1;
      console.error(`        FAILURE: ${String(report.failure)}`);
    }
    console.info('');
  }

  if (failed > 0) {
    console.error(`${failed} of ${scenarios.length} scenario(s) failed.`);
    process.exit(1);
  }
  console.info(`All ${scenarios.length} scenarios behaved as declared.`);
}

void main();
