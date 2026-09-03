/**
 * Background recovery.
 *
 * Two sweeps, resolving two genuinely different hazards:
 *
 *   reconciliation  releases stuck mid-provider-call. Money may or may not have
 *                   moved, and only the provider can say — so this asks, and
 *                   never retries. It runs against a `PaymentReader`, so it
 *                   structurally cannot capture.
 *
 *   liveness        releases abandoned in a transient state. The provider was
 *                   provably never called from these, so no money is at stake —
 *                   but each one holds its authorization's only active-release
 *                   slot, and left alone would prevent that mandate from ever
 *                   being spent again. This is a liveness fix for a hazard the
 *                   safety index itself creates. See ADR-011.
 *
 * A sweep that throws is logged and the loop continues. Stopping on a single
 * failure would leave every subsequent stuck release unresolved, which is a
 * worse outcome than a noisy log.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { ReconciliationService } from '@capturelock/kernel';

export interface SweeperHandle {
  stop(): void;
}

export function startSweepers(
  reconciliation: ReconciliationService,
  logger: FastifyBaseLogger,
  intervalSeconds: number,
): SweeperHandle {
  if (intervalSeconds <= 0) {
    logger.info('sweepers disabled (SWEEP_INTERVAL_SECONDS=0)');
    return { stop: () => undefined };
  }

  const tick = async (): Promise<void> => {
    try {
      const reconciled = await reconciliation.sweep();
      for (const outcome of reconciled) {
        logger.warn(
          {
            releaseId: outcome.releaseId,
            before: outcome.before,
            after: outcome.after,
            moneyMoved: outcome.moneyMoved,
            resolvedBy: outcome.resolvedBy,
          },
          'reconciled a release stuck mid-provider-call',
        );
      }

      const abandoned = await reconciliation.sweepAbandoned();
      for (const outcome of abandoned) {
        logger.warn(
          { releaseId: outcome.releaseId, before: outcome.before, after: outcome.after },
          'aborted a release abandoned in a transient state, freeing its authorization',
        );
      }
    } catch (error) {
      // Never silently swallowed, never fatal.
      logger.error({ err: error }, 'sweep failed; will retry on the next interval');
    }
  };

  const timer = setInterval(() => void tick(), intervalSeconds * 1000);
  // Do not hold the process open just for the sweeper.
  timer.unref();
  logger.info({ intervalSeconds }, 'reconciliation and liveness sweepers started');

  return { stop: () => clearInterval(timer) };
}
