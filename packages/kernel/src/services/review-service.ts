/**
 * Resolution of paused releases.
 *
 * An approval does not authorize a payment. It authorizes *re-verification*:
 * the release moves back to the capture gate and the kernel runs again against
 * fresh live state. If the price moved while a human was deliberating, the
 * approval does not paper over it.
 *
 * The reviewer is a separate principal from the agent, established by the API
 * layer. Nothing an agent can send reaches this service.
 */

import type { ReleaseState, ReviewId } from '@capturelock/core';
import { nextState } from '../release-fsm.js';
import type { CoreDependencies } from './dependencies.js';

export type ReviewResolution = 'APPROVED' | 'REJECTED';

export type ResolveReviewResult =
  | { readonly kind: 'RESOLVED'; readonly releaseId: string; readonly state: ReleaseState }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'ALREADY_RESOLVED' }
  | { readonly kind: 'RELEASE_MOVED_ON'; readonly state: ReleaseState };

export class ReviewService {
  constructor(private readonly deps: CoreDependencies) {}

  async resolve(
    reviewId: ReviewId,
    resolution: ReviewResolution,
    resolvedBy: string,
  ): Promise<ResolveReviewResult> {
    const now = this.deps.clock.now();
    const review = await this.deps.reviews.findById(reviewId);
    if (review === null) return { kind: 'NOT_FOUND' };

    const resolved = await this.deps.reviews.resolve(reviewId, resolution, resolvedBy, now);
    // A compare-and-set from OPEN: two reviewers clicking at once cannot both
    // resolve, and a second resolution cannot flip a rejection to an approval.
    if (resolved === null) return { kind: 'ALREADY_RESOLVED' };

    const release = await this.deps.releases.findById(review.releaseId);
    if (release === null) return { kind: 'NOT_FOUND' };

    const trigger = resolution === 'APPROVED' ? 'REVIEW_APPROVED' : 'REVIEW_REJECTED';
    const target = nextState(release.state, trigger);
    if (target === null) {
      return { kind: 'RELEASE_MOVED_ON', state: release.state };
    }

    const updated = await this.deps.releases.transition(
      release.releaseId,
      [release.state],
      target,
      { lastReasonCodes: [`REVIEW_${resolution}`] },
      now,
    );
    if (updated === null) {
      const current = await this.deps.releases.findById(release.releaseId);
      return { kind: 'RELEASE_MOVED_ON', state: current?.state ?? release.state };
    }

    await this.deps.evidence.append({
      chainId: release.authorizationId,
      kind: 'REVIEW_RESOLUTION',
      recordedAt: now,
      body: {
        reviewId,
        releaseId: release.releaseId,
        resolution,
        resolvedBy,
        // Recorded so an auditor can see the approval was for this cart and no
        // other.
        boundSnapshotHash: review.snapshotHash,
        resultingState: updated.state,
      },
    });

    return { kind: 'RESOLVED', releaseId: updated.releaseId, state: updated.state };
  }
}
