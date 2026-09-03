/**
 * Stage 3: is the server-issued snapshot intact, ours, and unspent?
 *
 * The snapshot is the only thing an agent may point at when asking to be
 * charged. It was priced by us from live merchant state, so if it is still
 * exactly as we issued it, the agent cannot have influenced the amount.
 *
 * The three questions are: was it altered, does it belong to this
 * authorization, and has it already been paid?
 */

import {
  cartHashInput,
  finding,
  hash,
  snapshotTotalsAreSelfConsistent,
  verifySnapshotIntegrity,
  type Finding,
} from '@capturelock/core';
import type { VerificationContext } from '../context.js';
import { blocked, completed, type StageOutcome, type VerificationStage } from '../pipeline.js';

const STAGE = 'SNAPSHOT' as const;

export const snapshotStage: VerificationStage = {
  id: STAGE,
  run(context: VerificationContext): StageOutcome {
    const snapshot = context.snapshot;

    if (snapshot === null) {
      return blocked('snapshot', [
        finding(
          STAGE,
          'SNAPSHOT_NOT_FOUND',
          'No verified snapshot exists for the referenced id; there is nothing whose price we vouched for.',
        ),
      ]);
    }

    const findings: Finding[] = [];

    const integrity = verifySnapshotIntegrity(snapshot);
    if (!integrity.valid) {
      findings.push(
        finding(
          STAGE,
          'SNAPSHOT_HASH_MISMATCH',
          'The snapshot no longer hashes to the value stored when it was issued; it was altered after issuance.',
          { storedHash: snapshot.snapshotHash, recomputedHash: integrity.recomputed },
        ),
      );
    }

    // Independent of the hash: an attacker who could recompute the hash would
    // still have to keep the stored totals consistent with the line items.
    if (!snapshotTotalsAreSelfConsistent(snapshot)) {
      findings.push(
        finding(
          STAGE,
          'SNAPSHOT_TOTALS_INCONSISTENT',
          'The totals recorded on the snapshot disagree with the totals its own lines imply.',
          { storedTotalMinor: snapshot.total.amountMinor },
        ),
      );
    }

    if (
      context.authorization !== null &&
      snapshot.authorizationId !== context.authorization.authorizationId
    ) {
      findings.push(
        finding(
          STAGE,
          'SNAPSHOT_NOT_BOUND_TO_AUTHORIZATION',
          'This snapshot was issued against a different authorization.',
          {
            snapshotAuthorizationId: snapshot.authorizationId,
            presentedAuthorizationId: context.authorization.authorizationId,
          },
        ),
      );
    }

    // A snapshot may only be redeemed once. Redemption by *this* release is
    // fine — that is the capture gate running after the order gate — but
    // redemption by any other release means the quote is already spent.
    const currentReleaseId = context.execution.release?.releaseId ?? null;
    if (
      snapshot.redeemedByReleaseId !== null &&
      snapshot.redeemedByReleaseId !== currentReleaseId
    ) {
      findings.push(
        finding(
          STAGE,
          'SNAPSHOT_ALREADY_REDEEMED',
          'Another release already redeemed this snapshot.',
          { redeemedByReleaseId: snapshot.redeemedByReleaseId },
        ),
      );
    }

    // The cart being charged must be byte-identical to the one the snapshot
    // commits to. Comparing canonical hashes rather than fields means a new
    // field added later cannot slip through an incomplete comparison.
    const proposalHash = hash('capturelock.v1.cart', cartHashInput(context.proposal));
    const snapshotCartHash = hash('capturelock.v1.cart', cartHashInput(snapshot.cart));
    if (proposalHash !== snapshotCartHash) {
      findings.push(
        finding(
          STAGE,
          'PROPOSAL_DIVERGES_FROM_SNAPSHOT',
          'The cart being charged is not the cart this snapshot vouched for.',
          { proposalCartHash: proposalHash, snapshotCartHash },
        ),
      );
    }

    return completed(findings);
  },
};
