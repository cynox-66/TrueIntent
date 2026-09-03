/**
 * Stage 7: is this release allowed to act right now?
 *
 * Everything here is about *how many times* and *in what order*, rather than
 * about what is being bought. Three distinct protections live in it:
 *
 *  - **Idempotency-key reuse.** A key that already has a stored answer must
 *    come back with the same request. If the payload changed, the agent is
 *    trying to get a new cart charged under an answer we already gave.
 *  - **State legality.** A release may only be captured from the states the
 *    machine permits, and never from a terminal one.
 *  - **Velocity.** Repeated attempts in a short window are a symptom of a retry
 *    storm or of probing; they pause rather than deny, because the transaction
 *    itself may be perfectly legitimate.
 *
 * This stage detects. The actual *enforcement* of at-most-once execution is a
 * database constraint and a compare-and-set in the release service — see
 * ADR-006. A check here that a concurrent transaction could race past would be
 * worse than no check, so nothing in this file is load-bearing for uniqueness.
 */

import {
  finding,
  isTerminalReleaseState,
  type Finding,
  type Gate,
  type ReleaseState,
} from '@capturelock/core';
import type { VerificationContext } from '../context.js';
import { completed, type StageOutcome, type VerificationStage } from '../pipeline.js';

const STAGE = 'EXECUTION' as const;

/** States from which each gate may legally run. */
const GATE_ENTRY_STATES: Readonly<Record<Gate, readonly ReleaseState[]>> = Object.freeze({
  ORDER_CREATION: ['DRAFT', 'VERIFYING'],
  CAPTURE: ['PAYMENT_AUTHORIZED', 'CAPTURE_VERIFYING', 'PAUSED'],
});

export const executionStage: VerificationStage = {
  id: STAGE,
  run(context: VerificationContext): StageOutcome {
    const findings: Finding[] = [];
    const execution = context.execution;

    const stored = execution.releaseForIdempotencyKey;
    if (stored !== null && stored.requestFingerprint !== execution.requestFingerprint) {
      findings.push(
        finding(
          STAGE,
          'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
          'This idempotency key already has a stored answer for a materially different request.',
          {
            storedFingerprint: stored.requestFingerprint,
            presentedFingerprint: execution.requestFingerprint,
            storedReleaseId: stored.releaseId,
          },
        ),
      );
    }

    const release = execution.release;
    if (release !== null) {
      if (isTerminalReleaseState(release.state)) {
        findings.push(
          finding(
            STAGE,
            'RELEASE_ALREADY_TERMINAL',
            'This release has already reached a terminal state and cannot act again.',
            { releaseId: release.releaseId, state: release.state },
          ),
        );
      } else if (!GATE_ENTRY_STATES[context.gate].includes(release.state)) {
        findings.push(
          finding(
            STAGE,
            'INVALID_RELEASE_STATE_FOR_GATE',
            'The release is not in a state from which this gate may run.',
            {
              releaseId: release.releaseId,
              state: release.state,
              gate: context.gate,
              permitted: [...GATE_ENTRY_STATES[context.gate]].sort().join(','),
            },
          ),
        );
      }
    }

    // One authorization funds one purchase. A second live release against it
    // means either a duplicate in flight or an attempt to spend the mandate
    // twice; both must stop before any provider call.
    // The release records the amount that was verified when the order was
    // created. If the snapshot now implies a different amount, something moved
    // between the two gates and the capture must not proceed on either figure.
    if (release !== null && context.snapshot !== null) {
      const verified = release.amount;
      const current = context.snapshot.total;
      if (verified.amountMinor !== current.amountMinor || verified.currency !== current.currency) {
        findings.push(
          finding(
            STAGE,
            'RELEASE_AMOUNT_DIVERGED',
            'The amount to capture differs from the amount recorded when this release was created.',
            {
              releaseAmountMinor: verified.amountMinor,
              snapshotTotalMinor: current.amountMinor,
              releaseCurrency: verified.currency,
              snapshotCurrency: current.currency,
            },
          ),
        );
      }
    }

    const other = execution.otherActiveRelease;
    if (other !== null && other.releaseId !== release?.releaseId) {
      findings.push(
        finding(
          STAGE,
          'AUTHORIZATION_HAS_ACTIVE_RELEASE',
          'Another non-terminal release already exists for this authorization.',
          { otherReleaseId: other.releaseId, otherState: other.state },
        ),
      );
    }

    if (execution.attemptsInWindow > execution.maxAttemptsInWindow) {
      findings.push(
        finding(
          STAGE,
          'RETRY_VELOCITY_EXCEEDED',
          'Too many release attempts in the velocity window; pausing for a human rather than continuing to retry.',
          {
            attempts: execution.attemptsInWindow,
            limit: execution.maxAttemptsInWindow,
            windowSeconds: execution.velocityWindowSeconds,
          },
        ),
      );
    }

    return completed(findings);
  },
};

export const __gateEntryStates = GATE_ENTRY_STATES;
