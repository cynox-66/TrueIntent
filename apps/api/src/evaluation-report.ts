/**
 * Serves the committed evaluation result.
 *
 * The number worth showing a viewer — the same agent, the same catalogue, the
 * same provider, run with and without this layer — already exists in
 * `reports/evaluation.json`, written by `pnpm eval`. This reads that file
 * rather than restating its figures anywhere else.
 *
 * That is the whole design constraint. A constant copied into a screen is a
 * number that can quietly stop being true, and a benchmark that disagrees with
 * its own report is worse than no benchmark. If the report is missing or
 * unreadable, this says so and the screen shows nothing — an absent proof point
 * is honest, an invented one is not.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What a screen may state about the evaluation.
 *
 * Deliberately narrow. It carries the counterfactual and the scenario count,
 * and nothing that could be mistaken for production traffic or a rate.
 */
export type EvaluationSummary =
  | {
      readonly available: true;
      readonly totalScenarios: number;
      readonly adversarialScenarios: number;
      /** Money moved on scenarios where it should not have, without the layer. */
      readonly baselineUnsafeCharges: number;
      /** The same figure with it. Zero, or the suite fails its own build. */
      readonly gatedUnsafeCharges: number;
      readonly baselineUnauthorizedSpendMinor: number;
      readonly currency: string;
      /** Nominal scenarios the layer wrongly refused. */
      readonly falseRefusals: number;
      readonly evidenceChainsValid: number;
      readonly decisionsReplayed: number;
      readonly generatedAt: string;
    }
  | { readonly available: false; readonly reason: string };

interface RawReport {
  generatedAt?: unknown;
  metrics?: Record<string, unknown>;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Locates `reports/evaluation.json`.
 *
 * Resolved from this module rather than from the working directory, because the
 * API is started from several of them. `apps/api/src` and `apps/api/dist` are
 * the same depth below the repository root, so one relative path serves both.
 */
function reportPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'reports',
    'evaluation.json',
  );
}

export function loadEvaluationSummary(): EvaluationSummary {
  let raw: RawReport;
  try {
    raw = JSON.parse(readFileSync(reportPath(), 'utf8')) as RawReport;
  } catch {
    return {
      available: false,
      reason: 'No evaluation report has been generated. Run `pnpm eval`.',
    };
  }

  const metrics = raw.metrics ?? {};
  const total = number(metrics['total']);
  const baselineUnsafe = number(metrics['baselineUnsafeCharges']);
  const gatedUnsafe = number(metrics['gatedUnsafeCharges']);
  const baselineSpend = number(metrics['baselineUnauthorizedSpendMinor']);

  // Every figure the screen shows must be present. A partial report renders
  // nothing rather than a half-stated comparison.
  if (total === null || baselineUnsafe === null || gatedUnsafe === null || baselineSpend === null) {
    return {
      available: false,
      reason: 'The evaluation report is missing the fields this summary reports.',
    };
  }

  return {
    available: true,
    totalScenarios: total,
    adversarialScenarios: number(metrics['adversarial']) ?? 0,
    baselineUnsafeCharges: baselineUnsafe,
    gatedUnsafeCharges: gatedUnsafe,
    baselineUnauthorizedSpendMinor: baselineSpend,
    // The evaluation suite is denominated in INR throughout; the report does
    // not carry a currency of its own, so it is named here rather than guessed
    // at by the screen.
    currency: 'INR',
    falseRefusals: number(metrics['falseRefusals']) ?? 0,
    evidenceChainsValid: number(metrics['evidenceChainsValid']) ?? 0,
    decisionsReplayed: number(metrics['decisionsReplayed']) ?? 0,
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : 'unknown',
  };
}
